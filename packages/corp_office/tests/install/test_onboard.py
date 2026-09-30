import io
import json
import os
import signal
import stat
import subprocess

import psutil
import pytest

from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import onboard as onboard_module
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
    paths.company.mkdir(parents=True)
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


def test_no_hire_leaves_the_company_without_an_agent(tmp_path):
    home = tmp_path / "home"
    ask = Script("Acme", "Me", "me")
    # An office that already answers (started by hand): nothing is installed, and no hire is posted.
    onboard(home, ask, stdin=io.StringIO('{"llm_config": {"provider": "openai"}}'),
            host=make_host(tmp_path, Runner(), answers=lambda s: True), hire=False)
    assert [p.kind for p in load_repo(home / "company").people.values()] == ["human"]
    assert any("not started by a service" in line for line in ask.seen)


def _git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


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
        assert lint(repo) == []
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
