import json
import os
import subprocess
import time

import psutil

from agent_corp.company_template import Owner, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import doctor, launchd, systemd
from agent_corp.install.doctor import Check
from agent_corp.install.launch import Launch, launch
from agent_corp.install.onboard import write_private
from agent_corp.profile.debrief import DEBRIEF_FLOW
from tests.company.conftest import _isolate_git  # noqa: F401

from .conftest import Runner, make_host

KEY = "sk-ant-test-0123456789"


def onboarded(tmp_path, provider=None, mode="launchd"):
    paths = OfficePaths(tmp_path / "home")
    paths.office.mkdir(parents=True, mode=0o700)
    paths.home.chmod(0o700)
    write_company(paths.company, paths.worktrees, company="Acme", owner=Owner("ngocbh", "Ngoc"))
    if provider is not None:
        write_private(paths.office / "provider.json", json.dumps(provider).encode())
    (paths.office / "install.json").write_text(json.dumps({"mode": mode, "name": "x"}))
    return paths


def by_name(checks):
    return {c.name: c for c in checks}


def run_checks(tmp_path, paths, runner=None, answers=False, probe=lambda: None, platform="darwin"):
    host = make_host(tmp_path, runner or Runner(), answers=lambda s: answers, platform=platform)
    return doctor.checks(paths.home, host=host, repo=tmp_path / "repo", probe=probe)


