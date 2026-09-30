"""The office's clone of the company repo: pinned worktrees, the repo lock, commits."""

import os
import re
import shutil
import stat
import subprocess
import threading
from pathlib import Path

import yaml

_IDENTITY = ["-c", "user.name=agent-corp office", "-c", "user.email=office@agent-corp.local"]
# Repo-local config and hooks still apply after the env is cleaned; never sign or run hooks.
_NO_HOOKS = ["-c", "commit.gpgsign=false", "-c", f"core.hooksPath={os.devnull}"]
_PIN_MARKER = ".agent-corp-pin"
_WRITE = stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
# `:(glob)` makes `*` match one path segment, so only people/<id>/profile.md matches.
_PROFILES = ":(glob)people/*/profile.md"
_BLOB_ID = re.compile(r"[0-9a-f]{40}")
_HANDLE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?")  # the protocol's Handle


class CompanyGitError(Exception):
    """A git command on the company clone failed; the message includes git's stderr."""


def _env() -> dict[str, str]:
    """os.environ without GIT_* variables, the system or user git config, or prompts."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return env | {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                  "GIT_TERMINAL_PROMPT": "0"}


def _literal(paths: list[str]) -> list[str]:
    """Pathspecs that match ``paths`` exactly, with no glob expansion."""
    return [f":(literal){p}" for p in paths]


class CompanyGit:
    """Git operations on one company clone. Hold ``lock`` around any write sequence.

    ``lock`` covers threads sharing this instance only, not other instances or
    processes, so the daemon must be the only opener of the clone.
    """

    def __init__(self, root: Path, worktrees: Path) -> None:
        self.root = root
        self.worktrees = worktrees
        self.lock = threading.RLock()

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run git in the clone; with ``check``, a non-zero exit raises ``CompanyGitError``."""
        out = subprocess.run(["git", "-C", str(self.root), *_IDENTITY, *_NO_HOOKS, *args],
                             capture_output=True, env=_env(),
                             # surrogateescape round-trips non-UTF-8 paths back into git args.
                             encoding="utf-8", errors="surrogateescape")
        if check and out.returncode != 0:
            raise CompanyGitError(f"git {' '.join(args)} exited {out.returncode}: {out.stderr.strip()}")
        return out

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

    def read_blob(self, blob_id: str) -> bytes | None:
        """Return the bytes of blob ``blob_id`` (40 lowercase hex), or None if the clone has no such blob."""
        if not _BLOB_ID.fullmatch(blob_id):  # keep rev expressions such as HEAD:<path> away from git
            return None
        # Bytes, not _git's text mode, which turns \r\n into \n.
        out = subprocess.run(["git", "-C", str(self.root), "cat-file", "blob", blob_id],
                             capture_output=True, env=_env())
        return out.stdout if out.returncode == 0 else None

    def find_commit(self, relpath: str, line: str) -> str | None:
        """Return the newest commit on HEAD that touches ``relpath`` and has ``line`` as a whole message line."""
        out = self._git("log", "--fixed-strings", f"--grep={line}", "--format=%H%x00%B%x1e", "HEAD",
                        "--", *_literal([relpath])).stdout
        for record in out.split("\x1e"):
            sha, _, body = record.strip("\n").partition("\0")
            if line in body.splitlines():  # --grep matches substrings; a trailer must match whole
                return sha
        return None

    def commit(self, paths: list[str], message: str) -> str:
        """Stage ``paths`` and commit them; return the new HEAD, or HEAD unchanged if nothing changed."""
        if not paths:  # `git commit --` with no paths would commit the whole index
            return self.head()
        with self.lock:
            # lexists: a tracked symlink whose target is gone is still present.
            present = [p for p in paths if os.path.lexists(self.root / p)]
            if present:
                self._git("add", "--", *_literal(present))
            if gone := [p for p in paths if p not in present]:  # a deletion, maybe already staged
                # `git add` fails on a path gone from both disk and index.
                self._git("rm", "-q", "--cached", "--ignore-unmatch", "--", *_literal(gone))
            # `git commit` exits 1 on an empty commit; callers rely on a no-op write succeeding.
            if self._git("diff", "--cached", "--quiet", "--", *_literal(paths),
                         check=False).returncode == 0:
                return self.head()
            self._git("commit", "-q", "-m", message, "--", *_literal(paths))
            return self.head()

    def unstage(self, paths: list[str]) -> None:
        """Reset ``paths`` in the index to HEAD, leaving the working files alone."""
        if paths:  # `git reset -q --` with no paths would reset the whole index
            self._git("reset", "-q", "--", *_literal(paths))

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

    def commit_hand_edits(self) -> list[str]:
        """Commit each changed, new, or deleted ``people/*/profile.md`` on its own; return their paths.

        ``--porcelain -z`` entries are ``XY path``. A rename or copy, staged (X) or in the
        worktree (Y, after ``git add -N``), is followed by a second field, its original
        path; a rename's original is committed too (as a deletion).
        """
        with self.lock:
            # --untracked-files=all lists a new profile inside a wholly untracked people/<new>/.
            out = self._git("status", "--porcelain", "-z", "--untracked-files=all", "--",
                            _PROFILES).stdout
            fields = out.split("\0")
            paths: set[str] = set()
            i = 0
            while i < len(fields):
                entry = fields[i]
                i += 1
                if not entry:
                    continue
                paths.add(entry[3:])
                xy = entry[:2]
                if "R" in xy or "C" in xy:
                    if "R" in xy:
                        paths.add(fields[i])
                    i += 1
            for rel in sorted(paths):
                self.commit([rel], f"profile(@{self.handle(rel)}): hand edit")
            return sorted(paths)

    def handle(self, profile_rel: str) -> str:
        """The handle of the person who owns ``people/<id>/profile.md``, else the id.

        A value that isn't a protocol handle falls back to the id too: the handle goes into
        commit messages, where a newline could forge a ``Commit-Id`` trailer.
        """
        pid = Path(profile_rel).parent.name
        try:
            data = yaml.safe_load((self.root / "people" / pid / "person.yaml").read_text(encoding="utf-8"))
            handle = data["handle"]
        except (OSError, UnicodeDecodeError, yaml.YAMLError, KeyError, TypeError):
            return pid
        return handle if isinstance(handle, str) and _HANDLE.fullmatch(handle) else pid
