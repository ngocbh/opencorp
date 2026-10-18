import json
import plistlib
import shlex
import subprocess
from pathlib import Path

from opencorp.install import legacy

from .conftest import Runner, make_host

REPO = Path("/opt/opencorp")
BUN = shlex.join(["bun", str(REPO / legacy.NEW_ENTRY)])


def MV(home):
    """The printed move of the old ``home`` next to it, which runs only while the new home is missing."""
    new = home.parent / ".opencorp"
    return f"[ ! -e {new} ] && mv {home} {new}"


def sh(command):
    return subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)


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


def test_a_launchd_office_is_stopped_then_moved_then_onboarded_again(tmp_path):
    home = old_home(tmp_path, "launchd")
    plist = old_plist(tmp_path, home=home)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)
    assert found.commands(501, REPO) == ["launchctl bootout gui/501/com.agent-corp.office", f"rm {plist}",
                                         f"{MV(home)}", f"{BUN} onboard"]


def test_a_systemd_unit_is_disabled_removed_and_reloaded(tmp_path):
    unit = tmp_path / ".config" / "systemd" / "user" / "agent-corp-office.service"
    unit.parent.mkdir(parents=True)
    unit.write_text("")
    found = legacy.find(make_host(tmp_path, Runner(), platform="linux"), {"PATH": ""}, REPO)
    assert found.commands(501, REPO) == ["systemctl --user disable --now agent-corp-office.service", f"rm {unit}",
                                         "systemctl --user daemon-reload", f"{BUN} onboard"]


def test_a_tmux_office_is_killed_first(tmp_path):
    old_home(tmp_path, "tmux")
    found = legacy.find(make_host(tmp_path, Runner([(["tmux", "has-session"], 0, "")])), {"PATH": ""}, REPO)
    assert found.commands(501, REPO)[0] == "tmux kill-session -t =agent-corp-office"


def test_nothing_is_moved_over_an_existing_new_home(tmp_path):
    old_home(tmp_path)
    (tmp_path / ".opencorp").mkdir()
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)
    assert not any("mv " in c for c in found.commands(501, REPO))
    assert any("keep the one with your company" in n for n in found.notes())


def test_with_both_homes_the_choice_comes_before_onboarding(tmp_path):
    home = old_home(tmp_path)
    new = tmp_path / ".opencorp"
    new.mkdir()
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": "", "AGENT_CORP_HOME": "/x"}, REPO)
    assert legacy.instructions(found, 501, REPO) == (
        f"\nboth {home} and {new} exist: keep the one with your company and remove the other yourself"
        f" (if you keep {home}, move it to {new})\n"
        "\nTo finish moving to OpenCorp, run these in order:\n"
        f"  {BUN} onboard\n"
        "\nAGENT_CORP_HOME is set, but OpenCorp reads OPENCORP_HOME now; rename it where you set it\n")


def test_old_environment_variables_get_a_note_not_a_command(tmp_path):
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": "", "AGENT_CORP_HOME": "/x"}, REPO)
    assert found.commands(501, REPO) == []
    assert found.notes() == ["AGENT_CORP_HOME is set, but OpenCorp reads OPENCORP_HOME now; rename it where you set it"]


def test_an_ac_wrapper_becomes_an_opencorp_wrapper(tmp_path):
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    wrapper = bin_dir / "ac"
    wrapper.write_text(f'#!/bin/bash\nexec bun {repo}/packages/ac/src/main.ts "$@"\n')
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, repo)
    new = bin_dir / "opencorp"
    assert found.commands(501, repo) == [
        f"[ ! -e {new} ] && sed 's#packages/ac/src/main.ts#packages/cli/src/main.ts#' {wrapper} > {new}"
        f" && chmod +x {new} && rm {wrapper}"]


def test_an_ac_link_becomes_an_opencorp_link(tmp_path):
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "ac").symlink_to(repo / "packages" / "ac" / "src" / "main.ts")
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, repo)
    assert found.commands(501, repo) == [
        f"[ ! -e {bin_dir / 'opencorp'} ] && ln -s {repo / 'packages/cli/src/main.ts'} {bin_dir / 'opencorp'}"
        f" && rm {bin_dir / 'ac'}"]


def test_instructions_swap_the_launcher_before_onboarding_then_list_the_notes(tmp_path):
    home = old_home(tmp_path)
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    wrapper = bin_dir / "ac"
    wrapper.write_text(f'#!/bin/bash\nexec bun {repo}/packages/ac/src/main.ts "$@"\n')
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir), "AGENT_CORP_HOME": "/x"}, repo)
    new = bin_dir / "opencorp"
    assert legacy.instructions(found, 501, repo) == (
        "\nTo finish moving to OpenCorp, run these in order:\n"
        f"  {MV(home)}\n"
        f"  [ ! -e {new} ] && sed 's#packages/ac/src/main.ts#packages/cli/src/main.ts#' {wrapper} > {new}"
        f" && chmod +x {new} && rm {wrapper}\n"
        "  opencorp onboard\n"
        "\nAGENT_CORP_HOME is set, but OpenCorp reads OPENCORP_HOME now; rename it where you set it\n")


def test_without_a_launcher_bun_runs_the_cli_to_onboard(tmp_path):
    home = old_home(tmp_path)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)
    assert found.commands(501, REPO) == [f"{MV(home)}", f"{BUN} onboard"]


def test_the_bun_line_names_the_bun_running_the_cli(tmp_path):
    old_home(tmp_path)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": "", legacy.BUN_ENV: "/u/.bun/bin/bun"}, REPO)
    assert found.commands(501, REPO)[-1] == f"/u/.bun/bin/bun {REPO / legacy.NEW_ENTRY} onboard"


