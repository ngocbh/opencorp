"""The office daemon entry point: ``python -m agent_corp.daemon.main --home ~/.agent-corp``."""

import argparse
import asyncio
import contextlib
import errno
import fcntl
import os
import signal
import socket
import stat
import sys
import threading
from pathlib import Path

import uvicorn

from agent_corp.chat.harness import Harness
from agent_corp.chat.hire import Hiring
from agent_corp.chat.provider import load_provider
from agent_corp.company.git import CompanyGit
from agent_corp.daemon.app import Office, OfficePaths, create_app
from agent_corp.daemon.bus import Bus
from agent_corp.extensions import ExtensionError, load_extensions
from agent_corp.perm.monitor import Monitor
from agent_corp.profile import GitProfileStore
from agent_corp.secrets import SecretStore
from agent_corp.store import Store
from agent_corp.worker import reap

# sockaddr_un.sun_path, including the terminating NUL.
SUN_PATH_MAX = 104 if sys.platform == "darwin" else 108


class OfficeStartError(Exception):
    """The daemon can't start; the message says why."""


class AlreadyRunning(OfficeStartError):
    """Another daemon holds this home's pidfile."""

    def __init__(self, pid: int | None) -> None:
        super().__init__(f"office already running (pid {pid})")
        self.pid = pid


class PidFile:
    """An exclusive ``flock`` on the pidfile, held for the daemon's lifetime."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None

    def acquire(self) -> None:
        """Take the lock and write our pid; ``AlreadyRunning`` if another process holds it.

        The pidfile is opened without following a symlink, so it can't truncate another file.
        """
        try:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise OfficeStartError(f"the pidfile {self.path} is a symlink") from exc
            raise OfficeStartError(f"can't open the pidfile {self.path}: {exc}") from exc
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            text = os.read(fd, 32).decode(errors="replace").strip()
            os.close(fd)
            raise AlreadyRunning(int(text) if text.isdecimal() else None) from None
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        self._fd = fd

    def release(self) -> None:
        """Clear the pid and drop the lock."""
        if self._fd is not None:
            os.ftruncate(self._fd, 0)
            os.close(self._fd)
            self._fd = None


def make_office_dir(path: Path) -> None:
    """Create ``path`` if needed and make it 0700; ``OfficeStartError`` if it isn't ours to use.

    The office dir holds the socket, pidfile, store, and secrets, so a symlink (which could
    point anywhere) or a directory owned by another user is refused.
    """
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        raise OfficeStartError(f"can't create the office directory {path}: {exc}") from exc
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise OfficeStartError(f"the office directory {path} is a symlink")
    if not stat.S_ISDIR(st.st_mode):
        raise OfficeStartError(f"the office directory {path} is not a directory")
    if st.st_uid != os.getuid():
        raise OfficeStartError(f"the office directory {path} is owned by uid {st.st_uid}, not {os.getuid()}")
    os.chmod(path, 0o700)


def check_socket_path(path: Path) -> None:
    """Raise ``OfficeStartError`` if ``path`` is too long for a unix socket."""
    size = len(os.fsencode(path))
    if size >= SUN_PATH_MAX:
        raise OfficeStartError(f"socket path too long ({size} bytes, limit {SUN_PATH_MAX - 1}): {path}")


def remove_stale_socket(path: Path) -> None:
    """Unlink the socket a crashed daemon left at ``path``; ``OfficeStartError`` if something else is there."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise OfficeStartError(f"{path} exists and is not a socket")
    path.unlink(missing_ok=True)


def bind_socket(path: Path) -> socket.socket:
    """A listening unix socket at ``path`` with mode 0600."""
    check_socket_path(path)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # uvicorn's --uds chmods the socket to 0666. Until listen() nobody can connect, so
    # chmod between bind and listen leaves no window, without a process-wide umask change.
    try:
        sock.bind(str(path))
        os.chmod(path, 0o600)
        sock.listen(128)
    except OSError as exc:
        sock.close()
        raise OfficeStartError(f"can't listen on {path}: {exc}") from exc
    return sock


