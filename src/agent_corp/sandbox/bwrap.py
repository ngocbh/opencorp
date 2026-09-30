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
        args += ["--bind", ws, ws]
        # Mounted after the workspace so they cover it. A missing .git/hooks stays
        # missing, and is then writable: bind mounts need an existing source.
        for path in map(str, policy.protected[1:]):
            args += ["--ro-bind-try", path, path]
    else:
        args += ["--ro-bind", ws, ws]
    # The tmpfs root holds only mount points; read-only, so writes outside the
    # binds fail instead of landing in a throwaway directory.
    return [*args, "--remount-ro", "/", "--chdir", ws, "--", *argv]
