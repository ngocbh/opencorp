"""A real office on a temp home, made as `opencorp init` makes it, and the office calls the TUI makes."""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

import httpx
import psutil

from opencorp.auth.identity import identity_path, read_identity
from opencorp.daemon.app import OfficePaths
from opencorp.install.launch import REPO

CLI = REPO / "packages" / "cli" / "src" / "main.ts"
"""The `opencorp` entry point in this checkout, run with bun."""


def wait_for(check, what, timeout=40.0):
    """Poll ``check`` until it returns something truthy and return that; fail naming ``what`` after ``timeout`` s."""
    end = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.1)


def folder(path: Path) -> Path:
    """Make a project folder at ``path`` with a README, and return its realpath."""
    path.mkdir()
    (path / "README.md").write_text("# Demo\n\nStatus: TODO\n")
    return path.resolve()


def asked(request) -> str:
    """A model request's messages as JSON text."""
    return json.dumps(request["messages"])


def alive(pid: int) -> bool:
    """Whether ``pid`` is running; a zombie counts as gone."""
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


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

    def onboard(self, device: bool = False) -> None:
        """Make Acme with Ngoc as CEO and Minh as its first teammate, and the office as a background process,
        as `opencorp init` would.

        With ``device``, init registers this device, so the office needs its token; the
        client sends it.
        """
        provider = {"llm_config": {"provider": "vllm", "model": "stub"}, "env": self.fake.env()}
        self.fake.script({"content": "OK", "match": "Reply with the single word OK."})  # init's model check
        done = subprocess.run(
            [sys.executable, "-m", "opencorp.install", "init", "--home", str(self.home),
             "--provider-stdin", "--company", "Acme", "--name", "Ngoc", "--handle", "ngocbh",
             "--service", "background", *([] if device else ["--no-device"])],
            input=json.dumps(provider), capture_output=True, text=True, cwd=REPO, timeout=120)
        if self.paths.pidfile.exists():
            self.pids.add(self.pid())
        assert done.returncode == 0, done.stdout + done.stderr
        assert "with you as CEO and Minh (@minh)" in done.stdout
        self.fake.forget()  # tests count the office's model calls from the first
        if device:
            self.http.headers.update(read_identity(identity_path(self.home)).headers())

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
        """``handle``, once the office lists a person with it; fail otherwise."""
        return next(p["handle"] for p in self.get("/people") if p["handle"] == handle)

    def folder_people(self, cwd: Path) -> list[str]:
        """The handles the picker offers first in ``cwd``: who has had a session there."""
        return [p["handle"] for p in self.get(f"/folders/{quote(str(cwd), safe='')}/people")]

    def session(self, sid: str):
        """Session ``sid`` as the office reports it."""
        return self.get(f"/sessions/{sid}")

    def status(self, sid: str) -> str:
        """Session ``sid``'s status, such as ``starting``, ``idle`` or ``busy``."""
        return self.session(sid)["status"]

    def _parts(self, sid: str, role: str, kind: str):
        return [p for m in self.get(f"/sessions/{sid}/messages") if m["role"] == role
                for p in m["parts"] if p["type"] == kind]

    def texts(self, sid: str) -> list[str]:
        """The text of Minh's replies in session ``sid``, oldest first."""
        return [p["text"] for p in self._parts(sid, "assistant", "text")]

    def users(self, sid: str) -> list[str]:
        """The text of the owner's messages in session ``sid``, oldest first."""
        return [p["text"] for p in self._parts(sid, "user", "text")]

    def tools(self, sid: str) -> list[tuple[str, str]]:
        """Each tool part in session ``sid`` as ``(tool, state)``."""
        return [(p["tool"], p["state"]) for p in self._parts(sid, "assistant", "tool")]

    def start_chat(self, person: str, cwd: Path, wait: bool = True) -> str:
        """Start a session as the TUI's new chat does and return its id; with ``wait``, wait until it is idle.

        The TUI sends the first message at once, while the session is still starting.
        """
        sid = self.post("/sessions", {"person": person, "cwd": str(cwd)})["id"]
        if wait:
            wait_for(lambda: self.status(sid) == "idle", f"session {sid} to start")
        return sid

    def prompt(self, sid: str, text: str):
        """Send ``text`` as the TUI does every message: a turn when idle, a steer when busy."""
        return self.post(f"/sessions/{sid}/prompt", {"text": text})

    def replying(self, sid: str) -> None:
        """Wait until the office has seen Minh's reply start in session ``sid``: the newest message is his."""
        # A prompt steers only once the office has handled the reply's start frame, which can
        # arrive just after the model request does.
        wait_for(lambda: self.get(f"/sessions/{sid}/messages")[-1]["role"] == "assistant",
                 f"session {sid}'s reply to start")

    def interrupt(self, sid: str):
        """Esc in the TUI."""
        return self.post(f"/sessions/{sid}/interrupt")

    def settled(self, sid: str, texts: list[str]) -> None:
        """Wait until session ``sid`` is idle with exactly ``texts`` as Minh's replies."""
        wait_for(lambda: self.status(sid) == "idle" and self.texts(sid) == texts, f"replies {texts}")

    def debriefed(self, sid: str) -> dict:
        """Wait until session ``sid`` has ended and its debrief is ready; return the debrief."""
        # GET /debriefs/{sid} can answer 404 until the session has ended.
        wait_for(lambda: self.status(sid) == "ended", f"session {sid} to end")

        def ready():
            debrief = self.get(f"/debriefs/{sid}")
            return debrief if debrief["state"] == "ready" else None

        return wait_for(ready, f"session {sid}'s debrief")

    def _cli_env(self) -> dict[str, str]:
        return dict(os.environ, OPENCORP_HOME=str(self.home))

    def opencorp(self, *args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run `opencorp <args>` in ``cwd`` against this office and wait for it."""
        done = subprocess.run(["bun", str(CLI), *args], cwd=cwd, env=self._cli_env(),
                              capture_output=True, text=True, timeout=90)
        if check:
            assert done.returncode == 0, f"opencorp {' '.join(args)}: {done.stdout}{done.stderr}"
        return done

    def git_log(self) -> list[str]:
        """The company repo's commit subjects, newest first."""
        return subprocess.run(["git", "-C", str(self.paths.company), "log", "--format=%s"],
                              check=True, capture_output=True, text=True).stdout.splitlines()

    def worker(self, sid: str) -> psutil.Process:
        """Session ``sid``'s worker: the office's child running in the session's run dir."""
        run_dir = str(self.paths.run_dir(sid))

        def find():
            for child in psutil.Process(self.pid()).children():
                try:
                    if child.cwd() == run_dir:
                        return child
                except psutil.Error:
                    pass
            return None

        return wait_for(find, f"session {sid}'s worker")

    def kill_office(self) -> int:
        """SIGKILL the office, as a crash would; return its pid."""
        pid = self.pid()
        os.kill(pid, signal.SIGKILL)
        wait_for(lambda: not alive(pid), "the office to die")
        return pid

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
