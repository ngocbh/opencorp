"""The daemon process: a 0600 socket, one daemon per home, clean shutdown."""

import importlib
import os
import signal
import stat
import subprocess
import sys
import time

import httpx
import pytest

from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import AlreadyRunning, OfficeStartError, PidFile, bind_socket, main, make_office_dir
from tests.daemon.conftest import base_files, served, write_repo


def test_socket_is_0600_even_with_a_loose_umask(short_dir):
    old = os.umask(0o022)
    try:
        sock = bind_socket(short_dir / "s.sock")
    finally:
        os.umask(old)
    sock.close()
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


async def test_served_over_a_real_socket(office, short_dir):
    async with served(office, short_dir / "o.sock") as c:
        r = await c.get("/people")
        assert r.status_code == 200 and [p["id"] for p in r.json()] == ["minh", "ngocbh"]
        assert stat.S_IMODE(os.stat(short_dir / "o.sock").st_mode) == 0o600


def _daemon(home):
    # The log goes to a file: an unread pipe fills up and blocks the daemon's writes.
    with open(home / "daemon.log", "w") as log:
        return subprocess.Popen([sys.executable, "-m", "agent_corp.daemon.main", "--home", str(home)],
                                stdout=log, stderr=subprocess.STDOUT)


def _log(home):
    return (home / "daemon.log").read_text()


def _is_socket(path):
    try:
        return stat.S_ISSOCK(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False


def _wait_for_socket(home, proc, timeout=20.0):
    path = OfficePaths(home).socket
    deadline = time.monotonic() + timeout
    while not _is_socket(path):
        assert proc.poll() is None, f"daemon exited {proc.returncode}:\n{_log(home)}"
        assert time.monotonic() < deadline, f"daemon did not create its socket:\n{_log(home)}"
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
    return short_dir


def test_daemon_serves_refuses_a_second_and_stops_cleanly(home):
    paths = OfficePaths(home)
    proc = _daemon(home)
    try:
        _wait_for_socket(home, proc)
        assert stat.S_IMODE(os.stat(paths.socket).st_mode) == 0o600
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(paths.socket)), base_url="http://localhost") as c:
            assert c.get("/people").status_code == 200
        second = subprocess.run([sys.executable, "-m", "agent_corp.daemon.main", "--home", str(home)],
                                capture_output=True, text=True, timeout=30)
        assert second.returncode == 1 and f"office already running (pid {proc.pid})" in second.stderr
    finally:
        _stop(home, proc)
    assert not paths.socket.exists()


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGHUP])
def test_sigint_and_sighup_stop_the_daemon_cleanly(home, sig):
    paths = OfficePaths(home)
    proc = _daemon(home)
    try:
        _wait_for_socket(home, proc)
    finally:
        _stop(home, proc, sig)
    assert not paths.socket.exists()
    PidFile(paths.pidfile).acquire()  # released


def test_stale_socket_file_is_replaced(home):
    paths = OfficePaths(home)
    paths.office.mkdir(parents=True)
    paths.socket.write_text("left by a crash")
    proc = _daemon(home)
    try:
        _wait_for_socket(home, proc)
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
