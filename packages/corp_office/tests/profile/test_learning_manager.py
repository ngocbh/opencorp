import os

import pytest

from opencorp.chat.harness import HarnessError
from opencorp.profile import GitProfileStore
from opencorp.profile.manager import profile_tools
from opencorp.secrets import write_private
from tests.profile.conftest import asked, status, texts, wait_for
from tests.profile.test_learning_feedback import PROFILE, git_log, profile_text
from tests.store.conftest import session


def test_the_profile_manager_proposes_an_edit_that_the_owner_applies(harness, fake_llm, learning):
    version = GitProfileStore(harness.git, "minh").read()[1]
    edited = PROFILE + "\n- Likes short replies.\n"
    fake_llm.script({"tool_calls": [{"name": "propose_edit",
                                     "arguments": {"text": edited, "base_version": version}}]},
                    {"content": "I proposed the edit."})
    session = learning.start_manager("minh", "Say that I like short replies.")
    assert (session.kind, session.person, session.work_item_id) == ("profile_manager", "minh", None)
    assert session.cwd == os.path.realpath(harness.git.root)
    wait_for(lambda: texts(harness, session.id) == ["I proposed the edit."], what="the reply")
    assert "Say that I like short replies." in asked(fake_llm.requests()[0])
    [proposal] = learning.proposals("minh")
    assert (proposal.session_id, proposal.base_version, proposal.text, proposal.status) == (
        session.id, version, edited, "open")
    assert profile_text(harness) == PROFILE  # nothing changes until the owner applies it

    profile = learning.apply(proposal.id)
    assert (profile.text, profile.version) == (edited, GitProfileStore(harness.git, "minh").read()[1])
    assert git_log(harness, "-1", "--format=%s").strip() == "profile(@minh): ngocbh via profile manager"
    assert learning.proposals("minh")[0].status == "applied"
    with pytest.raises(HarnessError) as err:
        learning.apply(proposal.id)
    assert (err.value.status, err.value.code) == (409, "not_open")

    wait_for(lambda: status(harness, session.id) == "idle", what="the next turn")
    harness.end(session.id)
    wait_for(lambda: status(harness, session.id) == "ended", what="ended")
    assert harness.store.get_debrief(session.id) is None


def test_the_profile_manager_is_opened_and_applied_by_who_acted(harness, fake_llm, learning):
    version = GitProfileStore(harness.git, "minh").read()[1]
    fake_llm.script({"tool_calls": [{"name": "propose_edit",
                                     "arguments": {"text": PROFILE + "- x\n", "base_version": version}}]},
                    {"content": "Proposed."})
    session = learning.start_manager("minh", "Add x.", by="lan")
    assert session.opened_by == "lan"
    wait_for(lambda: texts(harness, session.id) == ["Proposed."], what="the reply")
    assert [q.answered_by for q in harness.store.list_questions(session_id=session.id) if q.status != "open"] == ["lan"]
    [proposal] = learning.proposals("minh")
    learning.apply(proposal.id, by="lan")
    assert git_log(harness, "-1", "--format=%s").strip() == "profile(@minh): lan via profile manager"
    wait_for(lambda: status(harness, session.id) == "idle", what="the next turn")
    harness.end(session.id)
    wait_for(lambda: status(harness, session.id) == "ended", what="ended")


def test_the_profile_manager_stores_the_default(harness, fake_llm, learning):
    harness.connections.set_default("second")
    fake_llm.script({"content": "Hello."})
    session = learning.start_manager("minh", "Hi.")
    assert (session.connection, session.model) == ("second", None)
    wait_for(lambda: texts(harness, session.id) == ["Hello."], what="the reply")
    assert fake_llm.requests()[0]["model"] == "stub-2"
    wait_for(lambda: status(harness, session.id) == "idle", what="the next turn")
    harness.end(session.id)
    wait_for(lambda: status(harness, session.id) == "ended", what="ended")


def test_the_profile_manager_says_when_the_default_cant_be_read(harness, fake_llm, learning):
    write_private(harness.connections.dir / "_default.json", b"[]")
    fake_llm.script({"content": "Hello."})
    session = learning.start_manager("minh", "Hi.")
    assert (session.connection, session.model, session.model_note) == (
        "office", None, "The office's default connection can't be read; this chat uses office/stub.")
    wait_for(lambda: texts(harness, session.id) == ["Hello."], what="the reply")
    wait_for(lambda: status(harness, session.id) == "idle", what="the next turn")
    harness.end(session.id)
    wait_for(lambda: status(harness, session.id) == "ended", what="ended")


def test_the_profile_manager_needs_a_known_person(harness, learning):
    with pytest.raises(HarnessError) as err:
        learning.start_manager("nobody", "hi")
    assert err.value.status == 404
    with pytest.raises(HarnessError) as err:
        learning.proposals("nobody")
    assert err.value.status == 404
    assert harness.store.list_sessions(kind="profile_manager", limit=None) == []


def test_a_store_error_while_applying_is_not_a_not_open_conflict(harness, learning, monkeypatch):
    s = harness.store.create_session(session(kind="profile_manager", repo_commit=harness.git.head()))
    tools = profile_tools(harness.store, GitProfileStore(harness.git, "minh"), s)
    tools["propose_edit"](text="# Minh\n", base_version=tools["read"]()["version"])
    [proposal] = learning.proposals("minh")

    def through_a_symlink(self, *args, **kwargs):
        raise ValueError("people/minh/profile.md goes through a symlink; not writing it")

    monkeypatch.setattr(GitProfileStore, "write", through_a_symlink)
    with pytest.raises(ValueError, match="symlink"):
        learning.apply(proposal.id)
    assert learning.proposals("minh")[0].status == "open"
