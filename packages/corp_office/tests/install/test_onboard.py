import io
import json
import os
import signal
import stat
import subprocess

import httpx
import psutil
import pytest

from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, missing_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import onboard as onboard_module
from agent_corp.profile.debrief import DEBRIEF_FLOW
from agent_corp.profile.manager import MANAGER_FLOW
from agent_corp.install.launch import office_answers
from agent_corp.install.onboard import OnboardError, onboard, owner_defaults
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host
from .test_provider_setup import Script

KEY = "sk-ant-sentinel-5f0c2b9e7d41a3"


def test_the_owner_defaults_come_from_the_login():
    assert owner_defaults("ngocbh", "Hong Ngoc Bui,,,") == ("Hong Ngoc Bui", "ngocbh")
    assert owner_defaults("Ngoc_Bui", "") == ("Ngoc_Bui", "ngoc-bui")


def test_lint_errors_stop_onboarding_before_anything_runs(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    write_company(paths.company, paths.worktrees, company="Acme", owner=Owner("me", "me", "Me"))
    (paths.company / "company.yaml").write_text("name: Acme\nceo: nobody\n")
    run = Runner()
    with pytest.raises(OnboardError, match="company.unknown_ceo"):
        onboard(paths.home, Script(), host=make_host(tmp_path, run))
    assert run.calls == [] and not (paths.office / "install.json").exists()
    assert not (paths.office / "provider.json").exists()


def test_a_bad_handle_is_asked_again(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))
    ask = Script("Acme", "Me", "Bad_Handle", "Acme", "Me", "me")
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert any("should match pattern" in line for line in ask.seen)
    assert load_repo(tmp_path / "home" / "company").company.ceo == "me"


def test_a_company_whose_first_write_stopped_early_is_asked_for_and_finished(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))
    company = OfficePaths(tmp_path / "home").company
    company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(company)], check=True)
    (company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", Script("Acme", "Me", "me"), host=make_host(tmp_path, Runner()))
    assert lint(load_repo(company)) == [] and _git(company, "status", "--porcelain") == ""


def test_an_existing_home_others_can_read_is_made_private(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))
    home = tmp_path / "home"
    home.mkdir(mode=0o755)
    home.chmod(0o755)
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, Script("Acme", "Me", "me"), host=make_host(tmp_path, Runner()))
    assert stat.S_IMODE(os.stat(home).st_mode) == 0o700


def test_no_hire_leaves_the_company_without_an_agent(tmp_path):
    home = tmp_path / "home"
    write_company(home / "company", home / "worktrees", company="Acme", owner=Owner("me", "me", "Me"))
    ask = Script()
    # An office that already answers (started by hand): nothing is installed, and no hire is posted.
    onboard(home, ask, stdin=io.StringIO('{"llm_config": {"provider": "openai"}}'),
            host=make_host(tmp_path, Runner(), answers=lambda s: True), hire=False)
    assert [p.kind for p in load_repo(home / "company").people.values()] == ["human"]
    assert any("not started by a service" in line for line in ask.seen)


def test_a_hire_the_office_cant_take_is_an_onboard_error(tmp_path):
    def gone(request):
        raise httpx.ConnectError("[Errno 2] No such file or directory", request=request)

    with pytest.raises(OnboardError, match="first agent: the office didn't answer"):
        onboard_module._hire_first(tmp_path / "no.sock", "me", Script("", ""), transport=httpx.MockTransport(gone))
    odd = httpx.MockTransport(lambda request: httpx.Response(200, json={"issues": [], "person": {}}))
    with pytest.raises(OnboardError, match="first agent"):
        onboard_module._hire_first(tmp_path / "no.sock", "me", Script("", ""), transport=odd)


def _git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