def test_a_company_without_a_first_commit_is_told_to_onboard(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    paths.company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(paths.company)], check=True)
    (paths.company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"] == Check("company", "fail", f"{paths.company} has no company yet (no company.yaml, or no"
                                   " first commit); run `ac onboard` to finish it")


def test_a_fresh_machine_is_told_to_onboard(tmp_path):
    got = by_name(run_checks(tmp_path, OfficePaths(tmp_path / "home")))
    assert got["home"] == Check("home", "fail", f"no office home at {tmp_path / 'home'}; run `ac onboard`")
    assert got["company"] == Check("company", "fail", f"no company repo at {tmp_path / 'home' / 'company'}; run `ac onboard`")
    assert doctor.exit_code(got.values()) == 1


def test_an_onboarded_office_that_isnt_running_is_only_a_warning(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "openai"}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "ok" and got["provider"] == Check("provider", "ok", "openai, composer's own login")
    label = launchd.label(launch(paths.home, user_home=tmp_path))
    assert got["service"] == Check("service", "ok", f"launchd: {label} is loaded")
    assert got["home"] == Check("home", "ok", str(paths.home))
    assert got["office"].status == "warn" and "not answering" in got["office"].detail
    assert "Run `ac start`." in got["office"].detail
    assert f"`launchctl print gui/501/{label}` shows its status" in got["office"].detail
    assert got["sandbox"] == Check("sandbox", "ok", "sandboxed commands run")
    assert doctor.exit_code(got.values()) == 0


def test_a_home_others_can_read_warns(tmp_path):
    paths = onboarded(tmp_path)
    paths.home.chmod(0o755)
    got = by_name(run_checks(tmp_path, paths))
    assert got["home"].status == "warn" and "0755, not 0700" in got["home"].detail


def test_a_stopped_systemd_office_names_the_next_step_and_the_unit(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    got = by_name(run_checks(tmp_path, paths, Runner([(["loginctl"], 0, "", "Linger=yes\n")]), platform="linux"))
    assert "Run `ac start`." in got["office"].detail
    assert f"`systemctl --user status {unit}` shows its status" in got["office"].detail


def test_a_disabled_systemd_unit_shows_what_systemctl_said(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    run = Runner([(["systemctl", "--user", "is-enabled"], 1, "Failed to connect to bus: No medium found")])
    got = by_name(run_checks(tmp_path, paths, run, platform="linux"))
    assert got["service"].status == "fail" and "Failed to connect to bus: No medium found" in got["service"].detail


def test_lint_errors_fail(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / "company.yaml").write_text("name: Acme\nceo: nobody\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "fail" and "company.unknown_ceo" in got["company"].detail


def test_a_company_missing_template_files_is_told_to_onboard_again(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / DEBRIEF_FLOW).unlink()
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "warn"
    assert DEBRIEF_FLOW in got["company"].detail and "`ac onboard` adds" in got["company"].detail


def test_a_running_office_missing_template_files_is_told_to_stop_first(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / DEBRIEF_FLOW).unlink()
    got = by_name(run_checks(tmp_path, paths, answers=True))
    assert got["company"].status == "warn" and DEBRIEF_FLOW in got["company"].detail
    assert "The office is running; stop it and run `ac onboard` again to add 1 template file." in got["company"].detail


def test_a_provider_others_can_read_fails_without_showing_it(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    (paths.office / "provider.json").chmod(0o644)
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"].status == "fail" and "0600" in got["provider"].detail
    assert all(KEY not in c.detail for c in got.values())


def test_a_provider_composer_wont_take_fails_without_showing_the_key(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY, KEY: 1}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"].status == "fail" and "extra field" in got["provider"].detail
    assert all(KEY not in c.detail for c in got.values())


def test_a_saved_key_is_reported_but_not_shown(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"] == Check("provider", "ok", "anthropic, key saved")


def test_an_unloaded_launch_agent_fails(tmp_path):
    paths = onboarded(tmp_path)
    got = by_name(run_checks(tmp_path, paths, Runner([(["launchctl", "print"], 113, "")])))
    assert got["service"].status == "fail" and "run `ac onboard`" in got["service"].detail


def test_a_systemd_service_without_linger_warns_that_it_stops_at_logout(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    run = Runner([(["loginctl"], 0, "", "Linger=no\n")])
    got = by_name(run_checks(tmp_path, paths, run, platform="linux"))
    assert got["service"].status == "warn" and "loginctl enable-linger" in got["service"].detail
    assert unit in got["service"].detail
    assert ["loginctl", "show-user", "501", "--property=Linger"] in run.calls


def test_a_systemd_service_with_linger_is_ok(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    got = by_name(run_checks(tmp_path, paths, Runner([(["loginctl"], 0, "", "Linger=yes\n")]), platform="linux"))
    assert got["service"] == Check("service", "ok", f"systemd: {unit} is enabled")


def test_an_office_that_keeps_failing_to_start_is_a_crash_loop(tmp_path):
    paths = onboarded(tmp_path)
    (paths.office / "office.log").write_text("starting\nagent-corp office: the company repo has no .git\n\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["office"].status == "fail"
    assert "agent-corp office: the company repo has no .git" in got["office"].detail
    assert "Run `ac start`." in got["office"].detail


def test_an_office_that_crashed_with_a_traceback_fails(tmp_path):
    paths = onboarded(tmp_path)
    (paths.office / "office.log").write_text("Traceback (most recent call last):\n  File \"x\"\nKeyError: 'boom'\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["office"].status == "fail" and "KeyError: 'boom'" in got["office"].detail


def test_a_sandbox_that_cant_start_fails(tmp_path):
    got = by_name(run_checks(tmp_path, onboarded(tmp_path), probe=lambda: "sandbox-exec: Operation not permitted"))
    assert got["sandbox"] == Check("sandbox", "fail", "sandbox-exec: Operation not permitted")


def test_an_office_older_than_the_code_is_told_to_restart(tmp_path):
    me = psutil.Process()
    this = Launch(argv=tuple(me.cmdline()), env={}, cwd=tmp_path, home=tmp_path, name="office")
    assert doctor.version_check(this, os.getpid(), newest=time.time() + 60).status == "warn"
    assert doctor.version_check(this, os.getpid(), newest=0).status == "ok"
    other = Launch(argv=("/x/python", "-m", "agent_corp.daemon.main"), env={}, cwd=tmp_path, home=tmp_path, name="o")
    assert "not this office's daemon" in doctor.version_check(other, os.getpid(), newest=0).detail


def test_the_newest_source_covers_the_office_and_composer(tmp_path):
    office = tmp_path / "packages/corp_office/src/agent_corp/x.py"
    composer = tmp_path / "packages/agent-composer/src/agent_composer/y.py"
    for path, when in ((office, 100), (composer, 200)):
        path.parent.mkdir(parents=True)
        path.write_text("")
        os.utime(path, (when, when))
    assert doctor.newest_source(tmp_path) == 200
