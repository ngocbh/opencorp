import logging

import pytest

from opencorp.chat.connections import OFFICE, write_run_record
from opencorp.extensions.learning import Learning
from opencorp.profile.debrief import ready_debrief
from opencorp.protocol import now
from opencorp.protocol.models import Feedback
from opencorp.store import new_id
from opencorp.testing.fake_llm import LLM_CONFIG
from tests.profile.conftest import LEARNING_FILES, OUTPUT, settled, wait_for
from tests.store.conftest import message, session

SENTINEL = "sk-sentinel-5d1e09"


@pytest.fixture
def keyed(make_harness, monkeypatch):
    """A harness whose model key is ``SENTINEL`` and whose workers never start: spawning raises with the key."""
    harness = make_harness(files=LEARNING_FILES, llm_config={**LLM_CONFIG, "api_key": SENTINEL})

    def spawn(job, session_dir, handlers):
        raise RuntimeError(f"can't start a worker for llm_config {job.llm_config}")

    monkeypatch.setattr(harness.registry, "spawn", spawn)
    return harness


def test_learning_never_logs_the_model_key(keyed, caplog):
    harness = keyed
    caplog.set_level(logging.DEBUG, logger="opencorp")
    learning = Learning(harness.office, harness, tick=None)
    learning.start()
    try:
        head = harness.git.head()
        failed = harness.store.create_session(session(repo_commit=head, status="failed", run_ids=["r1"]))
        harness.store.add_message(message(failed.id, parts=[{"id": new_id(), "type": "text", "text": "fix it"}]))
        learning.tick()  # its debrief can't start
        wait_for(lambda: harness.store.get_debrief_record(failed.id) is not None
                 and harness.store.get_debrief_record(failed.id).attempts == 1, what="the failed debrief")

        failure = {"node_id": "debrief", "code": "provider_error", "message": f"401: bad key {SENTINEL}",
                   "traceback": f"Traceback: api_key={SENTINEL!r}"}
        learning._post(learning._debriefed, failed.id, new_id(), {"type": "result", "status": "failed",
                                                                  "output": None, "failure": failure})
        learning._post(learning._debriefed, failed.id, new_id(), {
            "type": "error", "message": f"ValidationError: api_key {SENTINEL}", "traceback": SENTINEL})

        ended = harness.store.create_session(session(repo_commit=head, status="ended", run_ids=["r2"]))
        harness.store.save_debrief(ready_debrief(ended, OUTPUT), run_id="dbr", attempts=1)
        write_run_record(harness.office.paths.run_dir(ended.id) / "runs" / "dbr.model.json", OFFICE, None,
                         harness.connections.resolve(OFFICE, None))  # so the feedback's run is on a connection
        fb = harness.store.add_feedback(Feedback(id=new_id(), session_id=ended.id, run_id="dbr", author="ngocbh",
                                                 text="Be brief.", status="queued", created_at=now()))
        learning.tick()  # learning from it can't start
        wait_for(lambda: harness.store.get_feedback(fb.id).attempts == 1, what="the failed attempt")
        settled(learning)
        for status in ("learning", "queued", "learning"):
            harness.store.set_feedback_status(fb.id, status)
        learning._post(learning._learned, fb.id, None, {
            "type": "result", "status": "succeeded", "output": {}, "failure": None,
            "backward": {"status": "failed", "failure": failure}})
        wait_for(lambda: harness.store.get_feedback(fb.id).status == "learning_failed", what="learning_failed")
        settled(learning)
    finally:
        learning.stop()
    assert "[redacted]" in caplog.text and "provider_error" in caplog.text
    assert "can't start the debrief" in caplog.text and "can't start learning" in caplog.text
    assert SENTINEL not in caplog.text
    assert not any(SENTINEL in str(r.args) or SENTINEL in r.getMessage() for r in caplog.records)
