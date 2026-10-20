"""Signing a browser in with a handle and password: the same session and cookie as pairing."""

import logging

import pytest
import yaml

from opencorp.auth.passwords import hash_password
from tests.company.conftest import _git
from tests.hq.conftest import PORT, hq_client

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
