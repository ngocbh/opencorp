"""GET /runs on the office socket."""

import pytest

from opencorp.runs.service import RunLogs
from opencorp.store import RunRow, new_id
from tests.store.conftest import session

T = "2026-10-20T10:00:00.000Z"


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


async def test_a_bearer_token_in_a_failure_never_reaches_get_runs(office, client):
    office.extras["runs"] = RunLogs(office)
    run_id = a_run(office)
    office.store.end_run(run_id, "failed", reason="AuthError: Bearer abcdefgh12345")  # stored as given
    r = await client.get("/runs")
    assert r.status_code == 200 and "abcdefgh12345" not in r.text and "Bearer (hidden)" in r.text


@pytest.mark.parametrize("params", [
    {"status": "busy"}, {"status": "failed,"}, {"status": "failed,busy"}, {"limit": "0"}, {"limit": "201"},
    {"limit": "x"}, {"since": "yesterday"}, {"until": "2026-10-20T10:00:00"}, {"since": "2026-13-01T00:00:00Z"},
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
