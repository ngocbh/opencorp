import io
import os
import signal
import subprocess

import json

import httpx
import psutil
import pytest
import yaml

from opencorp.auth.identity import Identity, device_name, read_identity, write_identity
from opencorp.auth.passwords import hash_password
from opencorp.auth.tokens import new_token, token_sha256
from opencorp.company.loader import load_repo
from opencorp.company_template import Owner, write_company
from opencorp.daemon.app import OfficePaths
from opencorp.install import onboard as onboard_module
from opencorp.install.onboard import TRIES, WHO, OnboardError, TtyPrompter, onboard, owner_defaults
from opencorp.protocol.models import Device
from opencorp.profile.debrief import DEBRIEF_FLOW
from opencorp.profile.manager import MANAGER_FLOW
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host
from .test_provider_setup import Script

PROVIDER = '{"llm_config": {"provider": "openai"}}'
PASSWORD = "pw-sentinel-77ab"


def _git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


def _stop(paths):
    if paths.pidfile.exists() and (pid := paths.pidfile.read_text().strip()):
        os.kill(int(pid), signal.SIGTERM)
        psutil.Process(int(pid)).wait(timeout=15)


def company(home, handle="me"):
    """A company at ``home`` made as `opencorp init` makes it, with ``handle`` as CEO and no device."""
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
    assert "This device has no identity yet; run `opencorp login` to use opencorp from it." in ask.seen
    assert not (home / "identity.json").exists()
    assert [line for line in ask.seen if line.startswith("Step ")] == [
        "Step 1 of 4: Company", "Step 2 of 4: This device", "Step 3 of 4: Model", "Step 4 of 4: Office"]


def test_onboard_saves_no_provider_whose_model_doesnt_answer(tmp_path, monkeypatch):
    home = tmp_path / "home"
    company(home)
    monkeypatch.setattr("opencorp.install.interview.model_problem", lambda provider: "Connection error")
    with pytest.raises(OnboardError, match="^the model didn't answer: Connection error$"):
        onboard(home, Script(), stdin=io.StringIO(PROVIDER), host=make_host(tmp_path, Runner(), answers=lambda s: True))
    assert not (home / "office" / "provider.json").exists()


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
    assert "The office is running; stop it and run `opencorp onboard` again to add 2 template files." in "\n".join(ask.seen)
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


def stop_after_the_device(monkeypatch):
    monkeypatch.setattr(onboard_module, "ensure_provider", lambda *a, **k: (_ for _ in ()).throw(OnboardError("stop")))


def published(tmp_path, humans=("ceo", "lan"), passwords=None, devices=None):
    """A company whose humans are ``humans`` (the first is CEO), pushed to a bare repo; the bare repo's path.

    ``passwords`` and ``devices`` give humans, by handle, a password's hash and a device list.
    """
    src = company(tmp_path / "src", humans[0])
    for handle in humans[1:]:
        (src / "people" / handle).mkdir()
        (src / "people" / handle / "person.yaml").write_text(
            f"handle: {handle}\nname: {handle.title()}\nkind: human\ntitle: Engineer\nmanager: {humans[0]}\n")
    for handle, password in (passwords or {}).items():
        with (src / "people" / handle / "person.yaml").open("a") as f:
            f.write(f"password_hash: {json.dumps(hash_password(password))}\n")
    for handle, listed in (devices or {}).items():
        with (src / "people" / handle / "person.yaml").open("a") as f:
            f.write(yaml.safe_dump({"devices": [d.model_dump() for d in listed]}))
    if humans[1:] or passwords or devices:
        _git(src, "add", "-A")
        _git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hire the humans")
    remote = tmp_path / "acme.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(src), str(remote)], check=True)
    return remote


def test_onboard_clones_the_company_and_commits_this_device_for_the_human_you_pick(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    remote = published(tmp_path)
    home = tmp_path / "home"
    ask = Script("lan")
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, ask, source=str(remote), host=make_host(tmp_path, Runner()))
    me = read_identity(home / "identity.json")
    assert (me.handle, me.device) == ("lan", device_name())
    assert load_repo(home / "company").people["lan"].devices == [
        Device(name=me.device, token_sha256=token_sha256(me.token))]
    assert _git(home / "company", "log", "-1", "--format=%s").strip() == f"devices(@lan): add {me.device}"
    assert _git(home / "company", "rev-parse", "--abbrev-ref", "main@{upstream}").strip() == "origin/main"
    assert _git(home / "company", "status", "--porcelain") == ""
    assert sorted(os.listdir(home)) == ["company", "identity.json", "office"]
    assert ask.offered == [["ceo", "lan"]] and not [line for line in ask.seen if line.startswith("The company's")]
    assert not [line for line in ask.seen if me.token in line]


