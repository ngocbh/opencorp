"""People routes."""

from urllib.parse import quote

import yaml


def _folder(cwd: str) -> str:
    return f"/folders/{quote(cwd, safe='')}/people"


async def test_hire_is_not_implemented_yet(client):
    r = await client.post("/people", json={"name": "Ava", "handle": "ava", "title": "R", "manager": "ngocbh"})
    assert r.status_code == 501
    assert r.json() == {"error": "not_implemented", "message": "POST /people is not implemented yet"}


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
