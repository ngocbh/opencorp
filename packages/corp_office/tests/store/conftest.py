"""Store fixtures and protocol model factories."""

import pytest

from agent_corp.protocol import now
from agent_corp.protocol.models import (
    Comment,
    Debrief,
    Feedback,
    Message,
    ProfileProposal,
    Question,
    Session,
    WorkItem,
)
from agent_corp.store import Store, new_id

COMMIT = "a" * 40


@pytest.fixture
def store(tmp_path):
    with Store(tmp_path / "office" / "store.sqlite") as s:
        yield s


def work_item(**over) -> WorkItem:
    t = now()
    return WorkItem.model_validate(
        {"id": new_id(), "title": "Fix the build", "kind": "task", "status": "open", "requester": "ngocbh",
         "created_at": t, "updated_at": t, **over}
    )


def comment(work_item_id: str, **over) -> Comment:
    return Comment.model_validate(
        {"id": new_id(), "work_item_id": work_item_id, "author": "ngocbh", "body": "looks good", "created_at": now(), **over}
    )


def session(**over) -> Session:
    t = now()
    return Session.model_validate(
        {"id": new_id(), "person": "minh", "harness": "composer", "office": "mac", "cwd": "/w/app",
         "repo_commit": COMMIT, "status": "idle", "kind": "main", "created_at": t, "updated_at": t, **over}
    )


def question(session_id: str, **over) -> Question:
    t = now()
    return Question.model_validate(
        {"id": new_id(), "session_id": session_id, "run_id": "run-1", "node_id": None, "source": "ask_user",
         "asker": "minh", "question": "Which db?", "status": "open", "created_at": t, "updated_at": t, **over}
    )


def feedback(session_id: str, **over) -> Feedback:
    return Feedback.model_validate(
        {"id": new_id(), "session_id": session_id, "run_id": "run-1", "author": "ngocbh", "text": "be brief",
         "status": "queued", "created_at": now(), **over}
    )


def message(session_id: str, parts=(), **over) -> Message:
    return Message.model_validate(
        {"id": new_id(), "session_id": session_id, "role": "assistant", "parts": list(parts), "created_at": now(), **over}
    )


def debrief(session_id: str, **over) -> Debrief:
    return Debrief.model_validate({"session_id": session_id, "state": "pending", "updated_at": now(), **over})


def proposal(session_id: str, **over) -> ProfileProposal:
    return ProfileProposal.model_validate(
        {"id": new_id(), "session_id": session_id, "person": "minh", "base_version": COMMIT, "text": "# Minh\n",
         "diff": "+# Minh\n", "status": "open", "created_at": now(), **over}
    )
