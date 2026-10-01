"""What a real office survives in M1: a killed worker, a killed office, racing feedback, and racing answers."""

import os
import signal

import pytest

from .fixtures.office import alive, asked, wait_for

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
