"""Profile routes over office.profile_store (a git-blob-versioned file store here)."""

import yaml

from tests.daemon.conftest import blob_id

MINH = "# Minh, Engineer\n"


async def test_get_profile(client):
    r = await client.get("/profiles/minh")
    assert r.status_code == 200
    assert r.json() == {"person": "minh", "text": MINH, "version": blob_id(MINH.encode()), "over_budget": False}


async def test_over_budget_uses_company_defaults(client, company):
    data = yaml.safe_load((company / "company.yaml").read_text())
    data["defaults"]["profile_max_chars"] = 5
    (company / "company.yaml").write_text(yaml.safe_dump(data))
    assert (await client.get("/profiles/minh")).json()["over_budget"] is True


async def test_unknown_person_is_404(client):
    for r in (await client.get("/profiles/ghost"),
              await client.put("/profiles/ghost", json={"text": "x", "base_version": "a" * 40})):
        assert r.status_code == 404 and r.json()["error"] == "not_found"


async def test_put_writes_emits_and_returns_the_profile(client, office, company, profile_stores):
    r = await client.put("/profiles/minh", json={"text": "# Minh\nterse\n", "base_version": blob_id(MINH.encode())})
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "# Minh\nterse\n" and body["version"] == blob_id(b"# Minh\nterse\n")
    assert (company / "people/minh/profile.md").read_text() == "# Minh\nterse\n"
    assert profile_stores["minh"].provenance == [{"source": "hand edit"}]
    event = office.store.events_after()[-1]
    assert (event.type, event.subject_id, event.data) == ("profile.updated", "minh", body)


async def test_put_with_stale_base_is_409_with_both_versions(client, company):
    stale = blob_id(b"old\n")
    r = await client.put("/profiles/minh", json={"text": "x", "base_version": stale})
    assert r.status_code == 409
    assert r.json() == {"expected": stale, "current": blob_id(MINH.encode())}
    assert (company / "people/minh/profile.md").read_text() == MINH


async def test_put_with_bad_version_is_422(client):
    r = await client.put("/profiles/minh", json={"text": "x", "base_version": "sha256:abc"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"


async def test_no_profile_store_is_501(client, office):
    office.profile_store = None
    assert (await client.get("/profiles/minh")).status_code == 501


async def test_put_checks_the_person_and_store_before_the_body(client, office):
    r = await client.put("/profiles/ghost", content=b"not json")
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    office.profile_store = None
    r = await client.put("/profiles/minh", content=b"not json")
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"
