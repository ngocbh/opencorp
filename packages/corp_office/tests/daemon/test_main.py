"""The daemon process: a 0600 socket, one daemon per home, clean shutdown."""

import asyncio
import errno
import importlib
import json
import os
import resource
import signal
import socket
import stat
import subprocess
import sys
import time

import httpx
import pytest

from opencorp.daemon.app import OfficePaths
from opencorp.daemon.main import (AlreadyRunning, OfficeStartError, PidFile, bind_socket, main, make_office_dir,
                                    raise_fd_limit, remove_stale_socket, server_config)
from opencorp.daemon.sockets import bind_tcp
from tests.daemon.conftest import base_files, served, write_repo
from tests.hq.net import free_port


def test_socket_is_0600_even_with_a_loose_umask(short_dir):
    old = os.umask(0o022)
    try:
        sock = bind_socket(short_dir / "s.sock")
    finally:
        os.umask(old)
    sock.close()
    assert stat.S_IMODE(os.stat(short_dir / "s.sock").st_mode) == 0o600


def test_socket_mode_does_not_touch_the_process_umask(short_dir, monkeypatch):
    def no_umask(mask):
        raise AssertionError("umask is process-wide: other threads' files would get it too")

    monkeypatch.setattr(os, "umask", no_umask)
    bind_socket(short_dir / "s.sock").close()
    assert stat.S_IMODE(os.stat(short_dir / "s.sock").st_mode) == 0o600


def test_too_long_socket_path_is_a_clear_error(tmp_path):
    with pytest.raises(OfficeStartError, match="socket path too long"):
        bind_socket(tmp_path / ("x" * 120) / "office.sock")


def test_office_dir_is_created_0700(short_dir):
    make_office_dir(short_dir / "home" / "office")
    assert stat.S_IMODE(os.stat(short_dir / "home" / "office").st_mode) == 0o700


def test_a_loose_office_dir_is_tightened_to_0700(short_dir):
    office = short_dir / "office"
    office.mkdir()
    os.chmod(office, 0o755)
    assert main(["--home", str(short_dir)]) == 1  # no company repo, but the dir is checked first
    assert stat.S_IMODE(os.stat(office).st_mode) == 0o700


@pytest.mark.parametrize("target", ["dir", "missing"])
def test_a_symlinked_office_dir_is_refused(short_dir, capsys, target):
    elsewhere = short_dir / "elsewhere"
    if target == "dir":
        elsewhere.mkdir()
    (short_dir / "office").symlink_to(elsewhere)
    assert main(["--home", str(short_dir)]) == 1
    assert f"{short_dir / 'office'}" in capsys.readouterr().err
    assert not elsewhere.exists() or list(elsewhere.iterdir()) == []


def test_an_office_dir_owned_by_someone_else_is_refused(short_dir, monkeypatch):
    (short_dir / "office").mkdir()
    monkeypatch.setattr(os, "getuid", lambda: os.stat(short_dir).st_uid + 1)
    with pytest.raises(OfficeStartError, match="owned by uid"):
        make_office_dir(short_dir / "office")


def test_a_stale_socket_is_removed(short_dir):
    bind_socket(short_dir / "s.sock").close()  # closing leaves the file, as a crash does
    remove_stale_socket(short_dir / "s.sock")
    assert not (short_dir / "s.sock").exists()
    remove_stale_socket(short_dir / "s.sock")  # nothing there is fine


@pytest.mark.parametrize("kind", ["dir", "file", "symlink"])
def test_something_else_at_the_socket_path_is_refused(short_dir, kind):
    path = short_dir / "s.sock"
    if kind == "dir":
        path.mkdir()
    elif kind == "file":
        path.write_text("mine")
    else:
        bind_socket(short_dir / "real.sock").close()
        path.symlink_to(short_dir / "real.sock")
    with pytest.raises(OfficeStartError, match="not a socket"):
        remove_stale_socket(path)
    assert os.path.lexists(path)


