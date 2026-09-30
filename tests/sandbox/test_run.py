import sys
import threading
import time

import psutil
import pytest

from agent_corp.sandbox.run import SandboxUnavailable, command, run, scrubbed_env
from agent_corp.tools.workspace import interpreter

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


def test_group_is_killed_before_the_leader_is_reaped(make_policy, monkeypatch):
    # Until the leader is reaped its pid, and so the group id, can't be reused, so the
    # kill can't reach an unrelated process group.
    run_module = sys.modules["agent_corp.sandbox.run"]
    seen = []
    real = run_module._kill_group

    def kill_group(pgid):
        seen.append(psutil.Process(pgid).status())
        real(pgid)

    monkeypatch.setattr(run_module, "_kill_group", kill_group)
    assert sh(make_policy(), "exit 0").exit == 0
    assert sh(make_policy(), "sleep 30", timeout=0.5).timed_out
    # psutil.Process raises if the pid is gone; after a timeout the leader is still alive.
    assert seen[0] == psutil.STATUS_ZOMBIE and len(seen) == 2


SETSID_CHILD = """
import os, time
if os.fork() == 0:
    os.setsid()
    os.execv("/bin/sleep", ["sleep", "{marker}"])
print("parent done")
"""


def py_call(policy, code, **kw):
    return run(policy, [str(interpreter()[0]), "-I", "-S", "-c", code], **kw)


def test_setsid_child_dies_with_the_call(make_policy):
    # setsid leaves the process group, so killing the group misses it; the child also
    # holds the output pipes, which must not stall the call.
    policy = make_policy(read_only=interpreter()[1])
    start = time.monotonic()
    result = py_call(policy, SETSID_CHILD.format(marker="4545"))
    assert result.stdout == b"parent done\n"
    assert time.monotonic() - start < 3
    assert gone("4545")


def test_escape_cleanup_spares_concurrent_calls(make_policy):
    policy = make_policy(read_only=interpreter()[1])
    results = []
    sibling = threading.Thread(target=lambda: results.append(sh(policy, "sleep 2; echo alive")))
    sibling.start()
    time.sleep(0.5)
    assert py_call(policy, SETSID_CHILD.format(marker="4546")).exit == 0
    sibling.join()
    assert results[0].exit == 0 and results[0].stdout == b"alive\n"
    assert gone("4546")


def test_output_is_capped(make_policy):
    result = sh(make_policy(), "head -c 100000 /dev/zero", max_output=1000)
    assert len(result.stdout) == 1000 and result.truncated


def test_unsupported_platform(monkeypatch, make_policy):
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(SandboxUnavailable):
        command(make_policy(), ["x"])
