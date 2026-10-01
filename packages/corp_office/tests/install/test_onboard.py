import io
import os
import signal
import subprocess

import psutil
import pytest

from agent_corp.company_template import Owner, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install.onboard import OnboardError, onboard, owner_defaults
from agent_corp.profile.debrief import DEBRIEF_FLOW
from agent_corp.profile.manager import MANAGER_FLOW
from tests.company.conftest import _isolate_git  # noqa: F401

from .conftest import Runner, make_host
from .test_provider_setup import Script

PROVIDER = '{"llm_config": {"provider": "openai"}}'


def _git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


def _stop(paths):
    if paths.pidfile.exists() and (pid := paths.pidfile.read_text().strip()):
        os.kill(int(pid), signal.SIGTERM)
        psutil.Process(int(pid)).wait(timeout=15)


def company(home, handle="me"):
    """A company at ``home`` made as `ac init` makes it, with ``handle`` as CEO and no device."""
    write_company(home / "company", home / "office" / "worktrees", company="Acme", owner=Owner(handle, "Me"))
    return home / "company"


def test_the_owner_defaults_come_from_the_login():
    assert owner_defaults("ngocbh", "Hong Ngoc Bui,,,") == ("Hong Ngoc Bui", "ngocbh")
    assert owner_defaults("Ngoc_Bui", "") == ("Ngoc_Bui", "ngoc-bui")


def test_lint_errors_stop_onboarding_before_anything_runs(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    company(paths.home)
    (paths.company / "company.yaml").write_text("name: Acme\nceo: nobody\n")
    run = Runner()
    with pytest.raises(OnboardError, match="company.unknown_ceo"):
        onboard(paths.home, Script(), host=make_host(tmp_path, run))
    assert run.calls == [] and not (paths.office / "install.json").exists()
    assert not (paths.office / "provider.json").exists()


def test_an_existing_company_without_an_identity_suggests_login(tmp_path):
    home = tmp_path / "home"
    company(home)
    ask = Script()
    onboard(home, ask, stdin=io.StringIO(PROVIDER), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert "This device has no identity yet; run `ac login` to use ac from it." in ask.seen
    assert not (home / "identity.json").exists()
    assert [line for line in ask.seen if line.startswith("Step ")] == [
        "Step 1 of 4: Company", "Step 2 of 4: This device", "Step 3 of 4: Model", "Step 4 of 4: Office"]


def test_an_office_started_by_hand_is_left_alone(tmp_path):
    home = tmp_path / "home"
    company(home)
    ask = Script()
    onboard(home, ask, stdin=io.StringIO(PROVIDER), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert any("not started by a service" in line for line in ask.seen)


def test_a_running_office_is_not_topped_up_behind_its_back(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    company(paths.home)
    (paths.company / DEBRIEF_FLOW).unlink()
    (paths.company / MANAGER_FLOW).unlink()
    _git(paths.company, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "drop two flows")
    head = _git(paths.company, "rev-parse", "HEAD")
    ask = Script()
    onboard(paths.home, ask, stdin=io.StringIO(PROVIDER), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert "The office is running; stop it and run `ac onboard` again to add 2 template files." in "\n".join(ask.seen)
    assert not (paths.company / DEBRIEF_FLOW).exists() and _git(paths.company, "rev-parse", "HEAD") == head


def test_a_running_office_without_a_company_is_not_written_to(tmp_path):
    with pytest.raises(OnboardError, match="running, but .* has no company yet"):
        onboard(tmp_path / "home", Script(), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert not (tmp_path / "home" / "company").exists()


def _onboard_twice(tmp_path, platform, started):
    """Onboard with auto, then again from a shell with other env; return the second run's commands."""
    company(tmp_path / "home")
    run = Runner()
    host = make_host(tmp_path, run, platform=platform,
                     answers=lambda s: any(c[:3] in started for c in run.calls))
    onboard(tmp_path / "home", Script(), stdin=io.StringIO(PROVIDER), host=host,
            environ={"PATH": "/usr/bin", "LC_TERMINAL_VERSION": "3.5.0"})
    first = len(run.calls)
    onboard(tmp_path / "home", Script(), stdin=io.StringIO(PROVIDER), host=host,
            environ={"PATH": "/opt/homebrew/bin:/usr/bin", "LC_TERMINAL_VERSION": "3.6.0"})
    return run.calls[first:]


def test_a_second_onboard_from_another_shell_leaves_a_running_launch_agent_alone(tmp_path):
    again = _onboard_twice(tmp_path, "darwin", [["launchctl", "bootstrap", "gui/501"]])
    assert [c[1] for c in again] == ["print"]


def test_a_second_onboard_from_another_shell_leaves_a_running_systemd_unit_alone(tmp_path):
    again = _onboard_twice(tmp_path, "linux", [["systemctl", "--user", "restart"]])
    assert [c[2] for c in again] == ["is-enabled"]
