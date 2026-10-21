"""Run Logs on a real office: a chat and its debrief are listed and nested, the chat's page has its turn's nodes, and
its records and download are shown as stored, a connection key the reply echoes included."""

from pathlib import Path

import pytest

from opencorp.chat.connections import ConnectionFile, Connections
from tests.profile.conftest import debrief_reply

from .test_hq import URL, local, wait_listening, web, web_office  # noqa: F401

pytestmark = pytest.mark.timeout(240)
KEY = "conn-key-e2e-7c1d2b9a4f60"


def test_a_chat_and_its_debrief_in_run_logs(web_office, workspace, tmp_path, local):  # noqa: F811
    office = web_office
    wait_listening(office)
    port, code = URL.search(office.opencorp("pair", "--no-open", cwd=tmp_path).stdout).groups()
    Connections(office.paths.office).put("e2e", ConnectionFile(
        llm_config={"provider": "vllm", "model": "stub", "api_key": KEY}, env=office.fake.env()))
    office.fake.script({"content": f"noted {KEY}"}, debrief_reply())
    sid = office.start_chat(office.person("minh"), workspace)
    office.prompt(sid, "remember this")
    office.settled(sid, [f"noted {KEY}"])
    office.post(f"/sessions/{sid}/end")
    office.debriefed(sid)
    with web(f"http://127.0.0.1:{port}") as browser:
        assert browser.post("/api/pair", json={"code": code}).status_code == 200
        (top,) = [r for r in browser.get("/api/runs").json()["runs"] if r["session_id"] == sid]
        assert (top["flow"], top["status"], top["driver"]) == ("chat", "finished", "ngocbh")
        assert (top["children"], top["children_total"]) == ([], 1)  # a list page counts children; ?parent= lists them
        (debrief,) = browser.get("/api/runs", params={"parent": top["run_id"]}).json()["runs"]
        assert (debrief["flow"], debrief["driver"], debrief["status"]) == ("debrief", "office", "finished")
        head = browser.get(f"/api/runs/{top['run_id']}").json()
        assert head["log_state"] == "ok" and [k["run_id"] for k in head["run"]["children"]] == [debrief["run_id"]]
        nodes = browser.get(f"/api/runs/{top['run_id']}/nodes").json()["nodes"]
        assert any(n["node_id"].endswith("/reply") and n["status"] == "succeeded" for n in nodes)
        assert all(n["kind"] is None for n in nodes)  # until yian#943
        events = browser.get(f"/api/runs/{top['run_id']}/events").json()["events"]
        assert any(f"noted {KEY}" in str(e["payload"]) for e in events)
        log = browser.get(f"/api/runs/{top['run_id']}/log")
        stored = Path(office.paths.run_dir(sid)) / "runs" / f"{top['run_id']}.jsonl"
        assert log.status_code == 200 and log.content == stored.read_bytes()
