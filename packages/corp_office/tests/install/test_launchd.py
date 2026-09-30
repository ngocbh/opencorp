import plistlib
import shutil
import subprocess
from pathlib import Path

import pytest

from agent_corp.install import launchd
from agent_corp.install.launch import ServiceError, launch

from .conftest import GOLDEN, Runner, make_host

SERVICE = "gui/501/com.agent-corp.office"


def test_the_plist_matches_the_golden_file(owner_launch):
    assert launchd.plist(owner_launch) == (GOLDEN / "launchd.plist").read_bytes()


@pytest.mark.skipif(shutil.which("plutil") is None, reason="needs macOS plutil")
def test_the_golden_plist_is_one_launchd_accepts():
    subprocess.run(["plutil", "-lint", str(GOLDEN / "launchd.plist")], check=True, capture_output=True)


def test_xml_special_characters_and_newlines_survive_the_plist():
    odd = launch(Path("/Users/o <&> \"q\" 'a'\nb/.agent-corp"), repo=Path("/opt/a&b<c>"),
                 environ={"LANG": "<&>]]>"}, user_home=Path("/Users/o"))
    back = plistlib.loads(launchd.plist(odd))
    assert back["ProgramArguments"] == list(odd.argv) and back["WorkingDirectory"] == str(odd.cwd)
    assert back["EnvironmentVariables"] == {"LANG": "<&>]]>"}
    assert back["StandardOutPath"] == back["StandardErrorPath"] == str(odd.log)


def test_a_first_install_writes_the_plist_and_bootstraps_it(tmp_path, owner_launch):
    run = Runner([(["launchctl", "print"], 113, "Could not find service")])
    launchd.install(owner_launch, make_host(tmp_path, run))
    path = tmp_path / "Library" / "LaunchAgents" / "com.agent-corp.office.plist"
    assert path.read_bytes() == launchd.plist(owner_launch)
    assert run.calls == [["launchctl", "print", SERVICE],
                         ["launchctl", "bootstrap", "gui/501", str(path)]]


def test_an_unchanged_loaded_service_is_only_kickstarted(tmp_path, owner_launch):
    run = Runner()
    host = make_host(tmp_path, run)
    launchd.install(owner_launch, host)
    run.calls.clear()
    launchd.install(owner_launch, host)
    assert run.calls == [["launchctl", "print", SERVICE], ["launchctl", "kickstart", SERVICE]]


def test_a_changed_plist_replaces_the_loaded_service(tmp_path, owner_launch):
    path = tmp_path / "Library" / "LaunchAgents" / "com.agent-corp.office.plist"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"old")
    run = Runner()
    launchd.install(owner_launch, make_host(tmp_path, run))
    assert run.calls == [["launchctl", "print", SERVICE], ["launchctl", "bootout", SERVICE],
                         ["launchctl", "bootstrap", "gui/501", str(path)]]
    assert path.read_bytes() == launchd.plist(owner_launch)


def test_a_bootstrap_that_keeps_failing_removes_the_plist_and_says_why(tmp_path, owner_launch):
    run = Runner([(["launchctl", "print"], 113, ""),
                  (["launchctl", "bootstrap"], 5, "Bootstrap failed: 5: Input/output error")])
    with pytest.raises(ServiceError, match="Input/output error"):
        launchd.install(owner_launch, make_host(tmp_path, run))
    assert not (tmp_path / "Library" / "LaunchAgents" / "com.agent-corp.office.plist").exists()
    assert [c[1] for c in run.calls].count("bootstrap") == 3


def test_a_kickstart_that_fails_boots_out_and_removes_the_plist(tmp_path, owner_launch):
    host = make_host(tmp_path, Runner())
    launchd.install(owner_launch, host)
    run = Runner([(["launchctl", "kickstart"], 1, "Operation not permitted")])
    with pytest.raises(ServiceError, match="Operation not permitted"):
        launchd.install(owner_launch, make_host(tmp_path, run))
    assert run.calls[-1] == ["launchctl", "bootout", SERVICE]
    assert not (tmp_path / "Library" / "LaunchAgents" / "com.agent-corp.office.plist").exists()


def test_no_launchctl_is_a_service_error(tmp_path, owner_launch):
    run = Runner([(["launchctl"], 127, "No such file or directory: 'launchctl'")])
    with pytest.raises(ServiceError, match="launchctl"):
        launchd.install(owner_launch, make_host(tmp_path, run))


def test_start_kickstarts_the_loaded_agent(tmp_path, owner_launch):
    run = Runner()
    launchd.start(owner_launch, make_host(tmp_path, run))
    assert run.calls == [["launchctl", "kickstart", SERVICE]]
