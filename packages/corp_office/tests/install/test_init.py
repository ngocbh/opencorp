import io
import json
import os
import stat
import subprocess
from dataclasses import replace

import pytest
import yaml

from opencorp.auth.identity import device_name, read_identity
from opencorp.auth.passwords import check_password
from opencorp.auth.tokens import token_sha256
from opencorp.company.draft import Draft, Teammate
from opencorp.company.lint import lint
from opencorp.company.loader import load_repo
from opencorp.company_template import Owner, is_new, missing_files, write_company
from opencorp.daemon.app import OfficePaths
from opencorp.install import init as init_module
from opencorp.install import onboard as onboard_module
from opencorp.install.init import NO_REMOTE, REMOTE, init, password_step, remote_step
from opencorp.install.interview import CONFIRM, Asking, Known, ModelError, asking
from opencorp.install.launch import office_answers
from opencorp.install.onboard import (GIT_ACCESS, SET_UP_AGAIN, TRY_AGAIN, NoTerminal, OnboardError, TtyPrompter,
                                        onboard, redact)
from opencorp.testing.fake_llm import LLM_CONFIG, FakeLLM
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host
from .test_interview import flow_replies
from .test_onboard import _git, _stop
from .test_provider_setup import Script

KEY = "sk-ant-sentinel-1c9e04b7a2d6"
PASSWORD = "pw-sentinel-5d1f"
FLAGS = Known(company="Acme", name="Me", handle="me")


def provider_stdin():
    """A provider on stdin, so the model step asks nothing."""
    return io.StringIO(json.dumps({"llm_config": LLM_CONFIG}))


def scripted(remote=""):
    """A prompter with no one at the terminal, so the company comes from the flags; it gives ``PASSWORD`` twice
    and then ``remote`` typed (none when empty)."""
    return Script(PASSWORD, PASSWORD, *((remote,) if remote else ("1",)), interactive=False)


def run_init(tmp_path, ask, known=FLAGS, **kwargs):
    """Run init at ``tmp_path / "home"`` with the provider on stdin and a host where nothing real runs."""
    init(tmp_path / "home", ask, known=known, stdin=provider_stdin(), host=make_host(tmp_path, Runner()), **kwargs)


def stop_after_the_company(monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))


def interviewed(monkeypatch, draft):
    """Make init's flow return ``draft`` without a model, asking for the password and the remote as its nodes do."""
    def init_flow(provider_path, prompter, known):
        return (replace(draft, owner=replace(draft.owner, password_hash=password_step(prompter))),
                remote_step(prompter, known.remote))

    monkeypatch.setattr(init_module, "init_flow", init_flow)


ACME = Draft("Acme", Owner(handle="ngocbh", name="Hong Ngoc Bui", title="CEO"),
             (Teammate("Lan", "lan", "QA", "Tests every release."), Teammate("Minh", "minh-dev", "Engineer")))


