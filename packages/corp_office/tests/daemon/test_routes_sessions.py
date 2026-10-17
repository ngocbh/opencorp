"""Session routes."""

import asyncio

import pytest

from agent_corp.auth.tokens import new_token
from agent_corp.chat.connections import ConnectionFile, Connections
from agent_corp.chat.harness import Harness, HarnessError
from agent_corp.chat.provider import Provider
from agent_corp.perm.monitor import Monitor
from agent_corp.secrets import SecretStore, write_private
from agent_corp.store import new_id
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import base_files, write_repo
from tests.daemon.test_app import ULID
from tests.daemon.test_auth import add_human, bearer, give_device
from tests.store.conftest import message, session


@pytest.fixture
def company(tmp_path):
    return write_repo(tmp_path / "company", base_files() | {"shared/flows/chat.yaml": CHAT_FLOW})


@pytest.fixture
def fake_llm():
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def chat(office, fake_llm):
    """The office, running the chat harness against the fake LLM."""
    monitor = Monitor(office.paths.company, office.store, SecretStore(office.paths.secrets))
    provider = Provider(llm_config=LLM_CONFIG, env=fake_llm.env())
    office.paths.office.mkdir(parents=True, exist_ok=True)
    write_private(office.paths.office / "provider.json", provider.model_dump_json().encode())
    harness = Harness(office, monitor, connections=Connections(office.paths.office))
    office.workers = office.extras["harness"] = harness
    return office


async def until(predicate, timeout=30):
    for _ in range(int(timeout / 0.05)):
        if value := predicate():
            return value
        await asyncio.sleep(0.05)
    raise AssertionError("timed out")