def test_a_directory_at_the_socket_path_exits_1(home, capsys):
    paths = OfficePaths(home)
    paths.socket.mkdir(parents=True)
    assert main(["--home", str(home)]) == 1
    assert f"{paths.socket} exists and is not a socket" in capsys.readouterr().err
    PidFile(paths.pidfile).acquire()  # released


def test_second_pidfile_lock_is_refused(tmp_path):
    first = PidFile(tmp_path / "office.pid")
    first.acquire()
    with pytest.raises(AlreadyRunning) as info:
        PidFile(tmp_path / "office.pid").acquire()
    assert info.value.pid == os.getpid()
    first.release()
    again = PidFile(tmp_path / "office.pid")
    again.acquire()
    again.release()


def test_a_symlinked_pidfile_is_refused_and_its_target_untouched(tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("precious\n")
    (tmp_path / "office.pid").symlink_to(victim)
    with pytest.raises(OfficeStartError, match="symlink"):
        PidFile(tmp_path / "office.pid").acquire()
    assert victim.read_text() == "precious\n"


async def test_served_over_a_real_socket(office, short_dir):
    async with served(office, short_dir / "o.sock") as c:
        r = await c.get("/people")
        assert r.status_code == 200 and [p["handle"] for p in r.json()] == ["minh", "ngocbh"]
        assert stat.S_IMODE(os.stat(short_dir / "o.sock").st_mode) == 0o600


def _daemon(home):
    # The log goes to a file: an unread pipe fills up and blocks the daemon's writes.
    with open(home / "daemon.log", "w") as log:
        return subprocess.Popen([sys.executable, "-m", "opencorp.daemon.main", "--home", str(home)],
                                stdout=log, stderr=subprocess.STDOUT)


def _log(home):
    return (home / "daemon.log").read_text()


def _serving(path):
    try:
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(path)), base_url="http://localhost", timeout=1) as c:
            return c.get("/people").status_code == 200
    except httpx.TransportError:
        return False


def _wait_until_serving(home, proc, timeout=20.0):
    path = OfficePaths(home).socket
    deadline = time.monotonic() + timeout
    while not _serving(path):
        assert proc.poll() is None, f"daemon exited {proc.returncode}:\n{_log(home)}"
        assert time.monotonic() < deadline, f"daemon is not serving on {path}:\n{_log(home)}"
        time.sleep(0.05)


def _stop(home, proc, sig=signal.SIGTERM):
    proc.send_signal(sig)
    try:
        assert proc.wait(timeout=15) == 0, _log(home)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@pytest.fixture
def home(short_dir):
    write_repo(short_dir / "company", base_files())
    # No daemon a test starts binds HQ's TCP port, which is on by default on macOS.
    (short_dir / "office").mkdir(mode=0o700)
    (short_dir / "office" / "hq.json").write_text('{"tcp": false}')
    return short_dir


def test_the_daemon_attaches_hq_after_the_extensions(home):
    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(OfficePaths(home).socket)),
                          base_url="http://localhost") as c:
            assert c.get("/hq").json()["tcp"]["enabled"] is False
            assert c.post("/hq/pair", json={}).json()["path"].startswith("/pair#")
    finally:
        _stop(home, proc)


def test_daemon_serves_turns_away_a_second_and_stops_cleanly(home):
    paths = OfficePaths(home)
    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
        assert stat.S_IMODE(os.stat(paths.socket).st_mode) == 0o600
        second = subprocess.run([sys.executable, "-m", "opencorp.daemon.main", "--home", str(home)],
                                capture_output=True, text=True, timeout=30)
        # Exit 0, so a service manager that restarts on failure doesn't retry the duplicate forever.
        assert second.returncode == 0 and f"office already running (pid {proc.pid})" in second.stderr
    finally:
        _stop(home, proc)
    assert not paths.socket.exists()


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGHUP])
def test_sigint_and_sighup_stop_the_daemon_cleanly(home, sig):
    paths = OfficePaths(home)
    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
    finally:
        _stop(home, proc, sig)
    assert not paths.socket.exists()
    PidFile(paths.pidfile).acquire()  # released


