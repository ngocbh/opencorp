"""The M1 journey on a real office: Minh edits a file, is steered and stopped, debriefs, learns, and starts his next session changed."""

import pytest

pytestmark = pytest.mark.timeout(180)


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
