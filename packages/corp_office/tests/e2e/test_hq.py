"""HQ on a real office: `opencorp pair` and password sign-in over TCP, hq.sock with TCP off and the SSH forwards
`opencorp pair` prints, the company and the event stream, signing out, and what `opencorp doctor` says about HQ."""

import re

import httpx
import pytest

from opencorp.install.doctor import Check, report

from .fixtures.office import RunningOffice, wait_for

pytestmark = pytest.mark.timeout(240)
URL = re.compile(r"http://127\.0\.0\.1:(\d+)/pair#([A-Za-z0-9_-]+)")
CODE = re.compile(r"/pair#([A-Za-z0-9_-]+)")
SSH_VARS = ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY")
LOCAL_PORT = 49381
"""The local port `opencorp pair` prints for an hq.sock forward."""


@pytest.fixture
def local(monkeypatch):
    """Run the CLI as from a local terminal: the tests may run over SSH, and the CLI inherits that."""
    for name in SSH_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def web_office(cli_ready, short_dir, fake_llm):
    """A running office with HQ's TCP listener on a free port."""
    running = RunningOffice(short_dir, fake_llm, hq={"tcp": True, "port": 0})
    try:
        running.onboard()
        yield running
    finally:
        running.stop()


@pytest.fixture
def sock_office(cli_ready, short_dir, fake_llm):
    """A running office with HQ's TCP listener off: hq.sock only."""
    running = RunningOffice(short_dir, fake_llm, hq={"tcp": False})
    try:
        running.onboard()
        yield running
    finally:
        running.stop()


def wait_listening(office: RunningOffice) -> dict:
    """HQ's status once its TCP listener is up."""
    return wait_for(lambda: (s := office.hq_status())["tcp"]["listening"] and s, "HQ's TCP listener", timeout=10)


def web(origin: str) -> httpx.Client:
    """A browser stand-in for HQ at ``origin``: same-origin requests, cookies kept, no proxy."""
    return httpx.Client(base_url=origin, headers={"origin": origin}, trust_env=False, timeout=10)


def over_hq_sock(office: RunningOffice, host: str) -> httpx.Client:
    """A browser stand-in reaching hq.sock through an SSH forward whose local end makes the Host header ``host``."""
    return httpx.Client(transport=httpx.HTTPTransport(uds=str(office.paths.office / "hq.sock")),
                        base_url=f"http://{host}", headers={"origin": f"http://{host}"}, timeout=10)


def doctor_line(status: str, name: str, detail: str) -> str:
    """One line of `opencorp doctor`'s report."""
    return report([Check(name, status, detail)])


def test_pair_sign_in_read_the_company_and_sign_out(web_office, tmp_path, local):
    status = wait_listening(web_office)
    out = web_office.opencorp("pair", "--no-open", cwd=tmp_path).stdout
    port, code = URL.search(out).groups()
    assert status["url"] == f"http://127.0.0.1:{port}/"
    origin = f"http://127.0.0.1:{port}"
    with web(origin) as browser:
        assert browser.get("/api/health").json()["ok"] is True
        assert browser.get("/api/company").status_code == 401
        session = browser.post("/api/pair", json={"code": code, "label": "e2e"}).json()
        assert (session["person"], session["via"], session["issued_by"]) == ("ngocbh", "pair", "ngocbh")
        company = browser.get("/api/company").json()
        assert company["company"]["name"] == "Acme" and {"ngocbh", "minh"} <= {p["handle"] for p in company["people"]}
        assert browser.get("/api/whoami").json()["person"] == "ngocbh"
        with browser.stream("GET", "/api/events") as r:
            assert next(r.iter_lines()) == ": connected"
        listed = web_office.opencorp("devices", "list", cwd=tmp_path).stdout
        assert "Browsers (this office):" in listed and session["id"] in listed and "(e2e)" in listed
        web_office.opencorp("devices", "remove-browser", session["id"], cwd=tmp_path)
        assert browser.get("/api/whoami").status_code == 401
        assert browser.post("/api/pair", json={"code": code}).status_code == 400  # single use
    doctor = web_office.opencorp("doctor", cwd=tmp_path, check=False).stdout
    assert doctor_line("ok", "hq", f"web app at {origin}/, and on {status['socket']}") in doctor, doctor


PASSWORD = "correct horse battery"


def test_password_sign_in_the_one_refusal_and_the_lock(web_office, tmp_path, local):
    origin = wait_listening(web_office)["url"].rstrip("/")
    web_office.http.put("/people/ngocbh/password", json={"password": PASSWORD}).raise_for_status()
    with web(origin) as browser:
        assert browser.get("/api/company").status_code == 401
        signed = browser.post("/api/login", json={"handle": "ngocbh", "password": PASSWORD, "label": "e2e"})
        assert signed.status_code == 200, signed.text
        assert (signed.json()["person"], signed.json()["via"]) == ("ngocbh", "login")
        assert f"opencorp_hq_{origin.rpartition(':')[2]}" in browser.cookies
        company = browser.get("/api/company").json()
        assert company["company"]["name"] == "Acme"
        assert not any(p.get("password_hash") for p in company["people"])
        assert browser.get("/api/whoami").json()["person"] == "ngocbh"

    with web(origin) as stranger:
        def sign_in(handle: str, password: str) -> httpx.Response:
            return stranger.post("/api/login", json={"handle": handle, "password": password})

        # One answer for an unknown handle, an agent and a wrong password, so none of them tells which it was.
        refusals = [sign_in("nobody", PASSWORD), sign_in("minh", PASSWORD), sign_in("ngocbh", "wrong horse battery")]
        assert [(r.status_code, r.json()) for r in refusals] == [
            (401, {"error": "bad_credentials", "message": "wrong handle or password"})] * 3
        for _ in range(4):  # five failures for (127.0.0.1, ngocbh) lock it
            assert sign_in("ngocbh", "wrong horse battery").status_code == 401
        locked = sign_in("ngocbh", PASSWORD)  # even the right password waits now
        assert (locked.status_code, locked.json()["error"]) == (429, "too_many_attempts")
        assert 0 < int(locked.headers["retry-after"]) <= 60
        assert "opencorp pair" in locked.json()["message"]
        # The lock is per handle: another handle's refusals still say only "wrong handle or password".
        assert sign_in("nobody", PASSWORD).status_code == 401

        # Pairing never goes through the password check, so the lock doesn't keep the owner out.
        code = URL.search(web_office.opencorp("pair", "--no-open", cwd=tmp_path).stdout).group(2)
        assert stranger.post("/api/pair", json={"code": code}).status_code == 200
        assert stranger.get("/api/company").status_code == 200
    assert PASSWORD not in (web_office.paths.office / "office.log").read_text()


