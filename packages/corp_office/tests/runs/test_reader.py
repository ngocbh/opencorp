"""The run-log reader: a lazy, bounded index per log with its node table; node and record pages; plain reads only."""

import asyncio
import hashlib
import os
import threading
import tracemalloc

import pytest

from opencorp.runs import reader as reader_mod
from opencorp.runs.reader import (BIG_LINE, RunLogReader, UnreadableLog, UnsupportedSchema, log_lines, node_page,
                                  read_event, read_events, refresh)
from tests.runs.logs import (FP, chat_log, expanded, failed, line, resumed, routed, run_started, started,
                             succeeded)


def test_the_summary_has_the_first_records_facts_and_the_open_nodes(tmp_path):
    index = refresh(chat_log(tmp_path / "r.jsonl"), None)
    assert (index.fingerprint, index.learnable, index.models) == (FP, True, {"chat/reply": "stub"})
    assert (list(index.open), index.last_seq, index.schemas) == (["chat#2/ask"], 15, {9})


def test_unknown_envelope_fields_before_or_after_seq_and_at_are_ignored(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + started(1, "a", at="2026-10-20T10:00:00.000Z", extra=1)
                     + started(2, "b", trace_id="t-1", worker="w-2"))  # "trace_id" and "worker" sort after "seq"
    assert list(refresh(path, None).open) == ["a", "b"]


@pytest.mark.parametrize("schema, message", [
    (11, "This log uses run-log schema 11, which this office can't read"),
    (8, "This log uses run-log schema 8, which is older than this office supports"),
    ("sk-" + "a" * 40, "This log uses a run-log schema this office can't read"),  # never echoed: it may be anything
    (True, "This log uses a run-log schema this office can't read")])
def test_an_unknown_or_retired_schema_stops_that_log_with_a_message(tmp_path, schema, message):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + line(1, "node_started", {"node_id": "a"}, schema=schema))
    with pytest.raises(UnsupportedSchema) as err:
        refresh(path, None)
    assert str(err.value) == message


def test_a_line_that_isnt_a_record_or_a_seq_out_of_order_makes_the_log_unreadable(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + b"[1, 2]\n")
    with pytest.raises(UnreadableLog, match="can't read"):
        refresh(path, None)
    path.write_bytes(run_started(0) + started(2, "a"))  # seq 1 never written: Yian refuses this log too
    with pytest.raises(UnreadableLog, match="out of order"):
        refresh(path, None)


def test_a_torn_last_line_is_left_for_later(tmp_path):
    path = chat_log(tmp_path / "r.jsonl")
    whole = path.read_bytes()
    path.write_bytes(whole + started(16, "chat#2/x")[:-5])
    index = refresh(path, None)
    assert (index.last_seq, index.offset) == (15, len(whole))


