import os
import stat
import subprocess

import pytest

from agent_corp.install import fallback
from agent_corp.install.launch import ServiceError, launch

from .conftest import Runner, make_host

SESSION = "agent-corp-office"


def test_the_tmux_command_runs_the_daemon_with_only_its_env_its_output_to_the_log_and_its_stdin_on_the_pane(
        owner_launch):
    assert fallback.shell_command(owner_launch) == (
        "exec env -i HOME=/Users/owner PATH=/usr/bin:/bin"
        " /opt/agent-corp/.venv/bin/python -m agent_corp.daemon.main --home /Users/owner/.agent-corp"
        " >>/Users/owner/.agent-corp/office/office.log 2>&1")


def test_tmux_starts_a_detached_session_in_the_repo(tmp_path, owner_launch):
    run = Runner([(["tmux", "has-session"], 1, "can't find session")])
    fallback.start_tmux(owner_launch, make_host(tmp_path, run))
    assert run.calls == [["tmux", "has-session", "-t", f"={SESSION}"],
                         ["tmux", "new-session", "-d", "-s", SESSION, "-c", "/opt/agent-corp",
                          fallback.shell_command(owner_launch)]]


def test_a_live_tmux_session_is_left_alone(tmp_path, owner_launch):
    run = Runner()
    fallback.start_tmux(owner_launch, make_host(tmp_path, run))
    assert run.calls == [["tmux", "has-session", "-t", f"={SESSION}"]]


def test_a_tmux_that_refuses_is_a_service_error(tmp_path, owner_launch):
    run = Runner([(["tmux", "has-session"], 1, ""), (["tmux", "new-session"], 1, "no server running")])
    with pytest.raises(ServiceError, match="no server running"):
        fallback.start_tmux(owner_launch, make_host(tmp_path, run))


def test_background_detaches_the_daemon_with_its_output_in_a_private_log(tmp_path):
    home = tmp_path / "home"
    got = {}

    def popen(argv, **kw):
        got.update(kw, argv=argv, log=os.fstat(kw["stdout"].fileno()))

    one = launch(home, repo=tmp_path / "repo", environ={"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-x"})
    fallback.start_background(one, make_host(tmp_path, Runner(), popen=popen))
    assert got["argv"] == list(one.argv) and got["env"] == {"PATH": "/usr/bin"}
    assert got["cwd"] == one.cwd and got["start_new_session"] is True
    assert got["stdin"] == subprocess.DEVNULL and got["stderr"] == subprocess.STDOUT
    assert stat.S_IMODE(got["log"].st_mode) == 0o600 and got["log"].st_ino == one.log.stat().st_ino
    assert stat.S_IMODE(one.office.stat().st_mode) == 0o700


def test_background_refuses_a_symlinked_log(tmp_path):
    one = launch(tmp_path / "home", repo=tmp_path / "repo", environ={})
    one.office.mkdir(parents=True, mode=0o700)
    one.log.symlink_to(tmp_path / "elsewhere")
    with pytest.raises(ServiceError, match="log"):
        fallback.start_background(one, make_host(tmp_path, Runner()))
    assert not (tmp_path / "elsewhere").exists()


def test_background_without_the_venv_is_a_service_error(tmp_path):
    one = launch(tmp_path / "home", repo=tmp_path / "no-repo", environ={})
    with pytest.raises(ServiceError, match="can't start"):
        fallback.start_background(one, make_host(tmp_path, Runner(), popen=subprocess.Popen))