@pytest.mark.parametrize(("path", "body"), [
    ("/sessions", {"person": "minh", "cwd": "/w/app"}),
    (f"/sessions/{ULID}/prompt", {"text": "hi"}),
    (f"/sessions/{ULID}/steer", {"text": "hi"}),
    (f"/sessions/{ULID}/interrupt", None),
    (f"/sessions/{ULID}/end", None),
    (f"/sessions/{ULID}/continue", None),
    (f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 10}),
    (f"/sessions/{ULID}/model", {"connection": "office", "model": "stub"}),
])
async def test_session_actions_need_a_harness(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


async def test_continue_answers_with_the_new_session_opened_by_the_caller(client, office, company):
    calls = []

    class FakeHarness:
        def continue_session(self, session_id, *, by=None):
            calls.append((session_id, by))
            return session(harness="codex", parent_session_id=session_id, opened_by=by)

    office.extras["harness"] = FakeHarness()
    add_human(company, "ava")
    token = new_token()
    give_device(company, "ava", "pc", token)
    r = await client.post(f"/sessions/{ULID}/continue", headers=bearer(token))
    assert r.status_code == 200 and r.json()["parent_session_id"] == ULID and calls == [(ULID, "ava")]


async def test_a_refused_continue_is_its_api_error(client, office):
    class FakeHarness:
        def continue_session(self, session_id, *, by=None):
            raise HarnessError(409, "live", f"session {session_id} is still open")

    office.extras["harness"] = FakeHarness()
    r = await client.post(f"/sessions/{ULID}/continue")
    assert (r.status_code, r.json()["error"]) == (409, "live")


async def test_list_sessions_filters_and_limits(client, office):
    a = office.store.create_session(session(person="minh"))
    office.store.create_session(session(person="ngocbh"))
    b = office.store.create_session(session(person="minh"))
    r = await client.get("/sessions", params={"person": "minh"})
    assert [s["id"] for s in r.json()] == [b.id, a.id]
    assert len((await client.get("/sessions", params={"limit": 1})).json()) == 1


async def test_list_sessions_defaults_to_fifty(client, office):
    for _ in range(51):
        office.store.create_session(session())
    assert len((await client.get("/sessions")).json()) == 50


@pytest.mark.parametrize("limit", ["0", "501", "x", "²"])  # "²".isdigit() is True
async def test_bad_limit_is_422(client, limit):
    r = await client.get("/sessions", params={"limit": limit})
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"


async def test_get_session(client, office):
    s = office.store.create_session(session())
    r = await client.get(f"/sessions/{s.id}")
    assert r.status_code == 200 and r.json() == s.model_dump(mode="json")


async def test_missing_session_is_404(client):
    for path in (f"/sessions/{ULID}", f"/sessions/{ULID}/messages"):
        r = await client.get(path)
        assert r.status_code == 404 and r.json()["error"] == "not_found"


async def test_messages_in_order(client, office):
    s = office.store.create_session(session())
    m1 = office.store.add_message(message(s.id, role="user", parts=[{"id": new_id(), "type": "text", "text": "hi"}]))
    m2 = office.store.add_message(message(s.id, parts=[{"id": new_id(), "type": "text", "text": "hello"}]))
    r = await client.get(f"/sessions/{s.id}/messages")
    assert r.json() == [m1.model_dump(mode="json"), m2.model_dump(mode="json")]


async def test_a_chat_over_the_routes(chat, client, fake_llm, tmp_path):
    store = chat.store
    fake_llm.script({"content": "Hi there."})
    (tmp_path / "ws").mkdir()
    r = await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})
    assert r.status_code == 200 and r.json()["person"] == "minh"
    sid = r.json()["id"]
    await until(lambda: store.get_session(sid).status == "idle")
    turn = store.list_questions(session_id=sid, status="open")[0]

    r = await client.post(f"/questions/{turn.id}/answer", json={"answer": "hello", "answer_kind": "text"})
    assert r.status_code == 200 and r.json()["answered_by"] == "ngocbh"
    await until(lambda: [m.role for m in store.list_messages(sid)] == ["user", "assistant"])
    await until(lambda: store.get_session(sid).status == "idle")

    r = await client.post(f"/sessions/{sid}/cost-cap", json={"cost_cap_usd": 0})
    assert (r.status_code, r.json()["error"]) == (422, "cap_too_low")
    r = await client.post(f"/sessions/{sid}/cost-cap", json={"cost_cap_usd": 9})
    assert r.json()["cost_cap_usd"] == 9
    assert (await client.post(f"/sessions/{sid}/interrupt")).json() == {"ok": True}
    assert (await client.post(f"/sessions/{sid}/end")).json() == {"ok": True}
    await until(lambda: store.get_session(sid).status == "ended")
    r = await client.post(f"/sessions/{sid}/prompt", json={"text": "late"})
    assert (r.status_code, r.json()["error"]) == (409, "not_live")


async def test_a_chat_starts_on_the_requested_connection_and_model(chat, client, fake_llm, tmp_path):
    Connections(chat.paths.office).put("second", ConnectionFile(llm_config={**LLM_CONFIG, "model": "stub-2"},
                                                                 env=fake_llm.env()))
    (tmp_path / "ws").mkdir()
    r = await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws"),
                                             "connection": "second", "model": "stub-5"})
    assert r.status_code == 200
    assert (r.json()["connection"], r.json()["model"], r.json()["model_note"]) == ("second", "stub-5", None)
    sid = r.json()["id"]
    await until(lambda: chat.store.get_session(sid).status == "idle")
    assert (await client.post(f"/sessions/{sid}/end")).json() == {"ok": True}
    await until(lambda: chat.store.get_session(sid).status == "ended")


