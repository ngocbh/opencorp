"""bubblewrap (Linux) command lines for sandboxed calls."""

from __future__ import annotations

import os

from agent_corp.sandbox.policy import SandboxPolicy

# Top-level system directories; on merged-/usr systems some are links into /usr.
SYSTEM_DIRS = ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt/homebrew")
SYSTEM_FILES = (
    "/etc/alternatives",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
    "/etc/nsswitch.conf",
    "/etc/hosts",
    "/etc/resolv.conf",
)
# systemd-resolved's stub, which /etc/resolv.conf points to on Ubuntu.
NETWORK_PATHS = ("/run/systemd/resolve",)


def command(policy: SandboxPolicy, argv: list[str]) -> list[str]:
    """Return the `bwrap` argv that runs `argv` under `policy`.

    The call gets new pid, ipc, uts, and (unless `policy.network`) network namespaces, a
    fresh `/proc` that shows only its own processes, and a new session. It dies with its
    parent. Only system paths, the workspace, the tmpdir, and the policy's read-only
    paths are mounted; the home directory, `/run/user` (the D-Bus user bus), and every
    other path are absent.
    """
    args = [
        "bwrap",
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--new-session",
    ]
    if not policy.network:
        args.append("--unshare-net")
    for path in SYSTEM_DIRS:
        if os.path.islink(path):
            args += ["--symlink", os.readlink(path), path]
        else:
            args += ["--ro-bind-try", path, path]
    for path in SYSTEM_FILES + (NETWORK_PATHS if policy.network else ()):
        args += ["--ro-bind-try", path, path]
    args += ["--proc", "/proc", "--dev", "/dev"]
    for path in policy.read_only:
        args += ["--ro-bind-try", str(path), str(path)]
    args += ["--bind", str(policy.tmpdir), str(policy.tmpdir)]
    ws = str(policy.workspace)
    if policy.writable:
        args += ["--bind", ws, ws, *_git_binds(policy)]
    else:
        args += ["--ro-bind", ws, ws]
    # The tmpfs root holds only mount points; read-only, so writes outside the
    # binds fail instead of landing in a throwaway directory.
    return [*args, "--remount-ro", "/", "--chdir", ws, "--", *argv]


def _git_binds(policy: SandboxPolicy) -> list[str]:
    """Return the mounts that keep a writable workspace's `.git` protected.

    They come after the workspace bind so they cover it. `.git` is bound onto itself:
    Linux refuses to rename a mount point, but not a directory that merely contains one,
    so binding only `.git/hooks` and `.git/config` would leave `mv .git .git2` open.
    A missing `.git/hooks` is created first, since a bind needs an existing source; a
    missing `.git/config` stays missing, and is then writable.

    Symlinks are never bound: bwrap follows them on both sides, so model code could point
    `.git/config` at `~/.ssh/id_ed25519` and have the next call mount the key.
    """
    git, hooks, config = policy.protected
    if git.is_symlink():
        return []
    if git.is_file():
        # A worktree's .git file names the real git dir.
        return ["--ro-bind", str(git), str(git)]
    if not git.is_dir():
        return []
    if not os.path.lexists(hooks):
        hooks.mkdir()
    binds = ["--bind", str(git), str(git)]
    for path in (hooks, config):
        if not path.is_symlink():
            binds += ["--ro-bind-try", str(path), str(path)]
    return binds
