"""A known secret in a run's reason never shows in part, wherever the reason was cut: by the 200 shown, by a cut
before it was stored (``_why`` at 500, the store at 2,000), or after the scrub shrank what came before it."""

from types import SimpleNamespace

import pytest

from opencorp.chat.harness import _why
from opencorp.runs.outcomes import RunEnd
from opencorp.runs.records import Live, Summaries
from opencorp.runs.scrub import Scrubber
from opencorp.runs.service import RunLogs
from opencorp.store import RunRow, new_id
from tests.store.conftest import session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"
KEY = "conn-key-5f3a9c1e7b2d4a60"  # a known value with no secret shape


class Known:
    async def scrubber(self):
        return Scrubber([KEY])


def one(store, reason, *, via_runend=True):  # noqa: F811
    s = store.create_session(session(status="ended"))
    run_id = new_id()
    store.add_session_run(s.id, run_id)
    store.add_run(RunRow(run_id, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None, T))
    store.end_run(run_id, "failed", reason=RunEnd("failed", reason).reason if via_runend else reason)
    return run_id


async def shown(store):  # noqa: F811
    (row,) = (await RunLogs(SimpleNamespace(store=store, extras={}), known=Known()).page()).runs
    return row.reason


def leaked(text):
    return any(KEY[:n] in text for n in range(8, len(KEY) + 1))


@pytest.mark.parametrize("at", [185, 190, 195, 199, 200, 201])
async def test_a_key_across_the_200_cut(store, at):  # noqa: F811
    one(store, "x" * at + KEY + " tail")
    text = await shown(store)
    assert not leaked(text) and len(text) <= 200


async def test_a_key_across_the_200_cut_after_known_values_shrink(store):  # noqa: F811
    one(store, (KEY + " ") * 12 + KEY + " end")
    assert not leaked(await shown(store))


async def test_a_key_cut_by_why_at_500_then_pulled_under_200_by_the_write_scrub(store):  # noqa: F811
    """_why cuts at 500 before RunEnd; a key across 500 is stored as a prefix, and a long shaped secret before it
    shrinks under the write scrub, pulling the prefix inside the 200 shown."""
    provider = SimpleNamespace(llm_config={})
    token = "A" * 340
    message = f"Bearer {token} " + "y" * (499 - len("AuthError: ") - len(f"Bearer {token} ") - 15) + KEY
    why = _why({"failure": {"cause_type": "AuthError", "message": message}}, provider)
    assert len(why) == 500 and KEY not in why and KEY[:12] in why
    one(store, why)
    text = await shown(store)
    assert not leaked(text), text


async def test_a_key_across_the_2000_store_cut_pulled_under_200(store):  # noqa: F811
    """A reason stored as given (a missed write path): cut at 2000; a long shaped secret before the key shrinks."""
    blob = "Bearer " + "B" * 1850
    one(store, blob + " " + "z" * (1999 - len(blob) - 1 - 12) + KEY, via_runend=False)
    text = await shown(store)
    assert not leaked(text), text


def test_without_a_scrub_the_partial_word_before_a_cut_is_dropped_too(store):  # noqa: F811
    run_id = one(store, "worker stopped: " + KEY[:12] + "…", via_runend=False)
    built = Summaries(store, Live()).build([store.get_run(run_id)])
    assert built[run_id].reason == "worker stopped: …"
