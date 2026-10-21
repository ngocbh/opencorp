"""GET /runs and one run's routes on the office socket."""

import pytest

from opencorp.runs.service import RunLogs
from opencorp.store import RunRow, new_id
from opencorp.runs import reader as reader_mod
from tests.runs.logs import chat_log, failed, line, run_started, started, succeeded
from tests.store.conftest import session

T = "2026-10-20T10:00:00.000Z"
KEY = "conn-key-5f3a9c1e7b2d4a60"


def a_run(office, **over):
    s = office.store.create_session(session(status="ended"))
    run_id = new_id()
    office.store.add_run(RunRow(**{"run_id": run_id, "session_id": s.id, "flow": "chat",
                                   "flow_path": "shared/flows/chat.yaml", "driver": "ngocbh", "parent_run_id": None,
                                   "launched_at": T, **over}))
    return run_id


def ids(r):
    return [x["run_id"] for x in r.json()["runs"]]


async def test_get_runs_lists_top_level_runs_and_one_runs_children(office, client):
    office.extras["runs"] = RunLogs(office)
    top = a_run(office)
    kid = a_run(office, flow="side_chat", parent_run_id=top)
    r = await client.get("/runs")
    assert r.status_code == 200 and ids(r) == [top] and r.json()["next"] is None
    assert (r.json()["runs"][0]["children"], r.json()["runs"][0]["children_total"]) == ([], 1)
    kids = await client.get("/runs", params={"parent": top})
    assert kids.status_code == 200 and ids(kids) == [kid] and kids.json()["next"] is None
    missing = await client.get("/runs", params={"parent": new_id()})
    assert (missing.status_code, missing.json()["error"]) == (404, "not_found")


async def test_get_runs_filters_by_statuses_and_a_launch_range_and_pages(office, client):
    office.extras["runs"] = RunLogs(office)
    old = a_run(office, launched_at="2026-10-01T10:00:00.000Z")
    failed = [a_run(office) for _ in range(3)]
    for run_id in [old, *failed]:
        office.store.end_run(run_id, "failed", reason="worker stopped")
    done = a_run(office)
    office.store.end_run(done, "finished")
    a_run(office, launched_at="2026-10-22T10:00:00.000Z")
    query = {"status": "failed,finished", "since": "2026-10-13T10:00:00Z", "until": "2026-10-21T00:00:00+00:00"}
    one = await client.get("/runs", params={**query, "limit": "2"})
    assert ids(one) == [done, failed[2]] and one.json()["next"] == failed[2]
    two = await client.get("/runs", params={**query, "limit": "2", "before": one.json()["next"]})
    assert ids(two) == failed[1::-1] and two.json()["next"] is None
    assert ids(await client.get("/runs", params={**query, "q": failed[0][-6:].lower()})) == [failed[0]]
    kid = a_run(office, flow="side_chat", parent_run_id=done, driver="lan")
    for params in ({"person": "lan"}, {"person": "lan", **query}):
        assert ids(await client.get("/runs", params=params)) == [done]
    assert ids(await client.get("/runs", params={"parent": done, **query})) == []
    assert ids(await client.get("/runs", params={"parent": done, "status": "running,interrupted"})) == [kid]


async def test_a_failure_reaches_get_runs_as_stored(office, client):
    office.extras["runs"] = RunLogs(office)
    run_id = a_run(office)
    office.store.end_run(run_id, "failed", reason="AuthError: Bearer abcdefgh12345")
    r = await client.get("/runs")
    assert r.status_code == 200 and r.json()["runs"][0]["reason"] == "AuthError: Bearer abcdefgh12345"


@pytest.mark.parametrize("params", [
    {"status": "busy"}, {"status": "failed,"}, {"status": "failed,busy"}, {"limit": "0"}, {"limit": "201"},
    {"limit": "x"}, {"limit": "+5"}, {"limit": " 5"}, {"limit": "1_0"}, {"limit": "9" * 5000}, {"since": "yesterday"},
    {"until": "2026-10-20T10:00:00"}, {"since": "2026-13-01T00:00:00Z"},
    {"parent": "01K0000000000000000000000Z", "status": "busy"}, {"parent": "01K0000000000000000000000Z", "limit": "0"},
])
async def test_get_runs_refuses_a_bad_status_limit_or_time(office, client, params):
    office.extras["runs"] = RunLogs(office)
    r = await client.get("/runs", params=params)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")


