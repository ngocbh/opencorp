"""A run's reason is shown as stored, cut only for length: to the 200 shown, after any cut before it was stored
(``_why`` at 500, the store at 256)."""

from types import SimpleNamespace

import pytest

from opencorp.runs.records import Live, Summaries
from opencorp.runs.service import RunLogs
from opencorp.store import REASON_CHARS, RunRow, new_id
from tests.store.conftest import session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"


def one(store, reason):  # noqa: F811
    s = store.create_session(session(status="ended"))
    run_id = new_id()
    store.add_session_run(s.id, run_id)
    store.add_run(RunRow(run_id, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None, T))
    store.end_run(run_id, "failed", reason=reason)
    return run_id


async def shown(store):  # noqa: F811
    (row,) = (await RunLogs(SimpleNamespace(store=store, extras={})).page()).runs
    return row.reason


@pytest.mark.parametrize("length", [199, 200, 201, 256, 3000])
async def test_a_reason_is_cut_to_the_200_shown(store, length):  # noqa: F811
    reason = "".join(chr(ord("a") + i % 26) for i in range(length))
    one(store, reason)
    assert await shown(store) == (reason if length <= REASON_CHARS else reason[:REASON_CHARS - 1] + "…")


def test_a_reason_cut_before_it_was_stored_keeps_its_cut(store):  # noqa: F811
    run_id = one(store, "worker stopped: conn-key-5f3a…")
    built = Summaries(store, Live()).build([store.get_run(run_id)])
    assert built[run_id].reason == "worker stopped: conn-key-5f3a…"
