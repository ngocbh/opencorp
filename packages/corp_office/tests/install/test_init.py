import json
import os
import stat
import subprocess

import pytest
import yaml

from agent_corp.auth.identity import device_name, read_identity
from agent_corp.auth.tokens import token_sha256
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, missing_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import onboard as onboard_module
from agent_corp.install.init import init, redact
from agent_corp.install.launch import office_answers
from agent_corp.install.onboard import OnboardError, onboard
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host
from .test_onboard import _git, _stop
from .test_provider_setup import Script

KEY = "sk-ant-sentinel-1c9e04b7a2d6"


def answers(company="Acme", name="Me", handle="me", remote=""):
    """Init's answers: the company and its CEO, one default teammate (Minh), and ``remote``."""
    return (company, name, handle, "", "", "", "", "", "", remote)


def stop_after_the_company(monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))


def test_init_makes_the_company_its_ceo_and_seeded_teammates_in_one_commit(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    ask = Script("Acme", "Hong Ngoc Bui", "ngocbh", "",
                 "Lan", "", "QA", "Tests every release.", "y",
                 "Minh", "minh-dev", "", "", "",
                 "")
    with pytest.raises(OnboardError, match="stop"):
        init(home, ask, host=make_host(tmp_path, Runner()))
    repo = load_repo(home / "company")
    assert repo.company.name == "Acme" and repo.company.ceo == "ngocbh"
    assert {h: (p.kind, p.title, p.manager) for h, p in repo.people.items()} == {
        "ngocbh": ("human", "CEO", None), "lan": ("agent", "QA", "ngocbh"), "minh-dev": ("agent", "Engineer", "ngocbh")}
    assert (home / "company/people/lan/profile.md").read_text() == "# Lan, QA\n\nTests every release.\n"
    assert (home / "company/people/minh-dev/profile.md").read_text() == "# Minh, Engineer\n"
    assert lint(repo) == [] and missing_files(home / "company") == []
    assert _git(home / "company", "log", "--format=%s").splitlines() == ["init: create the company"]
    assert _git(home / "company", "status", "--porcelain") == ""
    assert [line for line in ask.seen if line.startswith("Step ")] == [
        "Step 1 of 5: Company", "Step 2 of 5: You", "Step 3 of 5: First teammates", "Step 4 of 5: Remote",
        "Step 5 of 5: This machine"]


def test_init_registers_this_device_for_the_ceo_in_the_first_commit(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    ask = Script(*answers())
    with pytest.raises(OnboardError, match="stop"):
        init(home, ask, host=make_host(tmp_path, Runner()))
    me = read_identity(home / "identity.json")
    assert (me.handle, me.device) == ("me", device_name())
    assert stat.S_IMODE(os.stat(home / "identity.json").st_mode) == 0o600
    first = _git(home / "company", "show", "HEAD:people/me/person.yaml")
    assert yaml.safe_load(first)["devices"] == [{"name": me.device, "token_sha256": token_sha256(me.token)}]
    assert not [line for line in ask.seen if me.token in line]
    assert f"This device: {me.device}, acting as @me (its token is in {home / 'identity.json'})" in ask.seen


def test_init_replaces_an_old_identity(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    (home / "identity.json").write_text('{"handle": "old", "device": "old", "token": "act_old"}')
    with pytest.raises(OnboardError, match="stop"):
        init(home, Script(*answers()), host=make_host(tmp_path, Runner()))
    me = read_identity(home / "identity.json")
    assert me.handle == "me" and me.token != "act_old"


def test_no_device_leaves_the_company_open_without_tokens(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    with pytest.raises(OnboardError, match="stop"):
        init(home, Script(*answers()), host=make_host(tmp_path, Runner()), device=False)
    assert not (home / "identity.json").exists()
    assert load_repo(home / "company").people["me"].devices == []


def test_init_refuses_a_company_that_exists_and_suggests_onboard(tmp_path):
    home = tmp_path / "home"
    write_company(home / "company", home / "office/worktrees", company="Acme", owner=Owner("me", "Me"))
    head = _git(home / "company", "rev-parse", "HEAD")
    with pytest.raises(OnboardError, match=r"already a company at .*; run `ac onboard`"):
        init(home, Script(), host=make_host(tmp_path, Runner()))
    assert _git(home / "company", "rev-parse", "HEAD") == head


def test_a_bad_or_taken_handle_is_asked_again(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = Script("Acme", "Me", "Bad_Handle", "me", "", "Me Too", "me", "me-too", "", "", "", "")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert any("should match pattern" in line for line in ask.seen)
    assert "That doesn't work: @me is taken" in ask.seen
    assert set(load_repo(tmp_path / "home" / "company").people) == {"me", "me-too"}


def test_a_handle_that_never_works_stops_instead_of_asking_forever(tmp_path):
    ask = Script("Acme", "Me", *["Bad"] * 5)
    with pytest.raises(OnboardError, match="no usable answer to 'Your handle'"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert not (tmp_path / "home" / "company").exists()


def test_a_company_whose_first_write_stopped_early_is_finished(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    company = OfficePaths(tmp_path / "home").company
    company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(company)], check=True)
    (company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", Script(*answers()), host=make_host(tmp_path, Runner()))
    assert lint(load_repo(company)) == [] and _git(company, "status", "--porcelain") == ""


def _stop_before_the_first_commit(tmp_path, monkeypatch):
    """Run init as `an` of Acme until the company's first commit, which fails."""
    import agent_corp.company_template as template

    def fail(*a, **k):
        raise template.CompanyGitError("killed")

    with monkeypatch.context() as m:
        m.setattr(template.CompanyGit, "commit", fail)
        with pytest.raises(OnboardError, match="killed"):
            init(tmp_path / "home", Script(*answers(name="An", handle="an")), host=make_host(tmp_path, Runner()))
    company = OfficePaths(tmp_path / "home").company
    assert "ceo: \"an\"" in (company / "company.yaml").read_text()
    return company


@pytest.mark.parametrize("truncate", [False, True])
def test_a_second_init_after_a_stopped_first_write_uses_the_new_answers(tmp_path, monkeypatch, truncate):
    company = _stop_before_the_first_commit(tmp_path, monkeypatch)
    if truncate:
        (company / "company.yaml").write_text('name: "Ac')
    stop_after_the_company(monkeypatch)
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", Script(*answers("Beta", "Bo", "bo")), host=make_host(tmp_path, Runner()))
    committed = _git(company, "show", "HEAD:company.yaml")
    assert 'name: "Beta"' in committed and 'ceo: "bo"' in committed
    assert "people/bo/person.yaml" in _git(company, "ls-files").splitlines()
    # A truncated company.yaml doesn't say who run 1's owner was, so their file is left.
    assert (company / "people" / "an").exists() == truncate
    assert lint(load_repo(company)) == []


def test_a_user_id_without_an_account_is_an_onboard_error(tmp_path, monkeypatch):
    def unknown(uid):
        raise KeyError(f"getpwuid(): uid not found: {uid}")

    monkeypatch.setattr(onboard_module.pwd, "getpwuid", unknown)
    with pytest.raises(OnboardError, match="no account"):
        init(tmp_path / "home", Script("Acme"), host=make_host(tmp_path, Runner()))


def test_an_existing_home_others_can_read_is_made_private(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    home.mkdir(mode=0o755)
    home.chmod(0o755)
    with pytest.raises(OnboardError, match="stop"):
        init(home, Script(*answers()), host=make_host(tmp_path, Runner()))
    assert stat.S_IMODE(os.stat(home).st_mode) == 0o700


def test_a_running_office_without_a_company_is_not_written_to(tmp_path):
    with pytest.raises(OnboardError, match="running, but .* has no company yet"):
        init(tmp_path / "home", Script(), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert not (tmp_path / "home" / "company").exists()


def bare(path):
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(path)], check=True)
    return path


def test_a_remote_is_added_and_pushed_to_with_main_tracking_it(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    remote = bare(tmp_path / "acme.git")
    ask = Script(*answers(remote=str(remote)))
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    company = tmp_path / "home" / "company"
    assert _git(remote, "rev-parse", "main") == _git(company, "rev-parse", "HEAD")
    assert _git(company, "rev-parse", "--abbrev-ref", "main@{upstream}").strip() == "origin/main"
    assert any(line.startswith("Remote: pushed the company to") for line in ask.seen)


def test_a_push_that_fails_is_a_warning_with_the_retry_and_init_goes_on(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = Script(*answers(remote=str(tmp_path / "nowhere.git")))
    with pytest.raises(OnboardError, match="stop"):  # it got past the remote, to the provider
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    company = tmp_path / "home" / "company"
    warning = next(line for line in ask.seen if line.startswith("Warning: couldn't push"))
    assert f"Retry with `git -C {company} push -u origin main`." in warning
    assert _git(company, "remote", "get-url", "origin").strip() == str(tmp_path / "nowhere.git")
    assert "Step 5 of 5: This machine" in ask.seen


def test_a_token_in_the_remote_url_is_never_shown(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    url = "http://x-access-token:ghp_sentinel42@127.0.0.1:9/acme.git"
    ask = Script(*answers(remote=url))
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert any(line.startswith("Warning: couldn't push") for line in ask.seen)
    assert not [line for line in ask.seen if "ghp_sentinel42" in line]
    assert redact(url) == "http://***@127.0.0.1:9/acme.git"


def test_init_sets_up_the_office_and_a_second_onboard_changes_nothing(short_dir):
    paths = OfficePaths(short_dir)
    first = Script(*answers("Acme", "Hong Ngoc Bui", "ngocbh"), "openai", "", "")
    try:
        init(short_dir, first, mode="background")
        assert office_answers(paths.socket)
        repo = load_repo(paths.company)
        assert lint(repo) == [] and missing_files(paths.company) == []
        assert {p.handle: p.kind for p in repo.people.values()} == {"ngocbh": "human", "minh": "agent"}
        assert _git(paths.company, "log", "--format=%s").splitlines() == ["init: create the company"]
        me = read_identity(short_dir / "identity.json")
        assert [d.name for d in repo.people["ngocbh"].devices] == [me.device]
        assert stat.S_IMODE(os.stat(paths.office / "provider.json").st_mode) == 0o600
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
    ask = Script(*answers("Acme", "Hong Ngoc Bui", "ngocbh"), "anthropic", "", KEY)
    try:
        init(short_dir, ask, mode="background")
        assert json.loads((paths.office / "provider.json").read_text())["llm_config"]["api_key"] == KEY
        assert not [line for line in ask.seen if KEY in line]
        leaked = [p for p in short_dir.rglob("*") if p.is_file() and not p.is_symlink()
                  and p != paths.office / "provider.json" and KEY.encode() in p.read_bytes()]
        assert leaked == []
        token = read_identity(short_dir / "identity.json").token
        assert not [line for line in ask.seen if token in line]
        leaked = [p for p in short_dir.rglob("*") if p.is_file() and not p.is_symlink()
                  and p != short_dir / "identity.json" and token.encode() in p.read_bytes()]
        assert leaked == []
        # Git objects are compressed, so the byte search above can't see into them.
        objects = subprocess.run(["git", "-C", str(paths.company), "cat-file", "--batch-all-objects", "--batch"],
                                 capture_output=True, check=True).stdout
        assert objects and KEY.encode() not in objects and token.encode() not in objects
    finally:
        _stop(paths)

