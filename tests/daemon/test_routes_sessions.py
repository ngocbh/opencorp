"""Session routes."""

import pytest

from agent_corp.store import new_id
from tests.daemon.test_app import ULID
from tests.store.conftest import message, session


@pytest.mark.parametrize(("path", "body"), [
    ("/sessions", {"person": "minh", "cwd": "/w/app"}),
    (f"/sessions/{ULID}/prompt", {"text": "hi"}),
    (f"/sessions/{ULID}/steer", {"text": "hi"}),
    (f"/sessions/{ULID}/interrupt", None),
    (f"/sessions/{ULID}/end", None),
    (f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 10}),
])
async def test_session_actions_are_not_implemented_yet(client, path, body):
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
