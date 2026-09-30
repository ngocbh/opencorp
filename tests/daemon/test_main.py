"""The daemon process: a 0600 socket, one daemon per home, clean shutdown."""

import os
import signal
import stat
import subprocess
import sys
import time

import httpx
import pytest

from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import AlreadyRunning, OfficeStartError, PidFile, bind_socket, main
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
    return subprocess.Popen([sys.executable, "-m", "agent_corp.daemon.main", "--home", str(home)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _wait_for(path, proc, timeout=20.0):
    deadline = time.monotonic() + timeout
    while not path.exists():
        assert proc.poll() is None, proc.communicate()
        assert time.monotonic() < deadline, "daemon did not create its socket"
        time.sleep(0.05)


@pytest.fixture
def home(short_dir):
    write_repo(short_dir / "company", base_files())
    return short_dir


def test_daemon_serves_refuses_a_second_and_stops_cleanly(home):
    paths = OfficePaths(home)
    proc = _daemon(home)
    try:
        _wait_for(paths.socket, proc)
        assert stat.S_IMODE(os.stat(paths.socket).st_mode) == 0o600
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(paths.socket)), base_url="http://localhost") as c:
            assert c.get("/people").status_code == 200
        second = subprocess.run([sys.executable, "-m", "agent_corp.daemon.main", "--home", str(home)],
                                capture_output=True, text=True, timeout=30)
        assert second.returncode == 1 and f"office already running (pid {proc.pid})" in second.stderr
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=15) == 0
        assert not paths.socket.exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_stale_socket_file_is_replaced(home):
    paths = OfficePaths(home)
    paths.office.mkdir(parents=True)
    paths.socket.write_text("left by a crash")
    proc = _daemon(home)
    try:
        deadline = time.monotonic() + 20
        while True:
            assert proc.poll() is None, proc.communicate()
            if stat.S_ISSOCK(os.stat(paths.socket).st_mode):
                break
            assert time.monotonic() < deadline
            time.sleep(0.05)
    finally:
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=15) == 0


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