def test_stale_socket_file_is_replaced(home):
    paths = OfficePaths(home)
    paths.office.mkdir(parents=True, exist_ok=True)
    bind_socket(paths.socket).close()  # left by a crash
    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
    finally:
        _stop(home, proc)


def test_missing_company_repo_exits_1(short_dir, capsys):
    assert main(["--home", str(short_dir)]) == 1
    assert f"no company repo at {short_dir / 'company'}" in capsys.readouterr().err


def test_failing_extension_stops_start_up(home, tmp_path, monkeypatch, capsys):
    pkg = tmp_path / "extpath" / "badext"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "boom.py").write_text("def register(office):\n    raise RuntimeError('bad config')\n")
    monkeypatch.syspath_prepend(str(tmp_path / "extpath"))
    assert main(["--home", str(home)], extensions="badext") == 1
    assert "extension boom: bad config" in capsys.readouterr().err
    assert not OfficePaths(home).socket.exists()


def test_failing_start_hook_exits_1_and_cleans_up(home, tmp_path, monkeypatch, capsys):
    pkg = tmp_path / "extpath" / "badstart"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "hook.py").write_text(
        "def register(office):\n"
        "    def fail():\n"
        "        raise RuntimeError('no model key')\n"
        "    office.on_start.append(fail)\n")
    monkeypatch.syspath_prepend(str(tmp_path / "extpath"))
    assert main(["--home", str(home)], extensions="badstart") == 1
    assert "the office app failed to start" in capsys.readouterr().err
    assert not OfficePaths(home).socket.exists()
    PidFile(OfficePaths(home).pidfile).acquire()  # released


def test_failing_start_hook_stops_what_earlier_hooks_started(home, tmp_path, monkeypatch, capsys):
    pkg = tmp_path / "extpath" / "partialstart"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "a.py").write_text(
        "import threading\n"
        "stop = threading.Event()\n"
        "thread = None\n"
        "def register(office):\n"
        "    def start():\n"
        "        global thread\n"
        "        thread = threading.Thread(target=stop.wait, name='checker')\n"
        "        thread.start()\n"
        "    office.on_start.append(start)\n"
        "    office.on_stop.append(stop.set)\n")
    (pkg / "b.py").write_text(
        "def register(office):\n"
        "    def fail():\n"
        "        raise RuntimeError('no model key')\n"
        "    office.on_start.append(fail)\n")
    monkeypatch.syspath_prepend(str(tmp_path / "extpath"))
    try:
        assert main(["--home", str(home)], extensions="partialstart") == 1
        a = importlib.import_module("partialstart.a")
        assert a.stop.is_set()
        a.thread.join(5)
        assert not a.thread.is_alive()
    finally:
        importlib.import_module("partialstart.a").stop.set()  # never leave the thread running


def test_a_failing_stop_hook_does_not_stop_the_others(home, tmp_path, monkeypatch, capsys):
    pkg = tmp_path / "extpath" / "stopfail"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "a.py").write_text(
        "import threading\n"
        "stop = threading.Event()\n"
        "thread = None\n"
        "def register(office):\n"
        "    def start():\n"
        "        global thread\n"
        "        thread = threading.Thread(target=stop.wait, name='checker')\n"
        "        thread.start()\n"
        "    office.on_start.append(start)\n"
        "    office.on_stop.append(stop.set)\n")
    (pkg / "b.py").write_text(
        "def register(office):\n"
        "    def fail():\n"
        "        raise RuntimeError('no model key')\n"
        "    office.on_start.append(fail)\n")
    (pkg / "c.py").write_text(
        "def register(office):\n"
        "    def fail():\n"
        "        raise RuntimeError('c never started')\n"
        "    office.on_stop.append(fail)\n")
    monkeypatch.syspath_prepend(str(tmp_path / "extpath"))
    try:
        assert main(["--home", str(home)], extensions="stopfail") == 1
        a = importlib.import_module("stopfail.a")
        assert a.stop.is_set()
        a.thread.join(5)
        assert not a.thread.is_alive()
        err = capsys.readouterr().err
        # uvicorn logs the start-up error: B's, not C's stop failure raised while cleaning up.
        failure = err[err.index("Traceback"):err.index("Application startup failed")].rsplit("ERROR:", 1)[0]
        assert failure.rstrip().endswith("RuntimeError: no model key") and "c never started" not in failure
    finally:
        importlib.import_module("stopfail.a").stop.set()  # never leave the thread running


