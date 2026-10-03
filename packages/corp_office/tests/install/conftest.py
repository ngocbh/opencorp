import os
import stat
import subprocess
from pathlib import Path

import pytest

from agent_corp.install.launch import Host, Launch, launch

SERVICE_TOOLS = ("launchctl", "systemctl", "loginctl", "tmux")


@pytest.fixture(autouse=True)
def no_real_services(tmp_path_factory, monkeypatch):
    """Keep every test off the real machine: a temp ``HOME`` and ``AC_HOME``, and stand-ins for the service tools.

    The stand-ins come first on ``PATH``, refuse, and log their argv, so a code path that
    reaches the real host by mistake fails the test instead of registering a service.
    """
    root = tmp_path_factory.mktemp("host")
    bin_dir, calls = root / "bin", root / "calls.log"
    bin_dir.mkdir()
    for name in SERVICE_TOOLS:
        tool = bin_dir / name
        tool.write_text(f'#!/bin/sh\necho "{name} $*" >> "{calls}"\necho "refused: tests never run the real {name}" >&2\nexit 1\n')
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("HOME", str(root / "user"))
    monkeypatch.setenv("AC_HOME", str(root / "user" / ".agent-corp"))
    (root / "user").mkdir()
    yield
    assert not calls.exists(), f"a test ran a real service tool:\n{calls.read_text()}"


GOLDEN = Path(__file__).parent / "golden"


class Runner:
    """Records commands and answers each from a table of ``(argv prefix, returncode, stderr[, stdout])``."""

    def __init__(self, answers=()):
        self.calls: list[list[str]] = []
        self.answers = list(answers)

    def __call__(self, argv):
        self.calls.append(list(argv))
        for prefix, code, err, *out in self.answers:
            if list(argv[: len(prefix)]) == list(prefix):
                return subprocess.CompletedProcess(argv, code, out[0] if out else "", err)
        return subprocess.CompletedProcess(argv, 0, "", "")


@pytest.fixture
def owner_launch() -> Launch:
    """The owner's default office, with fixed paths so service files can be compared to goldens."""
    return launch(Path("/Users/owner/.agent-corp"), repo=Path("/opt/agent-corp"),
                  environ={"PATH": "/usr/bin:/bin", "HOME": "/Users/owner"}, user_home=Path("/Users/owner"))


def make_host(tmp_path: Path, runner: Runner, platform: str = "darwin", which=lambda name: None,
              popen=None, answers=lambda socket: False) -> Host:
    """A host whose home is ``tmp_path`` and whose commands go to ``runner``; nothing real runs.

    Its clock moves only when it sleeps, so waiting takes no real time.
    """
    now = [0.0]

    def sleep(seconds):
        now[0] += seconds

    return Host(platform=platform, user_home=tmp_path, uid=501, run=runner, popen=popen, which=which,
                sleep=sleep, clock=lambda: now[0], answers=lambda socket, timeout=2.0: answers(socket))
