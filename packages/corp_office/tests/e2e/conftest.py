"""E2E fixtures: a real office daemon on a temp home, onboarded with the fake LLM as its provider."""

import os
import shutil
import stat
import sys

import pytest

from opencorp.install.launch import REPO
from opencorp.testing.fake_llm import FakeLLM
from tests.company.conftest import _isolate_git  # noqa: F401
from tests.daemon.conftest import short_dir  # noqa: F401
from tests.sandbox.conftest import sandbox_available  # noqa: F401

from .fixtures.office import RunningOffice, folder

SERVICE_TOOLS = ("launchctl", "systemctl", "loginctl", "tmux")


@pytest.fixture(autouse=True)
def no_service_tools(tmp_path_factory, monkeypatch):
    """Put refusing stand-ins for the service tools first on ``PATH``, so no test registers a real service.

    ``HOME`` is left alone: bun, uv and the sandbox all read it.
    """
    root = tmp_path_factory.mktemp("service-tools")
    calls = root / "calls.log"
    for name in SERVICE_TOOLS:
        tool = root / name
        tool.write_text(f'#!/bin/sh\necho "{name} $*" >> "{calls}"\nexit 1\n')
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{root}{os.pathsep}{os.environ.get('PATH', '')}")
    yield
    assert not calls.exists(), f"a test ran a real service tool:\n{calls.read_text()}"


@pytest.fixture(autouse=True)
def fake_codex_on_path(tmp_path_factory, monkeypatch):
    """Put the fake Codex first on ``PATH`` as ``codex``, so `opencorp doctor` never runs the developer's real one."""
    root = tmp_path_factory.mktemp("codex")
    codex = root / "codex"
    codex.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I -m opencorp.testing.fake_codex "$@"\n')
    codex.chmod(codex.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{root}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.delenv("AGENT_CORP_CODEX_BIN", raising=False)


@pytest.fixture(scope="session")
def cli_ready():
    """Skip when asked to (``AGENT_CORP_SKIP_E2E=1``) or when `opencorp` can't run here (no bun, or no `bun install`); fail instead on CI."""
    on_ci = bool(os.environ.get("CI"))
    if os.environ.get("AGENT_CORP_SKIP_E2E") == "1":
        # A CI job that inherits the variable must not pass by skipping the whole suite.
        if on_ci:
            pytest.fail("AGENT_CORP_SKIP_E2E=1 is set on CI")
        pytest.skip("AGENT_CORP_SKIP_E2E=1 is set")
    problem = None
    if shutil.which("bun") is None:
        problem = "bun is not on PATH"
    elif not (REPO / "packages" / "cli" / "node_modules" / "@opencorp" / "tui").exists():
        problem = "the TS packages aren't installed; run `bun install --frozen-lockfile`"
    if problem:
        if on_ci:
            pytest.fail(f"opencorp can't run on CI: {problem}")
        pytest.skip(f"opencorp can't run here: {problem}")


@pytest.fixture
def fake_llm():
    """A running fake LLM server, released and stopped afterwards."""
    with FakeLLM() as fake:
        yield fake


@pytest.fixture
def office(cli_ready, short_dir, fake_llm):
    """A running office on a short temp home (macOS socket paths are capped at 104 bytes), stopped afterwards."""
    running = RunningOffice(short_dir, fake_llm)
    try:
        running.onboard()
        yield running
    finally:
        running.stop()


@pytest.fixture
def workspace(tmp_path):
    """A project folder with a README, outside the company repo."""
    return folder(tmp_path / "project")
