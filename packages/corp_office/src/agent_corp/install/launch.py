"""How the office daemon is started: its command, environment, and log, and the host it runs on."""

import contextlib
import hashlib
import os
import shutil
import socket as sock
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from agent_corp.worker.spawn import INHERITED_ENV

REPO = Path(__file__).resolve().parents[5]
"""The checkout this code runs from (``packages/corp_office/src/agent_corp/install`` up five);
the daemon runs from the same one (``<repo>/.venv``)."""


class ServiceError(Exception):
    """A service manager refused to install or start the office; the message says why."""


@dataclass(frozen=True)
class Launch:
    """One office's daemon: its launch command, environment and folder, and its service name."""

    argv: tuple[str, ...]
    env: dict[str, str]
    cwd: Path
    home: Path
    name: str

    @property
    def office(self) -> Path:
        return self.home / "office"

    @property
    def log(self) -> Path:
        """Where the daemon's stdout and stderr go (never an unread pipe, which would stall it)."""
        return self.office / "office.log"

    @property
    def socket(self) -> Path:
        return self.office / "office.sock"


CODEX_ENV = ("CODEX_HOME", "AGENT_CORP_CODEX_BIN")
"""Which Codex the office runs, when the caller's shell sets them: its home, and a binary other than ``codex``."""


def daemon_env(environ: Mapping[str, str]) -> dict[str, str]:
    """The daemon's environment: the worker allowlist, ``LC_*`` and ``CODEX_ENV``, so no key in the caller's shell
    reaches it.

    ``LC_TERMINAL*`` (iTerm's name and version) is left out: it isn't a locale, and it would
    change the service file whenever the terminal updates.
    """
    return {k: v for k, v in environ.items()
            if k in INHERITED_ENV or k in CODEX_ENV or (k.startswith("LC_") and not k.startswith("LC_TERMINAL"))}


def launch(home: Path, *, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
           user_home: Path | None = None) -> Launch:
    """The launch for the office at ``home``: ``<repo>/.venv/bin/python -m agent_corp.daemon.main --home <home>``.

    The home is taken as its realpath. The default home's service is ``office``; any other
    home gets ``office-<8 hex>`` from its path, so a test or second office never replaces the
    owner's service.
    """
    # Resolved the way the daemon resolves ``--home``, so both agree on the socket and pidfile.
    home = Path(os.path.realpath(os.path.expanduser(home)))
    default = Path(os.path.realpath((user_home or Path.home()) / ".agent-corp"))
    name = "office" if home == default else f"office-{hashlib.sha256(str(home).encode()).hexdigest()[:8]}"
    argv = (str(repo / ".venv" / "bin" / "python"), "-m", "agent_corp.daemon.main", "--home", str(home))
    return Launch(argv=argv, env=daemon_env(environ), cwd=repo, home=home, name=name)


def run_command(argv: list[str]) -> subprocess.CompletedProcess[str]:
    """Run ``argv`` and capture its output; a program that can't start is exit 127, not an exception."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
    except OSError as exc:
        return subprocess.CompletedProcess(argv, 127, "", str(exc))
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", f"{argv[0]} timed out")


def office_answers(socket: Path, timeout: float = 2.0) -> bool:
    """Whether an office is serving on ``socket`` (``GET /health`` answers 200 within ``timeout`` seconds)."""
    # httpx leaks the socket when a unix-socket connect fails, so probe with one we close.
    with contextlib.closing(sock.socket(sock.AF_UNIX, sock.SOCK_STREAM)) as probe:
        probe.settimeout(timeout)
        try:
            probe.connect(str(socket))
        except OSError:
            return False
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(socket)), base_url="http://office",
                          timeout=timeout) as client:
            return client.get("/health").status_code == 200
    except httpx.TransportError:
        return False


@dataclass(frozen=True)
class Host:
    """What installing touches on this machine: the platform, the user's home, and how to run things.

    Tests pass stubs for the callables.
    """

    platform: str = sys.platform
    user_home: Path = field(default_factory=Path.home)
    uid: int = field(default_factory=os.getuid)
    run: Callable[[list[str]], subprocess.CompletedProcess[str]] = run_command
    popen: Callable[..., object] = subprocess.Popen
    which: Callable[[str], str | None] = shutil.which
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    answers: Callable[..., bool] = office_answers
    """``answers(socket, timeout=2.0)``: whether the office on ``socket`` answers."""
