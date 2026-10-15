"""The Codex spike's helpers: scrubbing recordings, pinning the schema, and recording a stdio server."""

import json

from agent_corp.testing.codex_spike import SCHEMA_FILES, kept, pin_schema, scrub
from tests.company.conftest import _isolate_git  # noqa: F401  (autouse: the owner's git config stays out)


def test_scrub_replaces_paths_and_names_everywhere():
    obj = {"cwd": "/Users/ann/x/ws", "items": ["/Users/ann/.codex/sessions/a.jsonl", "ann wrote"],
           "account": {"email": "ann@corp.com"}}
    got = scrub(obj, {"/Users/ann/x/ws": "/work/spike/ws", "/Users/ann": "/home/owner", "ann": "owner"})
    assert got == {"cwd": "/work/spike/ws", "items": ["/home/owner/.codex/sessions/a.jsonl", "owner wrote"],
                   "account": {"email": "owner@example.com"}}


def test_scrub_replaces_longer_paths_first():
    assert scrub("/a/b/c and /a/b", {"/a/b": "B", "/a/b/c": "C"}) == "C and B"


def test_kept_keeps_requests_answers_and_the_notifications_the_office_reads():
    assert [kept(m) for m in [{"method": "mcpServer/startupStatus/updated", "params": {"name": "corp-wiki"}},
                              {"method": "configWarning", "params": {"summary": "x"}},
                              {"method": "item/started", "params": {}}, {"id": 1, "result": {}},
                              {"id": 2, "method": "item/tool/requestUserInput", "params": {}}]] == [
        False, False, True, True, True]


def test_pin_schema_keeps_the_bundles_the_tests_read_and_the_version(tmp_path):
    src = tmp_path / "gen"
    src.mkdir()
    for name in (*SCHEMA_FILES, "Other.json"):
        (src / name).write_text(json.dumps({"title": name}))
    out = tmp_path / "schema"
    pin_schema(src, out, version="codex-cli 0.130.0")
    assert sorted(p.name for p in out.iterdir()) == sorted([*SCHEMA_FILES, "VERSION"])
    assert (out / "VERSION").read_text() == "codex-cli 0.130.0\n"
