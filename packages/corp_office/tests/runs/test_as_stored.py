"""Run Logs show a run's log and reasons as they are stored: records, node errors and the download untouched,
reasons and node errors only cut for length."""

import json
from types import SimpleNamespace

from opencorp.runs.service import RunLogs
from opencorp.store import RunRow, new_id
from tests.runs.logs import failed, line, run_started, started
from tests.store.conftest import session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"
SECRETS = ("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 Bearer abcdefgh12345 "
           "https://kai:hunter2hunter2@example.com act_" + "A" * 43 + " $argon2id$v=19$m=65536$c2FsdA$aGFzaA")
"""What the scrub used to hide: a provider key, a bearer token, a URL password, a device token and a password hash."""


def a_run(store, tmp_path, *, reason=None, log=b""):  # noqa: F811
    """Run Logs over ``store``, and a failed run with ``reason`` and ``log`` as its log's bytes."""
    runs = RunLogs(SimpleNamespace(store=store, extras={}, paths=SimpleNamespace(run_dir=lambda sid: tmp_path / sid)))
    s = store.create_session(session(status="ended"))
    run_id = new_id()
    store.add_session_run(s.id, run_id)
    row = store.add_run(RunRow(run_id, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None, T))
    store.end_run(run_id, "failed", reason=reason, failed_node="chat")
    path = runs.log_path(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(log)
    return runs, run_id


def secret_log():
    payload = {"node_id": "chat", "value": {"api_key": SECRETS, "headers": {"Authorization": SECRETS}},
               "evidence": {"password": SECRETS}, "forward_capture": None, "commit_target": "chat"}
    return (run_started(0) + started(1, "chat") + line(2, "node_succeeded", payload) + started(3, "chat")
            + failed(4, "chat", f"401 for {SECRETS}"))


async def test_records_come_back_as_stored(store, tmp_path):  # noqa: F811
    log = secret_log()
    runs, run_id = a_run(store, tmp_path, log=log)
    stored = json.loads(log.splitlines()[2])["payload"]
    page = await runs.events(run_id, after=None, limit=10)
    shown = page.events[2]
    assert shown.payload == {**stored, "evidence": None} and shown.evidence_left_out
    assert (await runs.event(run_id, 2)).payload == stored
    assert all(e.withheld is None for e in page.events)


async def test_the_download_is_the_log_byte_for_byte(store, tmp_path):  # noqa: F811
    log = secret_log() + b"not json\n"
    runs, run_id = a_run(store, tmp_path, log=log)
    assert b"".join(await runs.log_lines(run_id)) == log


async def test_a_node_error_is_only_cut_for_length(store, tmp_path):  # noqa: F811
    runs, run_id = a_run(store, tmp_path, log=secret_log())
    page = await runs.nodes(run_id, before=None, limit=10)
    assert page.nodes[0].error == f"401 for {SECRETS}"
    long = "x" * 150 + SECRETS
    runs, run_id = a_run(store, tmp_path, log=run_started(0) + started(1, "chat") + failed(2, "chat", long))
    (node,) = (await runs.nodes(run_id, before=None, limit=10)).nodes
    assert node.error == long[:199] + "…"


async def test_a_reason_is_only_cut_for_length(store, tmp_path):  # noqa: F811
    runs, run_id = a_run(store, tmp_path, reason=f"401 for {SECRETS}")
    (row,) = (await runs.page()).runs
    assert row.reason == f"401 for {SECRETS}"
    assert (await runs.detail(run_id)).run.reason == f"401 for {SECRETS}"
    long = "y" * 150 + SECRETS
    runs, run_id = a_run(store, tmp_path, reason=long)
    assert (await runs.detail(run_id)).run.reason == long[:199] + "…"


async def test_a_stored_cut_is_shown_as_stored(store, tmp_path):  # noqa: F811
    runs, run_id = a_run(store, tmp_path, reason="worker stopped: hunter2hunt…")
    assert (await runs.detail(run_id)).run.reason == "worker stopped: hunter2hunt…"