def test_the_node_table_has_every_attempt_with_its_outcome(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(b"".join([
        run_started(0), started(1, "chat"), expanded(2, "chat"), started(3, "chat#0/route"),
        routed(4, "chat#0/route", "reply"), started(5, "chat#0/reply"), failed(6, "chat#0/reply", "boom " * 100),
        started(7, "m#0/a"), started(8, "m#1/a"), succeeded(9, "m#0/a")]))
    index = refresh(path, None)
    assert [(a.node_id, a.status, a.handle, a.end_seq) for a in index.nodes] == [
        ("chat", "expanded", None, 2), ("chat#0/route", "routed", "reply", 4), ("chat#0/reply", "failed", None, 6),
        ("m#0/a", "succeeded", None, 9), ("m#1/a", "open", None, None)]
    # The error is kept up to ERROR_KEPT; it is cut to ERROR_CHARS only when shown.
    assert index.nodes[2].error == ("boom " * 100)[:reader_mod.ERROR_KEPT - 1] + "…" and list(index.open) == ["m#1/a"]


def test_a_node_error_is_kept_up_to_error_kept_its_cut_marked(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + started(1, "a") + failed(2, "a", "x" * 5000))
    error = refresh(path, None).nodes[0].error
    assert reader_mod.ERROR_KEPT == 256 and len(error) == reader_mod.ERROR_KEPT and error.endswith("x…")


def test_a_resume_restarts_the_open_starts_and_only_the_latest_start_is_open(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + started(1, "chat#0/reply") + resumed(2, ["chat#0/reply"])
                     + started(3, "chat#0/reply"))
    index = refresh(path, None)
    assert [(a.seq, a.status) for a in index.nodes] == [(1, "restarted"), (3, "open")]
    assert index.dividers == [(2, ["chat#0/reply"])] and list(index.open) == ["chat#0/reply"]


def test_the_node_table_keeps_the_newest_attempts_past_its_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(reader_mod, "NODE_CAP", 5)
    index = refresh(chat_log(tmp_path / "r.jsonl"), None)
    assert len(index.nodes) == 5 and index.dropped and index.nodes[-1].node_id == "chat#2/ask"


def test_an_append_is_read_incrementally(tmp_path, monkeypatch):
    path = chat_log(tmp_path / "r.jsonl")
    index = refresh(path, None)
    applied, apply = [], reader_mod._apply
    monkeypatch.setattr(reader_mod, "_apply", lambda *a: (applied.append(a[3]), apply(*a))[1])
    with path.open("ab") as f:
        f.write(line(16, "backward_started", {"x": 1}))  # learning appends to a finished log days later
    assert refresh(path, index) is index and len(applied) == 1 and index.last_seq == 16


def test_a_truncation_then_a_same_size_rewrite_rebuilds(tmp_path):
    path = chat_log(tmp_path / "r.jsonl")
    index = refresh(path, None)
    data, last, other = path.read_bytes(), started(15, "chat#2/ask"), started(15, "chat#2/asx")
    assert data.endswith(last) and len(last) == len(other)
    path.write_bytes(data[:-len(last)] + other)  # same inode, same size, a different last line
    again = refresh(path, index)
    assert again is not index and list(again.open) == ["chat#2/asx"]


def test_an_append_that_skips_a_seq_rebuilds_then_says_unreadable_and_a_new_file_rebuilds(tmp_path):
    path = chat_log(tmp_path / "r.jsonl")
    index = refresh(path, None)
    with path.open("ab") as f:
        f.write(started(18, "late"))  # 16 and 17 never arrive
    with pytest.raises(UnreadableLog):
        refresh(path, index)
    os.replace(chat_log(tmp_path / "other.jsonl", turns=1), path)
    assert refresh(path, index).last_seq == 9


@pytest.mark.timeout(240)
def test_a_large_log_builds_with_memory_under_its_largest_line_plus_32_mib(tmp_path):
    path = tmp_path / "big.jsonl"
    filler = "w" * 1500
    with path.open("wb") as f:
        f.write(run_started(0))
        seq = 1
        while f.tell() < 32 << 20:
            f.write(started(seq, f"m#{seq}/a"))
            f.write(succeeded(seq + 1, f"m#{seq}/a", {"output": filler}))
            seq += 2
        f.write(started(seq, "huge"))
        f.write(succeeded(seq + 1, "huge", {"output": "h" * (2 << 20)}))
    tracemalloc.start()
    try:
        index = refresh(path, None)  # the node table included
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert index.last_seq == seq + 1 and not index.open and index.nodes[-1].node_id == "huge"
    assert peak < (2 << 20) + (32 << 20)


def test_node_pages_go_newest_first_with_their_dividers(tmp_path):
    index = refresh(chat_log(tmp_path / "r.jsonl", turns=3), None)
    page = node_page(index, before=None, limit=4)
    assert [a.node_id for a in page.nodes] == ["chat#3/ask", "chat#2/reply", "chat#2/route", "chat#2/ask"]
    older = node_page(index, before=page.next_before, limit=100)
    assert (older.nodes[0].node_id, older.nodes[-1].node_id, older.next_before) == ("chat#1/reply", "chat", None)
    assert page.nodes[0] is not index.nodes[-1]  # copies: a refresh can't change a page being sent


def test_record_pages_seek_by_seq_and_stop_at_the_count(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=30)  # seqs 0..183
    index = refresh(path, None)
    page = read_events(path, index, after=99, limit=10)
    assert ([e.seq for e in page.events], page.next_after, page.cut) == (list(range(100, 110)), 109, False)
    last = read_events(path, index, after=180, limit=10)
    assert ([e.seq for e in last.events], last.next_after) == ([181, 182, 183], None)


def test_an_envelope_field_after_seq_doesnt_hide_a_record_from_pages_or_one_record(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + b"".join(started(n, f"n{n}", trace_id=f"t{n}") for n in range(1, 70)))
    index = refresh(path, None)
    page = read_events(path, index, after=63, limit=10)
    assert [e.seq for e in page.events] == list(range(64, 70))
    assert read_event(path, index, 65).node_id == "n65"


def test_long_strings_are_cut_evidence_left_out_and_the_page_stops_at_its_bytes(tmp_path, monkeypatch):
    monkeypatch.setattr(reader_mod, "PAGE_BYTES", 20_000)
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + b"".join(
        succeeded(n, f"n{n}", {"output": "x" * 10_000}, evidence={"prompt": "p"}) for n in range(1, 6)))
    page = read_events(path, refresh(path, None), after=0, limit=500)
    first = page.events[0]
    assert first.cut == ["/value/output"] and len(first.payload["value"]["output"]) == reader_mod.FIELD_CHARS + 1
    assert first.evidence_left_out and first.payload["evidence"] is None and first.node_id == "n1"
    assert page.cut and len(page.events) < 5 and page.next_after == page.events[-1].seq


