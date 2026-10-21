"""The Run Logs list: top-level runs newest first with how many runs each started, filters that keep a parent whose
child matches, search by any part of an id, a launch range read in SQL, one run's children paged the same way, and
reasons scrubbed when served."""

from types import SimpleNamespace

import pytest

from opencorp.runs import service
from opencorp.runs.known import SecretsUnavailable
from opencorp.runs.scrub import Scrubber
from opencorp.runs.service import REASON_HIDDEN, RunLogs
from opencorp.store import RunRow, new_id
from tests.store.conftest import session, store  # noqa: F401

T = "2026-10-20T10:00:00.000Z"
KEY = "conn-key-5f3a9c1e7b2d4a60"


class Known:
    """KnownValues' one method, with fixed values (or none to be had)."""

    def __init__(self, values=(), *, fails=False):
        self.values, self.fails = values, fails

    async def scrubber(self):
        if self.fails:
            raise SecretsUnavailable("couldn't load the secrets to remove in time")
        return Scrubber(self.values)


def runs_for(store, known=None):  # noqa: F811
    return RunLogs(SimpleNamespace(store=store, extras={}), known=known)


def chat_with(store, *, kids=0, driver="ngocbh", outcome="finished", harness="composer", reason=None,  # noqa: F811
              at=T, kid_at=None):
    """A main session's run launched ``at``, ended with ``outcome`` (and ``reason``, stored as given), and ``kids``
    side-chat runs under it driven by lan, launched ``kid_at`` (``at`` by default)."""
    s = store.create_session(session(status="ended", harness=harness))
    top = new_id()
    store.add_session_run(s.id, top)
    store.add_run(RunRow(top, s.id, "chat", "shared/flows/chat.yaml", driver, None, at))
    store.end_run(top, outcome, reason=reason or (None if outcome == "finished" else "worker stopped"))
    for _ in range(kids):
        side = store.create_session(session(kind="side", status="ended"))
        kid = new_id()
        store.add_session_run(side.id, kid)
        store.add_run(RunRow(kid, side.id, "side_chat", "shared/flows/side_chat.yaml", "lan", top, kid_at or at))
        store.end_run(kid, "finished")
    return top


def ids(page):
    return [r.run_id for r in page.runs]


async def test_a_page_is_top_level_runs_newest_first_with_how_many_runs_each_started(store):  # noqa: F811
    first, second = chat_with(store, kids=2), chat_with(store)
    page = await runs_for(store).page()
    assert ids(page) == [second, first] and page.next is None
    assert [(r.children, r.children_total) for r in page.runs] == [([], 0), ([], 2)]


async def test_paging_by_top_level_run(store):  # noqa: F811
    tops = [chat_with(store, kids=2) for _ in range(3)]
    runs = runs_for(store)
    one = await runs.page(limit=2)
    assert ids(one) == tops[:0:-1] and one.next == tops[1]
    two = await runs.page(before=one.next, limit=2)
    assert ids(two) == [tops[0]] and two.next is None
    assert all(r.children_total == 2 for r in [*one.runs, *two.runs])


async def test_filters_keep_a_parent_whose_child_matches(store):  # noqa: F811
    with_side, plain, failed = chat_with(store, kids=1), chat_with(store), chat_with(store, outcome="failed")
    runs = runs_for(store)
    assert ids(await runs.page(flow="side_chat")) == [with_side]
    assert ids(await runs.page(person="lan")) == [with_side]
    assert ids(await runs.page(person="minh")) == [failed, plain, with_side]  # the employee
    assert ids(await runs.page(status=["failed"])) == [failed]


async def test_a_status_list_matches_any_of_them(store):  # noqa: F811
    failed, finished = chat_with(store, outcome="failed"), chat_with(store)
    chat_with(store, outcome="interrupted")
    assert ids(await runs_for(store).page(status=["failed", "finished"])) == [finished, failed]


