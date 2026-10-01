"""Learning routes: profile manager, proposals, feedback, debriefs."""

import asyncio
import json

import pytest

from agent_corp.chat.harness import Harness
from agent_corp.chat.provider import Provider
from agent_corp.extensions import learning
from agent_corp.perm.monitor import Monitor
from agent_corp.profile import GitProfileStore
from agent_corp.profile.debrief import pending_debrief
from agent_corp.profile.manager import propose
from agent_corp.secrets import SecretStore
from agent_corp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.chat.conftest import CHAT_FLOW
from tests.company.conftest import base_files, write_repo
from tests.daemon.test_app import ULID
from tests.profile.conftest import LEARNING_FILES, debrief_reply, learner_reply
from tests.store.conftest import session

PROFILE = "# Minh, Engineer\n"


@pytest.fixture
def company(tmp_path):
    return write_repo(tmp_path / "company", base_files() | {"shared/flows/chat.yaml": CHAT_FLOW} | LEARNING_FILES)


@pytest.fixture
def fake_llm():
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def learns(office, fake_llm):
    """The office, running the chat harness and learning against the fake LLM."""
    monitor = Monitor(office.paths.company, office.store, SecretStore(office.paths.secrets))
    harness = Harness(office, monitor, provider=lambda: Provider(llm_config=LLM_CONFIG, env=fake_llm.env()))
    office.workers = office.extras["harness"] = harness
    learning.register(office)
    return office


async def until(predicate, timeout=30):
    for _ in range(int(timeout / 0.05)):
        if value := predicate():
            return value
        await asyncio.sleep(0.05)
    raise AssertionError("timed out")


