"""HQ's Source routes: GET /api/company/tree and /api/company/file."""

import pytest
import yaml

from opencorp.auth.passwords import hash_password
from tests.company.conftest import _git
from tests.hq.conftest import hq_client

PROFILE = "people/minh/profile.md"


async def test_both_routes_need_a_session(web):
    for path in ("/api/company/tree", f"/api/company/file?at={'a' * 40}&path={PROFILE}"):
        r = await web.get(path)
        assert (r.status_code, r.json()["error"]) == (401, "sign_in_required"), path


async def test_the_tree_and_a_file_at_its_commit(signed_in, office):
    r = await signed_in.get("/api/company/tree")
    tree = r.json()
    assert r.status_code == 200 and tree["commit"]["id"] == office.git.head()
    assert {"path": PROFILE, "type": "file", "size": len("# Minh, Engineer\n")} in tree["entries"]
    r = await signed_in.get("/api/company/file", params={"at": tree["commit"]["id"], "path": PROFILE})
    assert r.status_code == 200
    assert r.json() == {"path": PROFILE, "commit": office.git.head(), "content": "text", "text": "# Minh, Engineer\n",
                        "target": None, "reason": None, "rewritten": False}


@pytest.mark.parametrize("params,status,code", [
    ({"path": PROFILE}, 409, "stale_commit"),
    ({"at": "HEAD", "path": PROFILE}, 409, "stale_commit"),
    ({"at": "{head}"}, 400, "bad_path"),
    ({"at": "{head}", "path": "people/../company.yaml"}, 400, "bad_path"),
    ({"at": "{head}", "path": "people"}, 404, "no_file"),
    ({"at": "{head}", "path": ":company.yaml"}, 404, "no_file"),
])
async def test_file_errors(signed_in, office, params, status, code):
    await signed_in.get("/api/company/tree")
    params = {k: v.format(head=office.git.head()) for k, v in params.items()}
    r = await signed_in.get("/api/company/file", params=params)
    assert (r.status_code, r.json()["error"]) == (status, code)


async def test_the_tree_is_at_the_sessions_commit(signed_in, hq, office, company, monkeypatch):
    old = await hq.snapshots.head()
    (company / PROFILE).write_text("# moved on\n")
    _git(company, "commit", "-qam", "move HEAD")

    async def head():
        return old

    monkeypatch.setattr(hq.snapshots, "head", head)  # the commit sessions are checked against
    r = await signed_in.get("/api/company/tree")
    assert r.json()["commit"]["id"] == old.sha != office.git.head()


async def test_the_guard_applies(office, hq, signed_in):
    async with hq_client(office, hq, origin="http://evil.example") as c:
        c.cookies = signed_in.cookies
        for path in ("/api/company/tree", "/api/company/file"):
            r = await c.get(path)
            assert r.status_code == 403, path


async def test_files_reach_the_browser_as_stored(signed_in, company):
    path = company / "people" / "ngocbh" / "person.yaml"
    data = yaml.safe_load(path.read_text())
    data["devices"] = [{"name": "mac", "token_sha256": "e" * 64}]  # a device, not a password: the session lives on
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    pasted = f"pasted {hash_password('a secret')}\n"
    (company / PROFILE).write_text(pasted)
    _git(company, "commit", "-qam", "a device and a pasted hash")
    at = (await signed_in.get("/api/company/tree")).json()["commit"]["id"]
    person = (await signed_in.get("/api/company/file", params={"at": at, "path": "people/ngocbh/person.yaml"})).json()
    assert (person["content"], person["text"], person["rewritten"]) == ("text", path.read_text(), False)
    assert "e" * 64 in person["text"]
    profile = (await signed_in.get("/api/company/file", params={"at": at, "path": PROFILE})).json()
    assert profile["text"] == pasted