class OfficeServer(uvicorn.Server):
    """uvicorn, stopped by SIGINT/SIGTERM/SIGHUP without re-raising the signal afterwards."""

    def __init__(self, config: uvicorn.Config, office: Office) -> None:
        super().__init__(config)
        self.office = office

    @contextlib.contextmanager
    def capture_signals(self):
        # uvicorn's own version re-raises the signal after shutdown, which kills the process
        # before the socket file and pidfile are cleaned up.
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        loop = asyncio.get_running_loop()
        sigs = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
        for sig in sigs:
            loop.add_signal_handler(sig, self.handle_exit, sig, None)
        try:
            yield
        finally:
            for sig in sigs:
                loop.remove_signal_handler(sig)

    def handle_exit(self, sig: int, frame: object) -> None:
        # SSE responses never finish on their own; uvicorn waits for open responses.
        self.office.bus.close()
        super().handle_exit(sig, frame)


def build_office(paths: OfficePaths) -> Office:
    """Open the store and the company clone and assemble the office, with the composer harness as its workers.

    Workers left by an earlier office are killed first; the harness resumes their sessions on start.
    ``POST /people`` gets one ``Hiring`` for the office's life.
    """
    store = Store(paths.store)
    git = CompanyGit(paths.company, paths.worktrees)
    reap(store)
    office = Office(paths=paths, store=store, git=git, bus=Bus(), profile_store=lambda handle: GitProfileStore(git, handle))
    monitor = Monitor(paths.company, store, SecretStore(paths.secrets))
    harness = Harness(office, monitor, provider=lambda: load_provider(paths.office / "provider.json"))
    office.workers = harness
    office.extras["harness"] = harness
    office.extras["hiring"] = Hiring(git)
    office.on_start.append(lambda: asyncio.to_thread(harness.restore))
    return office


async def run(paths: OfficePaths, *, extensions: str = "agent_corp.extensions") -> None:
    """Run the daemon until SIGINT, SIGTERM, or SIGHUP."""
    make_office_dir(paths.office)
    pidfile = PidFile(paths.pidfile)
    pidfile.acquire()
    try:
        if not (paths.company / ".git").exists():
            raise OfficeStartError(f"no company repo at {paths.company}")
        check_socket_path(paths.socket)
        office = build_office(paths)
        try:
            try:
                load_extensions(office, extensions)
            except ExtensionError as exc:
                raise OfficeStartError(str(exc)) from exc
            remove_stale_socket(paths.socket)  # we hold the lock, so no live daemon owns it
            sock = bind_socket(paths.socket)
            server = OfficeServer(uvicorn.Config(create_app(office), lifespan="on", log_level="info",
                                                 timeout_graceful_shutdown=5), office)
            try:
                await server.serve(sockets=[sock])
            except SystemExit as exc:
                # uvicorn exits this way when the app's lifespan startup fails.
                raise OfficeStartError("the office app failed to start (see the log above)") from exc
            finally:
                sock.close()
                paths.socket.unlink(missing_ok=True)
        finally:
            office.store.close()
    finally:
        pidfile.release()


def main(argv: list[str] | None = None, *, extensions: str = "agent_corp.extensions") -> int:
    """Parse arguments and run the daemon; returns the exit code (0 when this home's office is already running)."""
    parser = argparse.ArgumentParser(prog="agent-corp-office")
    parser.add_argument("--home", default="~/.agent-corp", help="agent-corp home directory")
    args = parser.parse_args(argv)
    paths = OfficePaths(Path(args.home).expanduser().resolve())
    try:
        asyncio.run(run(paths, extensions=extensions))
    except AlreadyRunning as exc:
        # Not a failure: services restart the office only on failure, so a duplicate start
        # must not look like a crash.
        print(f"agent-corp office: {exc}", file=sys.stderr)
        return 0
    except OfficeStartError as exc:
        print(f"agent-corp office: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
