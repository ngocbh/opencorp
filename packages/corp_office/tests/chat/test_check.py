"""The one-reply check of a new connection, run in a child process."""

import io
import json
import os
import subprocess
import sys

import pytest

from agent_corp.chat import check
from agent_corp.chat.check import NO_RESULT, NOT_FINISHED, one_reply_problem
from agent_corp.chat.provider import Provider
from agent_corp.worker.spawn import worker_env

SENTINEL = "sk-ant-sentinel-61f0d2c9a8b3"
PROVIDER = Provider(llm_config={"provider": "anthropic", "api_key": SENTINEL, "model": "claude-x"})


def fake_run(monkeypatch, stdout="", raises=None):
    """Make the check's ``subprocess.run`` answer ``stdout`` (or raise ``raises``); returns the calls it gets."""
    calls = []

    def run(argv, **kwargs):
        calls.append({"argv": argv, **kwargs, "cwd_existed": os.path.isdir(kwargs["cwd"]),
                      "cwd_files": os.listdir(kwargs["cwd"])})
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(check.subprocess, "run", run)
    return calls


def test_one_reply_check_runs_isolated_in_a_temp_cwd(monkeypatch):
    calls = fake_run(monkeypatch, '{"problem": null}\n')
    assert one_reply_problem(PROVIDER) is None
    [call] = calls
    assert call["argv"] == [sys.executable, "-I", "-m", "agent_corp.chat.check"]
    assert call["cwd_existed"] and call["cwd_files"] == [] and not os.path.exists(call["cwd"])
    assert os.path.realpath(call["cwd"]) != os.path.realpath(os.getcwd())
    assert call["env"] == worker_env() and call["capture_output"] and call["timeout"] == 90
    assert Provider.model_validate_json(call["input"]) == PROVIDER
    assert SENTINEL not in json.dumps([call["argv"], call["env"]])


@pytest.mark.parametrize(("stdout", "problem"), [
    ('a stray line\n{"problem": "HTTP 404"}\n', "HTTP 404"),
    ('{"problem": "HTTP 404"}', "HTTP 404"),
    ('{"problem": null}\nTraceback (most recent call last):\n', NO_RESULT),
    ("", NO_RESULT),
    ("not json\n", NO_RESULT),
    ('{"problem": 3}\n', NO_RESULT),
    ('{"problem": null, "extra": 1}\n', NO_RESULT),
    ('["problem"]\n', NO_RESULT),
])
def test_only_the_result_line_is_read(monkeypatch, stdout, problem):
    fake_run(monkeypatch, stdout)
    assert one_reply_problem(PROVIDER) == problem


def test_a_hung_check_says_it_didnt_finish(monkeypatch):
    calls = fake_run(monkeypatch, raises=subprocess.TimeoutExpired(["python"], 5))
    assert one_reply_problem(PROVIDER, timeout=5) == NOT_FINISHED
    assert calls[0]["timeout"] == 5 and not os.path.exists(calls[0]["cwd"])


def test_the_child_prints_only_its_result_on_stdout(monkeypatch, capsys):
    seen = []

    def model_problem(provider):
        seen.append(provider)
        print("composer chatter")
        return "HTTP 429"

    monkeypatch.setattr("agent_corp.install.interview.model_problem", model_problem)
    monkeypatch.setattr(sys, "stdin", io.StringIO(PROVIDER.model_dump_json()))
    check.main()
    out, err = capsys.readouterr()
    assert out == '{"problem": "HTTP 429"}\n' and "composer chatter" in err
    assert seen == [PROVIDER]
