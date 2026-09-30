import os

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.profile import GitProfileStore
from tests.profile.conftest import asked, status, texts, wait_for
from tests.profile.test_learning_feedback import PROFILE, git_log, profile_text


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


def test_the_profile_manager_needs_a_known_person(harness, learning):
    with pytest.raises(HarnessError) as err:
        learning.start_manager("nobody", "hi")
    assert err.value.status == 404
    with pytest.raises(HarnessError) as err:
        learning.proposals("nobody")
    assert err.value.status == 404
    assert harness.store.list_sessions(kind="profile_manager", limit=None) == []
