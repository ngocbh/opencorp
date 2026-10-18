import io
import json
import os
import shlex
import subprocess
import sys
import threading

import pytest
from pydantic import TypeAdapter

from opencorp.company.loader import load_repo
from opencorp.daemon.app import OfficePaths
from opencorp.install import __main__ as install_main
from opencorp.install import doctor, legacy
from opencorp.install.__main__ import main
from opencorp.install.doctor import codex_check as real_codex_check
from opencorp.install.interview import Known
from opencorp.install.launch import REPO, office_answers
from opencorp.protocol import models
from opencorp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .test_onboard import _stop

KEY = "sk-ant-sentinel-a7d93c10e5b2"


def test_install_tests_get_a_stand_in_codex_check():
    assert doctor.codex_check is not real_codex_check


def test_doctor_runs_the_codex_check_doctor_has_when_it_runs(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    main(["doctor", "--home", str(tmp_path / "home")])
    assert "ok    codex        stand-in" in capsys.readouterr().out


def test_doctor_on_a_fresh_machine_fails_and_says_to_onboard(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    assert main(["doctor", "--home", str(tmp_path / "home")]) == 1
    assert "fail  company      no company repo" in capsys.readouterr().out


def test_the_home_defaults_to_opencorp_home(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    monkeypatch.setenv("OPENCORP_HOME", str(tmp_path / "elsewhere"))
    main(["doctor"])
    assert f"no company repo at {os.path.realpath(tmp_path / 'elsewhere')}/company" in capsys.readouterr().out


def test_an_empty_opencorp_home_means_the_default(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("OPENCORP_HOME", "")
    main(["doctor"])
    assert f"no company repo at {os.path.realpath(tmp_path / '.opencorp')}/company" in capsys.readouterr().out


def test_start_before_onboarding_is_exit_3_with_a_hint(tmp_path, capsys):
    assert main(["start", "--home", str(tmp_path / "home")]) == 3
    assert "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one" in capsys.readouterr().err


def test_restart_before_onboarding_is_exit_3_with_a_hint(tmp_path, capsys):
    assert main(["restart", "--home", str(tmp_path / "home")]) == 3
    assert "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one" in capsys.readouterr().err


def test_start_with_a_company_that_has_no_first_commit_is_exit_3_with_a_hint(tmp_path, capsys):
    company = tmp_path / "home" / "company"
    company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(company)], check=True)
    (company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    assert main(["start", "--home", str(tmp_path / "home")]) == 3
    assert "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one" in capsys.readouterr().err


def test_an_init_error_is_exit_1_with_the_reason(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("not json"))
    args = ["init", "--home", str(tmp_path / "home"), "--provider-stdin", "--company", "Acme",
            "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    assert main(args) == 1
    assert "opencorp init: the provider on stdin is not valid JSON" in capsys.readouterr().err


def test_init_flags_are_known_answers_for_the_interview(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(install_main.init, "init", lambda home, prompter, **k: seen.update(prompter=prompter, **k))
    args = ["init", "--home", str(tmp_path / "home"), "--company", "Acme", "--name", "Me", "--handle", "me",
            "--agent", "Bo", "--agent-handle", "bo", "--title", "CTO", "--remote", "u", "--no-device"]
    assert main(args) == 0
    assert seen["known"] == Known("Acme", "Me", "me", "CTO", "Bo", "bo", remote="u")
    assert seen["prompter"].preset == {} and seen["prompter"].interactive is True
    assert seen["device"] is False


def test_ctrl_c_during_init_is_exit_130_with_only_a_newline(tmp_path, monkeypatch, capsys):
    def interrupted(*a, **k):
        raise KeyboardInterrupt

    monkeypatch.setattr(install_main.init, "init", interrupted)
    assert main(["init", "--home", str(tmp_path / "home")]) == 130
    assert capsys.readouterr().err == "\n"


@pytest.mark.parametrize("command", ["onboard", "offboard"])
def test_ctrl_c_during_onboard_or_offboard_is_exit_130_with_only_a_newline(tmp_path, monkeypatch, capsys, command):
    def interrupted(*a, **k):
        raise KeyboardInterrupt

    monkeypatch.setattr(install_main, "onboard", interrupted)
    monkeypatch.setattr(install_main.offboard, "offboard", interrupted)
    assert main([command, "--home", str(tmp_path / "home")]) == 130
    assert capsys.readouterr().err == "\n"


def test_the_same_handle_for_you_and_the_first_teammate_stops_init_before_it_starts(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(install_main.init, "init", lambda *a, **k: pytest.fail("init ran"))
    assert main(["init", "--home", str(tmp_path / "home"), "--handle", "x", "--agent-handle", "x"]) == 1
    assert capsys.readouterr().err == "opencorp init: --agent-handle 'x' is the same as --handle\n"


def test_onboard_flags_give_the_repo_to_clone_and_say_which_human_you_are(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(install_main, "onboard", lambda home, prompter, **k: seen.update(prompter=prompter, **k))
    args = ["onboard", "--home", str(tmp_path / "home"), "--from", "git@example.com:acme.git", "--handle", "lan"]
    assert main(args) == 0
    assert seen["source"] == "git@example.com:acme.git"
    assert seen["prompter"].choose("Which of them are you?", ["ceo", "lan"], "ceo") == "lan"


def test_onboard_without_a_company_or_a_repo_is_exit_1_with_the_ways_to_get_one(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    assert main(["onboard", "--home", str(tmp_path / "home"), "--provider-stdin"]) == 1
    assert "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one" in capsys.readouterr().err


@pytest.mark.parametrize("flag", ["--handle", "--agent-handle"])
def test_a_bad_handle_flag_stops_init_before_it_starts(tmp_path, monkeypatch, capsys, flag):
    # Checked before anything is asked, so a bad flag costs the owner no questions.
    monkeypatch.setattr(install_main.init, "init", lambda *a, **k: pytest.fail("init ran"))
    assert main(["init", "--home", str(tmp_path / "home"), flag, "Bad_Handle"]) == 1
    err = capsys.readouterr().err
    assert err.startswith(f"opencorp init: {flag} 'Bad_Handle': ") and "should match pattern" in err


def test_init_without_git_says_so_instead_of_a_traceback(tmp_path, monkeypatch, capsys):
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"llm_config": {"provider": "openai"}})))
    args = ["init", "--home", str(tmp_path / "home"), "--provider-stdin", "--company", "Acme",
            "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    assert main(args) == 1
    err = capsys.readouterr().err
    assert err.startswith("opencorp init: ") and "git" in err and "Traceback" not in err


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


def test_restart_replaces_a_running_office_and_starts_a_stopped_one(short_dir, monkeypatch, capsys):
    paths = OfficePaths(short_dir)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"llm_config": {"provider": "openai"}})))
    args = ["init", "--home", str(short_dir), "--provider-stdin", "--company", "Acme",
            "--name", "Hong Ngoc Bui", "--handle", "ngocbh", "--service", "background"]
    try:
        assert main(args) == 0, capsys.readouterr()
        old = paths.pidfile.read_text().strip()
        capsys.readouterr()
        assert main(["restart", "--home", str(short_dir)]) == 0
        new = paths.pidfile.read_text().strip()
        assert new != old and office_answers(paths.socket)
        assert capsys.readouterr().out == f"Restarted the office (pid {new}; was {old}).\n"
        _stop(paths)
        assert main(["restart", "--home", str(short_dir)]) == 0
        assert office_answers(paths.socket)
        pid = paths.pidfile.read_text().strip()
        assert capsys.readouterr().out == f"The office wasn't running; started it (pid {pid}).\n"
    finally:
        _stop(paths)


@pytest.fixture
def fake():
    with FakeLLM() as server:
        yield server


def test_init_in_a_real_process_keeps_the_key_off_the_terminal(short_dir, fake):
    paths = OfficePaths(short_dir)
    args = [sys.executable, "-m", "opencorp.install", "init", "--home", str(short_dir), "--provider-stdin",
            "--company", "Acme", "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    provider = {"llm_config": {**LLM_CONFIG, "api_key": KEY}, "env": fake.env()}
    fake.script({"content": "OK"})
    try:
        done = subprocess.run(args, input=json.dumps(provider), capture_output=True, text=True, timeout=60, cwd=REPO)
        assert done.returncode == 0, done.stderr
        assert KEY not in done.stdout and KEY not in done.stderr
        assert "Done." in done.stdout
        assert sorted(p.kind for p in load_repo(paths.company).people.values()) == ["agent", "human"]
        assert json.loads((paths.office / "provider.json").read_text())["llm_config"]["api_key"] == KEY
    finally:
        _stop(paths)


@pytest.mark.parametrize("command", ["init", "onboard"])
def test_json_prompts_and_provider_stdin_together_are_refused(tmp_path, capsys, command):
    with pytest.raises(SystemExit) as stopped:
        main([command, "--home", str(tmp_path), "--json-prompts", "--provider-stdin"])
    assert stopped.value.code == 2
    assert "not allowed with argument --json-prompts" in capsys.readouterr().err


def test_json_prompts_is_not_in_the_help(capsys):
    with pytest.raises(SystemExit):
        main(["init", "--help"])
    assert "--json-prompts" not in capsys.readouterr().out


DRIVER = '''
import sys

import opencorp.install.interview as interview
from opencorp.install.__main__ import main


def check(provider):
    """No model call; the print runs after the fd swap, so it must land on stderr, not between prompts."""
    print("a stray print")
    return None


interview.model_problem = check  # onboard imports it from here when it runs
sys.exit(main(sys.argv[1:]))
'''


def _answer(prompt) -> str | None:
    """What the test answers ``prompt`` with, as the setup screen would; None when it needs no answer."""
    if isinstance(prompt, models.SetupChoose):
        return "anthropic" if prompt.question == "Model provider" else prompt.default
    if isinstance(prompt, models.SetupSecret):
        return KEY
    if isinstance(prompt, models.SetupAsk):
        return ""
    return None


def test_onboard_with_json_prompts_in_a_real_process_keeps_the_channel_clean(short_dir, fake, tmp_path):
    paths = OfficePaths(short_dir)
    args = [sys.executable, "-m", "opencorp.install", "init", "--home", str(short_dir), "--provider-stdin",
            "--company", "Acme", "--name", "Ngoc", "--handle", "ngocbh", "--service", "background"]
    provider = {"llm_config": {**LLM_CONFIG, "api_key": KEY}, "env": fake.env()}
    fake.script({"content": "OK"})
    driver = tmp_path / "driver.py"
    driver.write_text(DRIVER)
    try:
        done = subprocess.run(args, input=json.dumps(provider), capture_output=True, text=True, timeout=60, cwd=REPO)
        assert done.returncode == 0, done.stderr
        _stop(paths)
        (paths.office / "provider.json").unlink()  # so onboard asks for the provider
        proc = subprocess.Popen([sys.executable, str(driver), "onboard", "--home", str(short_dir), "--json-prompts",
                                 "--service", "background"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, cwd=REPO)
        # Read on a thread: a full stderr pipe would stop the child mid-onboard.
        err: list[str] = []
        reader = threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True)
        reader.start()
        # The kill bounds the exchange: a hung child closes stdout, so the loop below ends.
        timer = threading.Timer(60, proc.kill)
        timer.start()
        lines, kinds, prompts = [], set(), TypeAdapter(models.SetupPrompt)
        try:
            for line in proc.stdout:
                lines.append(line)
                prompt = prompts.validate_json(line)
                kinds.add(prompt.type)
                if (answer := _answer(prompt)) is not None:
                    proc.stdin.write(json.dumps({"answer": answer}) + "\n")
                    proc.stdin.flush()
            code = proc.wait()
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        reader.join(10)
        assert not reader.is_alive()
        out, stderr = "".join(lines), "".join(err)
        assert code == 0, stderr
        assert "a stray print" in stderr and "a stray print" not in out
        assert KEY not in out and KEY not in stderr
        assert {"step", "say"} <= kinds
        assert json.loads((paths.office / "provider.json").read_text())["llm_config"]["api_key"] == KEY
    finally:
        _stop(paths)


def test_offboard_flags_reach_offboard(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(install_main.offboard, "offboard", lambda home, prompter, **k: seen.update(home=home, **k))
    assert main(["offboard", "--home", str(tmp_path / "home"), "--yes", "--delete-company"]) == 0
    assert seen == {"home": tmp_path / "home", "yes": True, "delete_company": True}


def test_offboard_without_a_terminal_or_yes_removes_nothing(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    (home / "office").mkdir(parents=True)
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    assert main(["offboard", "--home", str(home)]) == 1
    assert "opencorp offboard: nothing was removed; there's no terminal to ask on, so pass --yes" in capsys.readouterr().err
    assert (home / "office").is_dir()


def test_offboard_on_an_empty_home_is_exit_0(tmp_path, capsys):
    assert main(["offboard", "--home", str(tmp_path / "home")]) == 0
    assert "Nothing of this office to remove at" in capsys.readouterr().out


def test_doctor_prints_the_commands_that_finish_the_move(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(doctor, "sandbox_problem", lambda: None)
    monkeypatch.setenv("HOME", str(tmp_path))
    # Only conftest's refusing stand-ins (first on PATH) and the system dirs: no developer launcher in the output.
    monkeypatch.setenv("PATH", os.pathsep.join([os.environ["PATH"].split(os.pathsep)[0], "/usr/bin", "/bin"]))
    old, new = tmp_path / legacy.OLD_HOME, tmp_path / legacy.NEW_HOME
    (old / "office").mkdir(parents=True)
    main(["doctor", "--home", str(new)])
    out = capsys.readouterr().out
    assert "warn  leftovers" in out
    bun = shlex.join(["bun", str(REPO / legacy.NEW_ENTRY)])
    assert f"To finish moving to OpenCorp, run these in order:\n  mv {old} {new}\n  {bun} onboard\n" in out


@pytest.mark.parametrize("command", ["init", "onboard", "start", "restart"])
def test_the_default_home_waits_for_the_old_one_to_be_moved(tmp_path, monkeypatch, capsys, command):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("OPENCORP_HOME")
    old, new = tmp_path / legacy.OLD_HOME, tmp_path / legacy.NEW_HOME
    (old / "office").mkdir(parents=True)
    assert main([command]) == 1
    assert (f"opencorp {command}: the office from before the rename is at {old}; `opencorp doctor` prints the"
            f" commands that move it to {new}") in capsys.readouterr().err
    assert not new.exists()


def test_another_home_is_not_held_up_by_the_old_one(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / legacy.OLD_HOME).mkdir()
    assert main(["start", "--home", str(tmp_path / "elsewhere")]) == install_main.NOT_ONBOARDED
