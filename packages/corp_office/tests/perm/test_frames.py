"""Asset credentials never reach a worker: scan every frame, the model's requests, and the run log."""

import json
from pathlib import Path

from opencorp.worker.channel import Channel
from opencorp.worker.job import group_specs
from tests.perm.conftest import TOKEN, cluster
from tests.worker.conftest import Recorder, fake_llm, make_job, pin, registry, run, session_dir  # noqa: F401

CALLS = [
    {"name": "cluster_a__submit_job", "arguments": {"job": "train", "partition": "gpu-small"}},
    {"name": "cluster_a__submit_job", "arguments": {"job": "big", "partition": "gpu-big"}},
    {"name": "cluster_a__broken", "arguments": {}},
]


def test_no_frame_or_model_text_holds_a_secret(make_monitor, fake_llm, registry, make_job, session_dir,  # noqa: F811
                                              monkeypatch):
    grants = [{"who": "minh", "can": ["submit_job"], "where": {"partition": ["gpu-small"]}},
              {"who": "minh", "can": ["broken"]}]
    monitor = make_monitor(**{"assets/cluster-a.yaml": cluster(grants)})
    frames: list[str] = []
    send, recv = Channel.send, Channel.recv

    def record_send(self, frame):
        frames.append(json.dumps(frame))
        send(self, frame)

    def record_recv(self):
        frame = recv(self)
        frames.append(json.dumps(frame))
        return frame

    monkeypatch.setattr(Channel, "send", record_send)
    monkeypatch.setattr(Channel, "recv", record_recv)

    toolbox = monitor.tools("minh", run_id="r1", session_id="s1")
    fake_llm.script({"tool_calls": CALLS}, {"content": "done"})
    job = make_job("flows/tools.yaml", groups=group_specs({"toolbox": toolbox}))
    rec = run(registry, job, Recorder(tools={"toolbox": toolbox}), session_dir)

    assert rec.outcome["output"] == "done"
    model_text = json.dumps(fake_llm.requests())
    # The calls really ran, and their results reached the model.
    assert "ran train on gpu-small with [redacted]" in model_text
    assert 'permission denied: cluster_a__submit_job: partition must be one of [\\"gpu-small\\"]' in model_text
    assert "error: RuntimeError: cannot reach host (token [redacted])" in model_text
    assert sum('"type": "tool_call"' in f for f in frames) == 3
    assert sum('"type": "tool_result"' in f for f in frames) == 3
    # ...and the secret is nowhere a worker or the model could see it.
    assert not [f for f in frames if TOKEN in f]
    assert TOKEN not in model_text
    assert TOKEN not in Path(job.log).read_text()
    audit = monitor.store.list_audit()
    assert sorted(r.outcome for r in audit) == ["denied", "error", "ok"]
    assert not any(TOKEN in json.dumps(r.args) + (r.detail or "") for r in audit)
