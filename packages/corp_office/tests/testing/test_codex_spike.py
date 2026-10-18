"""The Codex spike's helpers: scrubbing recordings, pinning the schema, and recording a stdio server."""

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from opencorp.testing import codex_spike
from opencorp.testing.codex_spike import (
    CHECKS,
    RERUN_CHECKS,
    SCENARIOS,
    SCHEMA_FILES,
    AppServer,
    Recorder,
    Spike,
    SpikeError,
    checklist,
    kept,
    main,
    missing_names,
    office_env,
    owner_load,
    pin_schema,
    recut,
    scrub,
    signed_in,
)
from opencorp.worker import spawn
from tests.company.conftest import _isolate_git  # noqa: F401  (autouse: the owner's git config stays out)

SCHEMA = Path(__file__).parents[1] / "harness" / "fixtures" / "codex" / "schema"


@pytest.fixture(autouse=True)
def _scratch_under_tmp_path(tmp_path, monkeypatch):
    """A Spike's scratch folder goes under the test's own tmp_path, so a test that fails early leaves none behind."""
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))


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


def test_scrub_leaves_package_versions_that_look_like_emails():
    text = "npm i react@18.2.0 and @openai/codex@0.130.0; mail ann@corp.com"
    assert scrub(text, {}) == "npm i react@18.2.0 and @openai/codex@0.130.0; mail owner@example.com"


def test_the_spike_never_scrubs_a_user_or_host_that_is_a_protocol_word(tmp_path, monkeypatch):
    monkeypatch.setattr(codex_spike.socket, "gethostname", lambda: "model.local")
    monkeypatch.setattr(codex_spike.getpass, "getuser", lambda: "user")
    spike = Spike("codex", tmp_path / "out")
    shutil.rmtree(spike.root)
    assert spike.words == {"model.local": "owner-host"}
    assert spike.scrubbed({"user": "u", "model": "gpt", "status": "completed"}) == {
        "user": "u", "model": "gpt", "status": "completed"}


def test_scrub_replaces_words_only_where_they_stand_alone():
    assert scrub("dev wrote /dev/null with dev-tools as dev.", {}, {"dev": "owner"}) == (
        "owner wrote /dev/null with dev-tools as owner.")


def test_the_spike_scrubs_its_host_codex_home_and_user(tmp_path, monkeypatch):
    monkeypatch.setattr(codex_spike.socket, "gethostname", lambda: "annbox.corp.example")
    monkeypatch.setattr(codex_spike.getpass, "getuser", lambda: "ann")
    monkeypatch.setenv("CODEX_HOME", "/opt/ann-codex")
    spike = Spike("codex", tmp_path / "out")
    assert spike.root.parent == tmp_path
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


def test_a_server_that_exits_fails_fast_with_its_code_and_last_stderr_lines(tmp_path):
    stub = "import sys; print('no config under /Users/ann/x', file=sys.stderr); sys.exit(3)"
    recorder = Recorder(tmp_path / "s.jsonl", {"/Users/ann": "/home/owner"})
    started = time.monotonic()
    with AppServer([sys.executable, "-c", stub], tmp_path, recorder, stderr=tmp_path / "err.log") as server:
        with pytest.raises(SpikeError) as raised:
            server.request("initialize", timeout=30)
        with pytest.raises(SpikeError, match="exited"):
            server.next(timeout=30)
    assert time.monotonic() - started < 15
    assert "initialize: the app-server exited (code 3)" in str(raised.value)
    assert "no config under /home/owner/x" in str(raised.value)


def test_a_server_line_that_isnt_json_is_skipped(tmp_path):
    stub = "print('starting the gateway', flush=True)\n" + STUB
    with AppServer([sys.executable, "-c", stub], tmp_path, Recorder(tmp_path / "s.jsonl", {})) as server:
        assert server.request("initialize", {}) == {"ok": "initialize"}


def test_waiting_ends_at_its_deadline_while_other_messages_keep_coming(tmp_path):
    chatter = ("import json, os, sys, threading, time\n"
               "threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()\n"
               "while True:\n"
               "    print(json.dumps({'method': 'item/started', 'params': {}}), flush=True)\n    time.sleep(0.01)")
    with AppServer([sys.executable, "-c", chatter], tmp_path, Recorder(tmp_path / "s.jsonl", {})) as server:
        started = time.monotonic()
        with pytest.raises(SpikeError, match="no turn/completed in 1s"):
            server.wait("turn/completed", timeout=1)
        assert time.monotonic() - started < 5


