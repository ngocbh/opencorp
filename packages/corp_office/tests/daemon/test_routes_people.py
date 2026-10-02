"""People routes."""

from urllib.parse import quote

import pytest
import yaml

from agent_corp.chat.hire import Hiring


def _folder(cwd: str) -> str:
    return f"/folders/{quote(cwd, safe='')}/people"


HIRE = {"name": "Ava", "handle": "ava", "title": "R", "manager": "ngocbh"}


@pytest.fixture
def hiring(office):
    office.extras["hiring"] = Hiring(office.git)
    return office.extras["hiring"]


async def test_hiring_needs_a_hiring_desk(client):
    r = await client.post("/people", json=HIRE)
    assert (r.status_code, r.json()["error"]) == (501, "not_implemented")


async def test_hire_previews_then_commits(client, office, hiring, company):
    head = office.git.head()
    r = await client.post("/people", json=HIRE)
    assert r.status_code == 200 and r.json()["commit"] is None and r.json()["issues"] == []
    assert "id" not in r.json()["person"] and "b/people/ava/person.yaml" in r.json()["diff"]
    assert office.git.head() == head and not (company / "people/ava").exists()
    r = await client.post("/people", json=HIRE | {"confirm": True})
    assert r.status_code == 200 and r.json()["commit"] == office.git.head() != head
    assert sorted(p.name for p in (company / "people/ava").iterdir()) == ["person.yaml", "profile.md"]
    assert "ava" in [p["handle"] for p in (await client.get("/people")).json()]


async def test_a_confirm_without_a_preview_is_refused(client, office, hiring):
    head = office.git.head()
    r = await client.post("/people", json=HIRE | {"confirm": True})
    assert (r.status_code, r.json()["error"], office.git.head()) == (422, "lint_failed", head)


async def test_a_hire_with_lint_errors_previews_but_does_not_confirm(client, office, hiring):
    head = office.git.head()
    r = await client.post("/people", json=HIRE | {"manager": "ghost"})
    assert r.status_code == 200
    assert [(i["path"], i["code"], i["severity"]) for i in r.json()["issues"]] == [
        ("people/ava/person.yaml", "person.unknown_manager", "error")]
    r = await client.post("/people", json=HIRE | {"manager": "ghost", "confirm": True})
    assert (r.status_code, r.json()) == (422, {"error": "lint_failed", "message": "ghost"})
    r = await client.post("/people", json=HIRE | {"title": "Lead", "confirm": True})
    assert (r.status_code, r.json()["error"]) == (422, "lint_failed")
    assert office.git.head() == head


async def test_a_taken_handle_is_a_lint_error(client, office, hiring):
    head = office.git.head()
    r = await client.post("/people", json=HIRE | {"handle": "minh"})
    assert r.status_code == 200 and r.json()["issues"] == [
        {"path": "people/minh/person.yaml", "code": "person.duplicate_handle",
         "message": "@minh is already taken", "severity": "error"}]
    r = await client.post("/people", json=HIRE | {"handle": "minh", "confirm": True})
    assert (r.status_code, r.json()) == (422, {"error": "lint_failed", "message": "@minh is already taken"})
    assert office.git.head() == head


@pytest.mark.parametrize("body", [{k: v for k, v in HIRE.items() if k != "title"}, HIRE | {"handle": "Ava"},
                                  HIRE | {"kind": "human"}, HIRE | {"id": "ava"}])
async def test_a_malformed_hire_is_invalid_body(client, office, hiring, body):
    head = office.git.head()
    r = await client.post("/people", json=body)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")
    assert office.git.head() == head


async def test_people_lists_the_roster(client):
    r = await client.get("/people")
    assert r.status_code == 200
    assert [p["handle"] for p in r.json()] == ["minh", "ngocbh"]


async def test_people_shows_an_uncommitted_hand_edit(client, company):
    (company / "people/ava").mkdir()
    (company / "people/ava/person.yaml").write_text(yaml.safe_dump(
        {"handle": "ava", "name": "Ava", "kind": "agent", "title": "R", "manager": "ngocbh"}))
    assert "ava" in [p["handle"] for p in (await client.get("/people")).json()]


async def test_folder_people_most_recent_first(client, office):
    s = office.store
    s.touch_worked_folder("ngocbh", "/w/my app", at="2026-09-01T00:00:00.000Z")
    s.touch_worked_folder("minh", "/w/my app", at="2026-09-02T00:00:00.000Z")
    s.touch_worked_folder("minh", "/w/other", at="2026-09-03T00:00:00.000Z")
    s.touch_worked_folder("ghost", "/w/my app", at="2026-09-04T00:00:00.000Z")  # not in the repo
    r = await client.get(_folder("/w/my app"))
    assert r.status_code == 200
    assert [p["handle"] for p in r.json()] == ["minh", "ngocbh"]


async def test_folder_with_nobody_is_empty(client):
    assert (await client.get(_folder("/w/none"))).json() == []


async def test_people_are_served_without_their_password_hash(client, company):
    path = company / "people/ngocbh/person.yaml"
    path.write_text(path.read_text() + 'password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"\n')
    r = await client.get("/people")
    assert r.status_code == 200 and "scrypt" not in r.text
    assert {p["handle"]: p["password_hash"] for p in r.json()}["ngocbh"] is None
