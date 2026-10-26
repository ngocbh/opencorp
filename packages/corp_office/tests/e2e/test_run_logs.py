"""Run Logs on a real office: a chat is listed, its page has its turn's nodes with their kinds, and its records and
download are shown as stored, a connection key the reply echoes included."""

import pytest

from opencorp.chat.connections import ConnectionFile, Connections

from .fixtures.office import wait_for
from .test_hq import URL, local, wait_listening, web, web_office  # noqa: F401

pytestmark = pytest.mark.timeout(240)
KEY = "conn-key-e2e-7c1d2b9a4f60"


# The name is kept so results line up with the Python suite's, though a chat no longer has a debrief.
def test_a_chat_and_its_debrief_in_run_logs(web_office, workspace, tmp_path, local):  # noqa: F811
    office = web_office
    wait_listening(office)
    port, code = URL.search(office.opencorp("pair", "--no-open", cwd=tmp_path).stdout).groups()
    Connections(office.paths.office).put("e2e", ConnectionFile(
        llm_config={"provider": "vllm", "model": "stub", "api_key": KEY}, env=office.fake.env()))
    office.fake.script({"content": f"noted {KEY}"})
    sid = office.start_chat(office.person("minh"), workspace)
    office.prompt(sid, "remember this")
    office.settled(sid, [f"noted {KEY}"])
    office.post(f"/sessions/{sid}/end")
    office.ended(sid)
    with web(f"http://127.0.0.1:{port}") as browser:
        assert browser.post("/api/pair", json={"code": code}).status_code == 200

        def chat_finished():
            (run,) = [r for r in browser.get("/api/runs").json()["runs"] if r["session_id"] == sid]
            return run if run["status"] == "finished" else None

        # The run's status follows the ended session, once its run log records success.
        top = wait_for(chat_finished, "the chat's run to finish")
        assert (top["flow"], top["status"], top["driver"]) == ("chat", "finished", "ngocbh")
        assert (top["children"], top["children_total"]) == ([], 0)
        head = browser.get(f"/api/runs/{top['run_id']}").json()
        assert head["run"]["children"] == []
        nodes = browser.get(f"/api/runs/{top['run_id']}/nodes").json()["nodes"]
        assert any(n["node_id"].endswith("/reply") and n["status"] == "succeeded" for n in nodes)
        assert all(isinstance(n["kind"], str) and n["kind"] for n in nodes)
        assert {n["kind"] for n in nodes if n["node_id"].endswith("/reply")} == {"agent"}
        events = browser.get(f"/api/runs/{top['run_id']}/events").json()["events"]
        assert any(f"noted {KEY}" in str(e["payload"]) for e in events)
        log = browser.get(f"/api/runs/{top['run_id']}/log")
        stored = office.paths.runs / top["run_id"] / "log.jsonl"
        assert log.status_code == 200 and log.content == stored.read_bytes()
