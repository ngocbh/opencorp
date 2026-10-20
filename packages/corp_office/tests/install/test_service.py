import json
import os
import socket
import subprocess
import time

import psutil
import pytest

from opencorp.install import fallback, launchd, service, systemd
from opencorp.install.launch import Host, ServiceError, launch, office_answers
from tests.daemon.conftest import short_dir  # noqa: F401

from .conftest import Runner, make_host, no_web_port


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
    assert ["launchctl", "bootout", f"gui/501/com.opencorp.{one.name}"] in run.calls
    assert not list((tmp_path / "Library" / "LaunchAgents").iterdir())


@pytest.mark.parametrize(("platform", "where"), [("darwin", "Library/LaunchAgents"), ("linux", ".config/systemd/user")])
def test_a_service_file_that_cant_be_written_falls_back_to_tmux(tmp_path, one, platform, where):
    locked = tmp_path / where
    locked.mkdir(parents=True)
    locked.chmod(0o500)
    run = Runner([(["launchctl", "print"], 113, ""), (["tmux", "has-session"], 1, "")])
    got = service.install(one, make_host(tmp_path, run, platform=platform, which=lambda name: f"/usr/bin/{name}"))
    assert got.mode == "tmux" and "can't write" in got.notes[0] and "Permission denied" in got.notes[0]
    assert recorded(one)["mode"] == "tmux"