@pytest.mark.parametrize(("method", "path", "body"), [
    ("POST", "/profiles/minh/manager", {"text": "tidy"}),
    ("GET", "/profiles/minh/proposals", None),
    ("POST", f"/profile-proposals/{ULID}/apply", None),
    ("POST", "/feedback", {"session_id": ULID, "text": "be brief"}),
    ("GET", f"/debriefs/{ULID}", None),
    ("POST", f"/debriefs/{ULID}/confirm", {"indices": []}),
])
async def test_learning_routes_need_learning(client, method, path, body):
    r = await client.request(method, path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


@pytest.mark.parametrize("path", ["/profiles/minh/manager", "/feedback", f"/debriefs/{ULID}/confirm"])
async def test_learning_routes_need_learning_before_a_body(client, path):
    r = await client.post(path, json={"bad": True})
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"


async def test_debrief_follow_ups_and_feedback_over_the_routes(learns, client, fake_llm, tmp_path):
    store, harness = learns.store, learns.extras["harness"]
    fake_llm.script({"content": "Done."}, debrief_reply())
    (tmp_path / "ws").mkdir()
    s = await asyncio.to_thread(harness.start_session, "minh", str(tmp_path / "ws"))
    await until(lambda: store.get_session(s.id).status == "idle")
    await asyncio.to_thread(harness.prompt, s.id, "fix the bug")
    await until(lambda: [m.role for m in store.list_messages(s.id)] == ["user", "assistant"])
    await until(lambda: store.get_session(s.id).status == "idle")
    await asyncio.to_thread(harness.end, s.id)
    await until(lambda: store.get_session(s.id).status == "ended")

    r = await client.get(f"/debriefs/{s.id}")
    assert r.status_code == 200 and r.json()["state"] == "ready"
    assert [f["text"] for f in r.json()["follow_ups"]] == ["Add a test", "Update the docs"]
    r = await client.post(f"/debriefs/{s.id}/confirm", json={"indices": [1]})
    assert r.status_code == 200
    follow_up = r.json()["follow_ups"][1]
    assert follow_up["confirmed"] and store.get_work_item(follow_up["work_item_id"]).title == "Update the docs"
    r = await client.post(f"/debriefs/{s.id}/confirm", json={"indices": [2]})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")

    fake_llm.script(learner_reply(PROFILE + "\n- Be brief.\n"))
    r = await client.post("/feedback", json={"session_id": s.id, "text": "Be brief."})
    assert r.status_code == 200 and r.json()["status"] == "queued" and r.json()["author"] == "ngocbh"
    fid = r.json()["id"]
    await until(lambda: store.get_feedback(fid).status == "applied")
    other = store.create_session(session(repo_commit=learns.git.head(), status="ended", run_ids=["r-other"]))
    r = await client.post("/feedback", json={"session_id": s.id, "run_id": other.run_ids[0], "text": "x"})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")  # a run of another session


async def test_the_profile_manager_over_the_routes(learns, client, fake_llm):
    store, git = learns.store, learns.git
    fake_llm.script({"content": "What should change?"})
    r = await client.post("/profiles/minh/manager", json={"text": "Tidy my profile."})
    assert r.status_code == 200 and (r.json()["kind"], r.json()["person"]) == ("profile_manager", "minh")
    manager = store.get_session(r.json()["id"])
    profile = GitProfileStore(git, "minh")
    text, version = profile.read()
    first = propose(store, manager, profile, version, text, PROFILE + "\n- One.\n")
    r = await client.get("/profiles/minh/proposals")
    assert [p["id"] for p in r.json()] == [first.id]

    r = await client.post(f"/profile-proposals/{first.id}/apply")
    assert r.status_code == 200 and r.json()["text"] == PROFILE + "\n- One.\n"
    r = await client.post(f"/profile-proposals/{first.id}/apply")
    assert (r.status_code, r.json()["error"]) == (409, "not_open")

    text, version = profile.read()
    second = propose(store, manager, profile, version, text, text + "- Two.\n")
    (git.root / "people/minh/profile.md").write_text(PROFILE + "\n- Hand edit.\n")
    r = await client.post(f"/profile-proposals/{second.id}/apply")
    assert r.status_code == 409 and r.json() == {"expected": version, "current": profile.read()[1]}
    assert store.get_profile_proposal(second.id).status == "stale"


async def test_a_manager_chat_takes_a_later_turn_over_the_session_routes(learns, client, fake_llm):
    store = learns.store
    fake_llm.script({"content": "What should change?"}, {"content": "Noted."})
    r = await client.post("/profiles/minh/manager", json={"text": "Tidy my profile."})
    sid = r.json()["id"]
    await until(lambda: store.get_session(sid).status == "idle"
                and [m.role for m in store.list_messages(sid)] == ["user", "assistant"])
    r = await client.post(f"/sessions/{sid}/prompt", json={"text": "Drop the old team."})
    assert r.json() == {"ok": True}
    # The reply's message exists from the turn's start, before its text lands.
    await until(lambda: [p.text for m in store.list_messages(sid) for p in m.parts if p.type == "text"] == [
        "Tidy my profile.", "What should change?", "Drop the old team.", "Noted."])
    assert "Drop the old team." in json.dumps(fake_llm.requests()[-1]["messages"])


async def test_learning_routes_refuse_bad_requests(learns, client):
    s = learns.store.create_session(session(repo_commit=learns.git.head(), status="ended"))
    learns.store.save_debrief(pending_debrief(s))
    for method, path, body, status, code in [
        ("POST", "/profiles/nobody/manager", {"text": "hi"}, 404, "not_found"),
        ("POST", "/profiles/minh/manager", {"text": ""}, 422, "invalid_body"),
        ("GET", "/profiles/nobody/proposals", None, 404, "not_found"),
        ("POST", f"/profile-proposals/{ULID}/apply", None, 404, "not_found"),
        ("POST", "/feedback", {"session_id": ULID, "text": "x"}, 404, "not_found"),
        ("GET", f"/debriefs/{ULID}", None, 404, "not_found"),
        ("POST", f"/debriefs/{s.id}/confirm", {"indices": [0]}, 409, "not_ready"),
        ("POST", f"/debriefs/{s.id}/confirm", {"follow_ups": []}, 422, "invalid_body"),
    ]:
        r = await client.request(method, path, json=body)
        assert (r.status_code, r.json()["error"]) == (status, code), path
