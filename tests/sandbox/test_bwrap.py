import pytest

from agent_corp.sandbox import bwrap
from agent_corp.sandbox.policy import SandboxPolicy


@pytest.fixture
def make(tmp_path):
    ws, tmp = tmp_path / "ws", tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    return lambda writable=True, network=False: SandboxPolicy(ws, writable, network, tmp, read_only=(tmp_path,))


def triples(argv, flag):
    return [tuple(argv[i : i + 3]) for i, a in enumerate(argv) if a == flag]


def test_isolation_flags(make):
    argv = bwrap.command(make(), ["/bin/true"])
    assert argv[0] == "bwrap"
    for flag in ("--die-with-parent", "--unshare-pid", "--unshare-net", "--new-session"):
        assert flag in argv
    assert argv[argv.index("--proc") + 1] == "/proc"
    assert argv[argv.index("--remount-ro") + 1] == "/"
    assert argv[-2:] == ["--", "/bin/true"]


def test_network_keeps_the_host_network(make):
    assert "--unshare-net" not in bwrap.command(make(network=True), ["/bin/true"])


def test_workspace_bind_mode(make):
    rw = make()
    ws = str(rw.workspace)
    assert ("--bind", ws, ws) in triples(bwrap.command(rw, ["x"]), "--bind")
    ro = make(writable=False)
    argv = bwrap.command(ro, ["x"])
    assert ("--ro-bind", ws, ws) in triples(argv, "--ro-bind")
    assert ("--bind", ws, ws) not in triples(argv, "--bind")


def test_git_paths_are_read_only_over_a_writable_workspace(make):
    policy = make()
    argv = bwrap.command(policy, ["x"])
    ws_at = argv.index(str(policy.workspace))
    for path in map(str, policy.protected[1:]):
        assert ("--ro-bind-try", path, path) in triples(argv, "--ro-bind-try")
        # Later mounts cover earlier ones, so these come after the workspace bind.
        assert argv.index(path) > ws_at


def test_tmpdir_and_read_only(make):
    policy = make()
    argv = bwrap.command(policy, ["x"])
    tmp, extra = str(policy.tmpdir), str(policy.read_only[0])
    assert ("--bind", tmp, tmp) in triples(argv, "--bind")
    assert ("--ro-bind-try", extra, extra) in triples(argv, "--ro-bind-try")
    assert argv[argv.index("--chdir") + 1] == str(policy.workspace)


def test_home_is_not_mounted(make):
    argv = bwrap.command(make(), ["x"])
    assert "/home" not in argv and "/root" not in argv and "/run/user" not in " ".join(argv)
