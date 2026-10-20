"""Signing a browser in with a handle and password: the same session and cookie as pairing."""

import asyncio
import logging
import re
import threading

import httpx
import pytest
import yaml

from opencorp.auth.passwords import check_password, hash_password
from opencorp.hq import login as login_module
from opencorp.hq.api import create_hq_app
from opencorp.hq.login import DUMMY_HASH, MAX_KEYS, Busy, Throttle
from tests.company.conftest import _git
from tests.hq.conftest import ORIGIN, PORT, hq_client

PASSWORD = "correct horse battery"


def set_password(company, handle, password_hash):
    path = company / "people" / handle / "person.yaml"
    data = {**yaml.safe_load(path.read_text()), "password_hash": password_hash}
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    _git(company, "commit", "-qam", f"password for {handle}")


@pytest.fixture
def with_password(company):
    """The CEO, @ngocbh, has ``PASSWORD``."""
    set_password(company, "ngocbh", hash_password(PASSWORD))


async def login(web, handle="ngocbh", password=PASSWORD, **extra):
    return await web.post("/api/login", json={"handle": handle, "password": password, **extra})


async def test_the_right_password_signs_in(web, with_password):
    r = await login(web, label="Firefox on Linux")
    body = r.json()
    assert r.status_code == 200 and body["person"] == "ngocbh" and body["via"] == "login"
    assert body["issued_by"] == "ngocbh" and body["label"] == "Firefox on Linux" and "secret_sha256" not in body
    assert (await web.get("/api/whoami")).json() == {"person": "ngocbh", "device": body["name"]}


async def test_the_cookie_is_the_one_pairing_sets(web, with_password):
    cookie = (await login(web)).headers["set-cookie"]
    assert cookie.startswith(f"opencorp_hq_{PORT}=") and "HttpOnly" in cookie and "SameSite=Strict" in cookie
    assert "Path=/" in cookie and "Max-Age=2592000" in cookie and "Secure" not in cookie


async def test_without_a_session_the_401_names_both_ways_to_sign_in(web):
    message = (await web.get("/api/whoami")).json()["message"]
    assert "handle and password" in message and "`opencorp pair`" in message


async def test_a_wrong_password_is_401_bad_credentials(web, with_password):
    r = await login(web, password="not the password")
    assert r.status_code == 401 and r.json() == {"error": "bad_credentials", "message": "wrong handle or password"}
    assert "set-cookie" not in r.headers and (await web.get("/api/whoami")).status_code == 401


async def test_without_an_origin_the_guard_refuses(office, hq, with_password):
    async with hq_client(office, hq) as c:
        r = await login(c)
    assert r.status_code == 403 and r.json()["error"] == "origin_not_allowed"


async def test_only_post_api_login_skips_the_session_check(web, with_password):
    assert (await web.get("/api/login")).status_code == 401
    for path in ("/api/login/", "/api/login/x", "/api/loginx"):
        r = await web.post(path, json={"handle": "ngocbh", "password": PASSWORD})
        assert r.status_code == 401 and r.json()["error"] == "sign_in_required", path


async def test_a_bad_body_is_422_and_doesnt_quote_the_password(web, with_password):
    r = await web.post("/api/login", json={"handle": "ngocbh", "password": PASSWORD, "extra": PASSWORD})
    assert r.status_code == 422 and PASSWORD not in r.text
    r = await web.post("/api/login", json={"handle": "Not A Handle", "password": PASSWORD})
    assert r.status_code == 422 and PASSWORD not in r.text


async def test_signing_in_again_revokes_the_old_session(web, hq, office, with_password):
    first = (await login(web)).json()["id"]
    second = (await login(web)).json()["id"]
    assert office.store.get_hq_session(first) is None and office.store.get_hq_session(second) is not None


async def test_signing_in_with_a_cookie_that_proves_nothing_revokes_nothing(web, hq, office, with_password):
    other, _ = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set(f"opencorp_hq_{PORT}", f"{other.id}.forged", domain="127.0.0.1")
    assert (await login(web)).status_code == 200
    assert office.store.get_hq_session(other.id) is not None


async def test_a_password_change_ends_a_signed_in_session(web, company, with_password):
    assert (await login(web)).status_code == 200
    set_password(company, "ngocbh", hash_password("a different password"))
    assert (await web.get("/api/whoami")).status_code == 401