async def test_get_runs_without_run_logs_is_not_implemented(client):
    assert (await client.get("/runs")).status_code == 501


async def test_a_parent_with_more_children_than_sqlite_binds_at_once_lists(office, client):
    office.extras["runs"] = RunLogs(office)
    top = a_run(office)
    side = office.store.create_session(session(kind="side", status="ended"))
    with office.store.transaction() as tx:
        for _ in range(33_000):
            tx.execute("INSERT INTO runs (run_id, session_id, flow, flow_path, driver, parent_run_id, launched_at) "
                       "VALUES (?, ?, 'side_chat', 'shared/flows/side_chat.yaml', 'lan', ?, ?)",
                       (new_id(), side.id, top, T))
    r = await client.get("/runs", params={"person": "lan", "since": "2026-10-13T10:00:00.000Z"})
    assert r.status_code == 200 and ids(r) == [top] and r.json()["runs"][0]["children_total"] == 33_000
    r = await client.get("/runs", params={"parent": top, "status": "interrupted", "limit": "200"})
    assert r.status_code == 200 and len(r.json()["runs"]) == 200


async def test_get_runs_recent_is_open_runs_of_any_age_and_runs_started_since(office, client):
    office.extras["runs"] = RunLogs(office)
    s = office.store.create_session(session(status="idle"))
    old_open = new_id()
    office.store.add_session_run(s.id, old_open)
    office.store.add_run(RunRow(old_open, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None,
                                "2026-09-01T10:00:00.000Z"))
    old_closed = a_run(office, launched_at="2026-09-01T10:00:00.000Z")
    office.store.end_run(old_closed, "finished")
    recent = a_run(office)
    office.store.end_run(recent, "failed", reason="worker stopped")
    r = await client.get("/runs", params={"recent": "2026-10-13T10:00:00Z", "limit": "50"})
    assert r.status_code == 200 and ids(r) == [recent, old_open]
    r = await client.get("/runs", params={"recent": "2026-10-13T10:00:00Z", "status": "failed"})
    assert ids(r) == [recent]
    kid = a_run(office, flow="side_chat", parent_run_id=old_closed, launched_at="2026-10-15T10:00:00.000Z")
    r = await client.get("/runs", params={"parent": old_closed, "recent": "2026-10-13T10:00:00Z"})
    assert ids(r) == [kid]


@pytest.mark.parametrize("params", [
    {"recent": "2026-10-13T10:00:00Z", "since": "2026-10-13T10:00:00Z"},
    {"recent": "2026-10-13T10:00:00Z", "until": "2026-10-13T10:00:00Z"},
    {"recent": "last week"}, {"recent": "2026-10-13T10:00:00"},
    {"parent": "01K0000000000000000000000Z", "recent": "2026-10-13T10:00:00Z", "since": "2026-10-13T10:00:00Z"},
])
async def test_get_runs_refuses_a_bad_recent_or_recent_with_a_range(office, client, params):
    office.extras["runs"] = RunLogs(office)
    r = await client.get("/runs", params=params)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")


def with_log(office, *, schema=9, log=True):
    """Run Logs on the office (made once), and a run whose log is a synthetic chat log, one line in ``schema``, the
    bytes ``log``, or none."""
    runs = office.extras.get("runs")
    if not isinstance(runs, RunLogs):
        office.extras["runs"] = runs = RunLogs(office)
    s = office.store.create_session(session(status="ended", repo_commit=office.git.head()))
    row = RunRow(new_id(), s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None, T)
    office.store.add_run(row)
    if log:
        path = runs.log_path(row)
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(log, bytes):
            path.write_bytes(log)
        elif schema == 9:
            chat_log(path)
        else:
            path.write_bytes(line(0, "run_started", {}, schema=schema))
    return row.run_id


