"""The office app: error bodies, absolute-form targets, and start/stop."""

from agent_corp.daemon.app import AbsoluteFormPaths, OfficePaths, create_app
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
