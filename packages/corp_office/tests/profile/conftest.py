"""Learning fixtures: a harness whose company has the debrief and profile-manager flows, and Learning on it.

The harness's office has a second connection, ``second``, on model ``stub-2``.
"""

import json
import threading
from importlib.resources import files

import pytest

from opencorp.extensions.learning import Learning
from tests.chat.conftest import _isolate_git, fake_llm, make_harness, status, texts, wait_for, workspace  # noqa: F401

FLOWS = files("opencorp.company_template") / "shared" / "flows"
LEARNING_FILES = {f"shared/flows/{name}": (FLOWS / name).read_text() for name in ("debrief.yaml", "profile_manager.yaml")}
DEBRIEF_ASK = "Debrief it for the person who asked"
LEARNER_ASK = "You maintain one markdown profile document"
REVIEW_ASK = "Review one recorded AGENT invocation"
OUTPUT = {"summary": "Fixed the bug.", "status": "done", "artifacts": ["PR #4"], "decisions": [],
          "follow_ups": ["Add a test", "Update the docs"], "open_questions": []}


@pytest.fixture
def harness(make_harness):
    return make_harness(files=LEARNING_FILES, connections={"second": "stub-2"})


@pytest.fixture
def learning(harness):
    learning = Learning(harness.office, harness, tick=None)
    learning.start()
    yield learning
    learning.stop()


def settled(learning):
    """Wait until Learning's thread has done everything handed to it so far."""
    done = threading.Event()
    learning._post(done.set)
    assert done.wait(10)


def fails_once(monkeypatch, obj, name):
    """Make ``obj.name`` raise on its first call only."""
    original, calls = getattr(obj, name), []

    def flaky(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise RuntimeError(f"{name} failed")
        return original(*args, **kwargs)

    monkeypatch.setattr(obj, name, flaky)


def debrief_reply(output=OUTPUT, **extra):
    """A scripted debrief: the flow's structured output is a forced ``Record`` call."""
    return {"match": DEBRIEF_ASK, "tool_calls": [{"name": "Record", "arguments": output}], **extra}


def learner_reply(text, **extra):
    """A scripted profile learner reply with the new profile ``text``."""
    return {"match": LEARNER_ASK, "content": f"<profile>{text}</profile>", **extra}


def review_reply(**extra):
    """A scripted backward review of one agent node (the debrief's): no feedback of its own."""
    return {"match": REVIEW_ASK, "content": json.dumps({"input_feedback": {}, "self_feedback": [],
                                                         "variable_feedback": {}}), **extra}


def asked(request):
    """A model request's messages as JSON text."""
    return json.dumps(request["messages"])


def chat(harness, fake_llm, workspace, reply="Done."):
    """Start a session, take one turn, and end it; return the session id."""
    fake_llm.script({"content": reply})
    session = harness.start_session("minh", str(workspace))
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    harness.prompt(session.id, "fix the bug")
    wait_for(lambda: texts(harness, session.id) == [reply], what="the reply")
    wait_for(lambda: status(harness, session.id) == "idle", what="the next turn")
    harness.end(session.id)
    return session.id