async def test_the_person_filter_matches_the_driver(store):  # noqa: F811
    mine = chat_with(store, driver="lan")
    chat_with(store, driver="kai")
    assert ids(await runs_for(store).page(person="lan")) == [mine]


async def test_search_matches_any_part_of_a_run_id(store):  # noqa: F811
    target = chat_with(store)
    chat_with(store)
    assert ids(await runs_for(store).page(q=target[-6:].lower())) == [target]


async def test_a_launch_range_is_since_inclusive_and_until_exclusive(store):  # noqa: F811
    at = [f"2026-10-{d:02}T10:00:00.000Z" for d in (10, 11, 12, 13)]
    tops = [chat_with(store, at=t) for t in at]
    runs = runs_for(store)
    assert ids(await runs.page(since=at[1], until=at[3])) == [tops[2], tops[1]]
    assert ids(await runs.page(since=at[3])) == [tops[3]]
    assert ids(await runs.page(until=at[1])) == [tops[0]]


async def test_a_launch_range_combines_with_filters_and_paging(store):  # noqa: F811
    old_lan = chat_with(store, driver="lan", outcome="failed", at="2026-10-01T10:00:00.000Z")
    lan = [chat_with(store, driver="lan", outcome="failed") for _ in range(3)]
    chat_with(store, driver="kai", outcome="failed")
    chat_with(store, driver="lan")
    runs = runs_for(store)
    wanted = {"since": "2026-10-13T10:00:00.000Z", "person": "lan", "status": ["failed", "interrupted"],
              "flow": "chat"}
    one = await runs.page(**wanted, limit=2)
    assert ids(one) == lan[:0:-1] and one.next == lan[1]
    two = await runs.page(**wanted, before=one.next, limit=2)
    assert ids(two) == [lan[0]] and two.next is None
    assert ids(await runs.page(**wanted, q=lan[0][-5:])) == [lan[0]]
    assert old_lan not in ids(await runs.page(person="lan", status=["failed"], since=wanted["since"]))


async def test_a_child_outside_the_range_doesnt_show_its_parent(store):  # noqa: F811
    top = chat_with(store, kids=1, at="2026-10-13T10:00:00.000Z", kid_at="2026-10-15T10:00:00.000Z")
    runs = runs_for(store)
    assert ids(await runs.page(flow="side_chat", until="2026-10-14T10:00:00.000Z")) == []
    assert ids(await runs.page(flow="side_chat", since="2026-10-13T00:00:00.000Z")) == [top]


async def test_a_seven_day_query_over_many_old_runs_scans_only_the_rows_in_range(store, monkeypatch):  # noqa: F811
    old = [chat_with(store, at="2026-09-01T10:00:00.000Z") for _ in range(30)]
    recent = [chat_with(store, outcome="failed") for _ in range(3)]
    newer_old = [chat_with(store, at="2026-09-02T10:00:00.000Z") for _ in range(30)]  # ids after the recent runs
    scanned = []
    page_of = store.run_page

    def counted(**kw):
        rows = page_of(**kw)
        scanned.extend(rows)
        return rows

    monkeypatch.setattr(store, "run_page", counted)
    page = await runs_for(store).page(status=["running", "waiting", "idle", "failed"], since="2026-10-13T10:00:00.000Z")
    assert ids(page) == recent[::-1] and page.next is None
    assert {r.run_id for r in scanned} == set(recent) and old and newer_old  # no old row reached Python


async def test_a_filtered_page_stops_after_the_scan_cap_and_resumes(store, monkeypatch):  # noqa: F811
    monkeypatch.setattr(service, "SCAN_CAP", 4)
    monkeypatch.setattr(service, "BATCH", 2)
    target = chat_with(store, outcome="failed")
    plain = [chat_with(store) for _ in range(5)]
    runs = runs_for(store)
    one = await runs.page(status=["failed"])
    assert ids(one) == [] and one.next == plain[1]
    assert ids(await runs.page(status=["failed"], before=one.next)) == [target]