def test_linux_without_a_user_bus_or_tmux_runs_it_in_the_background(tmp_path, one):
    started = []
    run = Runner([(["systemctl"], 1, "Failed to connect to bus")])
    got = service.install(one, make_host(tmp_path, run, platform="linux", popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and "Failed to connect to bus" in got.notes[0]
    assert started == [list(one.argv)]


def test_a_newline_in_the_home_falls_back_from_systemd_to_tmux(tmp_path):
    odd = launch(tmp_path / "a\nb", repo=tmp_path / "repo", environ={"PATH": "/usr/bin"}, user_home=tmp_path)
    run = Runner([(["tmux", "has-session"], 1, "")])
    got = service.install(odd, make_host(tmp_path, run, platform="linux", which=lambda name: f"/usr/bin/{name}"))
    assert got.mode == "tmux" and "newline" in got.notes[0]
    assert [c[:2] for c in run.calls] == [["tmux", "has-session"], ["tmux", "new-session"]]


def test_a_chosen_mode_that_fails_is_an_error_not_a_fallback(tmp_path, one):
    run = Runner([(["systemctl"], 1, "Failed to connect to bus")])
    with pytest.raises(ServiceError, match="Failed to connect to bus"):
        service.install(one, make_host(tmp_path, run, platform="linux"), mode="systemd")
    assert not (one.office / "install.json").exists()


def test_a_running_office_under_launchd_is_only_checked_not_reinstalled(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner([(["launchctl", "print"], 113, "")])))
    plist = tmp_path / "Library" / "LaunchAgents" / f"com.opencorp.{one.name}.plist"
    before = plist.read_bytes()
    moved = launch(one.home, repo=one.cwd, environ={"PATH": "/opt/bin", "LC_CTYPE": "C"}, user_home=tmp_path)
    again = Runner()
    got = service.install(moved, make_host(tmp_path, again, answers=lambda s: True, which=lambda n: "/usr/bin/tmux"))
    assert got == service.Installed("launchd", [])
    assert again.calls == [["launchctl", "print", f"gui/501/com.opencorp.{one.name}"]]
    assert plist.read_bytes() == before


def test_a_running_office_under_systemd_is_only_checked_not_restarted(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    unit = tmp_path / ".config" / "systemd" / "user" / f"opencorp-{one.name}.service"
    before = unit.read_text()
    moved = launch(one.home, repo=one.cwd, environ={"PATH": "/opt/bin"}, user_home=tmp_path)
    again = Runner()
    got = service.install(moved, make_host(tmp_path, again, platform="linux", answers=lambda s: True))
    assert got == service.Installed("systemd", [])
    assert again.calls == [["systemctl", "--user", "is-enabled", f"opencorp-{one.name}.service"]]
    assert unit.read_text() == before


def test_a_running_office_its_service_manager_lost_is_an_error(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    run = Runner([(["systemctl", "--user", "is-enabled"], 1, "Failed to get unit file state: No such file")])
    with pytest.raises(ServiceError, match="(?s)No such file.*stop the office"):
        service.install(one, make_host(tmp_path, run, platform="linux", answers=lambda s: True))


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
    assert run.calls == [["systemctl", "--user", "start", f"opencorp-{one.name}.service"]]


def test_start_falls_back_to_the_background_when_the_service_wont_start(tmp_path, one):
    started = []
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    run = Runner([(["systemctl"], 1, "Unit is masked")])
    got = service.start(one, make_host(tmp_path, run, platform="linux", popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and "Unit is masked" in got.notes[0] and started == [list(one.argv)]
    assert recorded(one)["mode"] == "background"  # so the doctor doesn't call it a managed service


def test_start_removes_a_launch_agent_that_wont_kickstart_before_falling_back(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner()))
    run = Runner([(["launchctl", "kickstart"], 1, "Operation not permitted")])
    got = service.start(one, make_host(tmp_path, run, popen=lambda argv, **kw: None))
    assert got.mode == "background" and "Operation not permitted" in got.notes[0]
    # Left loaded, RunAtLoad would start it under launchd at the next login while the record says background.
    assert ["launchctl", "bootout", f"gui/501/com.opencorp.{one.name}"] in run.calls
    assert not list((tmp_path / "Library" / "LaunchAgents").iterdir())
    assert recorded(one)["mode"] == "background"


def test_start_removes_a_systemd_unit_that_wont_start_before_falling_back(tmp_path, one):
    service.install(one, make_host(tmp_path, Runner(), platform="linux"))
    units = tmp_path / ".config" / "systemd" / "user"
    name = f"opencorp-{one.name}.service"
    (units / "default.target.wants").mkdir()
    (units / "default.target.wants" / name).symlink_to(units / name)  # what `systemctl enable` makes
    run = Runner([(["systemctl", "--user", "start"], 1, "Unit is masked")])
    got = service.start(one, make_host(tmp_path, run, platform="linux", popen=lambda argv, **kw: None))
    assert got.mode == "background" and "Unit is masked" in got.notes[0]
    # Left enabled, it would start under systemd at the next login while the record says background.
    assert not (units / name).exists() and not os.path.lexists(units / "default.target.wants" / name)
    assert recorded(one)["mode"] == "background"


def test_start_without_an_install_runs_it_in_the_background(tmp_path, one):
    started = []
    got = service.start(one, make_host(tmp_path, Runner(), popen=lambda argv, **kw: started.append(argv)))
    assert got.mode == "background" and started == [list(one.argv)]
    assert recorded(one)["mode"] == "background"


def test_waiting_for_an_office_that_never_answers_shows_the_log(tmp_path, one):
    one.office.mkdir(parents=True)
    one.log.write_text("".join(f"line {i}\n" for i in range(30)) + "opencorp office: no company repo\n")
    with pytest.raises(ServiceError, match="(?s)did not answer.*line 29\nopencorp office: no company repo") as info:
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


def installed_as(launch, mode):
    launch.office.mkdir(parents=True, exist_ok=True)
    (launch.office / "install.json").write_text(json.dumps({"mode": mode, "name": launch.name}))


def test_uninstalling_a_launchd_office_boots_it_out_and_removes_its_plist(tmp_path, one):
    installed_as(one, "launchd")
    host = make_host(tmp_path, run := Runner())
    plist = launchd.plist_path(one, host)
    plist.parent.mkdir(parents=True)
    plist.write_bytes(launchd.plist(one))
    done = service.uninstall(one, host)
    assert run.calls == [["launchctl", "bootout", f"gui/501/{launchd.label(one)}"]]
    assert not plist.exists() and not (one.office / "install.json").exists()
    assert done == [f"launchd: booted out {launchd.label(one)} and removed {plist}"]


def test_uninstalling_a_launchd_office_that_isnt_loaded_still_removes_its_plist(tmp_path, one):
    installed_as(one, "launchd")
    host = make_host(tmp_path, Runner([(["launchctl", "bootout"], 3, "Boot-out failed: 3: No such process")]))
    plist = launchd.plist_path(one, host)
    plist.parent.mkdir(parents=True)
    plist.write_bytes(launchd.plist(one))
    service.uninstall(one, host)
    assert not plist.exists()


def test_a_recorded_launchd_office_without_its_plist_is_still_booted_out(tmp_path, one):
    installed_as(one, "launchd")
    service.uninstall(one, make_host(tmp_path, run := Runner()))
    assert run.calls == [["launchctl", "bootout", f"gui/501/{launchd.label(one)}"]]


def test_uninstalling_a_systemd_office_disables_and_stops_it_and_removes_its_unit(tmp_path, one):
    installed_as(one, "systemd")
    host = make_host(tmp_path, run := Runner(), platform="linux")
    unit = systemd.unit_path(one, host)
    wants = unit.parent / "default.target.wants" / systemd.unit_name(one)
    wants.parent.mkdir(parents=True)
    unit.write_text(systemd.unit(one))
    wants.symlink_to(unit)
    done = service.uninstall(one, host)
    assert run.calls == [["systemctl", "--user", "disable", "--now", systemd.unit_name(one)],
                         ["systemctl", "--user", "daemon-reload"]]
    assert not unit.exists() and not wants.is_symlink()
    assert done == [f"systemd: disabled and stopped {systemd.unit_name(one)} and removed {unit}"]


def test_uninstalling_a_tmux_office_kills_its_session(tmp_path, one):
    installed_as(one, "tmux")
    host = make_host(tmp_path, run := Runner(), which=lambda name: f"/usr/bin/{name}")
    done = service.uninstall(one, host)
    session = fallback.session(one)
    assert run.calls == [["tmux", "has-session", "-t", f"={session}"], ["tmux", "kill-session", "-t", f"={session}"]]
    assert done == [f"tmux: killed the session {session}"]


def test_a_tmux_office_whose_session_is_gone_has_nothing_to_kill(tmp_path, one):
    installed_as(one, "tmux")
    run = Runner([(["tmux", "has-session"], 1, "can't find session")])
    assert service.uninstall(one, make_host(tmp_path, run, which=lambda name: f"/usr/bin/{name}")) == []
    assert run.calls == [["tmux", "has-session", "-t", f"={fallback.session(one)}"]]


def test_uninstalling_removes_another_managers_leftover_file_too(tmp_path, one):
    # `opencorp start` records "background" when launchd won't start, but the plist stays behind.
    installed_as(one, "background")
    host = make_host(tmp_path, run := Runner())
    plist = launchd.plist_path(one, host)
    plist.parent.mkdir(parents=True)
    plist.write_bytes(launchd.plist(one))
    service.uninstall(one, host)
    assert not plist.exists() and run.calls[0][:2] == ["launchctl", "bootout"]


def test_uninstalling_nothing_runs_nothing(tmp_path, one):
    run = Runner()
    assert service.uninstall(one, make_host(tmp_path, run)) == []
    assert run.calls == []


def test_uninstalling_a_background_office_stops_its_daemon(short_dir):
    from .test_onboard import company

    home = short_dir / "home"
    company(home)
    no_web_port(home)
    run = launch(home)
    host = make_host(short_dir, Runner(), popen=subprocess.Popen, answers=office_answers)
    service.install(run, host, "background")
    service.wait(run, Host())
    pid = int((run.office / "office.pid").read_text())
    done = service.uninstall(run, host)
    assert done == [f"background: stopped the office (pid {pid})"]
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    assert not office_answers(run.socket)
    assert service.uninstall(run, host) == []


def test_a_pidfile_naming_some_other_process_is_left_alone(tmp_path, one):
    installed_as(one, "background")
    (one.office / "office.pid").write_text(f"{os.getpid()}\n")
    assert service.uninstall(one, make_host(tmp_path, Runner())) == []


def test_an_office_that_still_answers_after_uninstalling_is_an_error(tmp_path, one):
    with pytest.raises(ServiceError, match="still answers"):
        service.uninstall(one, make_host(tmp_path, Runner(), answers=lambda socket: True))


def test_restarting_a_background_office_runs_a_new_daemon(short_dir):
    from .test_onboard import company

    home = short_dir / "home"
    company(home)
    no_web_port(home)
    run = launch(home)
    host = make_host(short_dir, Runner(), popen=subprocess.Popen, answers=office_answers)
    service.install(run, host, "background")
    service.wait(run, Host())
    old = int((run.office / "office.pid").read_text())
    try:
        assert service.restart(run, Host(popen=subprocess.Popen)).mode == "background"
        service.wait(run, Host())
        new = int((run.office / "office.pid").read_text())
        assert new != old and office_answers(run.socket)
        assert not psutil.pid_exists(old) or psutil.Process(old).status() == psutil.STATUS_ZOMBIE
    finally:
        service.uninstall(run, host)


def answers_once_started(run: Runner):
    """An office that answers only after a start command ran, so its old daemon counts as stopped."""
    starts = (["launchctl", "kickstart"], ["systemctl", "--user"], ["tmux", "new-session"])
    return lambda socket: any(argv[:2] in starts for argv in run.calls)


def test_restarting_a_launchd_office_kickstarts_its_agent(tmp_path, one):
    installed_as(one, "launchd")
    run = Runner()
    assert service.restart(one, make_host(tmp_path, run, answers=answers_once_started(run))).mode == "launchd"
    assert run.calls == [["launchctl", "kickstart", f"gui/501/{launchd.label(one)}"]]


def test_restarting_a_systemd_office_starts_its_unit(tmp_path, one):
    installed_as(one, "systemd")
    run = Runner()
    host = make_host(tmp_path, run, platform="linux", answers=answers_once_started(run))
    assert service.restart(one, host).mode == "systemd"
    assert run.calls == [["systemctl", "--user", "start", systemd.unit_name(one)]]


def test_restarting_a_tmux_office_kills_a_lingering_session_before_starting_a_new_one(tmp_path, one):
    installed_as(one, "tmux")
    run = Runner([(["tmux", "has-session"], 0, "")])

    def runner(argv):
        if argv[:2] == ["tmux", "kill-session"]:
            run.answers[:] = [(["tmux", "has-session"], 1, "can't find session")]
        return run(argv)

    host = make_host(tmp_path, runner, which=lambda name: f"/usr/bin/{name}", answers=answers_once_started(run))
    assert service.restart(one, host).mode == "tmux"
    assert [argv[:2] for argv in run.calls] == [["tmux", "has-session"], ["tmux", "kill-session"],
                                                 ["tmux", "has-session"], ["tmux", "new-session"]]


def test_restarting_an_office_that_wont_stop_is_an_error_and_starts_nothing(tmp_path, one):
    installed_as(one, "launchd")
    run = Runner()
    with pytest.raises(ServiceError, match="still answers"):
        service.restart(one, make_host(tmp_path, run, answers=lambda socket: True))
    assert run.calls == []
