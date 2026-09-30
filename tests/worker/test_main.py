
def test_a_bad_start_frame_is_an_error_that_never_shows_the_env(worker_main, make_job):
    job = make_job(env={"OPENAI_API_KEY": "sk-SECRET"}).model_dump(mode="json")
    del job["run_id"]  # as with an office and worker of different versions
    office, out = worker_main()
    office.send({"type": "start", "job": job})
    frame = office.recv()
    assert frame["type"] == "error" and "run_id" in frame["message"]
    assert "sk-SECRET" not in frame["message"] and "sk-SECRET" not in frame["traceback"]
