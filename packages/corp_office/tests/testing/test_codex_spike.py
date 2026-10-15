"""The Codex spike's helpers: scrubbing recordings, pinning the schema, and recording a stdio server."""

import json
import shutil
import sys

from agent_corp.testing import codex_spike
from agent_corp.testing.codex_spike import (
    CHECKS,
    SCENARIOS,
    SCHEMA_FILES,
    AppServer,
    Recorder,
    Spike,
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


def test_scrub_replaces_dict_keys_and_emails_in_any_text():
    got = scrub({"/Users/ann/ws/a.py": "mail ann@corp.com or a.b+c@x.co.uk"}, {"/Users/ann": "/home/owner"})
    assert got == {"/home/owner/ws/a.py": "mail owner@example.com or owner@example.com"}


def test_scrub_replaces_words_only_where_they_stand_alone():
    assert scrub("dev wrote /dev/null with dev-tools as dev.", {}, {"dev": "owner"}) == (
        "owner wrote /dev/null with dev-tools as owner.")


def test_the_spike_scrubs_its_host_codex_home_and_user(tmp_path, monkeypatch):
    monkeypatch.setattr(codex_spike.socket, "gethostname", lambda: "annbox.corp.example")
    monkeypatch.setattr(codex_spike.getpass, "getuser", lambda: "ann")
    monkeypatch.setenv("CODEX_HOME", "/opt/ann-codex")
    spike = Spike("codex", tmp_path / "out")
    shutil.rmtree(spike.root)
    assert spike.scrubbed("ann on annbox.corp.example and annbox: /opt/ann-codex/auth.json, /dev/null") == (
        "owner on owner-host and owner-host: /codex-home/auth.json, /dev/null")


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


def test_one_failing_check_doesnt_hide_the_others(tmp_path, monkeypatch):
    spike = Spike("codex", tmp_path / "out")
    for check in CHECKS:
        monkeypatch.setattr(spike, check.name.replace("-", "_"), lambda thread: {"thread": thread}, raising=False)
    monkeypatch.setattr(spike, "sessions", lambda: ({"recorded": True}, "thr_1"), raising=False)

    def boom(thread):
        raise RuntimeError(f"no login under {spike.ws}")
    monkeypatch.setattr(spike, "launch", boom, raising=False)
    results = spike.run()
    assert results["S1"] == {"ok": False, "detail": {"error": "no login under /work/spike/ws"}}
    assert results["S4"] == {"ok": True, "detail": {"thread": "thr_1"}}
    assert all(results[c.id]["ok"] for c in CHECKS if c.id != "S1")
    assert json.loads((tmp_path / "out" / "spike.json").read_text()) == results
    assert not spike.root.exists()  # the scratch repo goes with the run


def test_every_check_has_its_method():
    assert [c.name for c in CHECKS if not callable(getattr(Spike, c.name.replace("-", "_"), None))] == []


def test_one_failing_scenario_doesnt_hide_the_others_and_runs_again_alone(tmp_path, monkeypatch):
    spike = Spike("codex", tmp_path / "out")
    for name in SCENARIOS:
        monkeypatch.setattr(spike, "_" + name.replace("-", "_"),
                            lambda thread, n=name: {"ran": n, **({"thread": "thr_1"} if n == "plain" else {})},
                            raising=False)

    def never_asked(thread):
        raise KeyError("turnId")
    monkeypatch.setattr(spike, "_interrupt", never_asked, raising=False)
    detail, thread = spike.sessions()
    assert (thread, detail["ok"]) == ("thr_1", True)
    assert detail["scenarios"]["interrupt"] == {"ok": False, "error": "'turnId'"}
    assert detail["scenarios"]["resume"] == {"ok": True, "ran": "resume"}
    (tmp_path / "out" / "spike.json").write_text(json.dumps({"S3": {"ok": True, "detail": detail}}))
    monkeypatch.setattr(spike, "_interrupt", lambda thread: {"status": "interrupted"})
    again = spike.rerun(["interrupt"])["S3"]["detail"]["scenarios"]
    assert again["interrupt"] == {"ok": True, "status": "interrupted"}
    assert again["resume"] == {"ok": True, "ran": "resume"}  # the others are kept


def test_the_results_are_scrubbed_before_they_are_written(tmp_path, monkeypatch):
    spike = Spike("codex", tmp_path / "out")
    ws = str(spike.ws)
    for check in CHECKS:
        monkeypatch.setattr(spike, check.name.replace("-", "_"), lambda thread: {}, raising=False)
    monkeypatch.setattr(spike, "sessions", lambda: ({"scenarios": {}}, "thr_1"))
    monkeypatch.setattr(spike, "writer_lock", lambda thread: {"refused": True, "error": f"locked in {ws}/.git"})
    results = spike.run()
    assert results["S5"]["detail"]["error"] == "locked in /work/spike/ws/.git"
    monkeypatch.delattr(spike, "sessions")
    monkeypatch.setattr(spike, "_plain", lambda thread: {"error": f"again in {ws}", "thread": "thr_2"})
    again = spike.rerun(["plain"])
    assert again["S3"]["detail"]["scenarios"]["plain"]["error"] == "again in /work/spike/ws"
    assert ws not in (tmp_path / "out" / "spike.json").read_text()


def test_only_whole_tokens_make_a_dropped_variable_relevant():
    full = {"https_proxy": "x", "SSL_CERT_FILE": "x", "REQUESTS_CA_BUNDLE": "x", "OPENAI_BASE_URL": "x",
            "NoDefaultCurrentDirectoryInExePath": "1", "XDG_DATA_DIRS": "x", "NODENAME": "x", "CODEXY": "x"}
    assert missing_names(full, {}) == {
        "relevant": ["OPENAI_BASE_URL", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "https_proxy"], "others": 4}
