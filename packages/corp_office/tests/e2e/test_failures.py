"""What a real office survives in M1: a killed worker, a killed office, racing feedback, and racing answers."""

import os
import signal

import pytest

from tests.profile.conftest import LEARNER_ASK, debrief_reply, learner_reply

from .fixtures.office import alive, asked, folder, wait_for

pytestmark = pytest.mark.timeout(180)


def first_turn(office, workspace):
    """Start a session with Minh in ``workspace`` and take one turn; return the session id."""
    office.fake.script({"content": "One."})
    sid = office.start_chat(office.person("minh"), workspace)
    office.prompt(sid, "first")
    office.settled(sid, ["One."])
    return sid


def test_a_worker_killed_mid_run_is_respawned_and_finishes_the_turn(office, workspace):
    fake = office.fake
    sid = first_turn(office, workspace)
    fake.script({"content": "Lost.", "hold": True}, {"content": "Recovered."})
    office.prompt(sid, "mid-run")
    fake.wait_for_requests(2, timeout=40)
    killed = office.worker(sid)
    os.killpg(killed.pid, signal.SIGKILL)
    office.settled(sid, ["One.", "Recovered."])
    fake.release()  # the dead worker's call: nobody reads its reply
    assert office.worker(sid).pid != killed.pid
    assert office.users(sid) == ["first", "mid-run"]
    assert len(office.session(sid)["run_ids"]) == 1  # resumed, not a new run
    assert len(fake.requests()) == 3 and "mid-run" in asked(fake.requests()[2])
    fake.script({"content": "Next."})
    office.prompt(sid, "second")
    office.settled(sid, ["One.", "Recovered.", "Next."])


def test_an_office_killed_mid_turn_comes_back_with_ac_start_and_finishes_the_turn(office, workspace):
    fake = office.fake
    sid = first_turn(office, workspace)
    fake.script({"content": "Lost.", "hold": True}, {"content": "Resumed."})
    office.prompt(sid, "mid-turn")
    fake.wait_for_requests(2, timeout=40)
    orphan = office.worker(sid)
    old = office.kill_office()
    wait_for(lambda: not alive(orphan.pid), "the orphaned worker to exit when its office dies")
    down = office.ac("end", cwd=workspace, check=False)
    assert (down.returncode, down.stderr.strip()) == (3, "The office isn't running. Run `ac doctor`.")
    office.ac("start", cwd=workspace)
    assert office.pid() != old
    office.settled(sid, ["One.", "Resumed."])
    fake.release()  # the dead worker's call: nobody reads its reply
    assert len(office.session(sid)["run_ids"]) == 1  # resumed, not a new run
    assert len(fake.requests()) == 3 and "mid-turn" in asked(fake.requests()[2])
    fake.script({"content": "Next."})
    office.prompt(sid, "second")
    office.settled(sid, ["One.", "Resumed.", "Next."])


def test_two_feedbacks_learned_at_once_both_land_in_the_profile(office, workspace, tmp_path):
    fake = office.fake
    minh = office.person("minh")
    folders, runs = [workspace, folder(tmp_path / "other")], []
    for n, cwd in enumerate(folders):
        fake.script({"content": f"Reply {n}."}, debrief_reply())
        sid = office.start_chat(minh, cwd)
        office.prompt(sid, "fix the bug")
        office.settled(sid, [f"Reply {n}."])
        office.post(f"/sessions/{sid}/end")
        office.debriefed(sid)
        runs += office.session(sid)["run_ids"]
    base = office.get(f"/profiles/{minh}")["text"]
    # Learning runs per session, so the two learner calls are in flight together; the second to
    # commit finds a newer profile and learns again on top of it, taking the merged reply.
    fake.script(learner_reply(base + "\n- Rule: brevity\n", hold=True) | {"match": "Be brief."},
                learner_reply(base + "\n- Rule: citations\n", hold=True) | {"match": "Cite files."},
                learner_reply(base + "\n- Rule: brevity\n- Rule: citations\n"))
    calls = len(fake.requests())
    for cwd, text in zip(folders, ["Be brief.", "Cite files."]):
        office.ac("feedback", "-m", text, cwd=cwd)  # queues it and returns; the learner call is held
    wait_for(lambda: sum(LEARNER_ASK in asked(r) for r in fake.requests()[calls:]) == 2, "both learner calls")
    fake.release()
    subjects = {f"profile(@minh): from feedback on run {run} (ngocbh)" for run in runs}
    wait_for(lambda: subjects <= set(office.git_log()), "both profile commits")
    text = office.get(f"/profiles/{minh}")["text"]
    assert "- Rule: brevity" in text and "- Rule: citations" in text
    assert len(fake.requests()) == calls + 3 and fake.pending() == []  # the loser learned again, once
    # The loser learned again on top of the winner: its second call carries the winner's rule.
    assert any(rule in asked(fake.requests()[calls + 2]) for rule in ("- Rule: brevity", "- Rule: citations"))
