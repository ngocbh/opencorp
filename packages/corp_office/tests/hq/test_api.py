"""HQ's /api: the allowlist."""

import pytest
import yaml

from opencorp.auth.passwords import hash_password
from opencorp.company import secret_keys
from tests.company.conftest import _git
from tests.hq.conftest import PORT
from tests.store.conftest import question, session, work_item


async def test_health_is_open_and_says_both_keys(web, hq, dist):
    r = await web.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "office": {"api": hq.api}, "app": {"build": "b1", "api": "x"}}


async def test_anything_else_under_api_needs_a_session_first(web):
    r = await web.get("/api/people")
    assert (r.status_code, r.json()["error"]) == (401, "sign_in_required")


async def test_anything_else_under_api_is_a_json_404(web, hq):
    _, cookie = await hq.sessions.issue("ngocbh", issued_by="ngocbh", label=None)
    web.cookies.set(f"opencorp_hq_{PORT}", cookie, domain="127.0.0.1")
    for path in ("/api", "/api/people", "/api/hq/pair", "/api/hq/browsers"):
        r = await web.get(path)
        assert (r.status_code, r.json()["error"]) == (404, "no_route"), path


async def test_company_is_the_head_snapshot_without_devices(signed_in, office, company):
    path = company / "people" / "ngocbh" / "person.yaml"
    data = yaml.safe_load(path.read_text())
    data["devices"] = [{"name": "mac", "token_sha256": "a" * 64}]  # a device, not a password: the session lives on
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    _git(company, "commit", "-qam", "a device")
    r = await signed_in.get("/api/company")
    body = r.json()
    assert r.status_code == 200 and body["sha"] == office.git.head() and body["company"]["ceo"] == "ngocbh"
    assert all(p["devices"] == [] and p["password_hash"] is None for p in body["people"])
    assert [g["id"] for g in body["groups"]] == ["eng"] and body["issues"] == []


async def test_company_strips_devices_and_password_hashes_whatever_the_snapshot_holds(signed_in, hq, monkeypatch):
    # The snapshot strips them already; the handler strips them again, since the response goes to a browser.
    view = await hq.snapshots.head()
    leaky = view.model_copy(update={"people": [
        p.model_copy(update={"devices": [{"name": "mac", "token_sha256": "a" * 64}],
                             "password_hash": hash_password("a secret")})
        for p in view.people]})

    async def head():
        return leaky

    monkeypatch.setattr(hq.snapshots, "head", head)
    r = await signed_in.get("/api/company")
    assert r.status_code == 200 and r.json()["people"]
    assert all(p["devices"] == [] and p["password_hash"] is None for p in r.json()["people"])
    assert "token_sha256" not in r.text and "$scrypt$" not in r.text


async def test_company_blanks_by_secret_keys(signed_in, hq, monkeypatch):
    view = await hq.snapshots.head()
    monkeypatch.setattr(secret_keys, "SECRET_KEYS", secret_keys.SECRET_KEYS | {"skills"})
    assert any(p.skills for p in view.people)  # loaded before the change, so only the handler can blank them
    r = await signed_in.get("/api/company")
    assert r.status_code == 200 and all(p["skills"] == [] for p in r.json()["people"])


@pytest.mark.parametrize("status", [["busy", "idle"], ["busy,idle"]])
async def test_sessions_filter_by_status(signed_in, office, status):
    a = office.store.create_session(session(status="busy"))
    b = office.store.create_session(session(status="idle"))
    office.store.create_session(session(status="ended"))
    r = await signed_in.get("/api/sessions", params=[("status", s) for s in status])
    assert {s["id"] for s in r.json()} == {a.id, b.id}


async def test_open_questions_a_work_item_and_costs(signed_in, office):
    s = office.store.create_session(session())
    q = office.store.add_question(question(s.id))
    item = office.store.create_work_item(work_item(assignee="ngocbh"))
    assert [x["id"] for x in (await signed_in.get("/api/questions", params={"status": "open"})).json()] == [q.id]
    assert (await signed_in.get(f"/api/work-items/{item.id}")).json()["assignee"] == "ngocbh"
    r = await signed_in.get("/api/costs", params={"since": "2026-10-19T00:00:00.000Z"})
    assert r.status_code == 200 and r.json()["since"] == "2026-10-19T00:00:00.000Z"


@pytest.mark.parametrize("path", ["/api/people", "/api/sessions/X/messages", "/api/connections", "/api/hq"])
async def test_routes_off_the_allowlist_are_a_json_404(signed_in, path):
    r = await signed_in.get(path)
    assert (r.status_code, r.json()["error"]) == (404, "no_route")


async def test_writes_off_the_allowlist_are_a_json_404(signed_in):
    for path in ("/api/sessions", "/api/people", "/api/questions/X/answer"):
        assert (await signed_in.post(path, json={})).status_code == 404


async def test_runs_are_on_the_allowlist(signed_in, office):
    from opencorp.runs.service import RunLogs
    from opencorp.store import RunRow, new_id

    office.extras["runs"] = RunLogs(office)
    s = office.store.create_session(session(status="ended"))
    run_id, kid = new_id(), new_id()
    office.store.add_run(RunRow(run_id, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None,
                                "2026-10-20T10:00:00.000Z"))
    office.store.add_run(RunRow(kid, s.id, "side_chat", "shared/flows/side_chat.yaml", "lan", run_id,
                                "2026-10-20T10:00:00.000Z"))
    r = await signed_in.get("/api/runs", params={"status": "interrupted,failed", "since": "2026-10-13T10:00:00.000Z",
                                                 "limit": "50"})
    assert r.status_code == 200 and [x["run_id"] for x in r.json()["runs"]] == [run_id]
    assert r.json()["runs"][0]["children_total"] == 1
    r = await signed_in.get("/api/runs", params={"parent": run_id})
    assert [x["run_id"] for x in r.json()["runs"]] == [kid]
    assert (await signed_in.get("/api/runs", params={"status": "busy"})).status_code == 422
    r = await signed_in.get("/api/runs", params={"recent": "2026-10-13T10:00:00.000Z", "limit": "50"})
    assert [x["run_id"] for x in r.json()["runs"]] == [run_id]
    both = {"recent": "2026-10-13T10:00:00.000Z", "since": "2026-10-13T10:00:00Z"}
    assert (await signed_in.get("/api/runs", params=both)).status_code == 422


async def test_runs_need_a_session(web):
    assert (await web.get("/api/runs")).status_code == 401