def test_init_makes_the_company_its_ceo_and_seeded_teammates_in_one_commit(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    home = tmp_path / "home"
    ask = Script(PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    repo = load_repo(home / "company")
    assert repo.company.name == "Acme" and repo.company.ceo == "ngocbh"
    assert {h: (p.kind, p.title, p.manager) for h, p in repo.people.items()} == {
        "ngocbh": ("human", "CEO", None), "lan": ("agent", "QA", "ngocbh"), "minh-dev": ("agent", "Engineer", "ngocbh")}
    assert (home / "company/people/lan/profile.md").read_text() == "# Lan, QA\n\nTests every release.\n"
    assert (home / "company/people/minh-dev/profile.md").read_text() == "# Minh, Engineer\n"
    assert lint(repo) == [] and missing_files(home / "company") == []
    assert _git(home / "company", "log", "--format=%s").splitlines() == ["init: create the company"]
    assert _git(home / "company", "status", "--porcelain") == ""
    assert f"Company repo: created at {home / 'company'}, with you as CEO and Lan (@lan), Minh (@minh-dev)" in ask.seen
    assert [line for line in ask.seen if line.startswith("Step ")] == [
        "Step 1 of 5: Model", "Step 2 of 5: Company", "Step 3 of 5: Password", "Step 4 of 5: Remote",
        "Step 5 of 5: This machine"]


def test_the_model_is_asked_first(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    ask = Script("openai", "", "", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert ask.seen[:3] == ["Step 1 of 5: Model", "Your agents think with this model; its key stays in this office,"
                            " readable only by you.", "Model provider"]
    provider = tmp_path / "home" / "office" / "provider.json"
    assert f"Model provider: saved to {provider}" in ask.seen
    assert json.loads(provider.read_text()) == {"llm_config": {"provider": "openai"}}


def test_the_provider_from_the_first_step_is_kept_by_the_last(tmp_path, monkeypatch):
    interviewed(monkeypatch, ACME)
    ask = Script("openai", "", "", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="did not answer"):  # the stand-in office never starts
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    provider = tmp_path / "home" / "office" / "provider.json"
    assert f"Model provider: saved to {provider}" in ask.seen
    assert f"Model provider: up to date at {provider}" in ask.seen
    assert ask.seen.count("Model provider") == 1
    assert json.loads(provider.read_text()) == {"llm_config": {"provider": "openai"}}


def test_the_flow_with_a_model_makes_the_company_and_never_sends_a_secret(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    remote = bare(tmp_path / "remote-sentinel-3b8e.git")
    out = {"company": "Acme", "owner": {"name": "Hong Ngoc Bui", "handle": "ngocbh", "title": "CEO"},
           "teammates": [{"name": "Lan", "handle": "lan", "title": "QA", "about": "Tests every release."}]}
    with FakeLLM() as fake:
        fake.script(*flow_replies("Tell me about the company.", out))
        ask = Script("Acme; I'm ngocbh; hire Lan for QA", "1", PASSWORD, PASSWORD, str(remote))
        provider = {"llm_config": {**LLM_CONFIG, "api_key": KEY}, "env": fake.env()}
        with pytest.raises(OnboardError, match="stop"):
            init(home, ask, stdin=io.StringIO(json.dumps(provider)), host=make_host(tmp_path, Runner()))
        sent = json.dumps(fake.requests())
    repo = load_repo(home / "company")
    assert repo.company.name == "Acme" and repo.company.ceo == "ngocbh"
    assert {h: (p.kind, p.title) for h, p in repo.people.items()} == {"ngocbh": ("human", "CEO"), "lan": ("agent", "QA")}
    assert (home / "company/people/lan/profile.md").read_text() == "# Lan, QA\n\nTests every release.\n"
    assert "Tell me about the company." in ask.seen and CONFIRM in ask.seen
    assert "Acme; I'm ngocbh; hire Lan for QA" in sent
    hashed = yaml.safe_load(_git(home / "company", "show", "HEAD:people/ngocbh/person.yaml"))["password_hash"]
    for secret in (PASSWORD, KEY, "remote-sentinel-3b8e", hashed):
        assert secret not in sent
    assert _git(remote, "rev-parse", "main") == _git(home / "company", "rev-parse", "HEAD")
    assert [line for line in ask.seen if line.startswith("Step ")] == [
        "Step 1 of 5: Model", "Step 2 of 5: Company", "Step 3 of 5: Password", "Step 4 of 5: Remote",
        "Step 5 of 5: This machine"]


def test_without_a_terminal_the_flags_make_the_company_without_asking_to_confirm(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    monkeypatch.setattr(init_module, "init_flow", lambda *a: pytest.fail("the flow ran"))
    ask = scripted()
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask, known=Known(company="Acme", name="Bo", handle="bo", agent="Lan", agent_handle="lan"))
    repo = load_repo(tmp_path / "home" / "company")
    assert repo.company.name == "Acme" and set(repo.people) == {"bo", "lan"}
    assert CONFIRM not in ask.seen


def failing_interview(monkeypatch, draft, failures=1):
    """Make init's flow fail with a ``ModelError`` ``failures`` times, then return ``draft`` as ``interviewed`` does."""
    real = init_module.init_flow
    calls = []

    def init_flow(*args):
        calls.append(args)
        if len(calls) <= failures:
            raise ModelError("the model couldn't run the interview: Connection error")
        return real(*args)

    monkeypatch.setattr(init_module, "init_flow", init_flow)
    return calls


def test_a_failed_interview_can_be_tried_again_with_the_same_model(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    calls = failing_interview(monkeypatch, ACME)
    ask = Script("openai", "", "", "1", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert len(calls) == 2
    assert "The model couldn't run the interview: Connection error" in ask.seen
    assert [TRY_AGAIN, SET_UP_AGAIN] in ask.offered
    assert load_repo(tmp_path / "home" / "company").company.name == "Acme"


def test_a_failed_interview_can_set_up_the_model_again(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    failing_interview(monkeypatch, ACME)
    ask = Script("openai", "", "", "2", "anthropic", KEY, "", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    provider = tmp_path / "home" / "office" / "provider.json"
    assert json.loads(provider.read_text()) == {"llm_config": {"provider": "anthropic", "api_key": KEY,
                                                               "model": "claude-sonnet-4-5"}}
    assert all(KEY not in line for line in ask.seen)


def test_setting_the_model_up_again_starts_from_step_ones_answers(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    failing_interview(monkeypatch, ACME)
    ask = Script("openai", KEY, "gpt-x", "2", "", "", "", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    provider = tmp_path / "home" / "office" / "provider.json"
    assert json.loads(provider.read_text()) == {"llm_config": {"provider": "openai", "api_key": KEY, "model": "gpt-x"}}
    assert "openai API key (empty keeps the one you just typed; not shown)" in ask.seen


def test_the_model_is_checked_before_it_is_saved(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    interviewed(monkeypatch, ACME)
    problems = ["Connection error", None]
    monkeypatch.setattr(init_module, "model_problem", lambda provider: problems.pop(0))
    ask = Script("openai", "", "", "1", PASSWORD, PASSWORD, "1")
    with pytest.raises(OnboardError, match="stop"):
        init(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert "The model didn't answer: Connection error" in ask.seen and problems == []


def test_flags_that_clash_without_a_terminal_stop_before_the_company_is_made(tmp_path):
    with pytest.raises(OnboardError, match="@me is taken; pass --agent-handle"):
        run_init(tmp_path, scripted(), known=Known(handle="me", agent_handle="me"))
    assert is_new(OfficePaths(tmp_path / "home").company)


def test_init_registers_this_device_for_the_ceo_in_the_first_commit(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    ask = scripted()
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    me = read_identity(home / "identity.json")
    assert (me.handle, me.device) == ("me", device_name())
    assert stat.S_IMODE(os.stat(home / "identity.json").st_mode) == 0o600
    first = _git(home / "company", "show", "HEAD:people/me/person.yaml")
    assert yaml.safe_load(first)["devices"] == [{"name": me.device, "token_sha256": token_sha256(me.token)}]
    assert not [line for line in ask.seen if me.token in line]
    assert f"This device: {me.device}, acting as @me (its token is in {home / 'identity.json'})" in ask.seen


def test_init_keeps_only_the_hash_of_the_ceos_password_in_the_first_commit(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    ask = scripted()
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    first = yaml.safe_load(_git(home / "company", "show", "HEAD:people/me/person.yaml"))
    assert check_password(PASSWORD, first["password_hash"])
    assert not [line for line in ask.seen if PASSWORD in line]
    assert PASSWORD not in _git(home / "company", "log", "-p", "--all")
    assert lint(load_repo(home / "company")) == []


def test_a_short_or_mistyped_password_is_asked_again(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = Script("eleven-char", PASSWORD, "typo-typo", PASSWORD, PASSWORD, "1", interactive=False)
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    assert "Your password, to log in new devices with (at least 12 characters, one you use nowhere else;" \
        " not shown)" in ask.seen
    assert "That doesn't work: use at least 12 characters" in ask.seen
    assert "That doesn't work: the two passwords differ" in ask.seen
    assert check_password(PASSWORD, load_repo(tmp_path / "home" / "company").people["me"].password_hash)


class NoTerminalScript(Script):
    def secret(self, question):
        self.seen.append(question)
        raise NoTerminal("no terminal")


def test_without_a_terminal_the_ceo_gets_no_password_and_is_told_how_to_set_one(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = NoTerminalScript("", interactive=False)
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    assert load_repo(tmp_path / "home" / "company").people["me"].password_hash is None
    assert "Password: none, since there's no terminal to ask on; set one later with `ac password`" in ask.seen


def test_init_replaces_an_old_identity(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    (home / "identity.json").write_text('{"handle": "old", "device": "old", "token": "act_old"}')
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, scripted())
    me = read_identity(home / "identity.json")
    assert me.handle == "me" and me.token != "act_old"


def test_no_device_leaves_the_company_open_without_tokens(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, scripted(), device=False)
    assert not (home / "identity.json").exists()
    assert load_repo(home / "company").people["me"].devices == []


def test_init_refuses_a_company_that_exists_and_suggests_onboard(tmp_path):
    home = tmp_path / "home"
    write_company(home / "company", home / "office/worktrees", company="Acme", owner=Owner("me", "Me"))
    head = _git(home / "company", "rev-parse", "HEAD")
    with pytest.raises(OnboardError, match=r"already a company at .*; run `ac onboard`"):
        init(home, Script(), host=make_host(tmp_path, Runner()))
    assert _git(home / "company", "rev-parse", "HEAD") == head


def test_a_company_whose_first_write_stopped_early_is_finished(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    company = OfficePaths(tmp_path / "home").company
    company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(company)], check=True)
    (company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, scripted())
    assert lint(load_repo(company)) == [] and _git(company, "status", "--porcelain") == ""


def _stop_before_the_first_commit(tmp_path, monkeypatch):
    """Run init as `an` of Acme until the company's first commit, which fails."""
    import opencorp.company_template as template

    def fail(*a, **k):
        raise template.CompanyGitError("killed")

    with monkeypatch.context() as m:
        m.setattr(template.CompanyGit, "commit", fail)
        with pytest.raises(OnboardError, match="killed"):
            run_init(tmp_path, scripted(), known=Known(company="Acme", name="An", handle="an"))
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
        run_init(tmp_path, scripted(), known=Known(company="Beta", name="Bo", handle="bo"))
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
        run_init(tmp_path, Script(interactive=False))


def test_an_existing_home_others_can_read_is_made_private(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    home = tmp_path / "home"
    home.mkdir(mode=0o755)
    home.chmod(0o755)
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, scripted())
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
    ask = scripted(remote=str(remote))
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    company = tmp_path / "home" / "company"
    assert _git(remote, "rev-parse", "main") == _git(company, "rev-parse", "HEAD")
    assert _git(company, "rev-parse", "--abbrev-ref", "main@{upstream}").strip() == "origin/main"
    assert any(line.startswith("Remote: pushed the company to") for line in ask.seen)


def test_a_remote_flag_is_used_without_asking(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    remote = bare(tmp_path / "acme.git")
    ask = Script(PASSWORD, PASSWORD, interactive=False)
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask, known=Known(company="Acme", name="Me", handle="me", remote=str(remote)))
    assert _git(remote, "rev-parse", "main") == _git(tmp_path / "home" / "company", "rev-parse", "HEAD")
    assert REMOTE not in ask.seen


def test_a_push_that_fails_is_a_warning_with_the_retry_and_init_goes_on(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = scripted(remote=str(tmp_path / "nowhere.git"))
    with pytest.raises(OnboardError, match="stop"):  # it got past the remote, to onboarding
        run_init(tmp_path, ask)
    company = tmp_path / "home" / "company"
    warning = next(line for line in ask.seen if line.startswith("Warning: couldn't push"))
    assert GIT_ACCESS in warning
    assert f"then retry with `git -C {company} push -u origin main`." in warning
    assert _git(company, "remote", "get-url", "origin").strip() == str(tmp_path / "nowhere.git")
    assert "Step 5 of 5: This machine" in ask.seen


def test_a_token_in_the_remote_url_is_never_shown(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    url = "http://x-access-token:ghp_sentinel42@127.0.0.1:9/acme.git"
    ask = scripted(remote=url)
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    assert any(line.startswith("Warning: couldn't push") for line in ask.seen)
    assert not [line for line in ask.seen if "ghp_sentinel42" in line]
    assert redact(url) == "http://***@127.0.0.1:9/acme.git"


def test_the_password_node_shows_step_3_and_returns_the_hash():
    prompter = Script(PASSWORD, PASSWORD)
    with asking(Asking(prompter)):
        assert check_password(PASSWORD, init_module.password({}))
    assert prompter.seen[0] == "Step 3 of 5: Password"


def test_the_remote_node_uses_the_flag_or_asks():
    flagged, none, typed = Script(), Script("1"), Script("git@example.com:a.git")
    with asking(Asking(flagged)):
        assert init_module.remote({"given": "u"}) == "u"
    with asking(Asking(none)):
        assert init_module.remote({"given": ""}) == ""
    with asking(Asking(typed)):
        assert init_module.remote({"given": ""}) == "git@example.com:a.git"
    assert REMOTE not in flagged.seen and none.seen[-1] == REMOTE and typed.seen[-1] == REMOTE
    assert typed.offered == [[NO_REMOTE]] and typed.typed == [True]


def test_without_anyone_to_ask_there_is_no_remote(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("2\ngit@example.com:a.git\n"))
    assert remote_step(TtyPrompter(interactive=False), "") == ""


def test_the_remote_is_asked_before_the_company_is_written(tmp_path, monkeypatch):
    stop_after_the_company(monkeypatch)
    ask = scripted()
    with pytest.raises(OnboardError, match="stop"):
        run_init(tmp_path, ask)
    created = next(i for i, line in enumerate(ask.seen) if line.startswith("Company repo: created at"))
    assert ask.seen.index("Step 3 of 5: Password") < ask.seen.index(REMOTE) < created


class InterruptedAtRemote(Script):
    def choose(self, question, options, default="", typed=False):
        if question == REMOTE:
            raise KeyboardInterrupt
        return super().choose(question, options, default, typed)


def test_ctrl_c_at_the_remote_leaves_no_company(tmp_path):
    with pytest.raises(KeyboardInterrupt):
        run_init(tmp_path, InterruptedAtRemote(PASSWORD, PASSWORD, interactive=False))
    assert is_new(OfficePaths(tmp_path / "home").company)


# Not interactive, so the company comes from the flags and no real model is asked; the CLI never runs init this
# way (it is interactive whenever the provider isn't on stdin).
CEO = Known(company="Acme", name="Hong Ngoc Bui", handle="ngocbh")


def test_init_sets_up_the_office_and_a_second_onboard_changes_nothing(short_dir):
    paths = OfficePaths(short_dir)
    first = Script("openai", "", "", PASSWORD, PASSWORD, "1", interactive=False)
    try:
        init(short_dir, first, known=CEO, mode="background")
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
    ask = Script("anthropic", KEY, "", PASSWORD, PASSWORD, "1", interactive=False)
    try:
        init(short_dir, ask, known=CEO, mode="background")
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