def test_a_line_over_2_mib_is_a_stub_with_its_kind_seq_and_size(tmp_path):
    path = tmp_path / "r.jsonl"
    huge = line(1, "node_succeeded", {"node_id": "big", "value": {"output": "y" * (BIG_LINE + 10)}},
                at="2026-10-20T10:00:00.000Z")
    path.write_bytes(run_started(0) + huge + started(2, "next"))
    page = read_events(path, refresh(path, None), after=0, limit=10)
    stub = page.events[0]
    assert (stub.seq, stub.kind, stub.size, stub.payload) == (1, "node_succeeded", len(huge), None)
    assert page.events[1].seq == 2


def test_one_record_by_seq_has_its_evidence_and_is_capped(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + succeeded(1, "a", {"output": "z" * 9000}, evidence={"prompt": "the prompt"}))
    index = refresh(path, None)
    event = read_event(path, index, 1)
    assert event.payload["evidence"] == {"prompt": "the prompt"} and event.cut == []
    monkeypatch.setattr(reader_mod, "EVENT_BYTES", 5000)
    assert read_event(path, index, 1).cut == ["/value/output"]
    assert read_event(path, index, 7) is None


def test_a_file_changed_under_a_page_stops_it_there(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=1)
    index = refresh(path, None)
    data = path.read_bytes().splitlines(keepends=True)
    path.write_bytes(b"".join(data[:4]) + started(9, "rewritten") + b"".join(data[5:]))  # line 4 no longer seq 4
    page = read_events(path, index, after=None, limit=100)
    assert ([e.seq for e in page.events], page.next_after) == ([0, 1, 2, 3], 3)


def test_the_download_is_every_complete_line_as_stored(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=1)
    whole = path.read_bytes()
    with path.open("ab") as f:
        f.write(b'{"torn')
    lines = log_lines(path)
    path.unlink()  # opened when called, so a log removed before it streams still streams whole
    lines = list(lines)
    assert len(lines) == 10 and b"".join(lines) == whole
    with pytest.raises(FileNotFoundError):
        log_lines(path)


async def test_two_first_requests_build_once(tmp_path, monkeypatch):
    path = chat_log(tmp_path / "r.jsonl")
    calls, gate, real = [], threading.Event(), reader_mod.refresh

    def slow(*args, **kwargs):
        calls.append(1)
        gate.wait(5)
        return real(*args, **kwargs)

    monkeypatch.setattr(reader_mod, "refresh", slow)
    reader = RunLogReader()
    both = asyncio.gather(reader.index(path), reader.index(path))
    await asyncio.sleep(0.1)
    gate.set()
    a, b = await both
    assert a is b and calls == [1]


async def test_a_log_is_read_whole_once_then_only_its_appends(tmp_path, monkeypatch):
    path = chat_log(tmp_path / "r.jsonl")
    starts, real = [], reader_mod._read
    monkeypatch.setattr(reader_mod, "_read", lambda f, index, *a: (starts.append(index.offset), real(f, index, *a))[1])
    reader = RunLogReader()
    assert await reader.ready(path, wait=5) is not None  # a run page's header
    assert node_page(await reader.index(path), before=None, limit=10).nodes  # then its Timeline
    assert node_page(await reader.index(path), before=None, limit=10).nodes  # and its refetch, much later
    assert starts.count(0) == 1


async def test_the_lru_evicts_the_least_recently_used_logs_by_bytes(tmp_path):
    paths = [chat_log(tmp_path / f"{n}.jsonl") for n in range(3)]
    reader = RunLogReader(budget=1)  # every index is over budget: only the one just used stays
    for path in paths:
        await reader.index(path)
    assert list(reader._lru) == [paths[2]]


