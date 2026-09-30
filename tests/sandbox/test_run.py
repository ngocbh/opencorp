import sys
import threading
import time

import psutil
import pytest

from agent_corp.sandbox.run import SandboxUnavailable, command, run, scrubbed_env

pytestmark = pytest.mark.usefixtures("sandbox_available")


def sh(policy, script, **kw):
    return run(policy, ["/bin/sh", "-c", script], **kw)


def test_runs_in_the_workspace(make_policy):
    policy = make_policy()
    result = sh(policy, "pwd; echo err >&2; exit 3")
    assert result.exit == 3
    assert result.stdout.decode().strip() == str(policy.workspace)
    assert result.stderr == b"err\n"
    assert not result.timed_out and not result.interrupted and not result.truncated
    assert result.duration >= 0


def test_stdin_is_passed(make_policy):
    assert sh(make_policy(), "cat", stdin=b"hello").stdout == b"hello"


def test_environment_is_scrubbed(make_policy, monkeypatch):
    monkeypatch.setenv("AGENT_CORP_TEST_SECRET", "s3cr3t-value")
    policy = make_policy()
    out = sh(policy, "env").stdout.decode()
    assert "s3cr3t-value" not in out
    env = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    assert env["HOME"] == env["TMPDIR"] == str(policy.tmpdir)
    assert set(scrubbed_env(policy)) <= set(env)


def test_timeout_kills_the_group(make_policy):
    start = time.monotonic()
    result = sh(make_policy(), "sleep 30", timeout=1)
    assert result.timed_out and result.exit is None
    assert time.monotonic() - start < 10


def test_cancel_kills_the_call(make_policy):
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    start = time.monotonic()
    result = sh(make_policy(), "sleep 30", cancel=cancel)
    assert result.interrupted and result.exit is None
    assert time.monotonic() - start < 10


def gone(marker):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        alive = [p for p in psutil.process_iter(["cmdline"]) if p.info["cmdline"] == ["sleep", marker]]
        if not alive:
            return True
        time.sleep(0.1)
    return False


def test_background_process_dies_with_the_call(make_policy):
    start = time.monotonic()
    result = sh(make_policy(), "sleep 4242 & echo started")
    assert result.stdout == b"started\n"
    # The background sleep holds the output pipes; the call must not wait for it.
    assert time.monotonic() - start < 10
    assert gone("4242")


def test_std_streams_by_path(make_policy):
    script = "echo out > /dev/stdout; echo err > /dev/stderr; echo fd > /dev/fd/1; cat /dev/fd/0"
    result = sh(make_policy(), script, stdin=b"in")
    assert result.exit == 0, result.stderr
    assert result.stdout == b"out\nfd\nin" and result.stderr == b"err\n"


def test_output_is_capped(make_policy):
    result = sh(make_policy(), "head -c 100000 /dev/zero", max_output=1000)
    assert len(result.stdout) == 1000 and result.truncated


def test_unsupported_platform(monkeypatch, make_policy):
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(SandboxUnavailable):
        command(make_policy(), ["x"])
