"""People routes."""


async def test_hire_is_not_implemented_yet(client):
    r = await client.post("/people", json={"name": "Ava", "handle": "ava", "title": "R", "manager": "ngocbh"})
    assert r.status_code == 501
    assert r.json() == {"error": "not_implemented", "message": "POST /people is not implemented yet"}