async def test_build_office_runs_the_chat_harness(home, monkeypatch):
    from opencorp.chat.connections import Connections
    from opencorp.chat.harness import Harness
    from opencorp.chat.hire import Hiring
    from opencorp.chat.logins import Logins
    from opencorp.chat.models import ModelCache
    from opencorp.company.snapshot import CompanySnapshots
    from opencorp.daemon.main import build_office
    from opencorp.profile import GitProfileStore

    started = []
    monkeypatch.setattr(Harness, "restore", lambda self: started.append("restore"))
    monkeypatch.setattr(ModelCache, "warm", lambda self: started.append(("warm", self)))
    monkeypatch.setattr(Logins, "close_all", lambda self: started.append(("close logins", self)))
    paths = OfficePaths(home)
    office = build_office(paths)
    try:
        assert isinstance(office.workers, Harness) and office.extras["harness"] is office.workers
        assert isinstance(office.extras["hiring"], Hiring) and office.extras["hiring"].git is office.git
        assert isinstance(office.profile_store("minh"), GitProfileStore)
        conns, cache = office.extras["connections"], office.extras["models"]
        assert isinstance(conns, Connections) and conns.office == paths.office
        assert office.workers.connections is conns
        assert isinstance(cache, ModelCache) and cache.connections is conns
        logins = office.extras["logins"]
        assert isinstance(logins, Logins) and logins.connections is conns and logins.models is cache
        assert isinstance(office.extras["company"], CompanySnapshots) and office.extras["company"].git is office.git
        assert started == []
        await office.start()  # restores live sessions, then lists each connection's models
        assert started == ["restore", ("warm", cache)]
        await office.stop()  # cancels the sign-ins still open
        assert started[-1] == ("close logins", logins)
    finally:
        office.store.close()


def test_the_office_runs_codex_sessions_on_the_harness_hooks(home):
    from opencorp.daemon.main import build_office
    from opencorp.harness.sessions import CodexSessions

    office = build_office(OfficePaths(home))
    try:
        harness = office.extras["harness"]
        assert isinstance(harness.codex, CodexSessions) and harness.codex.hooks is harness.hooks
    finally:
        office.workers.close_all()
        office.store.close()


async def test_a_bad_provider_file_fails_restored_sessions_but_the_office_starts(home):
    from opencorp.daemon.main import build_office
    from opencorp.protocol import now
    from opencorp.protocol.models import Session
    from opencorp.store import new_id

    paths = OfficePaths(home)
    make_office_dir(paths.office)
    (paths.office / "provider.json").write_text("{}")
    os.chmod(paths.office / "provider.json", 0o644)  # not private: load_provider refuses it
    workspace = home / "ws"
    workspace.mkdir()
    office = build_office(paths)
    try:
        t = now()
        session = office.store.create_session(Session(
            id=new_id(), person="minh", harness="composer", office="here", cwd=str(workspace),
            repo_commit=office.git.head(), status="idle", kind="main", created_at=t, updated_at=t))
        office.store.add_session_run(session.id, new_id())
        await office.start()
        assert office.store.get_session(session.id).status == "failed"
        await office.stop()
    finally:
        office.store.close()


def test_the_tcp_socket_reuses_addresses_but_never_shares_the_port():
    sock = bind_tcp(0)
    try:
        assert sock.getsockname()[0] == "127.0.0.1"
        assert sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) != 0
        assert sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT) == 0
    finally:
        sock.close()