def test_joining_as_a_human_with_a_password_needs_it(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    home = tmp_path / "home"
    ask = Script("lan", "wrong-password", PASSWORD)
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, ask, source=str(published(tmp_path, passwords={"lan": PASSWORD})), host=make_host(tmp_path, Runner()))
    me = read_identity(home / "identity.json")
    assert me.handle == "lan" and [d.name for d in load_repo(home / "company").people["lan"].devices] == [me.device]
    assert ask.seen.count("@lan's password (not shown)") == 2 and "That doesn't work: wrong password" in ask.seen
    assert not [line for line in ask.seen if PASSWORD in line]


def test_a_password_that_never_matches_stops_and_leaves_no_company(tmp_path):
    remote = published(tmp_path, passwords={"lan": PASSWORD})
    with pytest.raises(OnboardError, match="wrong password for @lan"):
        onboard(tmp_path / "home", Script("lan", *["nope-nope"] * TRIES), source=str(remote),
                host=make_host(tmp_path, Runner()))
    assert sorted(os.listdir(tmp_path / "home")) == ["office"]


def test_without_a_terminal_for_the_password_the_company_joins_without_this_device(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    home = tmp_path / "home"
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, TtyPrompter({WHO: "lan"}, interactive=False), source=str(published(tmp_path, passwords={"lan": PASSWORD})),
                host=make_host(tmp_path, Runner()))
    assert not (home / "identity.json").exists() and load_repo(home / "company").people["lan"].devices == []
    assert _git(home / "company", "log", "-1", "--format=%s").strip() == "hire the humans"


