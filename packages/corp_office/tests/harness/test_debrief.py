"""A Codex session's debrief: the employee learns as an apprentice, on the office model."""

import subprocess

import pytest

from opencorp.chat.connections import read_run_record
from opencorp.extensions.learning import Learning
from opencorp.protocol.models import FeedbackRequest
from opencorp.testing import fake_codex as fc
from tests.harness.conftest import start, status, wait_for
from tests.profile.conftest import LEARNING_FILES, debrief_reply, learner_reply, review_reply

PROFILE = "# Minh, Engineer\n"


@pytest.fixture
def learning(make_codex):
    h = make_codex(files=LEARNING_FILES)
    learning = Learning(h.office, h, tick=None)
    learning.start()
    yield h, learning
    learning.stop()


def test_a_codex_session_is_debriefed_as_an_apprentice_and_its_feedback_is_learned(learning, fake_codex, fake_llm,
                                                                                   workspace):
    h, learning = learning
    # No card: decisions in summaries are profile/test_debrief.py's. Codex names a file by its absolute path.
    fake_codex.script([[*fc.command("c1", "touch a"), *fc.file_change("f1", "{cwd}/a.md", "a\n"),
                        *fc.agent_message("m1", "Created a.")]])
    fake_llm.script(debrief_reply())
    sid = start(h, workspace)
    h.prompt(sid, "make a", by="ngocbh")
    wait_for(lambda: status(h, sid) == "idle" and h.store.list_messages(sid)[-1].role == "assistant",
             what="the turn's end")
    h.end(sid)
    wait_for(lambda: status(h, sid) == "ended", what="the debrief")
    sent = str(fake_llm.requests()[-1])
    assert "drove Codex (an AI coding agent)" in sent and "@ngocbh: make a" in sent
    assert "codex: $ touch a (exit 0)" in sent and "edited a.md (added, +1/-0)" in sent  # relative to the cwd
    assert h.store.get_debrief(sid).state == "ready"
    run_id = h.store.get_debrief_record(sid).run_id
    assert read_run_record(h.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json").connection == "office"
    fake_llm.script(review_reply(), learner_reply(PROFILE + "\n- Ask before touching files.\n"))
    fb = learning.add_feedback(FeedbackRequest(session_id=sid, text="Ask before touching files."))
    assert fb.run_id == run_id
    wait_for(lambda: h.store.get_feedback(fb.id).status == "applied", what="applied")
    assert (h.git.root / "people/minh/profile.md").read_text() == PROFILE + "\n- Ask before touching files.\n"


def test_a_session_with_no_opener_names_its_pinned_ceo_as_the_driver(learning, fake_codex, fake_llm, workspace):
    h, _ = learning
    fake_codex.script([fc.agent_message("m1", "Hi.")])
    fake_llm.script(debrief_reply())
    sid = start(h, workspace, by=None)
    h.prompt(sid, "hi")
    wait_for(lambda: status(h, sid) == "idle" and h.store.list_messages(sid)[-1].role == "assistant",
             what="the turn's end")
    # The company at HEAD has no company.yaml now; the session's pinned commit still names its CEO.
    for args in (["rm", "-q", "company.yaml"], ["commit", "-q", "-m", "no company"]):
        subprocess.run(["git", "-C", str(h.git.root), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                       check=True, capture_output=True)
    h.end(sid)
    wait_for(lambda: status(h, sid) == "ended", what="the debrief")
    assert h.store.get_debrief(sid).state == "ready"
    sent = str(fake_llm.requests()[-1])
    assert "In this session @ngocbh drove Codex" in sent and "@ngocbh: hi" in sent
