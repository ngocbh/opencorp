import json
import threading

import httpx
import pytest
from yian.run import run_flow

from agent_corp.chat.connections import ConnectionFile
from agent_corp.chat.models import list_models
from agent_corp.company.flows import load_confined
from agent_corp.testing.fake_llm import LLM_CONFIG


@pytest.fixture
def flow(pin, fake_llm, monkeypatch):
    for key, value in fake_llm.env().items():
        monkeypatch.setenv(key, value)
    return lambda name: load_confined(pin, pin / "flows" / f"{name}.yaml")


def shout(text: str) -> str:
    """Return text in capitals."""
    return text.upper()


def test_a_plain_reply(fake_llm, flow):
    fake_llm.script({"content": "hello there"})
    result = run_flow(flow("echo"), {"message": "hi"}, llm_config=LLM_CONFIG)
    assert (result.status, result.output) == ("succeeded", "hello there")
    [request] = fake_llm.requests()
    assert request["model"] == "stub" and "hi" in json.dumps(request["messages"])


def test_a_tool_call_then_a_reply(fake_llm, flow):
    fake_llm.script({"content": "Working", "tool_calls": [{"name": "shout", "arguments": {"text": "hi"}}]},
                    {"content": "Done."})
    result = run_flow(flow("tools"), {"message": "go"}, llm_config=LLM_CONFIG, tools={"toolbox": [shout]})
    assert (result.status, result.output) == ("succeeded", "Done.")
    first, second = fake_llm.requests()
    assert [t["function"]["name"] for t in first["tools"]] == ["shout"]
    assert "HI" in json.dumps(second["messages"])


def test_a_streamed_reply_ends_with_usage(fake_llm, flow):
    fake_llm.script({"content": "hello there", "usage": {"prompt_tokens": 7, "completion_tokens": 2}})
    chunks, events = [], []
    result = run_flow(flow("echo"), {"message": "hi"}, llm_config=LLM_CONFIG, on_stream=chunks.append,
                      on_event=events.append)
    assert result.output == "hello there"
    assert "".join(c.chunk for c in chunks) == "hello there" and chunks[-1].final
    [request] = fake_llm.requests()
    assert request["stream"] and request["stream_options"] == {"include_usage": True}
    [usage] = [e.usage for e in events if type(e).__name__ == "ModelCallFinished"]
    assert (usage.input_tokens, usage.output_tokens) == (7, 2)


def test_a_scripted_500_is_hit_once_and_keeps_the_next_reply(fake_llm, flow):
    fake_llm.script({"error": 500}, {"content": "later"})
    failed = run_flow(flow("echo"), {"message": "hi"}, llm_config=LLM_CONFIG)
    assert failed.status == "failed" and len(fake_llm.requests()) == 1
    assert fake_llm.pending() == [{"content": "later"}]
    assert run_flow(flow("echo"), {"message": "hi"}, llm_config=LLM_CONFIG).output == "later"


def test_an_unmatched_request_fails_loudly_once(fake_llm, flow):
    result = run_flow(flow("echo"), {"message": "hi"}, llm_config=LLM_CONFIG)
    assert result.status == "failed" and "no scripted reply" in result.failure.message
    assert len(fake_llm.requests()) == 1


def test_match_picks_a_reply_out_of_order(fake_llm, flow):
    fake_llm.script({"match": "second", "content": "two"}, {"match": "first", "content": "one"})
    assert run_flow(flow("echo"), {"message": "first"}, llm_config=LLM_CONFIG).output == "one"
    assert run_flow(flow("echo"), {"message": "second"}, llm_config=LLM_CONFIG).output == "two"


def test_the_http_routes_script_record_and_release(fake_llm):
    base = fake_llm.base_url
    assert httpx.post(f"{base}/_script", json={"replies": [{"content": "held", "hold": 10}]}).json() == {"queued": 1}
    got = {}
    body = {"model": "stub", "messages": [{"role": "user", "content": "x"}]}
    caller = threading.Thread(target=lambda: got.update(httpx.post(f"{base}/v1/chat/completions", json=body,
                                                                   timeout=20).json()))
    caller.start()
    fake_llm.wait_for_requests(1)
    caller.join(0.2)
    assert caller.is_alive()
    httpx.post(f"{base}/_release")
    caller.join(5)
    assert got["choices"][0]["message"]["content"] == "held"
    assert httpx.get(f"{base}/_requests").json() == [body]


def test_hold_true_waits_until_release(fake_llm):
    fake_llm.script({"content": "held", "hold": True})
    got = {}
    body = {"model": "stub", "messages": [{"role": "user", "content": "x"}]}
    caller = threading.Thread(target=lambda: got.update(httpx.post(f"{fake_llm.base_url}/v1/chat/completions",
                                                                   json=body, timeout=20).json()))
    caller.start()
    fake_llm.wait_for_requests(1)
    caller.join(1.5)  # longer than float(True) seconds
    assert caller.is_alive()
    fake_llm.release()
    caller.join(5)
    assert got["choices"][0]["message"]["content"] == "held"


def test_it_lists_its_model_without_recording_a_chat_request(fake_llm):
    r = httpx.get(f"{fake_llm.base_url}/v1/models")
    assert r.json() == {"object": "list", "data": [{"id": "stub", "object": "model"}]}
    assert fake_llm.requests() == [] and httpx.get(f"{fake_llm.base_url}/_requests").json() == []


def test_a_connection_to_it_is_listed_cleanly(fake_llm):
    listed = list_models(ConnectionFile(llm_config=LLM_CONFIG, env=fake_llm.env()), "office")
    assert (listed.listed, listed.error, [m.id for m in listed.models]) == (True, None, ["stub"])
