"""The office's clone of the company repo: pinned worktrees, the repo lock, commits."""

import os
import shutil
import stat
import subprocess
import threading
from pathlib import Path

_IDENTITY = ["-c", "user.name=agent-corp office", "-c", "user.email=office@agent-corp.local"]
_PIN_MARKER = ".agent-corp-pin"
_WRITE = stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH


class CompanyGit:
    """Git operations on one company clone. Hold ``lock`` around any write sequence."""

    def __init__(self, root: Path, worktrees: Path) -> None:
        self.root = root
        self.worktrees = worktrees
        self.lock = threading.RLock()

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(self.root), *_IDENTITY, *args],
                              check=check, capture_output=True, text=True)

    def head(self) -> str:
        """Return the commit id at HEAD."""
        return self.resolve("HEAD")

    def resolve(self, commit: str) -> str:
        """Return the full sha of ``commit`` (a sha, branch, or ``HEAD``); ValueError if unknown."""
        out = self._git("rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}", check=False)
        if out.returncode != 0:
            raise ValueError(f"unknown commit {commit!r}")
        return out.stdout.strip()

    def blob_id(self, relpath: str, commit: str = "HEAD") -> str | None:
        """Return the git blob id of ``relpath`` at ``commit``, or None if it is absent."""
        out = self._git("rev-parse", "--verify", "--quiet", f"{commit}:{relpath}", check=False)
        return out.stdout.strip() or None

    def commit(self, paths: list[str], message: str) -> str:
        """Stage ``paths`` and commit them; return the new HEAD, or HEAD unchanged if nothing changed."""
        with self.lock:
            self._git("add", "--", *paths)
            # `git commit` exits 1 on an empty commit; callers rely on a no-op write succeeding.
            if self._git("diff", "--cached", "--quiet", "--", *paths, check=False).returncode == 0:
                return self.head()
            self._git("commit", "-q", "-m", message, "--", *paths)
            return self.head()

    def pin(self, commit: str) -> Path:
        """Return a read-only worktree for ``commit``, keyed by full sha, creating it if needed.

        The marker file is written last, so a dir without it (a crash mid-setup, or a
        half-deleted dir) is rebuilt from scratch. Only files are made read-only, so
        ``git worktree remove --force`` and ``shutil.rmtree`` still work on a pin.
        """
        sha = self.resolve(commit)
        path = self.worktrees / sha
        with self.lock:
            if not (path / _PIN_MARKER).is_file():
                if path.exists():
                    shutil.rmtree(path)
                self._git("worktree", "prune")  # drop the registration of a removed dir
                self.worktrees.mkdir(parents=True, exist_ok=True)
                self._git("worktree", "add", "--detach", str(path), sha)
                for dirpath, _, files in os.walk(path):
                    for name in files:
                        p = Path(dirpath, name)
                        # chmod follows symlinks, which may point outside the pin.
                        if name != ".git" and not p.is_symlink():
                            p.chmod(p.stat().st_mode & ~_WRITE)
                (path / _PIN_MARKER).write_text(sha + "\n")
        return path
