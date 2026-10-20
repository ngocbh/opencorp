"""The run-log reader: a lazy, bounded index per log with its node table; node and record pages; plain reads only."""

import os
import tracemalloc

import pytest

from opencorp.runs import reader as reader_mod
from opencorp.runs.reader import (BIG_LINE, UnreadableLog, UnsupportedSchema, node_page, read_event, read_events,
                                  refresh, scrubbed_lines)
from tests.runs.logs import (FP, chat_log, expanded, failed, line, resumed, routed, run_started, started,
                             succeeded)


def nothing(record):
    """A scrub that keeps everything, for the reader's own tests."""
    return record


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
    (8, "This log uses run-log schema 8, which is older than this office supports")])
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
    assert len(index.nodes[2].error) == 200 and list(index.open) == ["m#1/a"]


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
    page = read_events(path, index, after=99, limit=10, scrub=nothing)
    assert ([e.seq for e in page.events], page.next_after, page.cut) == (list(range(100, 110)), 109, False)
    last = read_events(path, index, after=180, limit=10, scrub=nothing)
    assert ([e.seq for e in last.events], last.next_after) == ([181, 182, 183], None)


def test_an_envelope_field_after_seq_doesnt_hide_a_record_from_pages_or_one_record(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + b"".join(started(n, f"n{n}", trace_id=f"t{n}") for n in range(1, 70)))
    index = refresh(path, None)
    page = read_events(path, index, after=63, limit=10, scrub=nothing)
    assert [e.seq for e in page.events] == list(range(64, 70))
    assert read_event(path, index, 65, nothing).node_id == "n65"


def test_long_strings_are_cut_evidence_left_out_and_the_page_stops_at_its_bytes(tmp_path, monkeypatch):
    monkeypatch.setattr(reader_mod, "PAGE_BYTES", 20_000)
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + b"".join(
        succeeded(n, f"n{n}", {"output": "x" * 10_000}, evidence={"prompt": "p"}) for n in range(1, 6)))
    page = read_events(path, refresh(path, None), after=0, limit=500, scrub=nothing)
    first = page.events[0]
    assert first.cut == ["/value/output"] and len(first.payload["value"]["output"]) == reader_mod.FIELD_CHARS + 1
    assert first.evidence_left_out and first.payload["evidence"] is None and first.node_id == "n1"
    assert page.cut and len(page.events) < 5 and page.next_after == page.events[-1].seq


def test_a_line_over_2_mib_is_a_stub_with_its_kind_seq_and_size(tmp_path):
    path = tmp_path / "r.jsonl"
    huge = line(1, "node_succeeded", {"node_id": "big", "value": {"output": "y" * (BIG_LINE + 10)}},
                at="2026-10-20T10:00:00.000Z")
    path.write_bytes(run_started(0) + huge + started(2, "next"))
    page = read_events(path, refresh(path, None), after=0, limit=10, scrub=nothing)
    stub = page.events[0]
    assert (stub.seq, stub.kind, stub.size, stub.payload) == (1, "node_succeeded", len(huge), None)
    assert page.events[1].seq == 2


def test_one_record_by_seq_has_its_evidence_and_is_capped(tmp_path, monkeypatch):
    path = tmp_path / "r.jsonl"
    path.write_bytes(run_started(0) + succeeded(1, "a", {"output": "z" * 9000}, evidence={"prompt": "the prompt"}))
    index = refresh(path, None)
    event = read_event(path, index, 1, nothing)
    assert event.payload["evidence"] == {"prompt": "the prompt"} and event.cut == []
    monkeypatch.setattr(reader_mod, "EVENT_BYTES", 5000)
    assert read_event(path, index, 1, nothing).cut == ["/value/output"]
    assert read_event(path, index, 7, nothing) is None


def test_a_page_shows_a_withheld_record_as_its_stub(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=1)

    def withhold(record):
        return {"seq": record["seq"], "kind": record["kind"], "withheld": "a secret couldn't be removed"}

    page = read_events(path, refresh(path, None), after=None, limit=3, scrub=withhold)
    assert [(e.seq, e.withheld, e.payload) for e in page.events] == [
        (0, "a secret couldn't be removed", None), (1, "a secret couldn't be removed", None),
        (2, "a secret couldn't be removed", None)]


def test_a_file_changed_under_a_page_stops_it_there(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=1)
    index = refresh(path, None)
    data = path.read_bytes().splitlines(keepends=True)
    path.write_bytes(b"".join(data[:4]) + started(9, "rewritten") + b"".join(data[5:]))  # line 4 no longer seq 4
    page = read_events(path, index, after=None, limit=100, scrub=nothing)
    assert ([e.seq for e in page.events], page.next_after) == ([0, 1, 2, 3], 3)


def test_the_download_is_every_complete_line_through_the_scrub(tmp_path):
    path = chat_log(tmp_path / "r.jsonl", turns=1)
    with path.open("ab") as f:
        f.write(b'{"torn')
    lines = list(scrubbed_lines(path, lambda raw: raw.upper()))
    assert len(lines) == 10 and lines[0].startswith(b'{"KIND"')
