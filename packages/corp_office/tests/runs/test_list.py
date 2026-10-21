"""The Run Logs list: top-level runs newest first with how many runs each started, filters that keep a parent whose
child matches, search by any part of an id, a launch range read in SQL, one run's children paged the same way, and
reasons scrubbed when served."""

import threading
from types import SimpleNamespace

import pytest

from opencorp.runs import service
from opencorp.runs.known import SecretsUnavailable
from opencorp.runs.scrub import Scrubber
from opencorp.runs.service import REASON_HIDDEN, RunLogs
from opencorp.store import REASON_CHARS, RunRow, new_id
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


async def test_a_parent_launched_before_the_range_shows_when_a_child_in_it_matches(store):  # noqa: F811
    top = chat_with(store, kids=1, at="2026-10-13T10:00:00.000Z", kid_at="2026-10-15T10:00:00.000Z")
    runs = runs_for(store)
    since = "2026-10-14T00:00:00.000Z"
    assert ids(await runs.page(since=since)) == [top]
    assert ids(await runs.page(since=since, flow="side_chat")) == [top]
    assert ids(await runs.page(since=since, person="lan", status=["finished"])) == [top]
    assert ids(await runs.page(since=since, flow="chat")) == []  # the parent matches, but outside the range
    assert ids(await runs.page(since=since, status=["failed"])) == []  # the child is in range but doesn't match
    # A child outside the range doesn't show its parent.
    assert ids(await runs.page(flow="side_chat", until="2026-10-14T10:00:00.000Z")) == []
    assert ids(await runs.page(flow="side_chat", since="2026-10-13T00:00:00.000Z")) == [top]


async def test_a_seven_day_query_over_many_old_runs_scans_only_the_rows_in_range(store, monkeypatch):  # noqa: F811
    old = [chat_with(store, at="2026-09-01T10:00:00.000Z") for _ in range(30)]
    old_parent = chat_with(store, outcome="failed", kids=1, at="2026-09-01T10:00:00.000Z", kid_at=T)  # recent child
    recent = [chat_with(store, outcome="failed") for _ in range(3)]
    newer_old = [chat_with(store, at="2026-09-02T10:00:00.000Z") for _ in range(30)]  # ids after the recent runs
    scanned = []
    page_of = store.run_page

    def counted(**kw):
        rows = page_of(**kw)
        scanned.extend(rows)
        return rows

    monkeypatch.setattr(store, "run_page", counted)
    wanted = {"status": ["running", "waiting", "idle", "finished"], "since": "2026-10-13T10:00:00.000Z"}
    page = await runs_for(store).page(**wanted)
    assert ids(page) == [old_parent] and page.next is None  # its child finished in range
    assert {r.run_id for r in scanned} == {*recent, old_parent} and old and newer_old  # no other old row reached Python


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


class FakeHarness:
    """The harness's two reads the list makes: live runs (and sessions waking or finishing), and open nodes."""

    def __init__(self):
        self.live, self.finishing = {}, set()

    def live_runs(self):
        return dict(self.live), frozenset(self.finishing)

    def open_nodes(self, run_id):
        return []


def in_thread(fn):
    """Run ``fn`` on another thread (another store connection) and wait for it."""
    t = threading.Thread(target=fn)
    t.start()
    t.join()


def live_top(store, status):  # noqa: F811
    s = store.create_session(session(status=status))
    run_id = new_id()
    store.add_session_run(s.id, run_id)
    store.add_run(RunRow(run_id, s.id, "chat", "shared/flows/chat.yaml", "ngocbh", None, T))
    return s, run_id


async def test_a_run_that_finishes_while_listed_shows_running_not_interrupted(store, monkeypatch):  # noqa: F811
    harness = FakeHarness()
    s, run_id = live_top(store, "busy")
    harness.live[s.id] = run_id
    real_page = store.run_page

    def run_page(**kw):
        rows = real_page(**kw)
        if harness.live:  # _finish, after the rows were read: drop the live run (finishing), store the end, clear
            harness.live.clear()
            harness.finishing.add(s.id)

            def end():
                with store.transaction():
                    store.update_session(s.id, status="ended")
                    store.end_run(run_id, "finished")

            in_thread(end)
            harness.finishing.clear()
        return rows

    monkeypatch.setattr(store, "run_page", run_page)
    page = await RunLogs(SimpleNamespace(store=store, extras={"harness": harness})).page()
    assert [r.status for r in page.runs] == ["running"]


async def test_a_run_that_starts_while_listed_shows_running_not_interrupted(store, monkeypatch):  # noqa: F811
    harness = FakeHarness()
    s, run_id = live_top(store, "starting")
    real_page = store.run_page

    def run_page(**kw):
        if not harness.live:  # after Live was read, before the store reads: the harness takes the run, then busy
            harness.live[s.id] = run_id
            in_thread(lambda: store.update_session(s.id, status="busy"))
        return real_page(**kw)

    monkeypatch.setattr(store, "run_page", run_page)
    page = await RunLogs(SimpleNamespace(store=store, extras={"harness": harness})).page()
    assert [r.status for r in page.runs] == ["running"]


async def test_children_are_read_only_when_they_can_match(store, monkeypatch):  # noqa: F811
    top = chat_with(store, kids=1)
    side = store.create_session(session(kind="side", status="ended"))
    open_kid = store.add_run(RunRow(new_id(), side.id, "side_chat", "shared/flows/side_chat.yaml", "kai", top, T))
    asked = []
    real = store.run_children

    def run_children(ids, **kw):
        asked.append(kw)
        return real(ids, **kw)

    monkeypatch.setattr(store, "run_children", run_children)
    runs = runs_for(store)
    assert ids(await runs.page(status=["running", "idle"], person="kai")) == []  # its run has no outcome: interrupted
    assert ids(await runs.page(status=["interrupted"], person="kai", since="2026-10-13T00:00:00.000Z")) == [top]
    assert asked == [{"since": None, "until": None, "open_only": True},
                     {"since": "2026-10-13T00:00:00.000Z", "until": None, "open_only": False}]
    assert open_kid.parent_run_id == top


async def test_a_reason_the_scrub_lengthens_is_cut_as_the_store_cuts_it(store):  # noqa: F811
    short = "k3y-v4l-9"  # 9 characters, hidden as "[redacted]" (10)
    reason = "x" * 191 + short  # REASON_CHARS as stored, one more once scrubbed
    top = chat_with(store, outcome="failed", reason=reason)
    assert len(store.get_run(top).reason) == REASON_CHARS
    (row,) = (await runs_for(store, Known([short])).page()).runs
    assert len(row.reason) == REASON_CHARS and row.reason.endswith("…") and short not in row.reason