async def test_a_slow_build_answers_none_with_its_progress_then_the_index(tmp_path, monkeypatch):
    path = chat_log(tmp_path / "r.jsonl")
    gate, real = threading.Event(), reader_mod.refresh

    def slow(path_, index, *, progress=None):
        progress(10, 100)
        gate.wait(5)
        return real(path_, index, progress=progress)

    monkeypatch.setattr(reader_mod, "refresh", slow)
    reader = RunLogReader()
    assert await reader.ready(path, wait=0.1) is None
    assert reader.progress(path) == (10, 100)
    gate.set()
    assert (await reader.ready(path, wait=5)).last_seq == 15


async def test_an_unreadable_log_isnt_read_again_until_it_changes(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + line(1, "node_started", {"node_id": "a"}, schema=11))
    calls, real = [], reader_mod.refresh
    monkeypatch.setattr(reader_mod, "refresh", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    reader = RunLogReader()
    for _ in range(2):
        with pytest.raises(UnsupportedSchema):
            await reader.index(path)
    assert calls == [1]
    chat_log(path)  # replaced: read again
    assert (await reader.index(path)).last_seq == 15 and calls == [1, 1]


def test_one_record_is_capped_in_bytes_and_a_payload_still_too_large_is_a_size_stub(tmp_path):
    path = tmp_path / "r.jsonl"
    wide = succeeded(1, "wide", {"output": "ü" * (1 << 20)})  # 1 Mi characters, 2 MiB of UTF-8
    many = succeeded(2, "many", {f"k{i}": "s" * 3000 for i in range(1500)})  # every string under FIELD_CHARS
    path.write_bytes(run_started(0) + wide + many)
    index = refresh(path, None)
    assert read_event(path, index, 1).cut == ["/value/output"]
    stub = read_event(path, index, 2)
    assert (stub.kind, stub.node_id, stub.payload, stub.size) == ("node_succeeded", "many", None, len(many))
    assert len(stub.model_dump_json().encode()) <= reader_mod.EVENT_BYTES


def test_one_record_over_huge_line_is_a_size_stub_never_parsed(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    big = succeeded(1, "big", {"output": "b" * 5000})
    path.write_bytes(run_started(0) + big + started(2, "next"))
    index = refresh(path, None)
    monkeypatch.setattr(reader_mod, "HUGE_LINE", len(big))
    assert read_event(path, index, 1).payload["value"] == {"output": "b" * 5000}  # at the size: still read whole
    monkeypatch.setattr(reader_mod, "HUGE_LINE", len(big) - 1)
    monkeypatch.setattr(reader_mod, "_event", lambda *a, **k: pytest.fail("a huge record was parsed"))
    stub = read_event(path, index, 1)
    assert (stub.seq, stub.kind, stub.node_id, stub.payload, stub.size) == (1, "node_succeeded", None, None, len(big))
    assert read_event(path, index, 3) is None


def test_one_huge_record_is_read_without_holding_its_line(tmp_path):
    path = tmp_path / "r.jsonl"
    huge = succeeded(1, "huge", {"output": "h" * (reader_mod.HUGE_LINE + (4 << 20))})
    path.write_bytes(run_started(0) + huge + started(2, "next"))
    index = refresh(path, None)
    tracemalloc.start()
    try:
        stub, after = read_event(path, index, 1), read_event(path, index, 2)  # the second skips the huge line
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert (stub.kind, stub.payload, stub.size) == ("node_succeeded", None, len(huge))
    assert after.node_id == "next"
    assert peak < 4 * reader_mod.CHUNK


def test_a_log_rewritten_during_a_read_is_read_again_from_the_start(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    whole = chat_log(tmp_path / "whole.jsonl").read_bytes()
    path.write_bytes(run_started(0) + started(2, "a"))  # caught mid-rollback: seq 1 isn't there yet
    calls, real = [], reader_mod._read

    def read(f, index, *args):
        calls.append(1)
        try:
            return real(f, index, *args)
        finally:
            if len(calls) == 1:
                path.write_bytes(whole)  # the writer finishes while the bad read is under way

    monkeypatch.setattr(reader_mod, "_read", read)
    assert refresh(path, None).last_seq == 15 and len(calls) == 2


def test_a_log_unreadable_twice_in_a_row_says_so(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + started(2, "a"))
    calls, real = [], reader_mod._read

    def read(f, index, *args):
        calls.append(1)
        try:
            return real(f, index, *args)
        finally:
            path.write_bytes(run_started(0) + started(len(calls) + 2, "a"))  # still changing, still unreadable

    monkeypatch.setattr(reader_mod, "_read", read)
    with pytest.raises(UnreadableLog):
        refresh(path, None)
    assert len(calls) == 2


def test_the_cost_counts_the_ids_errors_and_retried_ids_it_holds(tmp_path, monkeypatch):
    short, long = tmp_path / "s.jsonl", tmp_path / "l.jsonl"
    short.write_bytes(run_started(0) + started(1, "a") + failed(2, "a", "x") + resumed(3, ["b"]))
    long.write_bytes(run_started(0) + started(1, "a" * 5000) + failed(2, "a" * 5000, "x" * 5000)
                     + resumed(3, ["b" * 3000]))
    assert refresh(long, None).cost() - refresh(short, None).cost() == 4999 + reader_mod.ERROR_KEPT - 1 + 2999
    monkeypatch.setattr(reader_mod, "NODE_CAP", 5)
    many = tmp_path / "m.jsonl"
    many.write_bytes(run_started(0) + b"".join(started(n, f"{n:04d}" + "n" * 996) for n in range(1, 101)))
    assert refresh(many, None).cost() < 100 * 1000  # trimmed attempts no longer count


def test_lines_are_hashed_outside_the_index_lock(tmp_path, monkeypatch):
    path = chat_log(tmp_path / "r.jsonl")
    index = refresh(path, None)
    with path.open("ab") as f:
        f.write(line(16, "backward_started", {}) + line(17, "backward_started", {}))
    locked, real = [], hashlib.sha256
    monkeypatch.setattr(hashlib, "sha256", lambda data: (locked.append(index.lock.locked()), real(data))[1])
    assert refresh(path, index).last_seq == 17 and len(locked) >= 2 and not any(locked)


def test_progress_and_size_never_say_less_than_was_read(tmp_path, monkeypatch):
    monkeypatch.setattr(reader_mod, "CHUNK", 256)
    path = chat_log(tmp_path / "r.jsonl")
    seen = []

    def progress(done, total):
        if not seen:
            with path.open("ab") as f:
                f.write(line(16, "backward_started", {"x": "y" * 4000}))  # appended while it is read
        seen.append((done, total))

    index = refresh(path, None, progress=progress)
    assert index.last_seq == 16 and all(0 <= done <= total for done, total in seen)
    assert index.size >= index.offset == path.stat().st_size


def test_a_record_written_as_utf8_reads_back_on_pages_and_by_seq(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + started(1, "世界🚀") + succeeded(2, "世界🚀", {"output": "é" * 10}))
    assert "世界🚀".encode() in path.read_bytes()  # as Yian writes it, not \u escapes
    index = refresh(path, None)
    page = read_events(path, index, after=0, limit=10)
    assert [e.node_id for e in page.events] == ["世界🚀", "世界🚀"] and list(index.open) == []
    assert read_event(path, index, 2).payload["value"] == {"output": "é" * 10}


def test_an_oversized_line_whose_kind_isnt_first_is_an_unknown_stub(tmp_path):
    path = tmp_path / "r.jsonl"
    huge = line(1, "node_succeeded", {"node_id": "big", "value": {"output": "y" * (BIG_LINE + 10)}}, aaa_first=1)
    path.write_bytes(run_started(0) + huge)
    stub = read_events(path, refresh(path, None), after=0, limit=10).events[0]
    assert (stub.seq, stub.kind, stub.size, stub.payload) == (1, "unknown", len(huge), None)


def test_each_node_page_has_only_the_dividers_among_its_attempts(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(b"".join([run_started(0), started(1, "a"), resumed(2, ["a"]), started(3, "a"), succeeded(4, "a"),
                               started(5, "b"), resumed(6, ["b"]), started(7, "b")]))
    index = refresh(path, None)
    newest = node_page(index, before=None, limit=2)
    assert ([a.seq for a in newest.nodes], newest.dividers, newest.next_before) == ([7, 5], [(6, ["b"])], 5)
    older = node_page(index, before=newest.next_before, limit=2)
    assert ([a.seq for a in older.nodes], older.dividers, older.next_before) == ([3, 1], [(2, ["a"])], None)


async def test_the_lru_keeps_at_most_128_logs(tmp_path):
    paths = [chat_log(tmp_path / f"{n}.jsonl", turns=0) for n in range(reader_mod.LRU_LOGS + 1)]
    reader = RunLogReader()
    for path in paths:
        await reader.index(path)
    assert reader_mod.LRU_LOGS == 128 and list(reader._lru) == paths[1:]