async def test_a_chat_is_credited_to_the_verified_person(chat, client, company, fake_llm, tmp_path):
    store = chat.store
    add_human(company, "ava")
    ava, ceo = new_token(), new_token()
    give_device(company, "ava", "pc", ava)
    give_device(company, "ngocbh", "mac", ceo)
    fake_llm.script({"content": "Hi Ava."}, {"content": "Hi Ngoc."})
    (tmp_path / "ws").mkdir()
    r = await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")}, headers=bearer(ava))
    assert r.status_code == 200 and r.json()["opened_by"] == "ava"
    sid = r.json()["id"]
    assert store.get_work_item(r.json()["work_item_id"]).requester == "ava"
    await until(lambda: store.get_session(sid).status == "idle")
    r = await client.post(f"/sessions/{sid}/prompt", json={"text": "hello"}, headers=bearer(ava))
    assert r.status_code == 200
    await until(lambda: len(store.list_messages(sid)) == 2 and store.get_session(sid).status == "idle")
    # Someone else in the same chat is credited as themselves; steer with no reply running is a prompt.
    r = await client.post(f"/sessions/{sid}/steer", json={"text": "hi too"}, headers=bearer(ceo))
    assert r.status_code == 200
    await until(lambda: len(store.list_messages(sid)) == 4)
    by_answer = {q.answer: q.answered_by for q in store.list_questions(session_id=sid, source="human_input")}
    assert (by_answer["hello"], by_answer["hi too"]) == ("ava", "ngocbh")
    assert "You're talking with Ava (@ava), your peer." in fake_llm.requests()[0]["messages"][0]["content"]


async def test_anyone_who_may_chat_may_switch_its_model(chat, client, company, fake_llm, tmp_path):
    Connections(chat.paths.office).put("second", ConnectionFile(llm_config={**LLM_CONFIG, "model": "stub-2"},
                                                                 env=fake_llm.env()))
    add_human(company, "ava")
    ava, ceo = new_token(), new_token()
    give_device(company, "ava", "pc", ava)
    give_device(company, "ngocbh", "mac", ceo)
    (tmp_path / "ws").mkdir()
    r = await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")}, headers=bearer(ceo))
    sid = r.json()["id"]
    await until(lambda: chat.store.get_session(sid).status == "idle")
    r = await client.post(f"/sessions/{sid}/model", json={"connection": "second", "model": "stub-5"},
                          headers=bearer(ava))
    assert r.status_code == 200
    assert (r.json()["connection"], r.json()["model"], r.json()["model_note"]) == ("second", "stub-5", None)
    r = await client.post(f"/sessions/{sid}/model", json={"connection": "gone", "model": "stub-5"},
                          headers=bearer(ava))
    assert (r.status_code, r.json()["error"]) == (422, "unknown_connection")
    assert (chat.store.get_session(sid).connection, chat.store.get_session(sid).model) == ("second", "stub-5")
    assert (await client.post(f"/sessions/{sid}/end", headers=bearer(ceo))).json() == {"ok": True}
    await until(lambda: chat.store.get_session(sid).status == "ended")


async def test_end_is_ending_at_once_and_a_second_end_is_a_no_op(chat, client, fake_llm, tmp_path):
    store = chat.store
    fake_llm.script({"content": "Working", "hold": 30}, {"content": "never"})
    (tmp_path / "ws").mkdir()
    sid = (await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})).json()["id"]
    await until(lambda: store.get_session(sid).status == "idle")
    assert (await client.post(f"/sessions/{sid}/prompt", json={"text": "hi"})).json() == {"ok": True}
    await until(lambda: fake_llm.requests())

    assert (await client.post(f"/sessions/{sid}/end")).json() == {"ok": True}
    assert store.get_session(sid).status == "ending"
    assert (await client.post(f"/sessions/{sid}/end")).json() == {"ok": True}
    for path in ("prompt", "steer"):
        r = await client.post(f"/sessions/{sid}/{path}", json={"text": "more"})
        assert (r.status_code, r.json()["error"]) == (409, "ending")
    fake_llm.release()
    await until(lambda: store.get_session(sid).status == "ended")
    for path in ("interrupt", "end"):
        r = await client.post(f"/sessions/{sid}/{path}")
        assert (r.status_code, r.json()["error"]) == (409, "not_live")


