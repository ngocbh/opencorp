import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path

import pytest

from opencorp.tools.workspace import WorkspaceTools, interpreter

ON_MAC = sys.platform == "darwin"
ON_LINUX = sys.platform.startswith("linux")

pytestmark = pytest.mark.usefixtures("sandbox_available")
PY = str(interpreter()[0])


@pytest.fixture
def short_dir():
    path = Path(tempfile.mkdtemp(prefix="acsb-", dir="/tmp")).resolve()
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
def office(short_dir, monkeypatch):
    """A fake home with the secrets and office state the sandbox must not reach."""
    home = short_dir / "home"
    files = {
        ".config/yian/auth.json": '{"key": "sk-decoy-auth"}',
        ".ssh/id_ed25519": "decoy-ssh-key",
        ".aws/credentials": "decoy-aws",
        ".opencorp/office/store.sqlite": "decoy-store",
        ".opencorp/office/runs/r1/log.jsonl": "decoy-run-log",
        ".opencorp/office/secrets/cluster-a": "decoy-asset-secret",
        ".opencorp/company/people/minh/person.yaml": "decoy-repo",
    }
    for rel, text in files.items():
        (home / rel).parent.mkdir(parents=True, exist_ok=True)
        (home / rel).write_text(text)
    monkeypatch.setenv("HOME", str(home))
    return home


class UnixServer:
    """A listening unix socket outside the workspace (stands in for tmux or the office)."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.bind(str(path))
        self.sock.listen()

    def close(self):
        self.sock.close()


def py(tools, code):
    return tools.shell(f"{PY} -I -S -c {shlex.quote(textwrap.dedent(code))}").output


CONNECT_UNIX = """
import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1]); print("CONNECTED")
except OSError as e:
    print("REFUSED", e)
