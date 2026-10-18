import pytest

from opencorp.sandbox import bwrap
from opencorp.sandbox.policy import SandboxPolicy


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
    (policy.workspace / ".git").mkdir()
    argv = bwrap.command(policy, ["x"])
    ws, git = str(policy.workspace), str(policy.workspace / ".git")
    # .git is bound onto itself so it is a mount point, which can't be renamed; binding
    # only .git/hooks and .git/config would still let `mv .git .git2` succeed.
    assert ("--bind", git, git) in triples(argv, "--bind")
    # Later mounts cover earlier ones: workspace, then .git, then the read-only paths.
    assert argv.index(ws) < argv.index(git)
    for path in map(str, policy.protected[1:]):
        assert ("--ro-bind-try", path, path) in triples(argv, "--ro-bind-try")
        assert argv.index(path) > argv.index(git)


def test_missing_git_hooks_is_created_so_it_can_be_bound(make):
    policy = make()
    (policy.workspace / ".git").mkdir()
    bwrap.command(policy, ["x"])
    assert (policy.workspace / ".git/hooks").is_dir()


def test_git_file_is_read_only(make):
    # A worktree's .git is a file naming the real git dir; it must not be rewritten.
    policy = make()
    (policy.workspace / ".git").write_text("gitdir: /elsewhere\n")
    argv = bwrap.command(policy, ["x"])
    git = str(policy.workspace / ".git")
    assert ("--ro-bind", git, git) in triples(argv, "--ro-bind")
    assert ("--bind", git, git) not in triples(argv, "--bind")


def test_git_symlinks_are_never_bound(make, tmp_path):
    # bwrap follows symlinks, so binding one would mount its target in the sandbox.
    secret = tmp_path / "secret"
    secret.mkdir()
    policy = make()
    git = policy.workspace / ".git"
    git.mkdir()
    (git / "hooks").symlink_to(secret)
    (git / "config").symlink_to(secret / "key")
    argv = bwrap.command(policy, ["x"])
    assert str(git / "hooks") not in argv and str(git / "config") not in argv
    (git / "hooks").unlink()
    (git / "config").unlink()
    git.rmdir()
    git.symlink_to(secret)
    assert str(git) not in bwrap.command(policy, ["x"])
    assert not (secret / "hooks").exists()


def test_no_git_no_git_binds(make):
    policy = make()
    argv = bwrap.command(policy, ["x"])
    assert not (policy.workspace / ".git").exists()
    assert str(policy.workspace / ".git") not in argv


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
