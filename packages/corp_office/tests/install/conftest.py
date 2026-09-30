import os
import stat

import pytest

SERVICE_TOOLS = ("launchctl", "systemctl", "loginctl", "tmux")


@pytest.fixture(autouse=True)
def no_real_services(tmp_path_factory, monkeypatch):
    """Keep every test off the real machine: a temp ``HOME`` and ``AGENT_CORP_HOME``, and stand-ins for the service tools.

    The stand-ins come first on ``PATH``, refuse, and log their argv, so a code path that
    reaches the real host by mistake fails the test instead of registering a service.
    """
    root = tmp_path_factory.mktemp("host")
    bin_dir, calls = root / "bin", root / "calls.log"
    bin_dir.mkdir()
    for name in SERVICE_TOOLS:
        tool = bin_dir / name
        tool.write_text(f'#!/bin/sh\necho "{name} $*" >> "{calls}"\necho "refused: tests never run the real {name}" >&2\nexit 1\n')
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("HOME", str(root / "user"))
    monkeypatch.setenv("AGENT_CORP_HOME", str(root / "user" / ".agent-corp"))
    (root / "user").mkdir()
    yield
    assert not calls.exists(), f"a test ran a real service tool:\n{calls.read_text()}"