async def test_one_runs_children_page_with_the_same_filters(store):  # noqa: F811
    top = chat_with(store, kids=3)
    kids = [r.run_id for r in store.run_children([top])]
    runs = runs_for(store)
    one = await runs.children(top, limit=2)
    assert ids(one) == kids[:2] and one.next == kids[1]
    assert [(r.children, r.children_total) for r in one.runs] == [([], 0), ([], 0)]
    two = await runs.children(top, before=one.next, limit=2)
    assert ids(two) == kids[2:] and two.next is None
    assert ids(await runs.children(top, q=kids[1][-6:])) == [kids[1]]
    assert ids(await runs.children(top, flow="chat")) == []
    assert ids(await runs.children(top, since="2026-10-21T00:00:00.000Z")) == []
    with pytest.raises(LookupError):
        await runs.children(new_id())


async def test_a_codex_debrief_is_top_level_and_says_so(store):  # noqa: F811
    s = store.create_session(session(status="ended", harness="codex"))
    run_id = new_id()
    store.add_run(RunRow(run_id, s.id, "debrief", "shared/flows/debrief.yaml", "office", None, T))
    (row,) = (await runs_for(store).page()).runs
    assert (row.run_id, row.codex, row.parent_run_id, row.driver) == (run_id, True, None, "office")


async def test_a_reason_is_fully_scrubbed_when_served(store):  # noqa: F811
    # Stored as given (no RunEnd), as a missed write path would leave it.
    top = chat_with(store, outcome="failed", reason=f"AuthError: Bearer abcdefgh12345 with {KEY}")
    (row,) = (await runs_for(store, Known([KEY])).page()).runs
    assert row.reason == "AuthError: Bearer (hidden) with [redacted]" and row.run_id == top
    parent = store.get_run(top)
    side = store.create_session(session(kind="side", status="ended"))
    kid = store.add_run(RunRow(new_id(), side.id, "side_chat", "shared/flows/side_chat.yaml", "lan", parent.run_id, T))
    store.end_run(kid.run_id, "failed", reason=f"leaked {KEY}")
    (child,) = (await runs_for(store, Known([KEY])).children(top)).runs
    assert child.reason == "leaked [redacted]"


async def test_a_list_whose_secrets_cant_be_read_hides_reasons_and_still_answers(store):  # noqa: F811
    top = chat_with(store, outcome="failed", reason="AuthError: 401")
    (row,) = (await runs_for(store, Known(fails=True)).page()).runs
    assert (row.status, row.reason) == ("failed", REASON_HIDDEN)
    side = store.create_session(session(kind="side", status="ended"))
    kid = store.add_run(RunRow(new_id(), side.id, "side_chat", "shared/flows/side_chat.yaml", "lan", top, T))
    store.end_run(kid.run_id, "failed", reason="AuthError: 401")
    (child,) = (await runs_for(store, Known(fails=True)).children(top)).runs
    assert child.reason == REASON_HIDDEN


async def test_the_list_never_opens_a_log(store, monkeypatch):  # noqa: F811
    import builtins
    from pathlib import Path

    from opencorp.runs.reader import RunLogReader

    chat_with(store, kids=1)
    opened = []
    real_open, real_path_open = builtins.open, Path.open

    def spy_open(file, *a, **kw):
        if str(file).endswith(".jsonl"):
            opened.append(file)
        return real_open(file, *a, **kw)

    def spy_path_open(self, *a, **kw):
        if self.suffix == ".jsonl":
            opened.append(self)
        return real_path_open(self, *a, **kw)

    monkeypatch.setattr(builtins, "open", spy_open)
    monkeypatch.setattr(Path, "open", spy_path_open)
    for name in ("index", "ready"):
        monkeypatch.setattr(RunLogReader, name, lambda *a, _name=name, **kw: opened.append(_name))
    runs = runs_for(store)
    await runs.page(status=["finished"])
    await runs.children((await runs.page()).runs[0].run_id)
    assert opened == []