def test_a_human_without_a_password_joins_and_is_told_to_set_one(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    ask = Script("lan")
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", ask, source=str(published(tmp_path)), host=make_host(tmp_path, Runner()))
    assert read_identity(tmp_path / "home" / "identity.json").handle == "lan"
    assert "@lan has no password yet; set one with `opencorp password` so a new device has to give it" in ask.seen


def test_an_identity_the_company_already_lists_is_kept_and_nothing_is_asked(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    me = Identity("lan", "old-mac", new_token())
    write_identity(home / "identity.json", me)
    remote = published(tmp_path, passwords={"lan": PASSWORD},
                       devices={"lan": [Device(name="old-mac", token_sha256=token_sha256(me.token))]})
    ask = Script()  # no answers: nothing may be asked
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, ask, source=str(remote), host=make_host(tmp_path, Runner()))
    assert read_identity(home / "identity.json") == me
    assert _git(home / "company", "log", "-1", "--format=%s").strip() == "hire the humans"
    assert f"This device: old-mac, acting as @lan (its token is in {home / 'identity.json'})" in ask.seen


def test_onboard_asks_for_the_repo_when_not_given_one(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    remote = published(tmp_path, humans=("ceo",))
    ask = Script(str(remote), "")  # the only human is the default
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", ask, host=make_host(tmp_path, Runner()))
    assert read_identity(tmp_path / "home" / "identity.json").handle == "ceo"


def test_the_human_named_like_this_login_is_the_default(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    monkeypatch.setattr(onboard_module, "login_defaults", lambda: ("Lan", "lan"))
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", Script(""), source=str(published(tmp_path)), host=make_host(tmp_path, Runner()))
    assert read_identity(tmp_path / "home" / "identity.json").handle == "lan"


def test_no_human_to_default_to_and_no_answer_stops_without_a_company(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "login_defaults", lambda: ("X", "someone-else"))
    with pytest.raises(OnboardError, match="no usable answer"):
        onboard(tmp_path / "home", TtyPrompter(interactive=False), source=str(published(tmp_path)),
                host=make_host(tmp_path, Runner()))
    assert sorted(os.listdir(tmp_path / "home")) == ["office"]


def test_no_pick_with_no_default_says_who_to_pick_and_names_the_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(onboard_module, "login_defaults", lambda: ("X", "someone-else"))
    ask = Script(*[""] * TRIES)
    with pytest.raises(OnboardError, match="no usable answer"):
        onboard(tmp_path / "home", ask, source=str(published(tmp_path)), host=make_host(tmp_path, Runner()))
    assert ask.seen.count("That doesn't work: say which one you are (@ceo, @lan), or pass --handle") == TRIES


def test_a_device_name_the_human_already_uses_gets_a_suffix(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    src_remote = published(tmp_path, humans=("ceo",))
    work = tmp_path / "work"
    subprocess.run(["git", "clone", "-q", str(src_remote), str(work)], check=True)
    person = work / "people/ceo/person.yaml"
    person.write_text(person.read_text() + f"devices:\n- name: {device_name()}\n  token_sha256: {'ab' * 32}\n")
    _git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "another office")
    _git(work, "push", "-q", "origin", "main")
    with pytest.raises(OnboardError, match="stop"):
        onboard(tmp_path / "home", Script(""), source=str(src_remote), host=make_host(tmp_path, Runner()))
    me = read_identity(tmp_path / "home" / "identity.json")
    assert me.device == f"{device_name()[:60]}-2"
    assert [d.name for d in load_repo(tmp_path / "home" / "company").people["ceo"].devices] == [device_name(), me.device]


@pytest.mark.parametrize("prompter", [Script(""), TtyPrompter(interactive=False)], ids=["empty", "non-interactive"])
def test_no_company_and_no_repo_suggests_init(tmp_path, prompter):
    with pytest.raises(OnboardError, match=r"no company at .*; run `opencorp init` to create one, or `opencorp onboard --from URL`"):
        onboard(tmp_path / "home", prompter, host=make_host(tmp_path, Runner()))
    assert not (tmp_path / "home" / "company").exists()


def test_a_repo_that_cant_be_cloned_leaves_nothing_behind(tmp_path):
    with pytest.raises(OnboardError, match=r"can't clone .*; if git needs a login or a new host key, set that up in"
                                           r" a terminal first .*then run `opencorp onboard` again"):
        onboard(tmp_path / "home", Script(), source=str(tmp_path / "nowhere.git"), host=make_host(tmp_path, Runner()))
    assert sorted(os.listdir(tmp_path / "home")) == ["office"]


def test_a_repo_without_a_company_is_refused_and_removed(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    _git(src, "init", "-q", "-b", "main")
    (src / "README.md").write_text("hi\n")
    _git(src, "add", "-A")
    _git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "readme")
    with pytest.raises(OnboardError, match="isn't a company repo"):
        onboard(tmp_path / "home", Script(), source=str(src), host=make_host(tmp_path, Runner()))
    assert sorted(os.listdir(tmp_path / "home")) == ["office"]


def test_a_company_init_left_unfinished_is_not_cloned_over(tmp_path):
    company_dir = tmp_path / "home" / "company"
    company_dir.mkdir(parents=True)
    (company_dir / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    with pytest.raises(OnboardError, match="run `opencorp init` to finish it"):
        onboard(tmp_path / "home", Script(), source=str(tmp_path / "x.git"), host=make_host(tmp_path, Runner()))
    assert os.listdir(company_dir) == ["company.yaml"]


def test_a_second_onboard_of_a_cloned_company_changes_nothing_and_asks_nothing(tmp_path, monkeypatch):
    stop_after_the_device(monkeypatch)
    remote = published(tmp_path)
    home = tmp_path / "home"
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, Script("lan"), source=str(remote), host=make_host(tmp_path, Runner()))
    head, identity = _git(home / "company", "rev-parse", "HEAD"), (home / "identity.json").read_text()
    again = Script()
    with pytest.raises(OnboardError, match="stop"):
        onboard(home, again, source=str(remote), host=make_host(tmp_path, Runner()))
    assert _git(home / "company", "rev-parse", "HEAD") == head and (home / "identity.json").read_text() == identity
    assert any(line.startswith("This device: ") for line in again.seen)


def test_a_cloned_office_takes_this_devices_token(short_dir, tmp_path):
    remote = published(tmp_path)
    paths = OfficePaths(short_dir)
    try:
        onboard(short_dir, Script("lan", "openai", "", ""), source=str(remote), mode="background")
        me = read_identity(short_dir / "identity.json")
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(paths.socket)), base_url="http://office") as c:
            assert c.get("/people").status_code == 401
            assert c.get("/whoami", headers=me.headers()).json() == {"person": "lan", "device": me.device}
    finally:
        _stop(paths)
