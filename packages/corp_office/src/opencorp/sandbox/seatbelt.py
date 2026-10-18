"""Seatbelt (macOS `sandbox-exec`) profiles for sandboxed calls."""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

from opencorp.sandbox.policy import SandboxPolicy

SYSTEM_SUBPATHS = (
    "/usr",
    "/bin",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/private/etc/ssl",
    "/private/var/db/timezone",
)
SYSTEM_LITERALS = (
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/private/etc/services",
    "/private/etc/protocols",
    "/private/etc/localtime",
    "/private/etc/passwd",
    "/private/etc/group",
    "/private/etc/shells",
    # /bin/sh execs the shell this link names.
    "/private/var/select/sh",
    # xcrun shims such as /usr/bin/git find the developer directory through these.
    "/private/var/select/developer_dir",
    "/private/var/db/xcode_select_link",
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
)
# Top-level links that path lookups go through.
ROOT_LINKS = ("/etc", "/tmp", "/var")
MACH_SERVICES = (
    "com.apple.system.opendirectoryd.libinfo",  # getpwuid and friends
    "com.apple.system.notification_center",  # notify(3), used by libc time zone code
)
NETWORK_MACH_SERVICES = (
    "com.apple.dnssd.service",
    "com.apple.SystemConfiguration.configd",
    "com.apple.trustd.agent",
)
SYSCTL_PREFIXES = ("hw.", "machdep.cpu.")
SYSCTL_NAMES = (
    "kern.argmax",
    "kern.boottime",
    "kern.hostname",
    "kern.maxfilesperproc",
    "kern.maxproc",
    "kern.ngroups",
    "kern.osproductversion",
    "kern.osrelease",
    "kern.ostype",
    "kern.osvariant_status",
    "kern.osversion",
    "kern.secure_kernel",
    "kern.usrstack64",
    "kern.version",
    "sysctl.proc_cputype",
    "vm.loadavg",
)
DNS_SOCKET = "/private/var/run/mDNSResponder"


def profile(policy: SandboxPolicy, canary: Path | None = None) -> str:
    """Return a default-deny SBPL profile that allows exactly what `policy` grants.

    Allowed: system and toolchain paths read-only, the workspace (read, or read-write
    with `.git`, `.git/hooks`, and `.git/config` read-only), the private tmpdir, the
    policy's extra read-only paths, a few mach services, and IP networking only if
    `policy.network`. Everything else, including unix sockets, Apple Events, and
    LaunchServices, is denied.

    `canary`, a directory, gets a `file-write-data` rule (a no-op on a directory) that
    marks processes running under this profile; see `sandbox.escapees`.
    """
    developer = _developer_dir()
    readable = [str(policy.workspace), str(policy.tmpdir), *map(str, policy.read_only)]
    if developer:
        readable.append(developer)
    ws = policy.workspace
    lines = [
        "(version 1)",
        "(deny default)",
        ";; Processes: children inherit this profile; no reach into other processes.",
        "(allow process-exec process-fork)",
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        _allow(
            "sysctl-read",
            [f"(sysctl-name-prefix {_q(p)})" for p in SYSCTL_PREFIXES]
            + [f"(sysctl-name {_q(n)})" for n in SYSCTL_NAMES],
        ),
        _allow("mach-lookup", [f"(global-name {_q(n)})" for n in MACH_SERVICES]),
        '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
        ";; System and toolchain, read-only.",
        _allow(
            "file-read*",
            ['(literal "/")']
            + [f"(subpath {_q(p)})" for p in (*SYSTEM_SUBPATHS, *([developer] if developer else []))]
            + [f"(literal {_q(p)})" for p in SYSTEM_LITERALS],
        ),
        '(allow file-write-data (literal "/dev/null"))',
        ";; The call's own descriptors by path, so `echo x > /dev/stderr` works.",
        '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))',
        ";; Ancestors of allowed paths: metadata only, so lookups and realpath work.",
        _allow("file-read-metadata", [f"(literal {_q(p)})" for p in (*ROOT_LINKS, *_ancestors(readable))]),
        ";; The workspace.",
    ]
    if policy.writable:
        git, hooks, config = policy.protected
        lines += [
            f"(allow file-read* file-write* (subpath {_q(ws)}))",
            ";; Model code must not plant git hooks or config the owner later runs",
            ";; unsandboxed, nor rename .git to swap in a planted one.",
            f"(deny file-write* (literal {_q(git)}) (subpath {_q(hooks)}) (literal {_q(config)}))",
        ]
    else:
        lines.append(f"(allow file-read* (subpath {_q(ws)}))")
    lines += [
        ";; The private temp directory.",
        f"(allow file-read* file-write* (subpath {_q(policy.tmpdir)}))",
    ]
    if policy.read_only:
        lines.append(_allow("file-read*", [f"(subpath {_q(p)})" for p in policy.read_only]))
    if canary is not None:
        lines += [
            ";; Marks this call's processes; see sandbox.escapees.",
            f"(allow file-write-data (literal {_q(canary)}))",
        ]
    if policy.network:
        lines += [
            ";; IP networking only: unix sockets (office, tmux) stay denied.",
            "(allow network-outbound (remote ip))",
            "(allow network-inbound (local ip))",
            "(allow network-bind (local ip))",
            f"(allow network-outbound (remote unix-socket (path-literal {_q(DNS_SOCKET)})))",
            _allow("mach-lookup", [f"(global-name {_q(n)})" for n in NETWORK_MACH_SERVICES]),
        ]
    return "\n".join(lines) + "\n"


def _allow(op: str, filters: Iterable[str]) -> str:
    return f"(allow {op} " + " ".join(filters) + ")"


def _q(value: str | os.PathLike[str]) -> str:
    """Quote a string for SBPL."""
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ancestors(paths: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for path in paths:
        for parent in Path(path).parents:
            seen[str(parent)] = None
    return list(seen)


def _developer_dir() -> str | None:
    """Return the selected Xcode or Command Line Tools directory, if any."""
    link = "/private/var/select/developer_dir"
    return os.path.realpath(link) if os.path.islink(link) else None
