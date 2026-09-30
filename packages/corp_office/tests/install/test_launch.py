import os
from pathlib import Path

from agent_corp.install.launch import REPO, Launch, daemon_env, launch, run_command

HOME = Path("/Users/owner/.agent-corp")


def test_the_launch_command_is_the_daemons_with_absolute_paths():
    got = launch(HOME, repo=Path("/opt/agent-corp"), environ={"PATH": "/usr/bin"}, user_home=Path("/Users/owner"))
    assert got == Launch(
        argv=("/opt/agent-corp/.venv/bin/python", "-m", "agent_corp.daemon.main", "--home", str(HOME)),
        env={"PATH": "/usr/bin"}, cwd=Path("/opt/agent-corp"), home=HOME, name="office")
    assert got.office == HOME / "office" and got.log == HOME / "office" / "office.log"
    assert got.socket == HOME / "office" / "office.sock"


def test_the_home_is_stored_as_its_realpath(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    got = launch(tmp_path / "link", repo=Path("/opt/agent-corp"), environ={}, user_home=tmp_path)
    assert got.home == Path(os.path.realpath(real)) and got.argv[-1] == str(got.home)


def test_another_home_gets_its_own_service_name():
    other = launch(Path("/tmp/h"), repo=Path("/opt/agent-corp"), environ={}, user_home=Path("/Users/owner"))
    assert other.name.startswith("office-") and len(other.name) == len("office-") + 8
    assert other.name == launch(Path("/tmp/h"), repo=Path("/x"), environ={}, user_home=Path("/Users/owner")).name


def test_the_daemon_gets_only_the_worker_allowlist_never_keys():
    environ = {"PATH": "/usr/bin", "HOME": "/Users/owner", "LC_ALL": "C", "LANG": "en_US.UTF-8",
               "ANTHROPIC_API_KEY": "sk-secret", "GITHUB_TOKEN": "ghp", "AGENT_CORP_HOME": "/x"}
    assert daemon_env(environ) == {"PATH": "/usr/bin", "HOME": "/Users/owner", "LC_ALL": "C", "LANG": "en_US.UTF-8"}


def test_repo_is_this_checkout():
    assert (REPO / "pyproject.toml").is_file() and (REPO / "packages" / "corp_office" / "src" / "agent_corp").is_dir()


def test_a_missing_program_is_exit_127_not_an_exception():
    out = run_command(["/nonexistent/launchctl", "print"])
    assert out.returncode == 127 and "nonexistent" in out.stderr
