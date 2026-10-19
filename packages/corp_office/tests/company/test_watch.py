"""company.updated each time the clone's HEAD moves."""

import asyncio

from opencorp.company.watch import HeadWatcher
from tests.company.conftest import _git
from tests.daemon.conftest import office, profile_stores  # noqa: F401  (the office fixture needs both)


async def next_company_event(sub, timeout=3.0):
    async with asyncio.timeout(timeout):
        while True:
            item = await sub.next(timeout=timeout)
            if item[1].type == "company.updated":
                return item[1]


async def test_a_move_emits_once_with_the_sha_and_the_first_read_is_only_a_baseline(office, company):
    watcher = HeadWatcher(office, interval=0.05)
    office.on_start.append(watcher.start)
    office.on_stop.append(watcher.stop)
    await office.start()
    try:
        sub = office.bus.subscribe(types={"company.updated"})
        await asyncio.sleep(0.2)
        assert office.store.events_after() == []  # starting emits nothing
        _git(company, "commit", "-q", "--allow-empty", "-m", "an outside commit")
        event = await next_company_event(sub)
        sha = office.git.head()
        assert event.subject_id == sha and event.data == {"sha": sha}
        await asyncio.sleep(0.2)
        assert [e.type for e in office.store.events_after()] == ["company.updated"]  # once per move
    finally:
        await office.stop()
    assert watcher._task is None


async def test_stop_before_start_is_harmless(office):
    await HeadWatcher(office).stop()


async def test_a_failed_read_or_emit_is_logged_and_polling_goes_on(office, company, monkeypatch, caplog):
    read_head, emit = office.git.read_head, office.store.emit
    failures = {"read": 2, "emit": 1}  # the baseline read and one poll fail, then the first emit

    def flaky_read():
        if failures["read"]:
            failures["read"] -= 1
            raise OSError("too many open files")
        return read_head()

    def flaky_emit(*args):
        if failures["emit"]:
            failures["emit"] -= 1
            raise OSError("disk full")
        return emit(*args)

    monkeypatch.setattr(office.git, "read_head", flaky_read)
    monkeypatch.setattr(office.store, "emit", flaky_emit)
    watcher = HeadWatcher(office, interval=0.05)
    office.on_start.append(watcher.start)
    office.on_stop.append(watcher.stop)
    await office.start()
    try:
        sub = office.bus.subscribe(types={"company.updated"})
        await asyncio.sleep(0.3)  # the two failed reads, then a baseline
        _git(company, "commit", "-q", "--allow-empty", "-m", "an outside commit")
        event = await next_company_event(sub)  # retried after the failed emit
        assert event.data == {"sha": office.git.head()}
    finally:
        await office.stop()
    assert failures == {"read": 0, "emit": 0} and "too many open files" in caplog.text and "disk full" in caplog.text