def test_a_throttled_sign_in_reaches_the_office_log(web_office, local):
    """The positive side of the "not in office.log" checks above: HQ's sign-in lines do reach the log."""
    origin = wait_listening(web_office)["url"].rstrip("/")
    with web(origin) as stranger:
        for _ in range(5):
            assert stranger.post("/api/login", json={"handle": "ngocbh", "password": PASSWORD}).status_code == 401
        assert stranger.post("/api/login", json={"handle": "ngocbh", "password": PASSWORD}).status_code == 429
    log = (web_office.paths.office / "office.log").read_text()
    assert "sign-in for @ngocbh from 127.0.0.1 throttled" in log
    assert PASSWORD not in log


def test_over_ssh_pair_prints_the_same_port_forward_and_the_hq_sock_one(web_office, tmp_path, monkeypatch):
    status = wait_listening(web_office)
    port, hq_sock = status["tcp"]["port"], status["socket"]
    monkeypatch.setenv("SSH_CONNECTION", "192.0.2.1 50000 192.0.2.2 22")
    out = web_office.opencorp("pair", "--no-open", cwd=tmp_path).stdout
    assert f"ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{port}:127.0.0.1:{port} " in out
    assert f"ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{LOCAL_PORT}:{hq_sock} " in out
    assert f"http://127.0.0.1:{port}/pair#" in out
    code = re.search(rf"http://127\.0\.0\.1:{LOCAL_PORT}/pair#([A-Za-z0-9_-]+)", out).group(1)
    # The hq.sock alternative works with the printed local port, while TCP listens too.
    with over_hq_sock(web_office, f"127.0.0.1:{LOCAL_PORT}") as browser:
        assert browser.post("/api/pair", json={"code": code}).status_code == 200
        assert browser.get("/api/company").json()["company"]["name"] == "Acme"


def test_with_tcp_off_pair_prints_the_socket_forward_and_hq_sock_serves_any_local_port(sock_office, tmp_path, local):
    out = sock_office.opencorp("pair", "--no-open", cwd=tmp_path).stdout
    hq_sock = sock_office.paths.office / "hq.sock"
    assert f"ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{LOCAL_PORT}:{hq_sock} " in out
    assert f"http://127.0.0.1:{LOCAL_PORT}/pair#" in out and '"tcp": true' in out
    code = CODE.search(out).group(1)
    with over_hq_sock(sock_office, "127.0.0.1:61234") as browser:  # any local port: hq.sock takes them all
        assert browser.post("/api/pair", json={"code": code}).status_code == 200
        assert browser.get("/api/company").json()["company"]["name"] == "Acme"
        assert browser.get("/api/company", headers={"host": "misha.example:61234"}).status_code == 403
    assert oct(hq_sock.stat().st_mode & 0o777) == "0o600"
    doctor = sock_office.opencorp("doctor", cwd=tmp_path, check=False).stdout
    assert doctor_line("ok", "hq", f"on {hq_sock} only (the web port is off); `opencorp pair` prints the SSH "
                                   "forward") in doctor, doctor


def test_the_code_never_reaches_a_process_list_or_the_log(sock_office, tmp_path):
    """The code is in no running process's arguments, the daemon's and its children's included (the CLI that printed
    it has exited by now), and not in the office's log."""
    import psutil

    out = sock_office.opencorp("pair", "--no-open", cwd=tmp_path).stdout
    code = CODE.search(out).group(1)
    assert not any(code in " ".join(p.info["cmdline"] or []) for p in psutil.process_iter(["cmdline"]))
    assert code not in (sock_office.paths.office / "office.log").read_text()


def test_doctor_names_what_keeps_hq_off_hq_sock(cli_ready, short_dir, fake_llm, tmp_path):
    running = None
    try:
        running = RunningOffice(short_dir, fake_llm, hq={"tcp": False})
        hq_sock = running.paths.office / "hq.sock"
        hq_sock.write_text("not a socket\n")
        running.onboard()
        assert running.hq_status()["socket_error"] == f"{hq_sock} exists and is not a socket"
        doctor = running.opencorp("doctor", cwd=tmp_path, check=False).stdout
        assert doctor_line("warn", "hq", f"not listening on {hq_sock}: {hq_sock} exists and is not a socket; run "
                                         "`opencorp restart` once that's fixed") in doctor, doctor
    finally:
        if running is not None:
            running.stop()