async def test_the_password_is_never_logged(web, with_password, caplog):
    caplog.set_level(logging.DEBUG)
    await login(web, password="a wrong guess here")
    r = await login(web)
    secret = r.headers["set-cookie"].split("=", 1)[1].split(";")[0].split(".")[1]
    assert PASSWORD not in caplog.text and "a wrong guess here" not in caplog.text and secret not in caplog.text
    assert "sign-in for @ngocbh from 127.0.0.1 failed" in caplog.text
    assert "sign-in for @ngocbh from 127.0.0.1 ok" in caplog.text


@pytest.mark.parametrize("case", ["wrong password", "unknown handle", "agent", "human without a password"])
async def test_every_failure_is_the_same_401(web, company, case):
    if case != "human without a password":
        set_password(company, "ngocbh", hash_password(PASSWORD))
    if case == "agent":
        set_password(company, "minh", hash_password(PASSWORD))  # a hash on an agent signs nobody in
    handle, password = {"wrong password": ("ngocbh", "not the password"), "unknown handle": ("nobody", PASSWORD),
                        "agent": ("minh", PASSWORD), "human without a password": ("ngocbh", PASSWORD)}[case]
    r = await login(web, handle, password)
    assert (r.status_code, r.json()) == (401, {"error": "bad_credentials", "message": "wrong handle or password"})
    assert "set-cookie" not in r.headers


@pytest.mark.parametrize("handle", ["nobody", "minh", "ngocbh"])
async def test_a_handle_without_a_password_still_costs_a_full_check(web, handle, monkeypatch):
    checked = []
    real = login_module.check_password
    monkeypatch.setattr(login_module, "check_password", lambda pw, phc: checked.append(phc) or real(pw, phc))
    assert (await login(web, handle)).status_code == 401
    assert checked == [login_module.DUMMY_HASH]


def test_the_dummy_hash_costs_what_a_real_one_does():
    cost = re.compile(r"\$scrypt\$ln=\d+,r=\d+,p=\d+\$")
    assert cost.match(login_module.DUMMY_HASH)[0] == cost.match(hash_password("x" * 12))[0]
    assert not check_password(PASSWORD, login_module.DUMMY_HASH)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_five_failures_in_fifteen_minutes_lock_the_pair_and_each_lock_doubles_to_fifteen_minutes():
    clock = Clock()
    t = Throttle(clock)
    for _ in range(4):
        t.failed(("p", "a"))
    assert t.wait(("p", "a")) is None
    waits = []
    for _ in range(5):
        t.failed(("p", "a"))
        waits.append(t.wait(("p", "a")))
        clock.now += waits[-1]  # waits it out, then fails again
        assert t.wait(("p", "a")) is None
    assert waits == [60, 120, 240, 480, 900]
    for _ in range(4):  # a 15-minute wait outlasts the pair's memory: it starts over
        t.failed(("p", "a"))
    assert t.wait(("p", "a")) is None


def test_the_wait_is_whole_seconds_rounded_up():
    clock = Clock()
    t = Throttle(clock)
    for _ in range(5):
        t.failed(("p", "a"))
    clock.now += 0.5
    wait = t.wait(("p", "a"))
    assert wait == 60 and isinstance(wait, int)


def test_failures_older_than_fifteen_minutes_dont_count():
    clock = Clock()
    t = Throttle(clock)
    for _ in range(4):
        t.failed(("p", "a"))
    clock.now += 15 * 60
    t.failed(("p", "a"))
    assert t.wait(("p", "a")) is None


def test_a_success_clears_the_pair_and_only_that_pair():
    t = Throttle(Clock())
    for _ in range(5):
        t.failed(("p", "a"))
        t.failed(("p", "b"))
    t.succeeded(("p", "a"))
    assert t.wait(("p", "a")) is None and t.wait(("p", "b")) == 60


def test_the_throttle_is_bounded():
    clock = Clock()
    t = Throttle(clock)
    for _ in range(5):
        t.failed(("p", "target"))
    for i in range(MAX_KEYS + 10):
        t.failed(("p", f"h{i}"))
    assert len(t) == MAX_KEYS
    clock.now += 15 * 60
    t.failed(("p", "new"))
    assert len(t) == 1  # entries go 15 minutes after their last failure


def test_filling_the_table_evicts_unlocked_pairs_never_a_lock():
    t = Throttle(Clock())
    for _ in range(5):
        t.failed(("p", "target"))
    for i in range(MAX_KEYS):
        t.failed(("p", f"h{i}"))
    assert len(t) == MAX_KEYS and t.wait(("p", "target")) == 60


