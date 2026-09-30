import subprocess
from pathlib import Path

import pytest

from agent_corp.install import systemd
from agent_corp.install.launch import ServiceError, launch

from .conftest import GOLDEN, Runner, make_host

UNIT = "agent-corp-office.service"


def test_the_unit_matches_the_golden_file(owner_launch):
    assert systemd.unit(owner_launch) == (GOLDEN / "systemd.service").read_text()


def test_spaces_percents_and_dollars_reach_the_daemon_unchanged():
    odd = launch(Path("/Users/o w/100%/$HOME/.agent-corp"), repo=Path("/opt/a c"),
                 environ={"LANG": 'say "hi"'}, user_home=Path("/Users/o w"))
    text = systemd.unit(odd)
    assert ('ExecStart="/opt/a c/.venv/bin/python" -m agent_corp.daemon.main'
            ' --home "/Users/o w/100%%/$$HOME/.agent-corp"\n') in text
    assert 'Environment="LANG=say \\"hi\\""\n' in text
    assert "WorkingDirectory=/opt/a c\n" in text


def test_a_newline_in_a_value_is_refused():
    with pytest.raises(ValueError, match="newline"):
        systemd.unit(launch(Path("/tmp/a\nb"), repo=Path("/opt/a"), environ={}, user_home=Path("/home/o")))


def test_installing_a_path_with_a_newline_is_a_service_error_and_writes_nothing(tmp_path):
    odd = launch(Path("/tmp/a\nb"), repo=Path("/opt/a"), environ={}, user_home=Path("/home/o"))
    run = Runner()
    with pytest.raises(ServiceError, match="newline"):
        systemd.install(odd, make_host(tmp_path, run, platform="linux"))
    assert run.calls == [] and not (tmp_path / ".config").exists()


def test_a_first_install_writes_enables_and_starts_the_unit(tmp_path, owner_launch):
    run = Runner()
    systemd.install(owner_launch, make_host(tmp_path, run, platform="linux"))
    path = tmp_path / ".config" / "systemd" / "user" / UNIT
    assert path.read_text() == systemd.unit(owner_launch)
    assert run.calls == [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", UNIT],
                         ["systemctl", "--user", "restart", UNIT]]


def test_an_unchanged_unit_is_only_started(tmp_path, owner_launch):
    run = Runner()
    host = make_host(tmp_path, run, platform="linux")
    systemd.install(owner_launch, host)
    run.calls.clear()
    systemd.install(owner_launch, host)
    assert run.calls == [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", UNIT],
                         ["systemctl", "--user", "start", UNIT]]


def test_no_user_bus_removes_the_unit_and_says_why(tmp_path, owner_launch):
    run = Runner([(["systemctl", "--user", "daemon-reload"], 1, "Failed to connect to bus: No medium found")])
    with pytest.raises(ServiceError, match="Failed to connect to bus"):
        systemd.install(owner_launch, make_host(tmp_path, run, platform="linux"))
    assert not (tmp_path / ".config" / "systemd" / "user" / UNIT).exists()


def test_a_failed_start_removes_the_unit_and_its_wants_link(tmp_path, owner_launch):
    user = tmp_path / ".config" / "systemd" / "user"
    wants = user / "default.target.wants" / UNIT

    def enable_then_fail(argv):
        if argv[2] == "enable":
            wants.parent.mkdir(parents=True, exist_ok=True)
            wants.symlink_to(user / UNIT)
        return subprocess.CompletedProcess(argv, 1 if argv[2] == "restart" else 0, "", "Job failed")

    with pytest.raises(ServiceError, match="restart"):
        systemd.install(owner_launch, make_host(tmp_path, enable_then_fail, platform="linux"))
    assert not (user / UNIT).exists() and not wants.is_symlink()


def test_start_starts_the_unit(tmp_path, owner_launch):
    run = Runner([(["systemctl"], 1, "Unit is masked")])
    with pytest.raises(ServiceError, match="Unit is masked"):
        systemd.start(owner_launch, make_host(tmp_path, run, platform="linux"))
    assert run.calls == [["systemctl", "--user", "start", UNIT]]