async def test_one_runs_routes(office, client):
    run_id = with_log(office)
    assert (await client.get(f"/runs/{run_id}")).json()["log_state"] == "ok"
    nodes = (await client.get(f"/runs/{run_id}/nodes", params={"limit": 2})).json()
    assert [n["node_id"] for n in nodes["nodes"]] == ["chat#2/ask", "chat#1/reply"] and nodes["next_before"] == 13
    assert {n["kind"] for n in nodes["nodes"]} == {None}
    events = (await client.get(f"/runs/{run_id}/events", params={"after": 13})).json()
    assert [e["seq"] for e in events["events"]] == [14, 15] and events["next_after"] is None
    assert (await client.get(f"/runs/{run_id}/events/3")).json()["kind"] == "node_started"
    log = await client.get(f"/runs/{run_id}/log")
    assert log.headers["content-disposition"] == f'attachment; filename="{run_id}.jsonl"'
    assert log.headers["cache-control"] == "no-store"
    runs = office.extras["runs"]
    assert log.content == runs.log_path(office.store.get_run(run_id)).read_bytes()  # as stored
    assert len(log.content.splitlines()) == 16


async def test_one_runs_routes_say_what_went_wrong(office, client):
    run_id = with_log(office)
    assert (await client.get(f"/runs/{new_id()}")).status_code == 404
    assert (await client.get(f"/runs/{run_id}/events/99")).json()["error"] == "not_found"
    assert (await client.get(f"/runs/{run_id}/events", params={"limit": "501"})).status_code == 422
    old = with_log(office, schema=8)
    r = await client.get(f"/runs/{old}/nodes")
    assert (r.status_code, r.json()["error"]) == (409, "unsupported_schema")
    assert (await client.get(f"/runs/{old}/log")).status_code == 200  # the download doesn't need the schema
    none = with_log(office, log=False)
    r = await client.get(f"/runs/{none}/events")
    assert (r.status_code, r.json()["error"]) == (404, "no_log")


async def test_one_runs_routes_while_its_log_is_first_read(office, client):
    run_id = with_log(office)

    async def not_yet(path, *, wait):
        return None

    office.extras["runs"].reader.ready = not_yet
    assert (await client.get(f"/runs/{run_id}/nodes")).json()["indexing"] is True
    assert (await client.get(f"/runs/{run_id}/events")).json()["indexing"] is True
    r = await client.get(f"/runs/{run_id}/events/3")
    assert (r.status_code, r.json()["error"]) == (503, "indexing")


async def test_one_huge_record_is_a_size_stub(office, client, monkeypatch):
    big = succeeded(2, "a", {"output": "b" * 5000})
    run_id = with_log(office, log=run_started(0) + started(1, "a") + big)
    monkeypatch.setattr(reader_mod, "HUGE_LINE", 4096)
    r = await client.get(f"/runs/{run_id}/events/2")
    assert r.status_code == 200
    got = r.json()
    assert (got["kind"], got.get("payload"), got["size"]) == ("node_succeeded", None, len(big))


async def test_a_node_error_is_shown_as_stored_cut_to_200(office, client):
    run_id = with_log(office, log=run_started(0) + started(1, "a") + failed(2, "a", "x" * 186 + KEY))
    r = await client.get(f"/runs/{run_id}/nodes")
    assert r.json()["nodes"][0]["error"] == ("x" * 186 + KEY)[:199] + "…"


async def test_a_log_removed_before_it_streams_has_no_log(office, client):
    run_id = with_log(office)
    runs = office.extras["runs"]
    real = runs._log

    async def removing(rid):  # between the lookup and the read
        found = await real(rid)
        found[1].unlink()
        return found

    runs._log = removing
    r = await client.get(f"/runs/{run_id}/log")
    assert (r.status_code, r.json()["error"]) == (404, "no_log")


async def test_a_schema_that_isnt_a_number_isnt_echoed(office, client):
    run_id = with_log(office, log=b'{"kind":"run_started","payload":{},"schema":"' + KEY.encode() + b'","seq":0}\n')
    head, nodes = await client.get(f"/runs/{run_id}"), await client.get(f"/runs/{run_id}/nodes")
    assert (nodes.status_code, nodes.json()["error"]) == (409, "unsupported_schema")
    assert KEY not in head.text + nodes.text
    assert head.json()["log_message"] == "This log uses a run-log schema this office can't read"
