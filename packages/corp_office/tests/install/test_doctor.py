import asyncio
import json
import os
import subprocess
import time

import httpx
import psutil

from opencorp.chat.connections import ConnectionFile, Connections
from opencorp.company_template import Owner, write_company
from opencorp.daemon.app import OfficePaths
from opencorp.install import doctor, launchd, legacy, systemd
from opencorp.install.doctor import Check, codex_check
from opencorp.install.launch import Launch, launch
from opencorp.install.onboard import SET_UP, write_private
from opencorp.profile.debrief import DEBRIEF_FLOW
from opencorp.worker.spawn import INHERITED_ENV
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import company, office, profile_stores, short_dir  # noqa: F401

from .conftest import Runner, make_host

KEY = "sk-ant-test-0123456789"


def onboarded(tmp_path, provider=None, mode="launchd"):
    paths = OfficePaths(tmp_path / "home")
    paths.office.mkdir(parents=True, mode=0o700)
    paths.home.chmod(0o700)
    write_company(paths.company, paths.worktrees, company="Acme", owner=Owner("ngocbh", "Ngoc"))
    if provider is not None:
        write_private(paths.office / "provider.json", json.dumps(provider).encode())
    (paths.office / "install.json").write_text(json.dumps({"mode": mode, "name": "x"}))
    return paths


def by_name(checks):
    return {c.name: c for c in checks}


def run_checks(tmp_path, paths, runner=None, answers=False, probe=lambda: None, platform="darwin"):
    host = make_host(tmp_path, runner or Runner(), answers=lambda s: answers, platform=platform)
    return doctor.checks(paths.home, host=host, repo=tmp_path / "repo", probe=probe,
                         codex=lambda env, environ, mode: Check("codex", "ok", "stand-in"), environ={},
                         hq=lambda socket, home: "unreachable")


def test_a_company_without_a_first_commit_is_told_to_onboard(tmp_path):
    paths = OfficePaths(tmp_path / "home")
    paths.company.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(paths.company)], check=True)
    (paths.company / "company.yaml").write_text('name: "Acme"\nceo: "me"\n')
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"] == Check("company", "fail", f"{paths.company} has no company yet (no company.yaml, or no"
                                   " first commit); run `opencorp init` to finish it")


def test_a_fresh_machine_is_told_to_onboard(tmp_path):
    got = by_name(run_checks(tmp_path, OfficePaths(tmp_path / "home")))
    assert got["home"] == Check("home", "fail", f"no office home at {tmp_path / 'home'}; {SET_UP}")
    assert got["company"] == Check("company", "fail", f"no company repo at {tmp_path / 'home' / 'company'}; {SET_UP}")
    assert doctor.exit_code(got.values()) == 1


def test_an_onboarded_office_that_isnt_running_is_only_a_warning(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "openai"}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "ok" and got["provider"] == Check("provider", "ok", "openai, yian's own login")
    label = launchd.label(launch(paths.home, user_home=tmp_path))
    assert got["service"] == Check("service", "ok", f"launchd: {label} is loaded")
    assert got["home"] == Check("home", "ok", str(paths.home))
    assert got["office"].status == "warn" and "not answering" in got["office"].detail
    assert "Run `opencorp start`." in got["office"].detail
    assert f"`launchctl print gui/501/{label}` shows its status" in got["office"].detail
    assert got["sandbox"] == Check("sandbox", "ok", "sandboxed commands run")
    assert doctor.exit_code(got.values()) == 0


def test_a_home_others_can_read_warns(tmp_path):
    paths = onboarded(tmp_path)
    paths.home.chmod(0o755)
    got = by_name(run_checks(tmp_path, paths))
    assert got["home"].status == "warn" and "0755, not 0700" in got["home"].detail


