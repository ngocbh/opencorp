"""The office app: error bodies, absolute-form targets, and start/stop."""

import asyncio
import logging
import threading
import time

import httpx
import pytest
import uvicorn

from agent_corp.daemon.app import AbsoluteFormPaths, OfficePaths, create_app
from agent_corp.daemon.main import OfficeServer, bind_socket
from tests.daemon.conftest import FakePool


async def test_unknown_route_is_an_api_error(client):
    r = await client.get("/nope")
    assert r.status_code == 404
    assert r.json() == {"error": "no_route", "message": "no route GET /nope"}


def test_paths_layout(tmp_path):
    p = OfficePaths(tmp_path)
    assert p.company == tmp_path / "company"
    assert p.store == tmp_path / "office" / "store.sqlite"
    assert p.socket == tmp_path / "office" / "office.sock"
    assert p.pidfile == tmp_path / "office" / "office.pid"
    assert p.worktrees == tmp_path / "office" / "worktrees"
    assert p.run_dir("S1") == tmp_path / "office" / "runs" / "S1"
    assert (p.memory, p.secrets) == (tmp_path / "office" / "memory", tmp_path / "office" / "secrets")


async def _call(app, scope):
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        pass

    await app(scope, receive, send)


def _scope(path: str, raw: bytes) -> dict:
    return {"type": "http", "method": "GET", "path": path, "raw_path": raw, "query_string": b"",
            "headers": [], "scheme": "http", "server": None, "client": None, "root_path": ""}


async def test_absolute_form_target_is_rewritten_to_its_path():
    seen = []

    async def inner(scope, receive, send):
        seen.append((scope["path"], scope["raw_path"]))

    mw = AbsoluteFormPaths(inner)
    await _call(mw, _scope("http://office/sessions/S1", b"http://office/sessions/S1"))
    await _call(mw, _scope("http://office", b"http://office"))
    await _call(mw, _scope("/people", b"/people"))
    assert seen == [("/sessions/S1", b"/sessions/S1"), ("/", b"/"), ("/people", b"/people")]


async def test_start_and_stop_run_callbacks_and_close_workers(office):
    calls = []
    office.workers = FakePool()
    office.on_start += [lambda: calls.append("s1"), _async(calls, "s2")]
    office.on_stop += [lambda: calls.append("t1"), lambda: calls.append("t2")]
    await office.start()
    await office.stop()
    assert calls == ["s1", "s2", "t2", "t1"]
    assert office.workers.closed == 1


async def test_failed_start_stops_the_office(office):
    calls = []

    def fail():
        raise RuntimeError("no model key")

    office.workers = FakePool()
    office.on_start += [lambda: calls.append("s1"), fail]
    office.on_stop += [lambda: calls.append("t1")]
    with pytest.raises(RuntimeError, match="no model key"):
        await office.start()
    assert calls == ["s1", "t1"]
    assert office.workers.closed == 1
    assert await office.bus.subscribe().next(timeout=1) is None  # the bus is closed


async def test_lifespan_starts_and_stops_the_office(office):
    office.workers = FakePool()
    app = create_app(office)
    async with app.router.lifespan_context(app):
        assert office.bus.attached
    assert office.workers.closed == 1


def _async(calls, name):
    async def cb():
        calls.append(name)
    return cb


