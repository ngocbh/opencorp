"""Device tokens at the office: enforcement, the acting person, the open probe, and device routes."""

import asyncio
import time
from urllib.parse import quote

import httpx
import yaml
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from agent_corp.auth.tokens import new_token, token_sha256
from agent_corp.daemon.app import create_app
from agent_corp.daemon.auth import acting_person
from agent_corp.install.launch import office_answers
from tests.company.conftest import _git

from .conftest import served


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def give_device(company, handle: str, name: str, token: str) -> None:
    """Commit a device for ``handle``, as a hand edit of the repo would."""
    path = company / "people" / handle / "person.yaml"
    data = yaml.safe_load(path.read_text())
    data["devices"] = [*data.get("devices", []), {"name": name, "token_sha256": token_sha256(token)}]
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    _git(company, "commit", "-qam", f"device for {handle}")


def add_human(company, handle: str) -> None:
    path = company / "people" / handle / "person.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(yaml.safe_dump({"handle": handle, "name": handle.title(), "kind": "human", "title": "R",
                                    "manager": "ngocbh"}, sort_keys=False))
    _git(company, "add", "-A")
    _git(company, "commit", "-qm", f"hire {handle}")


def devices(company, handle: str) -> list[dict] | None:
    return yaml.safe_load((company / "people" / handle / "person.yaml").read_text()).get("devices")


def subjects(company) -> list[str]:
    return _git(company, "log", "--format=%s").splitlines()


async def test_without_devices_an_unauthenticated_request_acts_as_the_ceo(client):
    r = await client.get("/whoami")
    assert (r.status_code, r.json()) == (200, {"person": "ngocbh", "device": None})


async def test_without_enforcement_a_token_is_still_checked(client, company):
    add_human(company, "ava")
    r = await client.get("/whoami", headers=bearer(new_token()))
    assert (r.status_code, r.json()["error"]) == (401, "bad_token")
    r = await client.get("/whoami", headers={"Authorization": "Basic x"})
    assert (r.status_code, r.json()["error"]) == (401, "bad_token")


async def test_once_a_human_has_a_device_unauthenticated_requests_are_refused(client, company):
    give_device(company, "ngocbh", "mac", new_token())
    for method, path in [("GET", "/people"), ("GET", "/whoami"), ("POST", "/sessions")]:
        r = await client.request(method, path)
        assert r.status_code == 401
        assert r.json() == {"error": "unauthenticated", "message": "this office needs a device token; run `ac login`"}


async def test_a_token_acts_as_its_person(client, company):
    add_human(company, "ava")
    ava = new_token()
    give_device(company, "ava", "pc", ava)
    assert (await client.get("/whoami", headers=bearer(ava))).json() == {"person": "ava", "device": "pc"}
    assert (await client.get("/people", headers=bearer(ava))).status_code == 200
    r = await client.get("/people", headers=bearer(new_token()))
    assert (r.status_code, r.json()["error"]) == (401, "bad_token")


async def test_a_refusal_never_echoes_the_token(client, company):
    give_device(company, "ngocbh", "mac", new_token())
    token = new_token()
    for header in (f"Bearer {token}", f"Bearer {token}!", token):
        r = await client.get("/whoami", headers={"Authorization": header})
        assert r.status_code == 401 and token not in r.text


async def test_the_health_probe_answers_without_a_token(client, company):
    give_device(company, "ngocbh", "mac", new_token())
    assert ((await client.get("/health")).status_code, (await client.get("/health")).json()) == (200, {"ok": True})
    assert (await client.head("/health")).status_code == 200
    assert (await client.get("/health/x")).status_code == 401


async def test_a_route_reads_the_body_after_the_check(office, company):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)

    async def echo(request: Request) -> JSONResponse:
        return JSONResponse({"person": acting_person(request), "body": (await request.body()).decode()})

    app = create_app(office)
    app.router.routes.append(Route("/echo", echo, methods=["POST"]))
    await office.start()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            r = await c.post("/echo", content=b"hello", headers=bearer(token))
    finally:
        await office.stop()
    assert r.json() == {"person": "ngocbh", "body": "hello"}


async def test_a_new_device_counts_once_it_is_committed(client, company):
    assert (await client.get("/whoami")).status_code == 200
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    assert (await client.get("/whoami")).status_code == 401
    assert (await client.get("/whoami", headers=bearer(token))).json()["person"] == "ngocbh"


async def test_an_uncommitted_device_does_not_count(client, company):
    token = new_token()
    path = company / "people/ngocbh/person.yaml"
    path.write_text(path.read_text() + f"devices:\n- name: mac\n  token_sha256: {token_sha256(token)}\n")
    assert (await client.get("/whoami")).json()["person"] == "ngocbh"
    assert (await client.get("/whoami", headers=bearer(token))).status_code == 401


async def test_the_event_stream_is_checked_like_any_get(office, company, short_dir):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    async with served(office, short_dir / "o.sock") as c:
        r = await c.get("/events")
        assert (r.status_code, r.json()["error"]) == (401, "unauthenticated")
        async with c.stream("GET", "/events", headers=bearer(token)) as stream:
            assert stream.status_code == 200
            async for line in stream.aiter_lines():
                assert line == ": connected"
                break


async def test_tokens_work_on_a_real_socket(office, company, short_dir):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    async with served(office, short_dir / "o.sock") as c:
        assert (await c.get("/health")).status_code == 200
        r = await c.get(f"/folders/{quote('/tmp/a b', safe='')}/people", headers=bearer(token))
        assert r.status_code == 200