def test_a_stopped_systemd_office_names_the_next_step_and_the_unit(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    got = by_name(run_checks(tmp_path, paths, Runner([(["loginctl"], 0, "", "Linger=yes\n")]), platform="linux"))
    assert "Run `opencorp start`." in got["office"].detail
    assert f"`systemctl --user status {unit}` shows its status" in got["office"].detail


def test_a_disabled_systemd_unit_shows_what_systemctl_said(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    run = Runner([(["systemctl", "--user", "is-enabled"], 1, "Failed to connect to bus: No medium found")])
    got = by_name(run_checks(tmp_path, paths, run, platform="linux"))
    assert got["service"].status == "fail" and "Failed to connect to bus: No medium found" in got["service"].detail


def test_lint_errors_fail(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / "company.yaml").write_text("name: Acme\nceo: nobody\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "fail" and "company.unknown_ceo" in got["company"].detail


def test_a_company_missing_template_files_is_told_to_onboard_again(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / DEBRIEF_FLOW).unlink()
    got = by_name(run_checks(tmp_path, paths))
    assert got["company"].status == "warn"
    assert DEBRIEF_FLOW in got["company"].detail and "`opencorp onboard` adds" in got["company"].detail


def test_a_running_office_missing_template_files_is_told_to_stop_first(tmp_path):
    paths = onboarded(tmp_path)
    (paths.company / DEBRIEF_FLOW).unlink()
    got = by_name(run_checks(tmp_path, paths, answers=True))
    assert got["company"].status == "warn" and DEBRIEF_FLOW in got["company"].detail
    assert "The office is running; stop it and run `opencorp onboard` again to add 1 template file." in got["company"].detail


def test_a_provider_others_can_read_fails_without_showing_it(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    (paths.office / "provider.json").chmod(0o644)
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"].status == "fail" and "0600" in got["provider"].detail
    assert all(KEY not in c.detail for c in got.values())


def test_connections_others_can_read_fail_without_showing_them(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    assert "connections" not in by_name(run_checks(tmp_path, paths))  # none added
    Connections(paths.office).put("second", ConnectionFile(llm_config={"provider": "anthropic", "api_key": KEY}))
    folder = paths.office / "connections"
    assert by_name(run_checks(tmp_path, paths))["connections"] == Check("connections", "ok", f"{folder} is private")
    (folder / "second.json").chmod(0o640)
    got = by_name(run_checks(tmp_path, paths))
    assert got["connections"] == Check("connections", "fail",
                                       f"second.json in {folder} must be private to its owner (mode 0600)")
    folder.chmod(0o750)
    got = by_name(run_checks(tmp_path, paths))
    assert got["connections"] == Check("connections", "fail", f"{folder} is mode 0750, not 0700")
    assert all(KEY not in c.detail for c in got.values())


def test_connections_that_is_not_a_directory_fails_with_what_it_is(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    folder = paths.office / "connections"
    folder.write_text("")
    assert by_name(run_checks(tmp_path, paths))["connections"] == Check("connections", "fail",
                                                                        f"{folder} is not a directory")
    folder.unlink()
    (tmp_path / "elsewhere").mkdir(mode=0o700)
    folder.symlink_to(tmp_path / "elsewhere")
    assert by_name(run_checks(tmp_path, paths))["connections"] == Check(
        "connections", "fail", f"{folder} must be a directory, not a symlink")


def test_a_connection_removed_during_the_check_is_skipped(tmp_path, monkeypatch):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    Connections(paths.office).put("second", ConnectionFile(llm_config={"provider": "anthropic", "api_key": KEY}))
    folder = paths.office / "connections"
    lstat = os.lstat

    def vanished(path, *args, **kwargs):
        if str(path).endswith("second.json"):
            raise FileNotFoundError(2, "No such file or directory", str(path))
        return lstat(path, *args, **kwargs)

    monkeypatch.setattr(os, "lstat", vanished)
    assert by_name(run_checks(tmp_path, paths))["connections"] == Check("connections", "ok", f"{folder} is private")


def test_a_provider_composer_wont_take_fails_without_showing_the_key(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY, KEY: 1}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"].status == "fail" and "extra field" in got["provider"].detail
    assert all(KEY not in c.detail for c in got.values())


def test_a_saved_key_is_reported_but_not_shown(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY, "model": "claude-x"}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"] == Check("provider", "ok", "anthropic, key saved")


def test_a_key_with_no_model_warns_and_names_the_model_onboard_saves(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "anthropic", "api_key": KEY}})
    got = by_name(run_checks(tmp_path, paths))
    assert got["provider"] == Check("provider", "warn", "anthropic, key saved, but no model, so runs fail;"
                                                        " `opencorp onboard` saves claude-sonnet-4-5")
    assert all(KEY not in c.detail for c in got.values())


def test_a_key_for_an_endpoint_of_your_own_with_no_model_fails(tmp_path):
    paths = onboarded(tmp_path, {"llm_config": {"provider": "openai", "base_url": "https://llm.example/v1",
                                                "api_key": KEY}})
    got = by_name(run_checks(tmp_path, paths))
    path = paths.office / "provider.json"
    assert got["provider"] == Check("provider", "fail", f"{path}: llm_config.model is missing, and an endpoint of"
                                                        " your own has no default model; run `opencorp onboard`")
    assert all(KEY not in c.detail for c in got.values())


def test_an_unloaded_launch_agent_fails(tmp_path):
    paths = onboarded(tmp_path)
    got = by_name(run_checks(tmp_path, paths, Runner([(["launchctl", "print"], 113, "")])))
    assert got["service"].status == "fail" and "run `opencorp onboard`" in got["service"].detail


def test_a_systemd_service_without_linger_warns_that_it_stops_at_logout(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    run = Runner([(["loginctl"], 0, "", "Linger=no\n")])
    got = by_name(run_checks(tmp_path, paths, run, platform="linux"))
    assert got["service"].status == "warn" and "loginctl enable-linger" in got["service"].detail
    assert unit in got["service"].detail
    assert ["loginctl", "show-user", "501", "--property=Linger"] in run.calls


def test_a_systemd_service_with_linger_is_ok(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    unit = systemd.unit_name(launch(paths.home, user_home=tmp_path))
    got = by_name(run_checks(tmp_path, paths, Runner([(["loginctl"], 0, "", "Linger=yes\n")]), platform="linux"))
    assert got["service"] == Check("service", "ok", f"systemd: {unit} is enabled")


def test_an_office_that_keeps_failing_to_start_is_a_crash_loop(tmp_path):
    paths = onboarded(tmp_path)
    (paths.office / "office.log").write_text("starting\nopencorp office: the company repo has no .git\n\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["office"].status == "fail"
    assert "opencorp office: the company repo has no .git" in got["office"].detail
    assert "Run `opencorp start`." in got["office"].detail


def test_an_office_that_crashed_with_a_traceback_fails(tmp_path):
    paths = onboarded(tmp_path)
    (paths.office / "office.log").write_text("Traceback (most recent call last):\n  File \"x\"\nKeyError: 'boom'\n")
    got = by_name(run_checks(tmp_path, paths))
    assert got["office"].status == "fail" and "KeyError: 'boom'" in got["office"].detail


def test_a_sandbox_that_cant_start_fails(tmp_path):
    got = by_name(run_checks(tmp_path, onboarded(tmp_path), probe=lambda: "sandbox-exec: Operation not permitted"))
    assert got["sandbox"] == Check("sandbox", "fail", "sandbox-exec: Operation not permitted")


def test_an_office_older_than_the_code_is_told_to_restart(tmp_path):
    me = psutil.Process()
    this = Launch(argv=tuple(me.cmdline()), env={}, cwd=tmp_path, home=tmp_path, name="office")
    assert doctor.version_check(this, os.getpid(), newest=time.time() + 60).status == "warn"
    assert doctor.version_check(this, os.getpid(), newest=0).status == "ok"
    other = Launch(argv=("/x/python", "-m", "opencorp.daemon.main"), env={}, cwd=tmp_path, home=tmp_path, name="o")
    assert "not this office's daemon" in doctor.version_check(other, os.getpid(), newest=0).detail


def test_the_newest_source_covers_the_office_and_composer(tmp_path):
    office = tmp_path / "packages/corp_office/src/opencorp/x.py"
    composer = tmp_path / "packages/yian/src/yian/y.py"
    for path, when in ((office, 100), (composer, 200)):
        path.parent.mkdir(parents=True)
        path.write_text("")
        os.utime(path, (when, when))
    assert doctor.newest_source(tmp_path) == 200


def _codex(tmp_path, login_exit, login_err=None, login_out=""):
    """A fake codex on a PATH; ``login status`` prints what real Codex does (on stderr) unless told otherwise."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    if login_err is None:
        login_err = "Logged in using ChatGPT\n" if login_exit == 0 else "Not logged in\n"
    (tmp_path / "login.err").write_text(login_err)
    (tmp_path / "login.out").write_text(login_out)
    (bin_dir / "codex").write_text(
        f'#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.130.0";;\n'
        f'login) cat "{tmp_path}/login.out"; cat "{tmp_path}/login.err" >&2; exit {login_exit};; esac\n')
    (bin_dir / "codex").chmod(0o755)
    return {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path)}


def test_codex_on_the_office_path_and_signed_in_is_ok(tmp_path):
    check = codex_check(_codex(tmp_path, 0), {})
    assert check.status == "ok" and "codex-cli 0.130.0" in check.detail


def test_codex_signed_out_or_missing_is_a_warning(tmp_path):
    signed_out = codex_check(_codex(tmp_path, 1), {})
    codex = tmp_path / "bin" / "codex"
    assert signed_out == Check("codex", "warn", f"codex-cli 0.130.0 at {codex} is signed out; run `{codex} login`")
    missing = codex_check({"PATH": str(tmp_path / "nowhere")}, {})
    assert missing.status == "warn" and "not on the office's PATH" in missing.detail


def test_a_codex_login_status_that_fails_otherwise_shows_its_first_line(tmp_path):
    env = _codex(tmp_path, 1, "\nError loading configuration: unknown field `modle` in config.toml\nat line 3\n")
    codex = tmp_path / "bin" / "codex"
    assert codex_check(env, {}) == Check("codex", "warn", f"codex-cli 0.130.0 at {codex}: `{codex} login status`"
                                         " failed: Error loading configuration: unknown field `modle` in config.toml")


def test_codex_is_signed_out_when_any_line_says_so(tmp_path):
    env = _codex(tmp_path, 1, "WARNING: proceeding, even though we could not update PATH\nNot logged in\n")
    codex = tmp_path / "bin" / "codex"
    assert codex_check(env, {}) == Check("codex", "warn",
                                         f"codex-cli 0.130.0 at {codex} is signed out; run `{codex} login`")


def test_a_failed_codex_login_status_shows_its_error_line_over_a_warning(tmp_path):
    env = _codex(tmp_path, 1, "WARNING: proceeding, even though we could not update PATH\n"
                              "Error loading configuration: unknown field `modle`\n")
    detail = codex_check(env, {}).detail
    assert detail.endswith("login status` failed: Error loading configuration: unknown field `modle`")


def test_codex_color_codes_are_dropped_before_matching_and_showing(tmp_path):
    env = _codex(tmp_path, 1, "\x1b[33mWARNING: odd\x1b[0m\n\x1b[1;31mError\x1b[0m checking login status: denied\n")
    assert codex_check(env, {}).detail.endswith("login status` failed: Error checking login status: denied")
    (tmp_path / "login.err").write_text("\x1b[2mNot logged in\x1b[0m\n")
    assert codex_check(env, {}).detail.endswith("is signed out; run `" + str(tmp_path / "bin" / "codex") + " login`")


def test_a_failed_codex_version_line_is_cut_short_and_uncolored(tmp_path):
    env = _codex(tmp_path, 0)
    codex = tmp_path / "bin" / "codex"
    codex.write_text('#!/bin/sh\nprintf "\\033[31mboom %s\\033[0m\\n" "$(printf "y%.0s" $(seq 1 300))" >&2\nexit 3\n')
    check = codex_check(env, {})
    assert check == Check("codex", "fail", f"{codex} --version failed: " + ("boom " + "y" * 300)[:200])


def test_a_failed_codex_login_status_falls_back_to_stdout_then_the_exit_code(tmp_path):
    env = _codex(tmp_path, 2, "", "something odd\n")
    assert codex_check(env, {}).detail.endswith("login status` failed: something odd")
    (tmp_path / "login.out").write_text("")
    assert codex_check(env, {}).detail.endswith("login status` failed: exit 2")


def test_a_failed_codex_login_status_line_is_cut_short(tmp_path):
    check = codex_check(_codex(tmp_path, 1, "Error checking login status: " + "x" * 500 + "\n"), {})
    assert check.status == "warn" and check.detail.endswith("failed: Error checking login status: " + "x" * 171)


def test_a_codex_that_hangs_or_cant_run_fails_the_check(tmp_path):
    env = _codex(tmp_path, 0)
    codex = tmp_path / "bin" / "codex"
    codex.write_text("#!/bin/sh\nsleep 5\n")
    hung = codex_check(env, {}, timeout=0.5)
    assert hung == Check("codex", "fail", f"{codex} --version didn't answer in 0.5 s")
    codex.write_text("#!/nonexistent/sh\n")
    broken = codex_check(env, {})
    assert broken.status == "fail" and broken.detail.startswith(f"{codex} can't run")


def test_checks_run_the_codex_check_they_are_given_in_the_app_servers_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    seen = []
    host = make_host(tmp_path, Runner(), answers=lambda s: False)
    found = doctor.checks(OfficePaths(tmp_path / "home").home, host=host, repo=tmp_path / "repo", probe=lambda: None,
                          codex=lambda env, environ, mode: seen.append(env) or Check("codex", "ok", "stand-in"))
    assert found[-1] == Check("codex", "ok", "stand-in")
    assert seen and all(k in INHERITED_ENV or k.startswith("LC_") for k in seen[0])
    assert "OPENAI_API_KEY" not in seen[0]


def test_opencorp_codex_bin_names_the_codex_the_check_runs(tmp_path):
    env = _codex(tmp_path, 0)
    other = tmp_path / "codex-dev"
    other.write_text('#!/bin/sh\ncase "$1" in --version) echo "codex-cli 9.9.9";; login) exit 0;; esac\n')
    other.chmod(0o755)
    by_path = codex_check(env, {"OPENCORP_CODEX_BIN": str(other)})
    assert by_path == Check("codex", "ok", f"codex-cli 9.9.9 at {other}, signed in")
    (tmp_path / "bin" / "codex-dev").symlink_to(other)
    by_name = codex_check(env, {"OPENCORP_CODEX_BIN": "codex-dev"})
    assert by_name == Check("codex", "ok", f"codex-cli 9.9.9 at {tmp_path / 'bin' / 'codex-dev'}, signed in")


def test_an_opencorp_codex_bin_the_office_cant_find_is_a_warning_even_with_codex_on_the_path(tmp_path):
    check = codex_check(_codex(tmp_path, 0), {"OPENCORP_CODEX_BIN": "/nowhere/codex"})
    assert check.status == "warn"
    assert "OPENCORP_CODEX_BIN names /nowhere/codex, which isn't an executable the office can find" in check.detail


def test_the_check_runs_codex_with_the_offices_codex_home_when_set(tmp_path):
    env = _codex(tmp_path, 0)
    (tmp_path / "bin" / "codex").write_text(
        '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.130.0";; login) [ "$CODEX_HOME" = /x/home ];; esac\n')
    assert codex_check(env, {"CODEX_HOME": "/x/home"}).status == "ok"
    assert codex_check(env, {}).status == "warn"
    assert "CODEX_HOME" not in env


def test_checks_give_the_codex_check_the_offices_environment_to_find_codex(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", "/x/home")
    monkeypatch.setenv("OPENCORP_CODEX_BIN", "/x/codex")
    seen = []
    host = make_host(tmp_path, Runner(), answers=lambda s: False)
    doctor.checks(OfficePaths(tmp_path / "home").home, host=host, repo=tmp_path / "repo", probe=lambda: None,
                  codex=lambda env, environ, mode: seen.append((env, environ)) or Check("codex", "ok", "stand-in"))
    env, environ = seen[0]
    assert environ["CODEX_HOME"] == "/x/home" and environ["OPENCORP_CODEX_BIN"] == "/x/codex"
    assert "CODEX_HOME" not in env and "OPENCORP_CODEX_BIN" not in env


def test_the_codex_check_runs_with_where_tls_finds_ca_certificates_when_set(tmp_path, monkeypatch):
    monkeypatch.setenv("SSL_CERT_FILE", "/etc/pki/tls/certs/ca-bundle.crt")
    monkeypatch.setenv("SSL_CERT_DIR", "/etc/pki/tls/certs")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    seen = []
    host = make_host(tmp_path, Runner(), answers=lambda s: False)
    doctor.checks(OfficePaths(tmp_path / "home").home, host=host, repo=tmp_path / "repo", probe=lambda: None,
                  codex=lambda env, environ, mode: seen.append(env) or Check("codex", "ok", "stand-in"))
    assert seen[0]["SSL_CERT_FILE"] == "/etc/pki/tls/certs/ca-bundle.crt"
    assert seen[0]["SSL_CERT_DIR"] == "/etc/pki/tls/certs" and "OPENAI_API_KEY" not in seen[0]


def test_codex_advice_says_how_the_office_picks_up_a_change_under_its_service(tmp_path):
    missing = {"PATH": str(tmp_path / "nowhere")}
    for mode in ("launchd", "systemd"):
        managed = codex_check(missing, {}, mode)
        assert "stop the office and run `opencorp onboard` again from that shell" in managed.detail
        assert "opencorp restart" not in managed.detail
        override = codex_check(missing, {"OPENCORP_CODEX_BIN": "/nowhere/codex"}, mode)
        assert "stop the office and run `opencorp onboard` again from that shell" in override.detail
    for mode in ("tmux", "background", None):
        assert "then `opencorp restart` from that shell" in codex_check(missing, {}, mode).detail


def test_checks_give_the_codex_check_the_offices_recorded_service_mode(tmp_path):
    paths = onboarded(tmp_path, mode="systemd")
    modes = []
    host = make_host(tmp_path, Runner([(["loginctl"], 0, "", "Linger=yes\n")]), answers=lambda s: False,
                     platform="linux")
    doctor.checks(paths.home, host=host, repo=tmp_path / "repo", probe=lambda: None,
                  codex=lambda env, environ, mode: modes.append(mode) or Check("codex", "ok", "stand-in"))
    assert modes == ["systemd"]


def test_a_codex_that_says_nothing_is_still_described(tmp_path):
    env = _codex(tmp_path, 0)
    codex = tmp_path / "bin" / "codex"
    codex.write_text('#!/bin/sh\ncase "$1" in --version) exit 3;; esac\n')
    assert codex_check(env, {}) == Check("codex", "fail", f"{codex} --version failed: exit 3")
    codex.write_text('#!/bin/sh\nexit 0\n')
    assert codex_check(env, {}) == Check("codex", "ok", f"{codex} (no version printed), signed in")


def test_leftovers_from_before_the_rename_warn_right_after_the_home(tmp_path):
    old = tmp_path / legacy.OLD_HOME
    old.mkdir()
    found = run_checks(tmp_path, onboarded(tmp_path))
    assert [c.name for c in found][:2] == ["home", "leftovers"]
    assert found[1].status == "warn" and f"the old home {old}" in found[1].detail
    assert doctor.exit_code(found) == 0


def test_no_leftovers_no_line(tmp_path):
    assert "leftovers" not in by_name(run_checks(tmp_path, onboarded(tmp_path)))


def test_a_missing_default_home_next_to_the_old_one_says_where_the_office_is(tmp_path):
    old = tmp_path / legacy.OLD_HOME
    (old / "office").mkdir(parents=True)
    got = by_name(run_checks(tmp_path, OfficePaths(tmp_path / legacy.NEW_HOME)))
    assert got["home"] == Check("home", "fail", f"no office home at {tmp_path / legacy.NEW_HOME}; the office from"
                                f" before the rename is at {old} (see leftovers)")


async def test_hq_status_is_read_with_this_devices_token(office, short_dir, company):
    from opencorp.auth.identity import Identity, identity_path, write_identity
    from opencorp.auth.tokens import new_token
    from opencorp.hq.core import attach
    from tests.daemon.conftest import served
    from tests.daemon.test_auth import give_device

    token = new_token()
    give_device(company, "ngocbh", "mac", token)  # enforced from now on
    write_identity(identity_path(short_dir), Identity("ngocbh", "mac", token))
    attach(office, listen=False)
    async with served(office, short_dir / "o.sock"):
        status = await asyncio.to_thread(doctor.hq_status, short_dir / "o.sock", short_dir)
        assert status["socket"].endswith("hq.sock")
        (short_dir / "identity.json").unlink()
        assert await asyncio.to_thread(doctor.hq_status, short_dir / "o.sock", short_dir) == "refused"  # 401


async def test_an_office_without_hq_or_no_office_at_all_is_unreachable(office, short_dir):
    from tests.daemon.conftest import served

    async with served(office, short_dir / "o.sock"):  # HQ not attached: 501
        assert await asyncio.to_thread(doctor.hq_status, short_dir / "o.sock", short_dir) == "unreachable"
    assert doctor.hq_status(short_dir / "nothing.sock", short_dir) == "unreachable"


def answering(monkeypatch, handler):
    """Make hq_status's socket transport answer with ``handler`` instead."""
    monkeypatch.setattr(doctor.httpx, "HTTPTransport", lambda uds: httpx.MockTransport(handler))


def test_an_office_from_before_hq_is_unreachable(tmp_path, monkeypatch):
    answering(monkeypatch, lambda request: httpx.Response(404, json={"error": "no_route"}))
    assert doctor.hq_status(tmp_path / "o.sock", tmp_path) == "unreachable"


def test_an_office_that_doesnt_answer_in_time_is_unreachable(tmp_path, monkeypatch):
    def slow(request):
        raise httpx.ReadTimeout("timed out", request=request)

    answering(monkeypatch, slow)
    assert doctor.hq_status(tmp_path / "o.sock", tmp_path) == "unreachable"


def status(**tcp):
    base = {"enabled": True, "port": 49380, "listening": True, "error": None, "next_retry_at": None}
    health = {"ok": True, "office": {"api": "0.0.1+aaa"}, "app": {"build": "b", "api": "0.0.1+aaa"}}
    return {"socket": "/h/office/hq.sock", "tcp": {**base, **tcp}, "url": "http://127.0.0.1:49380/", "health": health,
            "warnings": []}


def test_hq_listening_and_a_current_app(tmp_path):
    got = by_name(doctor.hq_checks(status(), tmp_path, tmp_path / "repo"))
    assert got["hq"].status == "ok" and "http://127.0.0.1:49380/" in got["hq"].detail and got["web app"].status == "ok"


def test_a_taken_port_names_the_fix(tmp_path):
    got = by_name(doctor.hq_checks(status(listening=False, error="Address already in use"), tmp_path, tmp_path))
    assert got["hq"].status == "warn" and "Address already in use" in got["hq"].detail and "hq.json" in got["hq"].detail


def test_tcp_off_points_at_pair(tmp_path):
    got = by_name(doctor.hq_checks(status(enabled=False, listening=False), tmp_path, tmp_path))
    assert got["hq"].status == "ok" and "opencorp pair" in got["hq"].detail


def test_an_unbuilt_or_stale_app_warns(tmp_path):
    s = status()
    s["health"]["app"] = None
    assert "bun run build" in by_name(doctor.hq_checks(s, tmp_path, tmp_path))["web app"].detail
    s["health"]["app"] = {"build": "b", "api": "0.0.1+bbb"}
    assert "doesn't match" in by_name(doctor.hq_checks(s, tmp_path, tmp_path))["web app"].detail


def test_the_offices_warnings_are_shown(tmp_path):
    s = {**status(), "warnings": ["the web port is on and this host has other users (ann): ..."]}
    assert [c.detail for c in doctor.hq_checks(s, tmp_path, tmp_path) if c.name == "hq warning"] == s["warnings"]


def test_a_refused_device_is_told_to_log_in(tmp_path):
    [got] = doctor.hq_checks("refused", tmp_path, tmp_path)
    assert got.status == "warn" and "`opencorp login`" in got.detail and "restart" not in got.detail


def test_an_unreachable_hq_is_told_to_restart(tmp_path):
    [got] = doctor.hq_checks("unreachable", tmp_path, tmp_path)
    assert got.status == "warn" and "`opencorp restart`" in got.detail and "login" not in got.detail


def test_a_running_office_reports_hq(tmp_path):
    paths = onboarded(tmp_path)
    host = make_host(tmp_path, Runner(), answers=lambda s: True)
    got = by_name(doctor.checks(paths.home, host=host, repo=tmp_path / "repo", probe=lambda: None,
                                codex=lambda env, environ, mode: Check("codex", "ok", "stand-in"), environ={},
                                hq=lambda socket, home: status()))
    assert got["hq"].status == "ok"
