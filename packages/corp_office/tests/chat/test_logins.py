"""Device sign-ins to the ChatGPT subscription, each adding a connection, on fake HTTP and a fake clock."""

import base64
import json
import logging
import os
import stat
import threading
import time

import pytest
from agent_composer.llm_clients.auth import AuthStore, HttpResponse, OpenAIAuth

from agent_corp.chat import logins as logins_module
from agent_corp.chat.connections import AUTH_FILE_ENV, ConnectionFile, Connections
from agent_corp.chat.logins import FORGET, LoginNotFound, Logins
from agent_corp.chat.provider import ProviderError
from agent_corp.secrets import write_private
from tests.chat.conftest import wait_for

SIGNATURE = "fake-signature-6e2a90d4"
REFRESH = "fake-refresh-b81c5f37"


def jwt(account="account-test"):
    """A token shaped like OpenAI's, naming ``account``; its signature part is a fake secret."""
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": account}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.{SIGNATURE}"


ACCESS = jwt()

USERCODE = HttpResponse(200, {"device_auth_id": "device-1", "user_code": "ABCD-EFGH", "interval": 1})
PENDING = HttpResponse(403, {"error": "pending"})
APPROVED = HttpResponse(200, {"authorization_code": "auth-code", "code_verifier": "verifier"})
TOKENS = HttpResponse(200, {"access_token": ACCESS, "refresh_token": REFRESH, "id_token": ACCESS, "expires_in": 3600})
CATALOG = HttpResponse(200, {"models": [{"slug": "gpt-5.5-codex", "visibility": "list", "priority": 2},
                                        {"slug": "gpt-5.5", "visibility": "list", "priority": 1}]})
FLOW = (USERCODE, PENDING, APPROVED, TOKENS, CATALOG)


class HTTP:
    """Composer's ``request`` sender: answers each call with the next response, and with ``rest`` once they run out;
    a response that is a function is called with the URL. Records each call."""

    def __init__(self, *responses, rest=None):
        self.responses = list(responses)
        self.rest = rest
        self.calls = []

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        response = self.responses.pop(0) if self.responses else self.rest
        return response(url) if callable(response) else response


def held(response, release):
    """``response``, given only once ``release`` is set."""
    def give(url):
        assert release.wait(30)
        return response
    return give


def waiting(url):
    """A sign-in that shows its code and then waits for the human forever."""
    return USERCODE if url.endswith("/usercode") else PENDING


