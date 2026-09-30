"""Session routes."""

import asyncio

import pytest

from agent_corp.chat.harness import Harness
from agent_corp.chat.provider import Provider
from agent_corp.perm.monitor import Monitor
from agent_corp.secrets import SecretStore
from agent_corp.store import new_id
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import base_files, write_repo
from tests.daemon.test_app import ULID
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
    harness = Harness(office, monitor, provider=lambda: Provider(llm_config=LLM_CONFIG, env=fake_llm.env()))
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
    (f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 10}),
])
async def test_session_actions_need_a_harness(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


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
    (f"/questions/{ULID}/answer", {"answer": "x", "answer_kind": "text"}, 404, "not_found"),
])
async def test_chat_routes_refuse_bad_requests(chat, client, path, body, status, code):
    r = await client.post(path, json=body)
    assert (r.status_code, r.json()["error"]) == (status, code)
