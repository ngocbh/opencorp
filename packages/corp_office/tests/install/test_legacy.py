import json
import plistlib
import shlex
from pathlib import Path

from opencorp.install import legacy

from .conftest import Runner, make_host

REPO = Path("/opt/opencorp")
BUN = shlex.join(["bun", str(REPO / legacy.NEW_ENTRY)])


def old_home(tmp_path, mode=None):
    home = tmp_path / ".agent-corp"
    (home / "office").mkdir(parents=True)
    if mode:
        (home / "office" / "install.json").write_text(json.dumps({"mode": mode, "name": "office"}))
    return home


def old_plist(tmp_path, name="office", home=None):
    plist = tmp_path / "Library" / "LaunchAgents" / f"com.agent-corp.{name}.plist"
    plist.parent.mkdir(parents=True, exist_ok=True)
    argv = ["/opt/opencorp/.venv/bin/python", "-m", "agent_corp.daemon.main", "--home", str(home)] if home else []
    plist.write_bytes(plistlib.dumps({"Label": plist.stem, "ProgramArguments": argv}) if home else b"")
    return plist


def test_a_clean_machine_has_nothing_left(tmp_path):
    assert not legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)


def test_the_old_home_and_its_launchd_job_are_found(tmp_path):
    home = old_home(tmp_path, "launchd")
    plist = old_plist(tmp_path)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)
    assert found.home == home and not found.both and found.plists == (plist,)
    assert "the old home" in found.summary() and "launchd job com.agent-corp.office" in found.summary()


def test_a_systemd_unit_is_found_by_its_old_name(tmp_path):
    unit = tmp_path / ".config" / "systemd" / "user" / "agent-corp-office.service"
    unit.parent.mkdir(parents=True)
    unit.write_text("")
    assert legacy.find(make_host(tmp_path, Runner(), platform="linux"), {"PATH": ""}, REPO).units == (unit,)


def test_tmux_is_asked_only_when_the_old_home_recorded_tmux(tmp_path):
    old_home(tmp_path, "tmux")
    run = Runner([(["tmux", "has-session"], 0, "")])
    assert legacy.find(make_host(tmp_path, run), {"PATH": ""}, REPO).sessions == ("agent-corp-office",)
    assert run.calls == [["tmux", "has-session", "-t", "=agent-corp-office"]]


def test_both_homes_are_noted(tmp_path):
    old_home(tmp_path)
    (tmp_path / ".opencorp").mkdir()
    assert legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO).both


def test_old_environment_variables_are_found(tmp_path):
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": "", "AGENT_CORP_HOME": "/x",
                                                        "AGENT_CORP_CODEX_BIN": "c", "OPENCORP_HOME": "/y"}, REPO)
    assert found.env == ("AGENT_CORP_CODEX_BIN", "AGENT_CORP_HOME")


def test_an_ac_launcher_for_this_checkout_is_found_even_dangling(tmp_path):
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "ac").symlink_to(repo / "packages" / "ac" / "src" / "main.ts")
    assert legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, repo).launchers == (bin_dir / "ac",)


def test_old_home_only_is_the_old_home_when_the_new_one_is_missing(tmp_path):
    assert legacy.old_home_only(tmp_path) is None
    home = old_home(tmp_path)
    assert legacy.old_home_only(tmp_path) == home
    (tmp_path / ".opencorp").mkdir()
    assert legacy.old_home_only(tmp_path) is None