class Clock:
    """A monotonic clock that only ``sleep`` (or a test) moves; each sleep also yields the thread for a moment."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        time.sleep(0.005)


@pytest.fixture
def conns(tmp_path):
    office = tmp_path / "office"
    office.mkdir(mode=0o700)
    write_private(office / "provider.json", json.dumps({"llm_config": {"provider": "anthropic"}}).encode())
    return Connections(office)


def make(conns, http, **kwargs):
    clock = Clock()
    return Logins(conns, auth=lambda **kw: OpenAIAuth(request=http, monotonic=clock, sleep=clock.sleep, **kw),
                  **kwargs)


def until(logins, login_id, state, by="ngocbh"):
    return wait_for(lambda: (found := logins.get(login_id, by=by)).state == state and found, what=state)


def no_tokens(*texts):
    for text in texts:
        assert SIGNATURE not in text and REFRESH not in text


def test_start_returns_the_url_and_code_then_signs_in(conns, caplog):
    caplog.set_level(logging.DEBUG)
    release = threading.Event()
    http = HTTP(USERCODE, held(PENDING, release), APPROVED, TOKENS, CATALOG)
    logins = make(conns, http)
    login = logins.start(by="ngocbh")
    assert (login.state, login.url, login.user_code, login.connection) == (
        "waiting", "https://auth.openai.com/codex/device", "ABCD-EFGH", None)
    release.set()
    done = until(logins, login.id, "signed_in")
    assert (done.connection, done.message) == ("chatgpt", None)
    auth = conns.auth_file("chatgpt")
    assert stat.S_IMODE(os.stat(auth).st_mode) == 0o600
    assert AuthStore(auth).selection("openai").model == "gpt-5.5"
    assert conns.get("chatgpt") == ConnectionFile(method="subscription",
                                                  llm_config={"provider": "openai", "model": "gpt-5.5"})
    assert conns.resolve("chatgpt", None).env == {AUTH_FILE_ENV: str(auth)}
    no_tokens(login.model_dump_json(), done.model_dump_json(), (conns.dir / "chatgpt.json").read_text(), caplog.text)
    assert ACCESS.split(".")[2] in auth.read_text()  # the tokens are in the sign-in, and only there


def test_the_sign_in_is_saved_before_the_connection(conns, monkeypatch):
    seen = []

    def put(name, conn):
        seen.append(conns.auth_file(name).exists())
        raise ProviderError("the disk is full")

    monkeypatch.setattr(conns, "put", put)
    logins = make(conns, HTTP(*FLOW))
    login = logins.start(by="ngocbh")
    failed = until(logins, login.id, "failed")
    assert seen == [True]
    assert failed.message == "the disk is full" and failed.connection is None
    assert not conns.auth_file("chatgpt").exists() and conns.names() == ["office"]


def test_a_second_sign_in_is_a_new_connection(conns):
    logins = make(conns, HTTP(*FLOW, *FLOW, *FLOW))
    first = until(logins, logins.start(by="ngocbh").id, "signed_in")
    second = until(logins, logins.start(by="ngocbh").id, "signed_in")
    assert (first.connection, second.connection) == ("chatgpt", "chatgpt-2")
    conns.remove("chatgpt")
    third = until(logins, logins.start(by="ngocbh").id, "signed_in")
    assert third.connection == "chatgpt-3"
    assert conns.names() == ["office", "chatgpt-2", "chatgpt-3"]


def test_cancel_stops_the_poll_and_saves_nothing(conns):
    http = HTTP(rest=waiting)
    logins = make(conns, http)
    login = logins.start(by="ngocbh")
    wait_for(lambda: len(http.calls) > 2, what="the poll")
    logins.cancel(login.id, by="ngocbh")
    assert logins.get(login.id, by="ngocbh").state == "cancelled"
    polls = len(http.calls)
    time.sleep(0.1)
    assert len(http.calls) == polls
    assert conns.names() == ["office"] and not conns.auth_file("chatgpt").exists()
    logins.cancel(login.id, by="ngocbh")  # cancelling an ended sign-in changes nothing
    assert logins.get(login.id, by="ngocbh").state == "cancelled"


@pytest.mark.parametrize("held_at", ["the listing", "the save"])
def test_a_cancel_after_the_code_is_approved_saves_nothing(conns, monkeypatch, held_at):
    monkeypatch.setattr(logins_module, "STOP_WAIT", 0.05)  # so cancel returns while the sign-in is held
    reached, release = threading.Event(), threading.Event()

    def hold():
        reached.set()
        assert release.wait(30)

    def catalog(url):
        hold()
        return CATALOG

    if held_at == "the save":
        add = conns.add
        monkeypatch.setattr(conns, "add", lambda *args, **kwargs: (hold(), add(*args, **kwargs))[1])
    logins = make(conns, HTTP(USERCODE, APPROVED, TOKENS, catalog if held_at == "the listing" else CATALOG))
    login = logins.start(by="ngocbh")
    assert reached.wait(5)
    logins.cancel(login.id, by="ngocbh")
    release.set()
    until(logins, login.id, "cancelled")
    assert conns.names() == ["office"] and not conns.auth_file("chatgpt").exists()


def test_a_sign_in_lists_the_models_of_every_connection_again(conns):
    warmed = threading.Event()

    class Cache:
        def warm(self):
            assert conns.names() == ["office", "chatgpt"]  # after the new connection is saved
            warmed.set()

    logins = make(conns, HTTP(*FLOW), models=Cache())
    until(logins, logins.start(by="ngocbh").id, "signed_in")
    assert warmed.wait(5)


def test_a_failed_sign_in_says_why_without_tokens(conns, caplog):
    logins = make(conns, HTTP(HttpResponse(400, {"error": "bad request"})))
    failed = logins.start(by="ngocbh")  # ended before a code was shown: start says so at once
    assert (failed.state, failed.url, failed.user_code) == ("failed", None, None)
    assert failed.message == "OpenAI authentication request failed (HTTP 400)"
    leaky = HttpResponse(401, {"error": f"bad token {ACCESS} {REFRESH}"})
    logins = make(conns, HTTP(USERCODE, APPROVED, TOKENS, leaky))  # refused after the tokens came
    failed = until(logins, logins.start(by="ngocbh").id, "failed")
    assert "HTTP 401" in failed.message
    no_tokens(failed.model_dump_json(), caplog.text)
    assert conns.names() == ["office"] and not conns.auth_file("chatgpt").exists()


def test_only_the_starter_sees_or_cancels_it(conns):
    logins = make(conns, HTTP(rest=waiting))
    login = logins.start(by="ngocbh")
    for call in (lambda: logins.get(login.id, by="ava"), lambda: logins.cancel(login.id, by="ava"),
                 lambda: logins.get("nope", by="ngocbh")):
        with pytest.raises(LoginNotFound):
            call()
    assert logins.get(login.id, by="ngocbh").state == "waiting"
    logins.close_all()


def test_a_finished_login_is_forgotten_after_ten_minutes(conns):
    clock = Clock()
    logins = make(conns, HTTP(HttpResponse(400, {}), rest=waiting), monotonic=clock)
    failed = logins.start(by="ngocbh")
    still_open = logins.start(by="ngocbh")
    clock.now += FORGET - 1
    assert logins.get(failed.id, by="ngocbh").state == "failed"
    clock.now += 1
    with pytest.raises(LoginNotFound):
        logins.get(failed.id, by="ngocbh")
    clock.now += 2 * FORGET
    assert logins.get(still_open.id, by="ngocbh").state == "waiting"  # an open sign-in is kept while it waits
    logins.close_all()


def test_close_all_cancels_every_open_sign_in(conns):
    logins = make(conns, HTTP(rest=waiting))
    ids = [logins.start(by="ngocbh").id, logins.start(by="ava").id]
    logins.close_all()
    assert [logins.get(i, by=by).state for i, by in zip(ids, ("ngocbh", "ava"))] == ["cancelled", "cancelled"]
    assert conns.names() == ["office"]


def test_a_sign_in_that_shows_no_code_in_time_still_returns_waiting(conns, monkeypatch):
    monkeypatch.setattr(logins_module, "START_WAIT", 0.1)
    release = threading.Event()
    logins = make(conns, HTTP(held(USERCODE, release), rest=waiting))
    login = logins.start(by="ngocbh")
    assert (login.state, login.url, login.user_code) == ("waiting", None, None)
    release.set()
    wait_for(lambda: logins.get(login.id, by="ngocbh").user_code == "ABCD-EFGH", what="the code")
    logins.close_all()