def _left_in_time_wait() -> int:
    """A port on 127.0.0.1 whose listener is closed and whose one connection the server side closed first, so that
    connection sits in TIME_WAIT on the server's port, as after a restart with a browser stream open."""
    listener = bind_tcp(0)
    port = listener.getsockname()[1]
    listener.setblocking(True)
    client = socket.create_connection(("127.0.0.1", port))
    conn, _ = listener.accept()
    conn.close()
    assert client.recv(1) == b""  # the client reads to EOF, then closes: a FIN, not a RST that clears TIME_WAIT
    client.close()
    listener.close()
    return port


def _blocked_without_reuse(port: int) -> bool:
    """Whether a socket without SO_REUSEADDR can't bind ``port`` right now."""
    with socket.socket() as plain:
        try:
            plain.bind(("127.0.0.1", port))
        except OSError as exc:
            assert exc.errno == errno.EADDRINUSE
            return True
    return False


def test_the_tcp_socket_binds_a_port_left_in_time_wait():
    port = _left_in_time_wait()
    if not _blocked_without_reuse(port):
        pytest.skip("this kernel lets a plain socket bind past TIME_WAIT, so there's nothing to show")
    bind_tcp(port).close()


def test_the_office_server_has_websockets_off():
    assert server_config(lambda *a: None).ws == "none"


def test_the_soft_fd_limit_is_raised_to_4096_within_the_hard_one(monkeypatch):
    set_to = []
    monkeypatch.setattr(resource, "getrlimit", lambda which: (256, 10240))
    monkeypatch.setattr(resource, "setrlimit", lambda which, limits: set_to.append(limits))
    raise_fd_limit()
    assert set_to == [(4096, 10240)]
    monkeypatch.setattr(resource, "getrlimit", lambda which: (256, 1024))
    raise_fd_limit()
    assert set_to[-1] == (1024, 1024)


async def test_a_websocket_upgrade_is_served_as_plain_http_on_the_office_socket(office, short_dir):
    async with served(office, short_dir / "o.sock"):
        reader, writer = await asyncio.open_unix_connection(str(short_dir / "o.sock"))
        writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
                     b"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        status = await asyncio.wait_for(reader.readline(), 5)
        writer.close()
    # With ws="none" uvicorn ignores the upgrade and serves /health. Without it, the upgrade reaches Starlette,
    # which has no WebSocket route, and uvicorn answers 403, so this pins the setting rather than only "not 101".
    assert status.startswith(b"HTTP/1.1 200")


def test_a_restart_with_an_open_web_stream_rebinds_the_port_at_once(home):
    port = free_port()
    (home / "office" / "hq.json").write_text(json.dumps({"tcp": True, "port": port}))
    paths = OfficePaths(home)

    def sock_client():
        return httpx.Client(transport=httpx.HTTPTransport(uds=str(paths.socket)), base_url="http://localhost")

    def listening(within):
        deadline = time.monotonic() + within
        while time.monotonic() < deadline:
            with sock_client() as c:
                if c.get("/hq").json()["tcp"]["listening"]:
                    return True
            time.sleep(0.05)
        return False

    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
        assert listening(3)
        with sock_client() as c:
            code = c.post("/hq/pair", json={}).json()["path"].split("#")[1]
        origin = f"http://127.0.0.1:{port}"
        with httpx.Client(base_url=origin, headers={"origin": origin}, trust_env=False) as web:
            assert web.post("/api/pair", json={"code": code}).status_code == 200
            with web.stream("GET", "/api/events") as r:
                lines = r.iter_lines()
                assert next(lines) == ": connected"
                _stop(home, proc)  # SIGTERM with the stream open: the server side closes first, into TIME_WAIT
                for _ in lines:  # read to EOF, so closing sends a FIN, not a RST that clears TIME_WAIT
                    pass
    finally:
        if proc.poll() is None:
            _stop(home, proc)
    if not _blocked_without_reuse(port):
        pytest.skip("this kernel lets a plain socket bind past TIME_WAIT, so there's nothing to show")
    proc = _daemon(home)
    try:
        _wait_until_serving(home, proc)
        assert listening(1.5)  # well before the first retry at 5 s: the first bind worked
    finally:
        _stop(home, proc)
