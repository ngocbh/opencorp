import io
import json
import os
import subprocess
import sys

import pytest

from agent_corp.company.loader import load_repo
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import __main__ as install_main
from agent_corp.install import doctor
from agent_corp.install.__main__ import main
from agent_corp.install.launch import REPO, office_answers
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .test_onboard import _stop

KEY = "sk-ant-sentinel-a7d93c10e5b2"


def test_doctor_on_a_fresh_machine_fails_and_says_to_onboard(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    assert main(["doctor", "--home", str(tmp_path / "home")]) == 1
    assert "fail  company   no company repo" in capsys.readouterr().out


def test_the_home_defaults_to_agent_corp_home(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    monkeypatch.setenv("AGENT_CORP_HOME", str(tmp_path / "elsewhere"))
    main(["doctor"])
    assert f"no company repo at {os.path.realpath(tmp_path / 'elsewhere')}/company" in capsys.readouterr().out


def test_start_before_onboarding_is_exit_3_with_a_hint(tmp_path, capsys):
    assert main(["start", "--home", str(tmp_path / "home")]) == 3
    assert "run `ac onboard`" in capsys.readouterr().err


def test_start_with_a_company_that_has_no_first_commit_is_exit_3_with_a_hint(tmp_path, capsys):
    company = tmp_path / "home" / "company"
    company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(company)], check=True)
    (company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    assert main(["start", "--home", str(tmp_path / "home")]) == 3
    assert "run `ac onboard`" in capsys.readouterr().err


def test_an_init_error_is_exit_1_with_the_reason(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("not json"))
    args = ["init", "--home", str(tmp_path / "home"), "--provider-stdin", "--company", "Acme",
            "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    assert main(args) == 1
    assert "ac init: the provider on stdin is not valid JSON" in capsys.readouterr().err


def test_init_flags_answer_their_questions_including_the_first_teammates_handle(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(install_main.init, "init", lambda home, prompter, **k: seen.update(prompter=prompter, **k))
    args = ["init", "--home", str(tmp_path / "home"), "--handle", "ngocbh", "--title", "Founder", "--agent", "Lan",
            "--agent-handle", "lan-dev", "--remote", "git@example.com:acme.git", "--no-device"]
    assert main(args) == 0
    assert seen["prompter"].ask("Your handle") == "ngocbh"
    assert seen["prompter"].ask("Your title", "CEO") == "Founder"
    assert seen["prompter"].ask("Their name") == "Lan"
    assert seen["prompter"].ask("Their handle") == "lan-dev"
    assert seen["prompter"].ask("Git remote URL (empty to skip)") == "git@example.com:acme.git"
    assert seen["device"] is False


@pytest.mark.parametrize("flag", ["--handle", "--agent-handle"])
def test_a_bad_handle_flag_stops_init_before_it_starts(tmp_path, monkeypatch, capsys, flag):
    # A preset answer is given again on every retry, so the question's own re-asking would never end.
    monkeypatch.setattr(install_main.init, "init", lambda *a, **k: pytest.fail("init ran"))
    assert main(["init", "--home", str(tmp_path / "home"), flag, "Bad_Handle"]) == 1
    err = capsys.readouterr().err
    assert err.startswith(f"ac init: {flag} 'Bad_Handle': ") and "should match pattern" in err


def test_init_without_git_says_so_instead_of_a_traceback(tmp_path, monkeypatch, capsys):
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"llm_config": {"provider": "openai"}})))
    args = ["init", "--home", str(tmp_path / "home"), "--provider-stdin", "--company", "Acme",
            "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    assert main(args) == 1
    err = capsys.readouterr().err
    assert err.startswith("ac init: ") and "git" in err and "Traceback" not in err


def test_scripted_init_then_start_brings_a_stopped_office_back(short_dir, monkeypatch, capsys):
    paths = OfficePaths(short_dir)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"llm_config": {"provider": "openai"}})))
    args = ["init", "--home", str(short_dir), "--provider-stdin", "--company", "Acme",
            "--name", "Hong Ngoc Bui", "--handle", "ngocbh", "--service", "background"]
    try:
        assert main(args) == 0, capsys.readouterr()
        assert "with you as CEO and Minh (@minh)" in capsys.readouterr().out
        assert main(["start", "--home", str(short_dir)]) == 0  # already running: nothing to do
        pid = paths.pidfile.read_text().strip()
        assert capsys.readouterr().out == f"The office is already running (pid {pid}).\n"
        _stop(paths)
        assert not office_answers(paths.socket)
        assert main(["start", "--home", str(short_dir)]) == 0
        assert office_answers(paths.socket)
        pid = paths.pidfile.read_text().strip()
        assert capsys.readouterr().out == f"Started the office (pid {pid}).\n"
    finally:
        _stop(paths)


def test_init_in_a_real_process_keeps_the_key_off_the_terminal(short_dir):
    paths = OfficePaths(short_dir)
    args = [sys.executable, "-m", "agent_corp.install", "init", "--home", str(short_dir), "--provider-stdin",
            "--company", "Acme", "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    try:
        done = subprocess.run(args, input=json.dumps({"llm_config": {"provider": "anthropic", "api_key": KEY}}),
                              capture_output=True, text=True, timeout=60, cwd=REPO)
        assert done.returncode == 0, done.stderr
        assert KEY not in done.stdout and KEY not in done.stderr
        assert "Done." in done.stdout
        assert sorted(p.kind for p in load_repo(paths.company).people.values()) == ["agent", "human"]
        assert json.loads((paths.office / "provider.json").read_text())["llm_config"]["api_key"] == KEY
    finally:
        _stop(paths)