def test_a_running_office_is_not_topped_up_behind_its_back(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    write_company(paths.company, paths.worktrees, company="Acme", owner=Owner("me", "me", "Me"))
    (paths.company / DEBRIEF_FLOW).unlink()
    (paths.company / MANAGER_FLOW).unlink()
    _git(paths.company, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "drop two flows")
    head = _git(paths.company, "rev-parse", "HEAD")
    ask = Script()
    onboard(paths.home, ask, stdin=io.StringIO('{"llm_config": {"provider": "openai"}}'),
            host=make_host(tmp_path, Runner(), answers=lambda s: True), hire=False)
    assert "The office is running; stop it and run `ac onboard` again to add 2 template files." in "\n".join(ask.seen)
    assert not (paths.company / DEBRIEF_FLOW).exists() and _git(paths.company, "rev-parse", "HEAD") == head


def test_a_running_office_without_a_company_is_not_written_to(tmp_path):
    with pytest.raises(OnboardError, match="running, but .* has no company yet"):
        onboard(tmp_path / "home", Script(), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert not (tmp_path / "home" / "company").exists()


def _onboard_twice(tmp_path, platform, started):
    """Onboard with auto, then again from a shell with other env; return the second run's commands."""
    run = Runner()
    host = make_host(tmp_path, run, platform=platform,
                     answers=lambda s: any(c[:3] in started for c in run.calls))
    provider = '{"llm_config": {"provider": "openai"}}'
    onboard(tmp_path / "home", Script("Acme", "Me", "me"), stdin=io.StringIO(provider), host=host,
            environ={"PATH": "/usr/bin", "LC_TERMINAL_VERSION": "3.5.0"}, hire=False)
    first = len(run.calls)
    onboard(tmp_path / "home", Script(), stdin=io.StringIO(provider), host=host,
            environ={"PATH": "/opt/homebrew/bin:/usr/bin", "LC_TERMINAL_VERSION": "3.6.0"}, hire=False)
    return run.calls[first:]


def test_a_second_onboard_from_another_shell_leaves_a_running_launch_agent_alone(tmp_path):
    again = _onboard_twice(tmp_path, "darwin", [["launchctl", "bootstrap", "gui/501"]])
    assert [c[1] for c in again] == ["print"]


def test_a_second_onboard_from_another_shell_leaves_a_running_systemd_unit_alone(tmp_path):
    again = _onboard_twice(tmp_path, "linux", [["systemctl", "--user", "restart"]])
    assert [c[2] for c in again] == ["is-enabled"]


def _stop(paths):
    if paths.pidfile.exists() and (pid := paths.pidfile.read_text().strip()):
        os.kill(int(pid), signal.SIGTERM)
        psutil.Process(int(pid)).wait(timeout=15)


def test_onboard_sets_up_the_office_and_a_second_run_changes_nothing(short_dir):
    paths = OfficePaths(short_dir)
    first = Script("Acme", "Hong Ngoc Bui", "ngocbh", "openai", "", "", "", "")
    try:
        onboard(short_dir, first, mode="background")
        assert office_answers(paths.socket)
        repo = load_repo(paths.company)
        assert lint(repo) == [] and missing_files(paths.company) == []
        assert (paths.company / "shared/flows/side_chat.yaml").is_file()
        assert {p.handle: p.kind for p in repo.people.values()} == {"ngocbh": "human", "minh": "agent"}
        assert repo.company.ceo == "ngocbh"
        assert _git(paths.company, "log", "--format=%s").splitlines() == [
            "hire(@minh): Minh, Engineer", "onboard: create the company"]
        assert stat.S_IMODE(os.stat(paths.office / "provider.json").st_mode) == 0o600
        assert stat.S_IMODE(os.stat(paths.home).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(paths.office).st_mode) == 0o700
        head, pid = _git(paths.company, "rev-parse", "HEAD"), paths.pidfile.read_text()
        provider = os.stat(paths.office / "provider.json").st_mtime_ns
        installed = (paths.office / "install.json").read_text()

        again = Script()  # no answers: a second run must not ask anything
        onboard(short_dir, again, mode="background")
        assert _git(paths.company, "rev-parse", "HEAD") == head and paths.pidfile.read_text() == pid
        assert os.stat(paths.office / "provider.json").st_mtime_ns == provider
        assert (paths.office / "install.json").read_text() == installed
        assert any("up to date" in line for line in again.seen)
    finally:
        _stop(paths)


def test_the_key_lands_only_in_the_provider_file(short_dir):
    paths = OfficePaths(short_dir)
    ask = Script("Acme", "Hong Ngoc Bui", "ngocbh", "anthropic", "", KEY, "", "")
    try:
        onboard(short_dir, ask, mode="background")
        assert json.loads((paths.office / "provider.json").read_text())["llm_config"]["api_key"] == KEY
        daemon = psutil.Process(int(paths.pidfile.read_text()))
        assert not [a for a in daemon.cmdline() if KEY in a]
        assert not [k for k, v in daemon.environ().items() if KEY in k or KEY in v]
        assert not [line for line in ask.seen if KEY in line]
        leaked = [p for p in short_dir.rglob("*") if p.is_file() and not p.is_symlink()
                  and p != paths.office / "provider.json" and KEY.encode() in p.read_bytes()]
        assert leaked == []
        # Git objects are compressed, so the byte search above can't see into them.
        objects = subprocess.run(["git", "-C", str(paths.company), "cat-file", "--batch-all-objects", "--batch"],
                                 capture_output=True, check=True).stdout
        assert objects and KEY.encode() not in objects
        assert (paths.office / "office.log").exists()
    finally:
        _stop(paths)