def test_without_the_running_bun_the_bun_on_path_is_named(tmp_path):
    old_home(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "bun").write_text("#!/bin/sh\n")
    (bin_dir / "bun").chmod(0o755)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, REPO)
    assert found.commands(501, REPO)[-1] == f"{bin_dir / 'bun'} {REPO / legacy.NEW_ENTRY} onboard"


def test_this_checkouts_opencorp_already_on_path_onboards(tmp_path):
    old_home(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "opencorp").write_text(f'#!/bin/sh\nexec bun {REPO}/packages/cli/src/main.ts "$@"\n')
    (bin_dir / "opencorp").chmod(0o755)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, REPO)
    assert found.commands(501, REPO)[-1] == "opencorp onboard"


def test_an_opencorp_for_another_checkout_is_not_used_to_onboard(tmp_path):
    old_home(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "opencorp").write_text('#!/bin/sh\nexec bun /elsewhere/packages/cli/src/main.ts "$@"\n')
    (bin_dir / "opencorp").chmod(0o755)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, REPO)
    assert found.commands(501, REPO)[-1] == f"{BUN} onboard"


def test_an_office_at_another_home_is_onboarded_at_that_home(tmp_path):
    other = tmp_path / "work" / "office home"
    other.mkdir(parents=True)
    plist = old_plist(tmp_path, "office-1a2b3c4d", home=other)
    gone = old_plist(tmp_path, "office-5e6f7a8b", home=tmp_path / "deleted")
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO)
    assert found.commands(501, REPO) == [
        "launchctl bootout gui/501/com.agent-corp.office-1a2b3c4d", f"rm {plist}",
        "launchctl bootout gui/501/com.agent-corp.office-5e6f7a8b", f"rm {gone}",
        f"{BUN} onboard --home {shlex.quote(str(other))}"]


def test_a_unit_at_another_home_is_onboarded_at_that_home(tmp_path):
    other = tmp_path / "w"
    other.mkdir()
    unit = tmp_path / ".config" / "systemd" / "user" / "agent-corp-office-1a2b3c4d.service"
    unit.parent.mkdir(parents=True)
    unit.write_text(f"[Service]\nExecStart=/opt/opencorp/.venv/bin/python -m agent_corp.daemon.main --home {other}\n")
    found = legacy.find(make_host(tmp_path, Runner(), platform="linux"), {"PATH": ""}, REPO)
    assert found.commands(501, REPO)[-1] == f"{BUN} onboard --home {other}"


def test_the_move_leaves_a_new_home_that_appeared_since_alone(tmp_path):
    home = old_home(tmp_path)
    move = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO).commands(501, REPO)[0]
    (tmp_path / ".opencorp").mkdir()
    sh(move)
    assert home.is_dir() and not (tmp_path / ".opencorp" / ".agent-corp").exists()


def test_the_move_moves_the_old_home(tmp_path):
    home = old_home(tmp_path, "launchd")
    move = legacy.find(make_host(tmp_path, Runner()), {"PATH": ""}, REPO).commands(501, REPO)[0]
    assert sh(move).returncode == 0
    assert not home.exists() and (tmp_path / ".opencorp" / "office" / "install.json").is_file()


def ac_wrapper(bin_dir, repo):
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / "ac"
    wrapper.write_text(f'#!/bin/bash\nexec bun {repo}/packages/ac/src/main.ts "$@"\n')
    wrapper.chmod(0o755)
    return wrapper


def test_an_opencorp_next_to_the_ac_launcher_is_kept_and_only_ac_goes(tmp_path):
    repo = tmp_path / "repo"
    wrapper = ac_wrapper(tmp_path / "bin", repo)
    (tmp_path / "bin" / "opencorp").write_text(f'#!/bin/sh\nexec bun {repo}/packages/cli/src/main.ts "$@"\n')
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(tmp_path / "bin")}, repo)
    assert found.commands(501, repo) == [f"rm {wrapper}"]


def test_an_opencorp_for_another_checkout_next_to_ac_is_kept_and_bun_onboards(tmp_path):
    repo = tmp_path / "repo"
    old_home(tmp_path)
    wrapper = ac_wrapper(tmp_path / "bin", repo)
    (tmp_path / "bin" / "opencorp").write_text('#!/bin/sh\nexec bun /elsewhere/packages/cli/src/main.ts "$@"\n')
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(tmp_path / "bin")}, repo)
    assert found.commands(501, repo)[1:] == [f"rm {wrapper}", f"bun {repo / legacy.NEW_ENTRY} onboard"]


def test_the_printed_swap_works_with_a_hash_and_a_space_in_the_paths(tmp_path):
    repo = tmp_path / "re#po x"
    bin_dir = tmp_path / "b#in"
    wrapper = ac_wrapper(bin_dir, repo)
    found = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(bin_dir)}, repo)
    [swap] = found.commands(501, repo)
    done = sh(swap)
    assert done.returncode == 0, done.stderr
    assert not wrapper.exists()
    assert (bin_dir / "opencorp").read_text() == f'#!/bin/bash\nexec bun {repo}/packages/cli/src/main.ts "$@"\n'


def test_the_printed_swap_doesnt_overwrite_an_opencorp_made_since(tmp_path):
    repo = tmp_path / "repo"
    wrapper = ac_wrapper(tmp_path / "bin", repo)
    [swap] = legacy.find(make_host(tmp_path, Runner()), {"PATH": str(tmp_path / "bin")}, repo).commands(501, repo)
    (tmp_path / "bin" / "opencorp").write_text("mine\n")
    sh(swap)
    assert (tmp_path / "bin" / "opencorp").read_text() == "mine\n" and wrapper.exists()
