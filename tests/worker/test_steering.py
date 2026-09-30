import json
import time

from agent_corp.worker.inbox import Inbox

from tests.worker.conftest import Recorder, run

TOOL_THEN_DONE = [{"content": "Working", "tool_calls": [{"name": "shout", "arguments": {"text": "hi"}}]},
                  {"content": "Done."}]


def test_steers_queue_until_drained():
    inbox = Inbox()
    assert inbox.steer("reply", "one") and inbox.steer("reply", "two")
    assert inbox.drain("reply") == ["one", "two"] and inbox.drain("reply") == []


def test_a_finished_node_refuses_steers_and_interrupts():
    inbox = Inbox()
    inbox.steer("reply", "unread")
    assert inbox.interrupt("reply") and inbox.interrupted("reply")
    assert inbox.finish("reply") == ["unread"]
    assert not inbox.interrupted("reply")
    assert not inbox.steer("reply", "late") and not inbox.interrupt("reply")
    assert inbox.drain("reply") == []


def test_leftovers_empties_every_queue():
    inbox = Inbox()
    inbox.steer("a", "1")
    inbox.steer("loop#1/b", "2")
    assert inbox.leftovers() == {"a": ["1"], "loop#1/b": ["2"]} and inbox.leftovers() == {}


class Steering(Recorder):
    """Runs ``shout``, and during the call steers or interrupts the running node."""

    def __init__(self, action, **kwargs):
        super().__init__(**kwargs)
        self.action = action

    def tool_call(self, worker, group, name, args):
        self.action(worker)
        time.sleep(0.2)  # let the frame reach the worker before the tool returns
        return args["text"].upper()


def spec_groups():
    return {"toolbox": [{"name": "shout", "parameters": {"type": "object", "required": ["text"],
                                                        "properties": {"text": {"type": "string"}}}}]}


def test_a_steer_reaches_the_next_model_call(fake_llm, registry, make_job, session_dir):
    fake_llm.script(*TOOL_THEN_DONE)
    handlers = Steering(lambda w: w.steer("reply", "Also mention Rome."))
    rec = run(registry, make_job("flows/steerable.yaml", groups=spec_groups()), handlers, session_dir)
    assert rec.outcome["output"] == "Done." and rec.left == []
    assert "Also mention Rome." in json.dumps(fake_llm.requests()[1]["messages"])


def test_an_interrupt_returns_the_text_so_far(fake_llm, registry, make_job, session_dir):
    fake_llm.script(*TOOL_THEN_DONE)
    rec = run(registry, make_job("flows/steerable.yaml", groups=spec_groups()),
              Steering(lambda w: w.interrupt("reply")), session_dir)
    assert (rec.outcome["status"], rec.outcome["output"]) == ("succeeded", "Working")
    assert len(fake_llm.requests()) == 1


def test_a_steer_the_node_never_reads_comes_back(fake_llm, registry, make_job, session_dir):
    fake_llm.script(*TOOL_THEN_DONE)
    handlers = Steering(lambda w: w.steer("reply", "Also mention Rome."))
    rec = run(registry, make_job("flows/tools.yaml", groups=spec_groups()), handlers, session_dir)
    assert rec.outcome["output"] == "Done." and rec.left == [("reply", ["Also mention Rome."])]
    assert "Rome" not in json.dumps(fake_llm.requests()[1]["messages"])


def test_a_steer_for_a_finished_node_comes_back_at_once(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "hello", "hold": 20})
    rec = Recorder(answers=["hi"])
    worker = registry.spawn(make_job("flows/chat.yaml", inputs={}), session_dir, rec)
    fake_llm.wait_for_requests(1, timeout=30)
    assert worker.steer("ask", "late")
    deadline = time.monotonic() + 10
    while not rec.left and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rec.left == [("ask", ["late"])]
    fake_llm.release()
    assert worker.wait(30) == 0
