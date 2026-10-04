import os
import subprocess

import pytest

from agent_corp.auth.devices import add_device
from agent_corp.auth.identity import device_name, read_identity
from agent_corp.auth.tokens import token_sha256
from agent_corp.company.git import CompanyGit
from agent_corp.company.loader import load_repo
from agent_corp.company_template import Owner, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install import launchd, service
from agent_corp.install.launch import Host, launch, office_answers
from agent_corp.install.offboard import CONFIRM, KEEP, REMOVE, OffboardError, launchers, offboard
from agent_corp.install.onboard import make_device, make_home
from agent_corp.protocol.models import Device
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host
from .test_provider_setup import Script


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def office(home, *, device=True):
    """An office as `ac init` leaves it: a company with this device listed for @me, identity.json, office state."""
    paths = OfficePaths(home)
    make_home(paths)
    owner = Owner("me", "Me")
    if device:
        owner = make_device(home, owner)
    write_company(paths.company, paths.worktrees, company="Acme", owner=owner)
    (paths.office / "provider.json").write_text('{"provider": "anthropic"}')
    (paths.office / "office.log").write_text("started\n")
    (home / "tui").mkdir()
    return paths


def publish(paths, tmp_path):
    """Push the company to a new bare repo, tracking it; the bare repo's path."""
    remote = tmp_path / "acme.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    git(paths.company, "remote", "add", "origin", str(remote))
    git(paths.company, "push", "-q", "-u", "origin", "main")
    return remote


def devices(paths):
    return [d.name for d in load_repo(paths.company).people["me"].devices]


def subjects(repo):
    return git(repo, "log", "--format=%s").splitlines()


def no_launchers():
    return {"PATH": ""}


def test_offboard_says_what_it_will_remove_and_no_keeps_everything(tmp_path):
    paths = office(tmp_path / "home")
    ask = Script("")
    with pytest.raises(OffboardError, match="nothing was removed"):
        offboard(paths.home, ask, host=make_host(tmp_path, Runner()), environ=no_launchers())
    said = "\n".join(ask.seen)
    assert f"this device ({device_name()}) from @me in the company repo" in said
    assert f"{paths.office} (the office's store, provider.json, connections and sign-ins, logs, and worktrees)" in said
    assert str(paths.home / "identity.json") in said and str(paths.home / "tui") in said
    assert f"Keeping the company repo at {paths.company}: it has no remote, so this is its only copy" in said
    assert ask.seen[-1] == CONFIRM and ask.offered == [[KEEP, REMOVE]]
    assert devices(paths) == [device_name()] and (paths.office / "provider.json").exists()
    assert (paths.home / "identity.json").exists() and (paths.home / "tui").exists()


