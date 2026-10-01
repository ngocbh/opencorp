"""The M1 journey on a real office: Minh edits a file, is steered and stopped, debriefs, learns, and starts his next session changed."""

import pytest

from tests.profile.conftest import OUTPUT, debrief_reply, learner_reply

from .fixtures.office import asked, wait_for

pytestmark = pytest.mark.timeout(180)

LEARNED = "- Keep replies short."


def test_the_m1_journey(office, workspace, sandbox_available):
    fake = office.fake
    # 1. `ac` in a fresh folder: the office is healthy, the picker offers Minh, and he edits a file.
    doctor = office.ac("doctor", cwd=workspace)
    assert not [line for line in doctor.stdout.splitlines() if line.startswith("fail")], doctor.stdout
    minh = office.person("minh")
    assert office.folder_people(workspace) == []
    fake.script({"match": "Mark the README done",
                 "tool_calls": [{"name": "edit_file", "arguments": {"path": "README.md", "old": "TODO", "new": "done"}}]},
                {"match": "Mark the README done", "content": "Marked it done."})
    sid = office.start_chat(minh, workspace, wait=False)  # the TUI prompts while the session starts
    assert office.folder_people(workspace) == ["minh"]
    # The worker takes about a second to boot, so the prompt is queued for the first turn.
    assert office.status(sid) == "starting"
    office.prompt(sid, "Mark the README done")
    office.settled(sid, ["Marked it done."])
    assert (workspace / "README.md").read_text() == "# Demo\n\nStatus: done\n"
    assert office.tools(sid) == [("edit_file", "completed")]

    # 2. Steer mid-reply: the TUI sends the follow-up with prompt, and it reaches the model's next call.
    fake.script({"content": "Looking.", "tool_calls": [{"name": "list", "arguments": {"path": "."}}], "hold": True},
                {"content": "Added both."})
    office.prompt(sid, "Add a changelog")
    fake.wait_for_requests(3, timeout=40)
    office.replying(sid)
    assert office.status(sid) == "busy"
    office.prompt(sid, "Also mention the date")
    fake.release()
    office.settled(sid, ["Marked it done.", "Looking.", "Added both."])
    assert "Also mention the date" in asked(fake.requests()[3])
    assert office.users(sid) == ["Mark the README done", "Add a changelog", "Also mention the date"]

    # Then Esc: the held reply and its write never land, the stopped reply says it was interrupted,
    # and the next prompt gets a fresh reply.
    fake.script({"content": "Writing.", "tool_calls": [{"name": "write_file", "arguments": {"path": "never.txt", "content": "x"}}], "hold": True},
                {"content": "Starting over."})
    office.prompt(sid, "Write never.txt")
    fake.wait_for_requests(5, timeout=40)
    office.replying(sid)
    office.interrupt(sid)
    fake.release()
    wait_for(lambda: office.status(sid) == "idle", "the interrupted turn to stop")
    office.prompt(sid, "Start over")
    office.settled(sid, ["Marked it done.", "Looking.", "Added both.", "[interrupted]", "Starting over."])
    assert not (workspace / "never.txt").exists()
    assert len(fake.requests()) == 6  # Esc made no model call of its own
    assert "Write never.txt" in asked(fake.requests()[5])  # the stopped turn stays in the history

    # 3. `/end`, the debrief, then `ac feedback` on the ended session's run.
    fake.script(debrief_reply())
    ended = office.ac("end", cwd=workspace)
    assert ended.stdout.strip() == f"Ending @minh's session {sid}; its debrief follows."
    assert office.debriefed(sid)["summary"] == OUTPUT["summary"]
    before = office.get(f"/profiles/{minh}")["text"]
    fake.script(learner_reply(before + f"\n{LEARNED}\n"))
    feedback = office.ac("feedback", "-m", "Keep replies short.", cwd=workspace)
    [run_id] = office.session(sid)["run_ids"]
    assert f"is queued for @minh (session {sid}, run {run_id})" in feedback.stdout

    # 4. The learned rule is a commit, and Minh's next session starts from it.
    subject = f"profile(@minh): from feedback on run {run_id} (ngocbh)"
    wait_for(lambda: subject in office.git_log(), "the profile commit")
    learned = office.get(f"/profiles/{minh}")["text"]
    assert learned == before + f"\n{LEARNED}\n"
    fake.script({"content": "Short."})
    calls = len(fake.requests())
    nxt = office.start_chat(minh, workspace, wait=False)
    assert office.status(nxt) == "starting"
    office.prompt(nxt, "Hello again")
    office.settled(nxt, ["Short."])
    # The profile rides in the first call as a JSON memory block, so compare line by line.
    assert all(line in asked(fake.requests()[calls]) for line in learned.splitlines() if line)
    assert LEARNED not in asked(fake.requests()[0])
