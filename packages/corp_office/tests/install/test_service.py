import json
import socket
import time

import pytest

from agent_corp.install import service
from agent_corp.install.launch import Host, ServiceError, launch
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host


def recorded(launch):
    return json.loads((launch.office / "install.json").read_text())


@pytest.fixture
def one(tmp_path):
    return launch(tmp_path / "home", repo=tmp_path / "repo", environ={"PATH": "/usr/bin"}, user_home=tmp_path)


def test_a_mac_uses_launchd_when_it_works(tmp_path, one):
    run = Runner([(["launchctl", "print"], 113, "")])
    got = service.install(one, make_host(tmp_path, run))
    assert got == service.Installed("launchd", [])
    assert recorded(one) == {"mode": "launchd", "name": one.name}


def test_a_failing_launchctl_falls_back_to_tmux(tmp_path, one):
    run = Runner([(["launchctl", "print"], 113, ""), (["launchctl", "bootstrap"], 5, "Input/output error"),
                  (["tmux", "has-session"], 1, "")])
    got = service.install(one, make_host(tmp_path, run, which=lambda name: f"/usr/bin/{name}"))
    assert got.mode == "tmux" and "Input/output error" in got.notes[0]
    assert run.calls[-1][:2] == ["tmux", "new-session"]
    assert recorded(one)["mode"] == "tmux"


def test_a_loaded_agent_that_wont_kickstart_is_removed_before_falling_back(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner()))
    run = Runner([(["launchctl", "kickstart"], 1, "Operation not permitted"), (["tmux", "has-session"], 1, "")])
    got = service.install(one, make_host(tmp_path, run, which=lambda name: f"/usr/bin/{name}"))
    assert got.mode == "tmux" and "Operation not permitted" in got.notes[0]
    assert ["launchctl", "bootout", f"gui/501/com.agent-corp.{one.name}"] in run.calls
    assert not list((tmp_path / "Library" / "LaunchAgents").iterdir())


def test_linux_without_a_user_bus_or_tmux_runs_it_in_the_background(tmp_path, one):
    started = []
    run = Runner([(["systemctl"], 1, "Failed to connect to bus")])
    got = service.install(one, make_host(tmp_path, run, platform="linux", popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and "Failed to connect to bus" in got.notes[0]
    assert started == [list(one.argv)]


def test_a_chosen_mode_that_fails_is_an_error_not_a_fallback(tmp_path, one):
    run = Runner([(["systemctl"], 1, "Failed to connect to bus")])
    with pytest.raises(ServiceError, match="Failed to connect to bus"):
        service.install(one, make_host(tmp_path, run, platform="linux"), mode="systemd")
    assert not (one.office / "install.json").exists()


def test_a_running_office_keeps_its_recorded_service(tmp_path, one):
    run = Runner([(["launchctl", "print"], 113, "")])
    service.install(one, make_host(tmp_path, run))
    again = Runner()
    got = service.install(one, make_host(tmp_path, again, answers=lambda s: True, which=lambda n: "/usr/bin/tmux"))
    assert got == service.Installed("launchd", [])
    assert again.calls[0][:2] == ["launchctl", "print"]  # the plist is still brought up to date


def test_a_running_office_in_tmux_or_the_background_is_not_started_twice(tmp_path, one):
    started = []
    host = make_host(tmp_path, Runner(), popen=lambda argv, **kw: started.append(argv))
    service.install(one, host, mode="background")
    running = make_host(tmp_path, Runner(), popen=lambda argv, **kw: started.append(argv), answers=lambda s: True)
    assert service.install(one, running) == service.Installed("background", [])
    assert started == [list(one.argv)]


def test_a_running_office_is_not_moved_to_another_service(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner([(["tmux", "has-session"], 1, "")])), mode="tmux")
    with pytest.raises(ServiceError, match="already running under tmux"):
        service.install(one, make_host(tmp_path, Runner(), answers=lambda s: True), mode="launchd")


def test_an_office_started_by_hand_is_left_running_and_no_service_is_installed(tmp_path, one):
    run = Runner()
    got = service.install(one, make_host(tmp_path, run, answers=lambda s: True))
    assert got.mode is None and "not started by a service" in got.notes[0]
    assert run.calls == [] and not (one.office / "install.json").exists()


def test_start_uses_the_recorded_service(tmp_path, one):
    run = Runner([(["systemctl", "--user", "start"], 0, "")])
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    assert service.start(one, make_host(tmp_path, run, platform="linux")) == service.Installed("systemd", [])
    assert run.calls == [["systemctl", "--user", "start", f"agent-corp-{one.name}.service"]]


def test_start_falls_back_to_the_background_when_the_service_wont_start(tmp_path, one):
    started = []
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    run = Runner([(["systemctl"], 1, "Unit is masked")])
    got = service.start(one, make_host(tmp_path, run, platform="linux", popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and "Unit is masked" in got.notes[0] and started == [list(one.argv)]


def test_start_without_an_install_runs_it_in_the_background(tmp_path, one):
    started = []
    got = service.start(one, make_host(tmp_path, Runner(), popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and started == [list(one.argv)]


def test_waiting_for_an_office_that_never_answers_shows_the_log(tmp_path, one):
    one.office.mkdir(parents=True)
    one.log.write_text("".join(f"line {i}\n" for i in range(30)) + "agent-corp office: no company repo\n")
    with pytest.raises(ServiceError, match="(?s)did not answer.*line 29\nagent-corp office: no company repo") as info:
        service.wait(one, make_host(tmp_path, Runner()), timeout=1)
    assert "line 9\n" not in str(info.value)


def test_waiting_on_an_office_that_accepts_but_never_answers_stops_at_the_deadline(short_dir):
    one = launch(short_dir, repo=short_dir, environ={})
    one.office.mkdir()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as hung:
        hung.bind(str(one.socket))
        hung.listen(8)  # the kernel accepts connections; nothing ever reads or answers
        began = time.monotonic()
        with pytest.raises(ServiceError, match="did not answer"):
            service.wait(one, Host(run=Runner()), timeout=0.5)
        assert time.monotonic() - began < 1.5


def test_a_broken_record_counts_as_no_record(tmp_path, one):
    one.office.mkdir(parents=True)
    for text in ("not json", "[]", '{"mode": "cron"}'):
        (one.office / "install.json").write_text(text)
        assert service.recorded_mode(one) is None
