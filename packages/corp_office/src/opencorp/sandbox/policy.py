"""What one sandboxed call may touch."""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path


# Home paths holding credentials or office state; a workspace may not be one of them or
# lie inside one, since the workspace is readable (and maybe writable) by model code.
SENSITIVE_HOME_PATHS = (
    ".opencorp",
    ".ssh",
    ".aws",
    ".gnupg",
    ".config",
    "Library",
    ".claude",
    ".codex",
    ".docker",
    ".kube",
    ".netrc",
)


class UnsafeWorkspace(ValueError):
    """The workspace would expose the home directory, the whole disk, or credentials."""


def _real(path: str | os.PathLike[str]) -> Path:
    # Seatbelt matches resolved paths (/private/var/..., not /var/...), so every
    # path the profile names must be resolved the same way.
    return Path(os.path.realpath(path))


def check_workspace(workspace: str | os.PathLike[str]) -> None:
    """Raise `UnsafeWorkspace` if `workspace` is `/`, contains the home directory, or is or
    lies inside a sensitive home path (`SENSITIVE_HOME_PATHS`)."""
    workspace = _real(workspace)
    home = _real(Path.home())
    if workspace == Path("/") or home.is_relative_to(workspace):
        raise UnsafeWorkspace(
            f"workspace {workspace} contains the home directory {home}; "
            "use a project folder"
        )
    for rel in SENSITIVE_HOME_PATHS:
        sensitive = _real(home / rel)
        if workspace.is_relative_to(sensitive):
            raise UnsafeWorkspace(
                f"workspace {workspace} is inside the sensitive path {sensitive}; "
                "use a project folder"
            )


@dataclass(frozen=True)
class SandboxPolicy:
    """The access one sandboxed call gets.

    Args:
        workspace: The session's folder; readable, and writable if `writable`.
        writable: Whether the workspace is writable (`harness_policy.sandbox` is
            `workspace-write`). Its `.git`, `.git/hooks`, and `.git/config` stay read-only.
        network: Whether the call may use IP networking (`harness_policy.network`).
        tmpdir: A private, writable temp directory; also the call's `HOME` and `TMPDIR`.
        read_only: Extra read-only paths, such as the interpreter the file tools run on.

    Raises:
        ValueError: `workspace` or `tmpdir` is not an existing directory.
        UnsafeWorkspace: `workspace` is `/`, contains the home directory, or is or lies
            inside a sensitive home path (`SENSITIVE_HOME_PATHS`).
    """

    workspace: Path
    writable: bool
    network: bool
    tmpdir: Path
    read_only: tuple[Path, ...] = field(default=())

    def __post_init__(self) -> None:
        for name in ("workspace", "tmpdir"):
            path = _real(getattr(self, name))
            if not path.is_dir():
                raise ValueError(f"{name} {path} is not an existing directory")
            object.__setattr__(self, name, path)
        read_only: Iterable[str | os.PathLike[str]] = self.read_only
        object.__setattr__(self, "read_only", tuple(_real(p) for p in read_only))
        check_workspace(self.workspace)

    @property
    def protected(self) -> tuple[Path, ...]:
        """Return the workspace paths that stay read-only in a writable workspace."""
        git = self.workspace / ".git"
        return (git, git / "hooks", git / "config")
