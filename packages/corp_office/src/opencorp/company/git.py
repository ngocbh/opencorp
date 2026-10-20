"""The office's clone of the company repo: pinned worktrees, the repo lock, commits."""

import os
import re
import shutil
import stat
import subprocess
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from opencorp.protocol import stamp
from opencorp.protocol.models import CommitInfo

_IDENTITY = ["-c", "user.name=OpenCorp office", "-c", "user.email=office@opencorp.local"]
# Repo-local config and hooks still apply after the env is cleaned; never sign or run hooks.
_NO_HOOKS = ["-c", "commit.gpgsign=false", "-c", f"core.hooksPath={os.devnull}"]
_PIN_MARKER = ".opencorp-pin"
_WRITE = stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
# `:(glob)` makes `*` match one path segment, so only people/<handle>/profile.md matches.
_PROFILES = ":(glob)people/*/profile.md"
_BLOB_ID = re.compile(r"[0-9a-f]{40}")
_COMMIT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_KINDS = {"040000": "folder", "100644": "file", "100755": "file", "120000": "symlink", "160000": "submodule"}


@dataclass(frozen=True)
class TreeEntry:
    """One entry of a commit's tree: its repo path, kind, object id and blob size (None for a folder or submodule).

    ``path`` is decoded with surrogateescape, so a name that isn't UTF-8 holds lone surrogates.
    """

    path: str
    type: str
    blob: str
    size: int | None


def is_commit_id(value: object) -> bool:
    """Whether ``value`` is a full hex commit id (sha-1 or sha-256), as opposed to any other rev expression."""
    return isinstance(value, str) and _COMMIT_ID.fullmatch(value) is not None


def _full_id(commit: str) -> str:
    """``commit`` if it is a full hex commit id; ValueError otherwise, so no rev expression reaches git."""
    if not is_commit_id(commit):
        raise ValueError(f"not a full commit id: {commit!r}")
    return commit


def _replace_surrogates(text: str) -> str:
    """``text`` with the lone surrogates of bytes that weren't UTF-8 as U+FFFD, so it can go into JSON."""
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


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
                             stdin=subprocess.DEVNULL, capture_output=True, env=_env(),
                             # surrogateescape round-trips non-UTF-8 paths back into git args.
                             encoding="utf-8", errors="surrogateescape")
        if check and out.returncode != 0:
            raise CompanyGitError(f"git {' '.join(args)} exited {out.returncode}: {out.stderr.strip()}")
        return out

    def head(self) -> str:
        """Return the commit id at HEAD."""
        return self.resolve("HEAD")

    def read_head(self) -> str:
        """Return the commit id at HEAD read straight from the ref files, falling back to ``head``.

        It costs two small file reads instead of a git process, for checks made on every request.
        """
        gitdir = self.root / ".git"
        try:
            head = (gitdir / "HEAD").read_text().strip()
            if head.startswith("ref: "):
                ref = head.removeprefix("ref: ")
                loose = gitdir / ref
                if loose.is_file():
                    head = loose.read_text().strip()
                else:  # `git gc` moves refs into packed-refs
                    packed = (gitdir / "packed-refs").read_text().splitlines()
                    head = next((line.split()[0] for line in packed if line.endswith(f" {ref}")), "")
            if _COMMIT_ID.fullmatch(head):
                return head
        except OSError:
            pass
        return self.head()

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

    def files(self, folder: str, commit: str = "HEAD") -> dict[str, str]:
        """Return the blob id of every file under ``folder`` at ``commit``, by repo path."""
        out = self._git("ls-tree", "-r", "-z", "--full-tree", commit, "--", *_literal([folder])).stdout
        found = {}
        for entry in filter(None, out.split("\0")):
            info, _, path = entry.partition("\t")
            _, kind, blob = info.split()
            if kind == "blob":
                found[path] = blob
        return found

    def list_tree(self, commit: str) -> list[TreeEntry]:
        """Every entry of the tree at ``commit`` (a full hex id), folders included; modes other than a folder, a
        file, a symlink or a submodule are left out."""
        out = self._git("ls-tree", "-r", "-t", "-z", "-l", "--full-tree", _full_id(commit)).stdout
        found = []
        for entry in filter(None, out.split("\0")):
            info, _, path = entry.partition("\t")
            mode, _, blob, size = info.split()
            if (kind := _KINDS.get(mode)) is not None:
                found.append(TreeEntry(path, kind, blob, int(size) if size.isdecimal() else None))
        return found

    def commit_info(self, commit: str) -> CommitInfo:
        """The subject, author name (never the email) and commit time of ``commit`` (a full hex id)."""
        # --no-show-signature: a repo's log.showSignature would put gpg's output before the format.
        out = self._git("log", "-1", "--no-show-signature", "--format=%H%x00%s%x00%an%x00%ct",
                        _full_id(commit)).stdout
        sha, subject, author, ct = out.rstrip("\n").split("\0")
        return CommitInfo(id=sha, subject=_replace_surrogates(subject), author=_replace_surrogates(author),
                          time=stamp(datetime.fromtimestamp(int(ct), UTC)))

    def read_blob(self, blob_id: str) -> bytes | None:
        """Return the bytes of blob ``blob_id`` (40 lowercase hex), or None if the clone has no such blob."""
        if not _BLOB_ID.fullmatch(blob_id):  # keep rev expressions such as HEAD:<path> away from git
            return None
        # Bytes, not _git's text mode, which turns \r\n into \n.
        out = subprocess.run(["git", "-C", str(self.root), "cat-file", "blob", blob_id],
                             stdin=subprocess.DEVNULL, capture_output=True, env=_env())
        return out.stdout if out.returncode == 0 else None

    def read_blobs(self, blob_ids: list[str]) -> dict[str, bytes]:
        """Return the bytes of each blob in ``blob_ids`` that the clone has, by id, read in one git call."""
        ids = [b for b in dict.fromkeys(blob_ids) if _BLOB_ID.fullmatch(b)]
        if not ids:
            return {}
        out = subprocess.run(["git", "-C", str(self.root), "cat-file", "--batch"], input=b"".join(
            f"{b}\n".encode() for b in ids), capture_output=True, env=_env()).stdout
        found, at = {}, 0
        for blob in ids:
            end = out.index(b"\n", at)
            header = out[at:end].split()
            at = end + 1
            if len(header) < 3:  # "<id> missing"
                continue
            size = int(header[2])
            if header[1] == b"blob":
                found[blob] = out[at:at + size]
            at += size + 1
        return found

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
                # The directory is the handle; one line, so a hand-made name can't add a trailer.
                handle = " ".join(Path(rel).parent.name.split())
                self.commit([rel], f"profile(@{handle}): hand edit")
            return sorted(paths)
