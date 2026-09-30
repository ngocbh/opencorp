from agent_corp.worker import main as main_module


def bad_start(make_job) -> dict:
    job = make_job().model_dump(mode="json")
    del job["run_id"]
    return {"type": "start", "job": job}



def test_a_bad_start_frame_is_an_error_that_never_shows_the_env(worker_main, make_job):
    job = make_job(env={"OPENAI_API_KEY": "sk-SECRET"}).model_dump(mode="json")
    del job["run_id"]  # as with an office and worker of different versions
    office, _, _ = worker_main()
    office.send({"type": "start", "job": job})
    frame = office.recv()
    assert frame["type"] == "error" and "run_id" in frame["message"]
    assert "sk-SECRET" not in frame["message"] and "sk-SECRET" not in frame["traceback"]


def test_after_its_last_frame_a_worker_answers_steers_until_the_office_closes(worker_main, make_job):
    office, thread, out = worker_main()
    office.send(bad_start(make_job))
    assert office.recv()["type"] == "error"
    office.send({"type": "steer", "node_id": "reply", "text": "too late"})
    assert office.recv() == {"type": "steer_left", "node_id": "reply", "texts": ["too late"]}
    assert thread.is_alive()
    office.close_send()
    thread.join(5)
    assert out == {"code": main_module.EXIT_FAILED}


def test_a_worker_stops_waiting_for_the_office_after_a_while(worker_main, make_job, monkeypatch):
    monkeypatch.setattr(main_module, "LINGER", 0.2)
    office, thread, out = worker_main()
    office.send(bad_start(make_job))
    assert office.recv()["type"] == "error"
    thread.join(5)
    assert out == {"code": main_module.EXIT_FAILED}