async def test_the_check_adds_well_under_a_millisecond(client, company):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    await client.get("/whoami", headers=bearer(token))  # load the roster
    n = 300

    async def timed(path: str, headers=None) -> float:
        start = time.perf_counter()
        for _ in range(n):
            await client.get(path, headers=headers)
        return (time.perf_counter() - start) / n

    open_ = await timed("/health")  # skips the check; otherwise as small a route as /whoami
    checked = await timed("/whoami", bearer(token))
    assert checked - open_ < 0.5e-3


# Device routes.


def device(name: str, token: str) -> dict:
    return {"name": name, "token_sha256": token_sha256(token)}


async def test_bootstrap_an_unauthenticated_request_adds_the_first_device(client, company):
    token = new_token()
    r = await client.post("/people/ngocbh/devices", json=device("mac", token))
    assert r.status_code == 200 and r.json()["devices"] == [device("mac", token)]
    assert subjects(company)[0] == "devices(@ngocbh): add mac"
    assert devices(company, "ngocbh") == [device("mac", token)]
    assert (await client.get("/people")).status_code == 401  # tokens are needed now
    assert (await client.get("/people", headers=bearer(token))).status_code == 200


async def test_a_device_change_answers_without_the_password_hash(client, company):
    path = company / "people/ngocbh/person.yaml"
    path.write_text(path.read_text() + 'password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"\n')
    r = await client.post("/people/ngocbh/devices", json=device("mac", new_token()))
    assert r.status_code == 200 and "scrypt" not in r.text
    assert "scrypt" in path.read_text()  # kept in the file


async def test_a_human_adds_and_removes_their_own_devices(client, company):
    add_human(company, "ava")
    pc, laptop = new_token(), new_token()
    give_device(company, "ava", "pc", pc)
    r = await client.post("/people/ava/devices", json=device("laptop", laptop), headers=bearer(pc))
    assert r.status_code == 200 and r.json()["devices"] == [device("pc", pc), device("laptop", laptop)]
    r = await client.delete("/people/ava/devices/pc", headers=bearer(laptop))
    assert r.status_code == 200 and r.json()["devices"] == [device("laptop", laptop)]
    assert subjects(company)[:2] == ["devices(@ava): remove pc", "devices(@ava): add laptop"]
    assert (await client.get("/whoami", headers=bearer(pc))).status_code == 401


async def test_subjects_never_carry_a_hash(client, company):
    token = new_token()
    await client.post("/people/ngocbh/devices", json=device("mac", token))
    await client.delete("/people/ngocbh/devices/mac", headers=bearer(token))
    log = _git(company, "log", "--format=%B")
    assert token_sha256(token) not in log and token not in log


async def test_the_same_device_again_changes_nothing_and_a_new_hash_conflicts(client, company):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    head = subjects(company)
    r = await client.post("/people/ngocbh/devices", json=device("mac", token), headers=bearer(token))
    assert r.status_code == 200 and r.json()["devices"] == [device("mac", token)]
    assert subjects(company) == head
    r = await client.post("/people/ngocbh/devices", json=device("mac", new_token()), headers=bearer(token))
    assert (r.status_code, r.json()["error"]) == (409, "device_exists")
    assert subjects(company) == head


async def test_a_token_already_listed_is_refused(client, company):
    add_human(company, "ava")
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    r = await client.post("/people/ngocbh/devices", json=device("other", token), headers=bearer(token))
    assert (r.status_code, r.json()["error"]) == (409, "token_in_use")
    r = await client.post("/people/ava/devices", json=device("pc", token), headers=bearer(token))
    assert (r.status_code, r.json()["error"]) == (409, "token_in_use")


async def test_the_ceo_changes_anyones_devices_and_others_cannot(client, company):
    add_human(company, "ava")
    add_human(company, "bo")
    ceo, ava, bo = new_token(), new_token(), new_token()
    give_device(company, "ngocbh", "mac", ceo)
    give_device(company, "bo", "pc", bo)
    r = await client.post("/people/ava/devices", json=device("pc", ava), headers=bearer(ceo))
    assert r.status_code == 200
    r = await client.post("/people/ava/devices", json=device("x", new_token()), headers=bearer(bo))
    assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    r = await client.delete("/people/ngocbh/devices/mac", headers=bearer(ava))
    assert (r.status_code, r.json()["error"]) == (403, "forbidden")
    r = await client.delete("/people/bo/devices/pc", headers=bearer(ceo))
    assert r.status_code == 200 and r.json()["devices"] == []


async def test_agents_have_no_devices(client):
    r = await client.post("/people/minh/devices", json=device("box", new_token()))
    assert (r.status_code, r.json()["error"]) == (422, "not_a_human")


async def test_unknown_people_and_devices_are_404(client, company):
    r = await client.post("/people/ghost/devices", json=device("mac", new_token()))
    assert (r.status_code, r.json()["error"]) == (404, "not_found")
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    r = await client.delete("/people/ngocbh/devices/pc", headers=bearer(token))
    assert (r.status_code, r.json()["error"]) == (404, "not_found")


async def test_a_malformed_device_is_invalid_body(client):
    r = await client.post("/people/ngocbh/devices", json={"name": "Mac", "token_sha256": "A" * 64})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")


async def test_removing_the_last_device_turns_enforcement_off(client, company):
    token = new_token()
    give_device(company, "ngocbh", "mac", token)
    r = await client.delete("/people/ngocbh/devices/mac", headers=bearer(token))
    assert r.status_code == 200
    assert devices(company, "ngocbh") is None
    assert (await client.get("/whoami")).json() == {"person": "ngocbh", "device": None}


async def test_the_liveness_probe_works_once_tokens_are_needed(office, company, short_dir):
    give_device(company, "ngocbh", "mac", new_token())
    async with served(office, short_dir / "o.sock"):
        assert await asyncio.to_thread(office_answers, short_dir / "o.sock")