def test_offboard_removes_the_device_and_the_office_but_keeps_a_company_with_no_remote(tmp_path):
    paths = office(tmp_path / "home")
    ask = Script("2")
    offboard(paths.home, ask, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert devices(paths) == []
    assert subjects(paths.company)[0] == f"devices(@me): remove {device_name()}"
    assert sorted(os.listdir(paths.home)) == ["company"]
    assert git(paths.company, "worktree", "list").count("\n") == 1
    assert any("Kept the company repo" in line and "no remote" in line for line in ask.seen)


def test_offboard_deletes_a_pushed_company_and_then_the_empty_home(tmp_path):
    paths = office(tmp_path / "home")
    remote = publish(paths, tmp_path)
    pushed = git(remote, "rev-parse", "main")
    offboard(paths.home, Script(), yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert not paths.home.exists()
    assert git(remote, "rev-parse", "main") == pushed  # offboard never pushes


def test_this_devices_own_commits_dont_count_as_unpushed(tmp_path):
    # A company joined with `ac onboard --from` has this device's commit on top of what it cloned.
    paths = office(tmp_path / "home", device=False)
    publish(paths, tmp_path)
    me = make_device(paths.home, Owner("me", "Me"))
    add_device(CompanyGit(paths.company, paths.worktrees), "me", me.devices[0], "me")
    ask = Script()
    offboard(paths.home, ask, yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert not paths.home.exists()
    assert f"the company repo at {paths.company} (everything in it is pushed)" in "\n".join(ask.seen)


@pytest.mark.parametrize(("change", "why"), [
    ("commit", "it has 1 commit not pushed to its remote"),
    ("edit", "it has uncommitted changes"),
    ("untracked", "it has uncommitted changes"),
    ("branch", "its branch drafts isn't pushed anywhere"),
    ("stash", "it has stashed changes"),
])
def test_offboard_keeps_a_company_with_work_that_isnt_pushed(tmp_path, change, why):
    paths = office(tmp_path / "home")
    publish(paths, tmp_path)
    readme = paths.company / "notes.md"
    if change in ("commit", "stash", "edit"):
        readme.write_text("notes\n")
        git(paths.company, "add", "notes.md")
    if change == "commit":
        git(paths.company, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes")
    elif change == "stash":
        git(paths.company, "stash", "-q")
    elif change == "untracked":
        readme.write_text("notes\n")
    elif change == "branch":
        git(paths.company, "branch", "drafts")
    ask = Script()
    offboard(paths.home, ask, yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert sorted(os.listdir(paths.home)) == ["company"]
    said = "\n".join(ask.seen)
    assert f"Keeping the company repo at {paths.company}: {why}" in said
    assert "--delete-company" in said


def test_delete_company_deletes_it_even_with_unpushed_work(tmp_path):
    paths = office(tmp_path / "home")
    (paths.company / "notes.md").write_text("notes\n")
    ask = Script()
    offboard(paths.home, ask, yes=True, delete_company=True, host=make_host(tmp_path, Runner()),
             environ=no_launchers())
    assert not paths.home.exists()
    assert f"the company repo at {paths.company}, even though it has no remote, so this is its only copy" in \
        "\n".join(ask.seen)


def test_a_second_offboard_finds_nothing_and_asks_nothing(tmp_path):
    paths = office(tmp_path / "home")
    offboard(paths.home, Script(), yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    ask = Script()
    offboard(paths.home, ask, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert f"Nothing of this office to remove at {paths.home}." in ask.seen
    assert any(line.startswith(f"Keeping the company repo at {paths.company}") for line in ask.seen)
    assert CONFIRM not in ask.seen and ask.offered == []
    assert subjects(paths.company)[0] == f"devices(@me): remove {device_name()}"
    ask = Script()
    offboard(tmp_path / "nowhere", ask, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert f"Nothing of this office to remove at {os.path.realpath(tmp_path / 'nowhere')}." in ask.seen


def test_offboard_cleans_up_a_half_made_office(tmp_path):
    # Onboarding that stopped before the company leaves only the office dir.
    home = tmp_path / "home"
    make_home(OfficePaths(home))
    (home / ".company-clone").mkdir()
    offboard(home, Script(), yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert not home.exists()


def test_offboard_with_an_identity_the_company_doesnt_list_skips_the_device(tmp_path):
    paths = office(tmp_path / "home", device=False)
    make_device(paths.home, Owner("me", "Me"))  # identity.json only
    ask = Script()
    offboard(paths.home, ask, yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert not any("from @me in the company repo" in line for line in ask.seen)
    assert subjects(paths.company) == ["init: create the company"]


def test_offboard_uninstalls_a_launchd_office_through_the_host(tmp_path):
    paths = office(tmp_path / "home")
    run = launch(paths.home, user_home=tmp_path)
    host = make_host(tmp_path, runner := Runner())
    plist = launchd.plist_path(run, host)
    plist.parent.mkdir(parents=True)
    plist.write_bytes(launchd.plist(run))
    (paths.office / "install.json").write_text('{"mode": "launchd"}')
    ask = Script()
    offboard(paths.home, ask, yes=True, host=host, environ=no_launchers())
    assert ["launchctl", "bootout", f"gui/501/{launchd.label(run)}"] in runner.calls
    assert not plist.exists()
    assert f"the office's launchd service ({plist})" in "\n".join(ask.seen)


def test_an_office_that_wont_stop_keeps_its_state(tmp_path):
    paths = office(tmp_path / "home")
    with pytest.raises(OffboardError, match="still answers"):
        offboard(paths.home, Script(), yes=True, host=make_host(tmp_path, Runner(), answers=lambda socket: True),
                 environ=no_launchers())
    assert (paths.office / "provider.json").exists() and (paths.home / "identity.json").exists()


def test_offboard_removes_the_device_through_a_running_office(short_dir):
    paths = office(short_dir / "home")
    run = launch(paths.home)
    host = make_host(short_dir, Runner(), popen=subprocess.Popen, answers=office_answers)
    service.install(run, host, "background")
    service.wait(run, Host())
    me = read_identity(paths.home / "identity.json")
    ask = Script()
    offboard(paths.home, ask, yes=True, host=host, environ=no_launchers())
    assert devices(paths) == []
    assert subjects(paths.company)[0] == f"devices(@me): remove {me.device}"
    assert f"Removed this device ({me.device}) from @me through the office." in ask.seen
    assert not office_answers(run.socket)
    assert sorted(os.listdir(paths.home)) == ["company"]


def test_offboard_reports_how_ac_was_put_on_path_and_keeps_the_checkout(tmp_path):
    repo = tmp_path / "checkout"
    (repo / "packages" / "ac" / "src").mkdir(parents=True)
    (repo / "packages" / "ac" / "src" / "main.ts").write_text("")
    wrapper, linked, other = tmp_path / "local", tmp_path / "bun", tmp_path / "sbin"
    for d in (wrapper, linked, other):
        d.mkdir()
    (wrapper / "ac").write_text(f'#!/bin/bash\nexec bun {repo}/packages/ac/src/main.ts "$@"\n')
    (linked / "ac").symlink_to(repo / "packages" / "ac" / "src" / "main.ts")
    (other / "ac").write_bytes(b"\x7fELF not ours")
    found = launchers({"PATH": os.pathsep.join(map(str, (wrapper, linked, other)))}, repo)
    assert found == [wrapper / "ac", linked / "ac"]
    ask = Script()
    offboard(tmp_path / "nowhere", ask, host=make_host(tmp_path, Runner()), repo=repo,
             environ={"PATH": str(wrapper)})
    said = "\n".join(ask.seen)
    assert f"rm {wrapper / 'ac'}" in said
    assert f"The checkout at {repo} stays" in said


def test_offboard_with_no_launcher_on_path_says_so(tmp_path):
    ask = Script()
    offboard(tmp_path / "nowhere", ask, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert any("No `ac` launcher from" in line for line in ask.seen)


def test_offboard_never_prints_the_token_or_the_provider(tmp_path):
    paths = office(tmp_path / "home")
    token = read_identity(paths.home / "identity.json").token
    ask = Script()
    offboard(paths.home, ask, yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    said = "\n".join(ask.seen)
    assert token not in said and token_sha256(token) not in said and "anthropic" not in said


def test_a_device_named_like_another_doesnt_hide_this_ones_commits(tmp_path):
    paths = office(tmp_path / "home", device=False)
    publish(paths, tmp_path)
    other = Device(name="laptop", token_sha256="0" * 64)
    add_device(CompanyGit(paths.company, paths.worktrees), "me", other, "me")
    make_device(paths.home, Owner("me", "Me"))
    ask = Script()
    offboard(paths.home, ask, yes=True, host=make_host(tmp_path, Runner()), environ=no_launchers())
    assert "it has 1 commit not pushed to its remote" in "\n".join(ask.seen)
