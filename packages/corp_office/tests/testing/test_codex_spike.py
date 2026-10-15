"""The Codex spike's helpers: scrubbing recordings, pinning the schema, and recording a stdio server."""

import json
import sys

from agent_corp.testing.codex_spike import (
    CHECKS,
    SCHEMA_FILES,
    AppServer,
    Recorder,
    checklist,
    kept,
    missing_names,
    office_env,
    owner_load,
    pin_schema,
    scrub,
)
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


STUB = r'''
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    if "id" in msg and "method" in msg:
        print(json.dumps({"method": "item/started", "params": {"seen": msg["method"]}}), flush=True)
        print(json.dumps({"id": msg["id"], "result": {"ok": msg["method"]}}), flush=True)
'''


def test_app_server_records_both_directions(tmp_path):
    log = tmp_path / "s.jsonl"
    with AppServer([sys.executable, "-c", STUB], tmp_path, Recorder(log, {})) as server:
        assert server.request("initialize", {"x": 1}) == {"ok": "initialize"}
        assert server.wait("item/started")["params"] == {"seen": "initialize"}
    lines = [json.loads(line) for line in log.read_text().splitlines()]
    assert [(entry["dir"], entry["msg"].get("method", "result")) for entry in lines] == [
        ("out", "initialize"), ("in", "item/started"), ("in", "result")]


def test_the_recorder_keeps_only_what_the_office_reads(tmp_path):
    log = tmp_path / "s.jsonl"
    recorder = Recorder(log, {"/Users/ann": "/home/owner"})
    for msg in [{"method": "configWarning", "params": {"summary": "x"}},
                {"method": "item/started", "params": {"cwd": "/Users/ann/ws"}}]:
        recorder.write("in", msg)
    assert [json.loads(line) for line in log.read_text().splitlines()] == [
        {"dir": "in", "msg": {"method": "item/started", "params": {"cwd": "/home/owner/ws"}}}]


def test_owner_load_routes_approvals_to_the_user():
    assert owner_load("/w", "workspace-write", network=True) == {
        "cwd": "/w", "sandbox": "workspace-write", "approvalPolicy": "on-request", "approvalsReviewer": "user",
        "config": {"sandbox_workspace_write": {"network_access": True}}}


def test_the_office_env_is_the_workers_and_only_names_of_what_it_drops_are_kept():
    full = {"PATH": "/bin", "HOME": "/h", "LC_ALL": "C", "LC_TERMINAL": "iTerm2", "HTTPS_PROXY": "http://p:3128",
            "NODE_EXTRA_CA_CERTS": "/ca.pem", "CODEX_HOME": "/c", "EDITOR": "vim"}
    narrow = office_env(full)
    assert narrow == {"PATH": "/bin", "HOME": "/h", "LC_ALL": "C"}
    assert missing_names(full, narrow) == {"relevant": ["CODEX_HOME", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"],
                                           "others": 2}


def test_the_checklist_names_every_check_and_marks_failures():
    results = {c.id: {"ok": c.id != "S5", "detail": "x"} for c in CHECKS}
    text = checklist(results)
    assert [line.split()[1] for line in text.splitlines()] == [c.id for c in CHECKS]
    assert "FAIL S5" in text and "ok   S1" in text