def test_a_table_full_of_locks_refuses_new_pairs_until_the_first_lock_ends():
    clock = Clock()
    t = Throttle(clock)
    for i in range(MAX_KEYS):
        for _ in range(5):
            t.failed(("p", f"h{i}"))
        clock.now += 1 / 128  # exact in binary, so the sum is too
    assert t.wait(("p", "new")) == 53  # the oldest lock, from 7.8 s ago, ends first
    t.failed(("p", "new"))  # a check that started before the table filled: dropped, not a lock evicted
    assert len(t) == MAX_KEYS and t.wait(("p", "h0")) is not None
    clock.now += 60
    assert t.wait(("p", "new")) is None


def peer_client(office, hq, peer):
    app = create_hq_app(office, hq, port=PORT)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(peer, 50000)), base_url=ORIGIN,
                             headers={"host": f"127.0.0.1:{PORT}", "origin": ORIGIN})


@pytest.fixture
def fast_checks(monkeypatch):
    """Password checks without scrypt's cost: the throttle tests make many."""
    monkeypatch.setattr(login_module, "check_password", lambda pw, phc: pw == PASSWORD and phc != DUMMY_HASH)


async def test_five_failures_give_429_with_retry_after_even_for_the_right_password(web, with_password, fast_checks):
    for _ in range(5):
        assert (await login(web, password="a wrong guess")).status_code == 401
    r = await login(web)
    assert r.status_code == 429 and r.json()["error"] == "too_many_attempts" and r.headers["retry-after"] == "60"
    assert r.headers["content-type"] == "application/json"
    assert "opencorp pair" in r.json()["message"] and "set-cookie" not in r.headers


async def test_a_throttled_handle_leaves_other_handles_and_peers_alone(office, hq, web, with_password, fast_checks):
    for _ in range(5):
        await login(web, password="a wrong guess")
    assert (await login(web, "minh", "a wrong guess")).status_code == 401
    async with peer_client(office, hq, "127.0.0.2") as other:
        assert (await login(other)).status_code == 200


async def test_pairing_still_works_while_a_handle_is_throttled(web, hq, with_password, fast_checks):
    for _ in range(6):
        await login(web, password="a wrong guess")
    code = (await hq.mint("ngocbh", issuer="ngocbh", open_file=False)).path.split("#")[1]
    assert (await web.post("/api/pair", json={"code": code})).status_code == 200


async def test_a_success_clears_the_count(web, with_password, fast_checks):
    for _ in range(4):
        await login(web, password="a wrong guess")
    assert (await login(web)).status_code == 200
    for _ in range(4):
        assert (await login(web, password="a wrong guess")).status_code == 401


async def test_two_checks_at_a_time_and_a_third_is_503_busy_at_once(web, with_password, monkeypatch):
    entered, release = [], threading.Event()

    def held(pw, phc):
        entered.append(phc)
        release.wait(10)
        return False

    monkeypatch.setattr(login_module, "check_password", held)
    first = [asyncio.create_task(login(web, password="a wrong guess")) for _ in range(2)]
    try:
        async with asyncio.timeout(5):
            while len(entered) < 2:
                await asyncio.sleep(0.01)
        r = await login(web)
        assert r.status_code == 503 and r.json()["error"] == "busy" and len(entered) == 2
    finally:
        release.set()
    assert [r.status_code for r in await asyncio.gather(*first)] == [401, 401]
    monkeypatch.setattr(login_module, "check_password", lambda pw, phc: pw == PASSWORD)
    assert (await login(web)).status_code == 200  # the busy answer counted no failure, and the slots came back


async def test_a_check_whose_request_went_away_still_holds_its_slot(hq, with_password, monkeypatch):
    entered, release = [], threading.Event()

    def held(pw, phc):
        entered.append(phc)
        release.wait(10)
        return False

    monkeypatch.setattr(login_module, "check_password", held)
    gone = [asyncio.create_task(hq.logins.check("p", "ngocbh", "a wrong guess")) for _ in range(2)]
    try:
        async with asyncio.timeout(5):
            while len(entered) < 2:
                await asyncio.sleep(0.01)
        for task in gone:
            task.cancel()
        await asyncio.gather(*gone, return_exceptions=True)
        with pytest.raises(Busy):
            await hq.logins.check("p", "ngocbh", PASSWORD)
    finally:
        release.set()
    async with asyncio.timeout(5):
        while hq.logins._checks.locked():
            await asyncio.sleep(0.01)