# (method, path, body) for every non-SSE route in the WP1 route table. GET /events is
# covered over a real socket in test_routes_events.py.
ULID = "01JA1H0000000000000000000A"
TABLE = [
    ("GET", "/people", None),
    ("GET", "/folders/%2Fw%2Fapp/people", None),
    ("POST", "/people", {"name": "Ava", "handle": "ava", "title": "R", "manager": "ngocbh"}),
    ("GET", "/sessions", None),
    ("POST", "/sessions", {"person": "minh", "cwd": "/w/app"}),
    ("GET", f"/sessions/{ULID}", None),
    ("GET", f"/sessions/{ULID}/messages", None),
    ("POST", f"/sessions/{ULID}/prompt", {"text": "hi"}),
    ("POST", f"/sessions/{ULID}/steer", {"text": "hi"}),
    ("POST", f"/sessions/{ULID}/interrupt", None),
    ("POST", f"/sessions/{ULID}/end", None),
    ("POST", f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 10}),
    ("GET", f"/work-items/{ULID}", None),
    ("GET", f"/work-items/{ULID}/comments", None),
    ("GET", "/questions", None),
    ("GET", f"/questions/{ULID}", None),
    ("POST", f"/questions/{ULID}/answer", {"answer": "a", "answer_kind": "text"}),
    ("POST", f"/questions/{ULID}/side", {"text": "why?"}),
    ("POST", f"/questions/{ULID}/send-back", {"note": "more"}),
    ("POST", f"/questions/{ULID}/stop", None),
    ("GET", "/profiles/minh", None),
    ("PUT", "/profiles/minh", {"text": "x", "base_version": "a" * 40}),
    ("POST", "/profiles/minh/manager", {"text": "tidy"}),
    ("GET", "/profiles/minh/proposals", None),
    ("POST", f"/profile-proposals/{ULID}/apply", None),
    ("POST", "/feedback", {"session_id": ULID, "text": "be brief"}),
    ("GET", f"/debriefs/{ULID}", None),
    ("POST", f"/debriefs/{ULID}/confirm", {"follow_ups": []}),
]


@pytest.mark.parametrize(("method", "path", "body"), TABLE)
async def test_every_table_route_is_served(client, method, path, body):
    r = await client.request(method, path, json=body)
    assert r.headers["content-type"].startswith("application/json")
    if r.status_code >= 400:
        assert r.json().get("error") not in {"no_route", "method_not_allowed"}, r.json()


async def test_wrong_method_is_405_with_every_allowed_method(client):
    r = await client.delete("/people")
    assert r.status_code == 405 and r.json()["error"] == "method_not_allowed"
    assert r.headers["allow"] == "GET, HEAD, POST"  # from both /people routes
    r = await client.post(f"/sessions/{ULID}/messages")
    assert r.status_code == 405 and r.headers["allow"] == "GET, HEAD"


async def test_unexpected_error_is_a_500_api_error(office, monkeypatch):
    def boom(session_id):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(office.store, "get_session", boom)
    transport = httpx.ASGITransport(app=create_app(office), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        r = await c.get(f"/sessions/{ULID}")
    assert r.status_code == 500
    assert r.json() == {"error": "internal_error", "message": "internal error"}


class _SlowHandler(logging.Handler):
    def emit(self, record):
        time.sleep(0.2)


def test_a_500_closes_its_connection_so_the_next_request_works(office, short_dir, monkeypatch):
    def boom(session_id):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(office.store, "get_session", boom)
    # The server runs in its own thread and logs slowly, as a real daemon logging a long
    # traceback does: uvicorn closes the connection only after logging, so without
    # "connection: close" the client reuses it in the meantime.
    handler = _SlowHandler()
    logging.getLogger("uvicorn.error").addHandler(handler)
    sock = bind_socket(short_dir / "o.sock")
    server = OfficeServer(uvicorn.Config(create_app(office), lifespan="on", log_level="warning"), office)
    thread = threading.Thread(target=lambda: asyncio.run(server.serve(sockets=[sock])))
    thread.start()
    try:
        while not server.started:
            assert thread.is_alive()
            time.sleep(0.01)
        transport = httpx.HTTPTransport(uds=str(short_dir / "o.sock"))
        with httpx.Client(transport=transport, base_url="http://localhost", timeout=10) as c:
            r = c.get(f"/sessions/{ULID}")
            assert r.status_code == 500 and r.headers["connection"] == "close"
            assert c.get("/people").status_code == 200
    finally:
        logging.getLogger("uvicorn.error").removeHandler(handler)
        server.should_exit = True
        thread.join(10)
