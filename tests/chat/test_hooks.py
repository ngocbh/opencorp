import logging

import pytest

from agent_corp.chat.hooks import Hooks


def test_callbacks_run_in_order_with_their_arguments():
    hooks, calls = Hooks(), []
    hooks.run_started.append(lambda s, r: calls.append(("a", s, r)))
    hooks.run_started.append(lambda s, r: calls.append(("b", s, r)))
    hooks.fire("run_started", "S", "R")
    assert calls == [("a", "S", "R"), ("b", "S", "R")]


def test_a_failing_callback_is_logged_and_the_rest_still_run(caplog):
    hooks, calls = Hooks(), []

    def boom(*_):
        raise RuntimeError("boom")

    hooks.session_ended += [boom, calls.append]
    with caplog.at_level(logging.ERROR, logger="agent_corp.chat.hooks"):
        assert hooks.fire("session_ended", "S") == [None]
    assert calls == ["S"]
    assert "session_ended callback" in caplog.text and "boom" in caplog.text


def test_fire_returns_results_for_answer_checks():
    hooks = Hooks()
    hooks.answer_check += [lambda q, a, k: None, lambda q, a, k: "pick one"]
    assert hooks.fire("answer_check", "Q", "x", "text") == [None, "pick one"]


def test_an_unknown_hook_name_is_an_error():
    with pytest.raises(ValueError, match="no hook named 'nope'"):
        Hooks().fire("nope")