"""


@pytest.mark.parametrize("rel", [
    ".config/yian/auth.json",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".opencorp/office/store.sqlite",
    ".opencorp/office/runs/r1/log.jsonl",
    ".opencorp/office/secrets/cluster-a",
    ".opencorp/company/people/minh/person.yaml",
])
def test_cannot_read_owner_or_office_files(make_policy, office, rel):
    tools = WorkspaceTools(make_policy())
    target = office / rel
    shell = tools.shell(f"cat {target}").output
    assert "decoy" not in shell and not shell.endswith("[exit 0]")
    assert "decoy" not in tools.read_file(str(target)).output
    assert "decoy" not in tools.search("decoy", path=str(office)).output


def test_cannot_list_the_real_home(make_policy):
    tools = WorkspaceTools(make_policy())
    home = Path(os.path.realpath(os.path.expanduser("~")))
    listing = tools.list_dir(str(home)).output
    if ON_MAC:
        assert listing.startswith("error:")
    else:
        # bwrap creates the parents of mounted paths (such as a uv-managed Python under
        # ~/.local), so those entries, and only those, may show.
        allowed = {p.relative_to(home).parts[0] + "/" for p in tools.policy.read_only if p.is_relative_to(home)}
        assert listing.startswith("error:") or listing == "(empty)" or set(listing.splitlines()) <= allowed


@pytest.mark.parametrize("network", [False, True])
@pytest.mark.parametrize("name", ["tmux-501/default", "office/office.sock"])
def test_cannot_connect_to_unix_sockets(make_policy, short_dir, name, network):
    server = UnixServer(short_dir / name)
    try:
        tools = WorkspaceTools(make_policy(network=network))
        code = CONNECT_UNIX.replace("sys.argv[1]", repr(str(server.path)))
        out = py(tools, code)
        assert "REFUSED" in out and "CONNECTED" not in out
    finally:
        server.close()


def test_cannot_write_outside_the_workspace(make_policy, ws, short_dir, office):
    tools = WorkspaceTools(make_policy())
    for target in (ws.parent / "outside.txt", short_dir / "outside.txt", office / ".ssh/authorized_keys"):
        assert tools.write_file(str(target), "x").output.startswith("error:")
        assert not tools.shell(f"echo x > {target}").output.endswith("[exit 0]")
        assert not target.exists()
    assert tools.write_file("../escape.txt", "x").output.startswith("error:")
    assert not (ws.parent / "escape.txt").exists()


def test_git_hooks_and_config_are_read_only(make_policy, ws):
    (ws / ".git/hooks").mkdir(parents=True)
    (ws / ".git/config").write_text("[core]\n")
    tools = WorkspaceTools(make_policy())
    assert tools.write_file(".git/hooks/pre-commit", "evil").output.startswith("error:")
    assert tools.edit_file(".git/config", "[core]", "[core]\nhooksPath=x").output.startswith("error:")
    # Renaming .git away (to plant a new hooks dir and rename it back) is denied too.
    assert not tools.shell("mv .git .git2").output.endswith("[exit 0]")
    assert not (ws / ".git/hooks/pre-commit").exists()
    assert (ws / ".git/config").read_text() == "[core]\n"
    # The rest of .git stays writable, so git itself works.
    assert tools.write_file(".git/HEAD", "ref: refs/heads/main\n").output.startswith("wrote")


def test_links_do_not_escape(make_policy, ws, office):
    tools = WorkspaceTools(make_policy())
    secret = office / ".ssh/id_ed25519"
    out = tools.shell(f"ln -s {secret.parent} sl; cat sl/id_ed25519").output
    assert "decoy" not in out
    out = tools.shell(f"ln {secret} hard; cat hard").output
    assert "decoy" not in out


@pytest.mark.parametrize("network", [False, True])
def test_network_only_when_allowed(make_policy, network):
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    port = server.getsockname()[1]
    try:
        tools = WorkspaceTools(make_policy(network=network))
        out = py(tools, f"""
            import socket
            s = socket.socket()
            s.settimeout(5)
            try:
                s.connect(("127.0.0.1", {port})); print("CONNECTED")
            except OSError as e:
                print("REFUSED", e)
            """)
        assert ("CONNECTED" in out) is network, out
    finally:
        server.close()


def test_background_process_is_dead_after_the_call(make_policy):
    tools = WorkspaceTools(make_policy())
    out = tools.shell("sleep 4343 >/dev/null 2>&1 & echo started")
    assert out.output == "started\n[exit 0]"
    import psutil

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not [p for p in psutil.process_iter(["cmdline"]) if p.info["cmdline"] == ["sleep", "4343"]]:
            break
        time.sleep(0.1)
    else:
        pytest.fail("background sleep outlived the call")


def test_no_environment_secrets(make_policy, monkeypatch):
    monkeypatch.setenv("OPENCORP_API_KEY", "sk-office-secret")
    tools = WorkspaceTools(make_policy())
    out = tools.shell("env").output
    assert "sk-office-secret" not in out and "OPENCORP_API_KEY" not in out


def secret_process():
    """An unsandboxed process with a secret in its environment, like the office."""
    marker = "sk-proc-" + os.urandom(4).hex()
    env = {"PATH": "/usr/bin:/bin", "OFFICE_SECRET": marker}
    proc = subprocess.Popen([PY, "-I", "-S", "-c", "import time; time.sleep(60)"], env=env)
    return proc, marker


@pytest.mark.skipif(not ON_LINUX, reason="Linux /proc")
def test_linux_proc_environ_of_the_office_is_hidden(make_policy):
    proc, marker = secret_process()
    try:
        tools = WorkspaceTools(make_policy())
        out = tools.shell("cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; ls /proc").output
        assert marker not in out
    finally:
        proc.kill()
        proc.wait()


@pytest.mark.skipif(not ON_MAC, reason="macOS sysctl")
@pytest.mark.xfail(reason="Seatbelt does not gate KERN_PROCARGS2: same-uid process environments are readable on macOS")
def test_macos_other_process_environ_is_hidden(make_policy):
    proc, marker = secret_process()
    try:
        tools = WorkspaceTools(make_policy())
        out = py(tools, f"""
            import ctypes
            libc = ctypes.CDLL(None)
            mib = (ctypes.c_int * 3)(1, 49, {proc.pid})  # CTL_KERN, KERN_PROCARGS2
            size = ctypes.c_size_t(1 << 20)
            buf = ctypes.create_string_buffer(1 << 20)
            if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0:
                print(buf.raw[: size.value].decode("latin-1"))
            """)
        assert marker not in out
    finally:
        proc.kill()
        proc.wait()


@pytest.mark.skipif(not ON_MAC, reason="macOS services")
def test_macos_launch_services_and_launchd_are_unreachable(make_policy, short_dir):
    tools = WorkspaceTools(make_policy())
    marker = short_dir / "escaped"
    out = tools.shell(f"launchctl submit -l dev.opencorp.sandbox-test -- /usr/bin/touch {marker}").output
    time.sleep(1)
    subprocess.run(["launchctl", "remove", "dev.opencorp.sandbox-test"], capture_output=True)
    assert not marker.exists(), out
    assert not tools.shell("/usr/bin/open -g -a Finder").output.endswith("[exit 0]")
    assert not tools.shell("echo x | /usr/bin/pbcopy").output.endswith("[exit 0]")
