import os
import signal

from tests.worker.conftest import Recorder, run


def test_a_killed_run_resumes_in_a_new_worker(fake_llm, registry, store, make_job, session_dir):
    fake_llm.script({"content": "lost", "hold": True})
    worker = registry.spawn(make_job(), session_dir, Recorder())
    fake_llm.wait_for_requests(1, timeout=30)
    os.killpg(worker.pgid, signal.SIGKILL)
    assert worker.wait(10) == -signal.SIGKILL
    assert registry.get("s1") is None and store.list_workers() == []
    fake_llm.release()
    fake_llm.script({"content": "recovered"})
    rec = run(registry, make_job(kind="resume"), Recorder(), session_dir)
    assert (rec.returncode, rec.outcome["status"], rec.outcome["run_id"], rec.outcome["output"]) == (
        0, "succeeded", "r1", "recovered")


def test_a_backward_job_resumes_then_runs_backward(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "ok"})
    assert run(registry, make_job(learnable=True), Recorder(), session_dir).outcome["status"] == "succeeded"
    rec = run(registry, make_job(kind="backward"), Recorder(), session_dir)
    assert rec.returncode == 0
    assert rec.outcome["status"] == "succeeded" and rec.outcome["output"] == "ok"
    assert rec.outcome["backward"] == {"status": "succeeded", "failure": None}
    assert len(fake_llm.requests()) == 1  # no feedback, so nothing to learn


def test_backward_on_a_run_that_is_not_learnable_is_an_error(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "ok"})
    run(registry, make_job(), Recorder(), session_dir)
    rec = run(registry, make_job(kind="backward", feedback="shorter please"), Recorder(), session_dir)
    assert rec.returncode == 1
    assert rec.outcome["message"] == "ValueError: backward requires a run retained with learnable=True"


def test_a_killed_run_whose_provider_has_a_key_resumes_with_that_key(fake_llm, registry, make_job, session_dir):
    key = "sk-test-resume-0123456789"
    llm = {"provider": "vllm", "model": "stub", "base_url": f"{fake_llm.base_url}/v1", "api_key": key}
    fake_llm.script({"content": "lost", "hold": True})
    worker = registry.spawn(make_job(llm_config=llm, env={}), session_dir, Recorder())
    fake_llm.wait_for_requests(1, timeout=30)
    os.killpg(worker.pgid, signal.SIGKILL)
    assert worker.wait(10) == -signal.SIGKILL
    fake_llm.release()
    fake_llm.script({"content": "recovered"})
    rec = run(registry, make_job(kind="resume", llm_config=llm, env={}), Recorder(), session_dir)
    assert (rec.outcome["status"], rec.outcome["output"]) == ("succeeded", "recovered")
    assert fake_llm.authorizations()[-1] == f"Bearer {key}"
