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


async def test_hire_previews_then_commits(client, office, hiring):
    head = office.git.head()
    r = await client.post("/people", json=HIRE)
    assert r.status_code == 200 and r.json()["commit"] is None and r.json()["issues"] == []
    assert office.git.head() == head
    pid = r.json()["person"]["id"]
    r = await client.post("/people", json=HIRE | {"id": pid, "confirm": True})
    assert r.status_code == 200 and r.json()["commit"] == office.git.head() != head
    assert pid in [p["id"] for p in (await client.get("/people")).json()]


async def test_a_hire_with_lint_errors_previews_but_does_not_confirm(client, office, hiring):
    head = office.git.head()
    r = await client.post("/people", json=HIRE | {"handle": "minh"})
    assert r.status_code == 200
    issue = r.json()["issues"][0]
    pid = r.json()["person"]["id"]
    assert issue == {"path": f"people/{pid}/person.yaml", "code": "person.duplicate_handle",
                     "message": "@minh is already used by minh", "severity": "error"}
    r = await client.post("/people", json=HIRE | {"handle": "minh", "id": pid, "confirm": True})
    assert (r.status_code, r.json()) == (422, {"error": "lint_failed", "message": "@minh is already used by minh"})
    r = await client.post("/people", json=HIRE | {"title": "Lead", "id": pid, "confirm": True})
    assert (r.status_code, r.json()["error"]) == (422, "lint_failed")
    assert office.git.head() == head


@pytest.mark.parametrize("body", [{k: v for k, v in HIRE.items() if k != "title"}, HIRE | {"handle": "Ava"},
                                  HIRE | {"kind": "human"}, HIRE | {"confirm": True}])
async def test_a_malformed_hire_is_invalid_body(client, office, hiring, body):
    head = office.git.head()
    r = await client.post("/people", json=body)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")
    assert office.git.head() == head


async def test_people_lists_the_roster(client):
    r = await client.get("/people")
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == ["minh", "ngocbh"]
    assert r.json()[0]["handle"] == "minh"


async def test_people_shows_an_uncommitted_hand_edit(client, company):
    (company / "people/ava").mkdir()
    (company / "people/ava/person.yaml").write_text(yaml.safe_dump(
        {"id": "ava", "handle": "ava", "name": "Ava", "kind": "agent", "title": "R", "manager": "ngocbh"}))
    assert "ava" in [p["id"] for p in (await client.get("/people")).json()]


async def test_folder_people_most_recent_first(client, office):
    s = office.store
    s.touch_worked_folder("ngocbh", "/w/my app", at="2026-09-01T00:00:00.000Z")
    s.touch_worked_folder("minh", "/w/my app", at="2026-09-02T00:00:00.000Z")
    s.touch_worked_folder("minh", "/w/other", at="2026-09-03T00:00:00.000Z")
    s.touch_worked_folder("ghost", "/w/my app", at="2026-09-04T00:00:00.000Z")  # not in the repo
    r = await client.get(_folder("/w/my app"))
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == ["minh", "ngocbh"]


async def test_folder_with_nobody_is_empty(client):
    assert (await client.get(_folder("/w/none"))).json() == []
