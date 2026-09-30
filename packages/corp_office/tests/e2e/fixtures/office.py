"""A real office on a temp home, onboarded as `ac onboard` does it, and the office calls the TUI makes."""

import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import httpx
import psutil

from agent_corp.daemon.app import OfficePaths
from agent_corp.install.launch import REPO

AC = REPO / "packages" / "ac" / "src" / "main.ts"
"""The `ac` entry point in this checkout, run with bun."""


def folder(path: Path) -> Path:
    """Make a project folder at ``path`` with a README, and return its realpath."""
    path.mkdir()
    (path / "README.md").write_text("# Demo\n\nStatus: TODO\n")
    return path.resolve()


class RunningOffice:
    """An office daemon on ``home`` whose provider is ``fake``, driven over its unix socket."""

    def __init__(self, home: Path, fake):
        self.home = home
        self.paths = OfficePaths(home)
        self.fake = fake
        self.http = self.client()
        self.pids: set[int] = set()

    def client(self) -> httpx.Client:
        """A new HTTP client on the office socket: one more TUI, as far as the office can tell."""
        return httpx.Client(transport=httpx.HTTPTransport(uds=str(self.paths.socket)),
                            base_url="http://office", timeout=30)

    def onboard(self) -> None:
        """Onboard Acme with Ngoc as CEO and the office as a background process, as `ac onboard` would."""
        provider = {"llm_config": {"provider": "vllm", "model": "stub"}, "env": self.fake.env()}
        done = subprocess.run(
            [sys.executable, "-m", "agent_corp.install", "onboard", "--home", str(self.home),
             "--provider-stdin", "--company", "Acme", "--name", "Ngoc", "--handle", "ngocbh",
             "--service", "background"],
            input=json.dumps(provider), capture_output=True, text=True, cwd=REPO, timeout=120)
        if self.paths.pidfile.exists():
            self.pids.add(self.pid())
        assert done.returncode == 0, done.stdout + done.stderr
        assert "First agent: hired Minh (@minh)" in done.stdout

    def pid(self) -> int:
        """The pid in the office's pidfile."""
        return int(self.paths.pidfile.read_text())

    def get(self, path: str, **params):
        """GET ``path`` from the office and return the JSON body; fail on an error status."""
        response = self.http.get(path, params=params)
        response.raise_for_status()
        return response.json()

    def post(self, path: str, body=None):
        """POST ``body`` to ``path`` on the office and return the JSON body; fail on an error status."""
        response = self.http.post(path, json=body)
        response.raise_for_status()
        return response.json()

    def person(self, handle: str) -> str:
        """The id of the person with ``handle`` (a hire's id is a ULID, not the handle)."""
        return next(p["id"] for p in self.get("/people") if p["handle"] == handle)

    def folder_people(self, cwd: Path) -> list[str]:
        """The handles the picker offers first in ``cwd``: who has had a session there."""
        return [p["handle"] for p in self.get(f"/folders/{quote(str(cwd), safe='')}/people")]

    def _ac_env(self) -> dict[str, str]:
        return dict(os.environ, AGENT_CORP_HOME=str(self.home))

    def ac(self, *args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run `ac <args>` in ``cwd`` against this office and wait for it."""
        done = subprocess.run(["bun", str(AC), *args], cwd=cwd, env=self._ac_env(),
                              capture_output=True, text=True, timeout=90)
        if check:
            assert done.returncode == 0, f"ac {' '.join(args)}: {done.stdout}{done.stderr}"
        return done

    def stop(self) -> None:
        """Stop every office this test started, and any worker a killed office left behind."""
        self.http.close()
        if self.paths.pidfile.exists():
            self.pids.add(self.pid())
        for pid in self.pids:
            try:
                office = psutil.Process(pid)
                if str(self.home) not in " ".join(office.cmdline()):
                    continue  # the pid was reused by something else
                office.terminate()
                office.wait(15)
            except psutil.TimeoutExpired:
                office.kill()
            except psutil.Error:
                pass
        # A safety net: workers exit by themselves when their office goes.
        runs = str(self.paths.runs) + os.sep
        for proc in psutil.process_iter():
            try:
                if proc.cwd().startswith(runs):
                    os.killpg(proc.pid, signal.SIGKILL)
            except (psutil.Error, OSError):
                pass