async def test_a_steer_reaches_a_running_reply_and_a_prompt_check_can_refuse(chat, client, fake_llm, tmp_path):
    chat.extras["harness"].hooks.prompt_check.append(lambda s, text: "not that" if text == "nope" else None)
    fake_llm.script({"content": "Working", "hold": 30}, {"content": "Done."})
    (tmp_path / "ws").mkdir()
    sid = (await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})).json()["id"]
    await until(lambda: chat.store.get_session(sid).status == "idle")
    assert (await client.post(f"/sessions/{sid}/prompt", json={"text": "hi"})).json() == {"ok": True}
    await until(lambda: fake_llm.requests())

    for path in ("prompt", "steer"):
        r = await client.post(f"/sessions/{sid}/{path}", json={"text": "nope"})
        assert (r.status_code, r.json()) == (422, {"error": "refused", "message": "not that"})
    assert (await client.post(f"/sessions/{sid}/steer", json={"text": "Also Rome."})).json() == {"ok": True}
    fake_llm.release()
    await until(lambda: len(fake_llm.requests()) >= 2)
    assert "Also Rome." in str(fake_llm.requests()[1]["messages"]) and "nope" not in str(fake_llm.requests())


@pytest.mark.parametrize(("error", "status", "code"), [
    (RuntimeError("sentinel"), 500, "start_failed"),
    (HarnessError(422, "invalid_body", "the folder is gone"), 422, "invalid_body"),  # it vanished after the check
])
async def test_a_spec_that_cant_be_built_fails_the_session(chat, client, tmp_path, monkeypatch, caplog, error,
                                                            status, code):
    harness = chat.extras["harness"]
    ended = []
    harness.hooks.session_ended.append(lambda s: ended.append(s.status))

    def broken(session):
        raise error
    monkeypatch.setattr(harness, "main_spec", broken)
    (tmp_path / "ws").mkdir()
    r = await client.post("/sessions", json={"person": "minh", "cwd": str(tmp_path / "ws")})
    assert (r.status_code, r.json()["error"]) == (status, code)
    (session,) = chat.store.list_sessions()
    assert (session.status, ended) == ("failed", ["failed"]) and session.id not in harness._live
    # Only the office log holds an unexpected error's text.
    assert "sentinel" not in r.text and ("sentinel" in caplog.text) == isinstance(error, RuntimeError)


@pytest.mark.parametrize(("path", "body", "status", "code"), [
    ("/sessions", {"person": "nobody", "cwd": "/tmp"}, 404, "not_found"),
    ("/sessions", {"person": "ngocbh", "cwd": "/tmp"}, 422, "not_an_agent"),
    ("/sessions", {"person": "minh", "cwd": "relative"}, 422, "invalid_body"),
    ("/sessions", {"person": "minh", "cwd": "/tmp", "harness": "codex"}, 422, "unsupported_harness"),
    ("/sessions", {"person": "minh", "cwd": "/"}, 422, "unsafe_workspace"),
    (f"/sessions/{ULID}/prompt", {"text": "hi"}, 404, "not_found"),
    (f"/sessions/{ULID}/prompt", {"text": ""}, 422, "invalid_body"),
    (f"/sessions/{ULID}/interrupt", None, 404, "not_found"),
    (f"/sessions/{ULID}/end", None, 404, "not_found"),
    (f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 1}, 404, "not_found"),
    (f"/sessions/{ULID}/model", {"connection": "office", "model": "stub"}, 404, "not_found"),
    (f"/sessions/{ULID}/model", {"connection": "office", "model": ""}, 422, "invalid_body"),
    (f"/sessions/{ULID}/model", {"connection": "office"}, 422, "invalid_body"),
    (f"/questions/{ULID}/answer", {"answer": "x", "answer_kind": "text"}, 404, "not_found"),
])
async def test_chat_routes_refuse_bad_requests(chat, client, path, body, status, code):
    r = await client.post(path, json=body)
    assert (r.status_code, r.json()["error"]) == (status, code)