def test_the_recorder_keeps_only_what_the_office_reads(tmp_path):
    log = tmp_path / "s.jsonl"
    recorder = Recorder(log, {"/Users/ann": "/home/owner"})
    for msg in [{"method": "configWarning", "params": {"summary": "x"}},
                {"method": "item/started", "params": {"cwd": "/Users/ann/ws"}}]:
        recorder.write("in", msg)
    assert [json.loads(line) for line in log.read_text().splitlines()] == [
        {"dir": "in", "msg": {"method": "item/started", "params": {"cwd": "/home/owner/ws"}}}]


def note(method, **params):
    return {"method": method, "params": {"threadId": "t1", "turnId": "u1", **params}}


def recorded(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


def test_the_recorder_scrubs_a_path_split_across_deltas_and_keeps_their_count_and_order(tmp_path):
    log = tmp_path / "s.jsonl"
    recorder = Recorder(log, {"/tmp/ac-codex-spike-x1": "/work/spike"})
    text = "Wrote /tmp/ac-codex-spike-x1/ws/a.md for you."
    pieces = ["Wrote /tmp/ac-co", "dex-spike-", "x1/ws/a", ".md for you."]
    recorder.write("in", note("item/started", item={"type": "agentMessage", "id": "m1", "text": ""}))
    for i, piece in enumerate(pieces):
        recorder.write("in", note("item/agentMessage/delta", itemId="m1", delta=piece))
        if i == 1:  # what happens meanwhile stays where it happened
            recorder.write("out", {"id": 7, "result": {}})
    recorder.write("in", note("item/completed", item={"type": "agentMessage", "id": "m1", "text": text}))
    lines = recorded(log)
    assert "/tmp/ac-" not in log.read_text()
    assert [(e["dir"], e["msg"].get("method")) for e in lines] == [
        ("in", "item/started"), ("in", "item/agentMessage/delta"), ("in", "item/agentMessage/delta"), ("out", None),
        ("in", "item/agentMessage/delta"), ("in", "item/agentMessage/delta"), ("in", "item/completed")]
    deltas = [e["msg"]["params"]["delta"] for e in lines if e["msg"].get("method") == "item/agentMessage/delta"]
    assert "".join(deltas) == lines[-1]["msg"]["params"]["item"]["text"] == "Wrote /work/spike/ws/a.md for you."
    assert deltas[:3] == ["Wrote /", "", "work/spike/ws/a"]  # a cut inside the path moves back to where it changed
    notes = Draft7Validator(json.loads((SCHEMA / "ServerNotification.json").read_text()))
    for delta in [e["msg"] for e in lines if e["msg"].get("method") == "item/agentMessage/delta"]:
        notes.validate(delta)


def test_the_recorder_keeps_each_stream_apart(tmp_path):
    log = tmp_path / "s.jsonl"
    recorder = Recorder(log, {"/Users/ann": "/home/owner"})
    for msg in [note("item/reasoning/summaryTextDelta", itemId="r1", summaryIndex=0, delta="In /Users/"),
                note("item/reasoning/summaryTextDelta", itemId="r1", summaryIndex=1, delta="Then /Use"),
                note("item/reasoning/summaryTextDelta", itemId="r1", summaryIndex=0, delta="ann/a."),
                note("item/reasoning/summaryTextDelta", itemId="r1", summaryIndex=1, delta="rs/ann/b."),
                note("item/commandExecution/outputDelta", itemId="c1", delta="/Users/a"),
                note("item/completed", item={"type": "reasoning", "id": "r1", "summary": [], "content": []}),
                note("item/commandExecution/outputDelta", itemId="c1", delta="nn/c\n"),
                note("item/completed", item={"type": "commandExecution", "id": "c1"})]:
        recorder.write("in", msg)
    joined = {}
    for e in recorded(log):
        params = e["msg"]["params"]
        if "delta" in params:
            key = (params["itemId"], params.get("summaryIndex"))
            joined[key] = joined.get(key, "") + params["delta"]
    assert joined == {("r1", 0): "In /home/owner/a.", ("r1", 1): "Then /home/owner/b.", ("c1", None): "/home/owner/c\n"}


def test_a_stream_still_open_when_the_turn_completes_is_written_then(tmp_path):
    log = tmp_path / "s.jsonl"
    recorder = Recorder(log, {"/Users/ann": "/home/owner"})
    recorder.write("in", note("item/agentMessage/delta", itemId="m1", delta="/Users/a"))
    recorder.write("in", note("item/agentMessage/delta", itemId="m1", delta="nn"))
    assert log.read_text() == ""  # held until its stream ends
    recorder.write("in", {"method": "turn/completed", "params": {"threadId": "t1", "turn": {"id": "u1"}}})
    assert [e["msg"]["params"].get("delta") for e in recorded(log)] == ["/", "home/owner", None]


DELTAS = r'''
import json, sys
for piece in ["/Users/a", "nn/x"]:
    print(json.dumps({"method": "item/agentMessage/delta",
                      "params": {"threadId": "t1", "turnId": "u1", "itemId": "m1", "delta": piece}}), flush=True)
sys.stdin.read()
'''


def test_a_stream_still_open_when_the_server_ends_is_written_scrubbed(tmp_path):
    log = tmp_path / "s.jsonl"
    with AppServer([sys.executable, "-c", DELTAS], tmp_path, Recorder(log, {"/Users/ann": "/home/owner"})) as server:
        server.wait("item/agentMessage/delta", where=lambda m: m["params"]["delta"] == "nn/x", timeout=30)
    assert "".join(e["msg"]["params"]["delta"] for e in recorded(log)) == "/home/owner/x"


def test_recut_leaves_pieces_the_scrub_doesnt_change_as_they_are_after_one_scrub():
    calls = []
    assert recut(lambda s: calls.append(s) or s, ["a /x", "/y b"]) == ["a /x", "/y b"]
    assert calls == ["a /x/y b"]
    assert recut(lambda s: s, []) == []


def test_recut_cuts_where_the_scrubbed_prefix_stops_agreeing_with_the_scrubbed_whole():
    def text(s):
        return s.replace("/Users/ann", "/home/owner")

    assert recut(text, ["see /Us", "ers/a", "nn/x ok"]) == ["see /", "", "home/owner/x ok"]


class UnflushableRecorder(Recorder):
    def flush(self):
        raise OSError("disk full")


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_recording_that_fails_to_flush_still_ends_the_wait_for_the_server(tmp_path):
    server = AppServer([sys.executable, "-c", "pass"], tmp_path, UnflushableRecorder(tmp_path / "s.jsonl", {}))
    with pytest.raises(SpikeError, match="exited"):
        server.next(timeout=10)
    with pytest.raises(OSError, match="disk full"):
        server.close()


def test_owner_load_routes_approvals_to_the_user():
    assert owner_load("/w", "workspace-write", network=True) == {
        "cwd": "/w", "sandbox": "workspace-write", "approvalPolicy": "on-request", "approvalsReviewer": "user",
        "config": {"sandbox_workspace_write": {"network_access": True}}}


def test_the_office_env_is_the_workers_plus_codex_home_and_only_names_of_what_it_drops_are_kept():
    full = {"PATH": "/bin", "HOME": "/h", "LC_ALL": "C", "LC_TERMINAL": "iTerm2", "HTTPS_PROXY": "http://p:3128",
            "NODE_EXTRA_CA_CERTS": "/ca.pem", "CODEX_HOME": "/c", "EDITOR": "vim"}
    narrow = office_env(full)
    assert narrow == {"PATH": "/bin", "HOME": "/h", "LC_ALL": "C", "CODEX_HOME": "/c"}
    assert missing_names(full, narrow) == {"relevant": ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"], "others": 2}


def test_the_office_env_has_no_codex_home_when_none_is_set():
    assert office_env({"PATH": "/bin", "HOME": "/h", "OPENAI_API_KEY": "x"}) == {"PATH": "/bin", "HOME": "/h"}


def test_the_spikes_allowlist_is_the_offices():
    assert codex_spike.INHERITED_ENV == spawn.INHERITED_ENV


def test_the_office_env_keeps_where_tls_finds_ca_certificates():
    full = {"PATH": "/bin", "SSL_CERT_FILE": "/ca.pem", "SSL_CERT_DIR": "/certs", "REQUESTS_CA_BUNDLE": "/ca.pem"}
    narrow = office_env(full)
    assert narrow == {"PATH": "/bin", "SSL_CERT_FILE": "/ca.pem", "SSL_CERT_DIR": "/certs"}
    assert missing_names(full, narrow) == {"relevant": ["REQUESTS_CA_BUNDLE"], "others": 0}


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
    assert results["S1"] == {"ok": False, "detail": {"error": "RuntimeError: no login under /work/spike/ws"}}
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
    assert detail["scenarios"]["interrupt"] == {"ok": False, "error": "KeyError: 'turnId'"}
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


FAKE_CODEX = r'''
import json, os, sys

if sys.argv[1:] != ["app-server", "--listen", "stdio://"]:  # --version, login status
    print("codex-cli 0.0.0-fake")
    sys.exit(0)
ask = os.environ.get("FAKE_CODEX_ASKS")  # the approval method a turn asks first; none when unset
says_cwd = os.environ.get("FAKE_CODEX_SAYS_CWD")  # a turn streams its cwd in two deltas and never ends, when set


def send(msg):
    print(json.dumps(msg), flush=True)


def ran_and_completed():
    send({"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c1"},
                                               "threadId": "thr_1", "turnId": "turn_1"}})
    send({"method": "turn/completed", "params": {"threadId": "thr_1",
                                                 "turn": {"id": "turn_1", "status": "completed", "items": []}}})


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method is None:  # the answer to an approval
        ran_and_completed()
    elif "id" in msg:
        result = {"thread/start": {"thread": {"id": "thr_1"}}, "turn/start": {"turn": {"id": "turn_1"}},
                  "account/read": {"account": None, "requiresOpenaiAuth": False}}
        send({"id": msg["id"], "result": result.get(method, {})})
        if method == "turn/start" and ask:
            send({"id": 900, "method": ask, "params": {"itemId": "c1", "threadId": "thr_1", "turnId": "turn_1"}})
        elif method == "turn/start" and says_cwd:
            for piece in (os.getcwd()[:6], os.getcwd()[6:]):
                send({"method": "item/agentMessage/delta",
                      "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "m1", "delta": piece}})
        elif method == "turn/start":
            send({"method": "turn/completed", "params": {"threadId": "thr_1",
                                                         "turn": {"id": "turn_1", "status": "completed"}}})
'''


@pytest.fixture
def fake_spike(tmp_path):
    """A Spike whose ``codex`` is ``FAKE_CODEX``; ``FAKE_CODEX_ASKS`` picks the approval a turn asks for."""
    codex = tmp_path / "codex"
    codex.write_text(f"#!{sys.executable}\n{FAKE_CODEX}")
    codex.chmod(0o755)
    spike = Spike(str(codex), tmp_path / "out")
    yield spike
    shutil.rmtree(spike.root, ignore_errors=True)


def test_an_approval_scenario_is_ok_only_when_codex_asked_for_its_kind(fake_spike, monkeypatch):
    monkeypatch.delenv("FAKE_CODEX_ASKS", raising=False)
    assert fake_spike._command_approve(None) == {"ok": False, "status": "completed", "asked": []}
    monkeypatch.setenv("FAKE_CODEX_ASKS", "item/commandExecution/requestApproval")
    assert fake_spike._command_decline(None) == {"ok": True, "status": "completed",
                                                 "asked": ["item/commandExecution/requestApproval"]}
    assert fake_spike._file_change(None)["ok"] is False
    monkeypatch.setenv("FAKE_CODEX_ASKS", "item/fileChange/requestApproval")
    assert fake_spike._file_change(None)["ok"] is True


def test_waiting_for_a_command_answers_approvals_on_the_way(fake_spike, monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_ASKS", "item/commandExecution/requestApproval")
    with fake_spike.server("ran") as server:
        server.request("turn/start", {"threadId": "thr_1", "input": []})
        assert fake_spike.wait_command_started(server)["params"]["item"]["type"] == "commandExecution"
    monkeypatch.delenv("FAKE_CODEX_ASKS")
    with fake_spike.server("ran-nothing") as server:
        server.request("turn/start", {"threadId": "thr_1", "input": []})
        with pytest.raises(SpikeError, match="the model ran no command"):
            fake_spike.wait_command_started(server)


def test_eof_kills_its_app_server_when_it_fails(fake_spike, monkeypatch):
    monkeypatch.delenv("FAKE_CODEX_ASKS", raising=False)
    servers = []
    real = fake_spike.server
    monkeypatch.setattr(fake_spike, "server", lambda name, env=None: servers.append(real(name, env)) or servers[-1])
    with pytest.raises(SpikeError, match="the model ran no command"):
        fake_spike.eof(None)
    assert servers[0].proc.poll() is not None


def test_eof_writes_the_deltas_still_waiting_when_it_fails(fake_spike, monkeypatch):
    monkeypatch.delenv("FAKE_CODEX_ASKS", raising=False)
    monkeypatch.setenv("FAKE_CODEX_SAYS_CWD", "1")

    def fails_after_the_deltas(server):
        deltas = lambda: sum(m.get("method") == "item/agentMessage/delta" for m in server.seen)  # noqa: E731
        server.wait("item/agentMessage/delta", where=lambda m: deltas() == 2, timeout=30)
        raise SpikeError("the model ran no command")

    monkeypatch.setattr(fake_spike, "wait_command_started", fails_after_the_deltas)
    with pytest.raises(SpikeError, match="the model ran no command"):
        fake_spike.eof(None)
    lines = [json.loads(line)["msg"] for line in (fake_spike.out / "sessions" / "eof.jsonl").read_text().splitlines()]
    assert "".join(m["params"]["delta"] for m in lines if m.get("method") == "item/agentMessage/delta") == (
        "/work/spike/ws")


def test_eof_and_office_env_run_again_alone(tmp_path, monkeypatch):
    spike = Spike("codex", tmp_path / "out")
    before = {"S3": {"ok": True, "detail": {"scenarios": {"plain": {"ok": True}}}},
              "S6": {"ok": False, "detail": {"error": "SpikeError: no item/started in 180s"}},
              "S7": {"ok": True, "detail": {"turn": "completed"}}}
    (tmp_path / "out" / "spike.json").write_text(json.dumps(before))
    monkeypatch.setattr(spike, "eof", lambda thread: {"seconds_to_exit": 0.5, "group_left": False})
    results = spike.rerun(["eof"])
    assert results == {**before, "S6": {"ok": True, "detail": {"seconds_to_exit": 0.5, "group_left": False}}}
    assert RERUN_CHECKS == ("eof", "office-env")
    assert not spike.root.exists()


def test_signed_in_counts_an_account_or_a_login_that_needs_no_openai_auth():
    assert signed_in({"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True})["signed_in"] is True
    assert signed_in({"account": None, "requiresOpenaiAuth": False}) == {
        "signed_in": True, "has_account": False, "requires_openai_auth": False}
    assert signed_in({"account": None, "requiresOpenaiAuth": True})["signed_in"] is False


def test_launch_counts_a_gateway_login_without_an_account(fake_spike):
    assert fake_spike.launch(None) == {"ok": True, "version": "codex-cli 0.0.0-fake", "login_status_exit": 0,
                                       "signed_in": True, "has_account": False, "requires_openai_auth": False}


def test_a_scratch_repo_that_fails_leaves_no_temp_folder(tmp_path, monkeypatch):
    scratch = tmp_path / "scratch"
    monkeypatch.setattr(codex_spike.tempfile, "mkdtemp", lambda prefix: (scratch.mkdir(), str(scratch))[1])
    run = subprocess.run

    def no_git(command, **kwargs):
        if command[0] == "git":
            raise subprocess.CalledProcessError(128, command)
        return run(command, **kwargs)
    monkeypatch.setattr(codex_spike.subprocess, "run", no_git)
    with pytest.raises(subprocess.CalledProcessError):
        Spike("codex", tmp_path / "out")
    assert not scratch.exists()


def test_running_one_again_needs_a_full_run_first(tmp_path, capsys):
    assert main(["--out", str(tmp_path / "out"), "--codex", sys.executable, "--scenario", "office-env"]) == 2
    assert "run the full spike first" in capsys.readouterr().out


def test_only_the_service_read_gates_nothing():
    assert [c.id for c in CHECKS if not c.gates] == ["S4"]
