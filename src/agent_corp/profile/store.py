"""A person's profile.md in the company clone as a composer MarkdownStore, versioned by git blob id."""

import hashlib
import os
import re
import tempfile
from pathlib import Path

from agent_composer.memory.contracts import JsonObject
from agent_composer.memory.storage.markdown import MarkdownVersionMismatch

from agent_corp.company.git import CompanyGit, CompanyGitError

EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
_ID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9](?:-?[a-z0-9])*")  # the protocol's Id
_ID_MAX = 64
_TOKEN = re.compile(r"\S+")


def blob_id(data: bytes) -> str:
    """The git blob id of ``data``."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def commit_message(handle: str, provenance: JsonObject | None) -> str:
    """``profile(@<handle>): <source>``, with a ``Commit-Id`` trailer when ``provenance`` has one.

    ``source`` falls back to ``from feedback on run <run_id>`` (composer's provenance has a
    run id but no source), then to ``write``.
    """
    p = provenance or {}
    source, run_id, commit_id = p.get("source"), p.get("run_id"), _commit_id(p)
    if not (isinstance(source, str) and source.strip()):
        source = f"from feedback on run {run_id}" if isinstance(run_id, str) and run_id else "write"
    # One line, whatever the caller sent, so neither part can add a trailer.
    subject = f"profile(@{' '.join(handle.split())}): {' '.join(source.split())}"
    return subject if commit_id is None else f"{subject}\n\nCommit-Id: {commit_id}"


def _commit_id(provenance: JsonObject | None) -> str | None:
    """``provenance["commit_id"]``, or None; ValueError if it isn't one non-blank token."""
    commit_id = (provenance or {}).get("commit_id")
    if commit_id is not None and not (isinstance(commit_id, str) and _TOKEN.fullmatch(commit_id)):
        raise ValueError(f"commit_id must be a string without whitespace, not {commit_id!r}")
    return commit_id


class GitProfileStore:
    """``people/<person_id>/profile.md`` in the company clone, as a composer ``MarkdownStore``.

    Versions are git blob ids, and every version handed out is committed, so it stays
    readable. Every write is a commit. The constructor does no I/O: the office builds one
    per request on its event loop.
    """

    def __init__(self, git: CompanyGit, person_id: str) -> None:
        if not (isinstance(person_id, str) and len(person_id) <= _ID_MAX and _ID.fullmatch(person_id)):
            raise ValueError(f"not a person id: {person_id!r}")
        self.git = git
        self.person_id = person_id
        self.path = f"people/{person_id}/profile.md"

    def read(self, version: str | None = None) -> tuple[str, str]:
        """Return ``(text, version)``. Reading the current version commits pending hand edits first.

        Raises ``LookupError`` for an unknown version, ``ValueError`` for text that is not
        UTF-8, and ``OSError`` when git fails.
        """
        if version is not None:
            data = self._blob(version)
            if data is None:
                raise LookupError(f"unknown profile version {version!r}")
            return data.decode("utf-8"), version
        try:
            with self.git.lock:
                self.git.commit_hand_edits()
                current = self._current()
                data = self._blob(current)
        except CompanyGitError as exc:
            raise OSError(str(exc)) from exc
        if data is None:
            raise OSError(f"blob {current} of {self.path} is missing from the clone")
        return data.decode("utf-8"), current

    def write(self, text: str, *, base_version: str, provenance: JsonObject | None = None) -> str:
        """Replace the profile and commit it if ``base_version`` is current; return the new version.

        If a write with the same ``provenance["commit_id"]`` was already committed for this
        profile, return its version and write nothing (a retried write). Raises
        ``MarkdownVersionMismatch`` for a stale base, ``ValueError`` for a bad commit id or a
        profile path through a symlink, and ``OSError`` when git fails.
        """
        if type(text) is not str or type(base_version) is not str:
            raise TypeError("text and base_version must be strings")
        commit_id = _commit_id(provenance)
        data = text.encode("utf-8")
        try:
            with self.git.lock:
                if commit_id is not None and (done := self._committed(commit_id)) is not None:
                    return done
                self.git.commit_hand_edits()  # a pending hand edit is the current version
                current = self._current()
                if current != base_version:
                    raise MarkdownVersionMismatch(base_version, current)
                message = commit_message(self.git.handle(self.path), provenance)
                target = self._target()
                previous = target.read_bytes() if target.exists() else None
                self._put(target, data)
                try:
                    self.git.commit([self.path], message)
                except BaseException:
                    # Left on disk, the text would be committed later as a hand edit without
                    # its Commit-Id, and a retry of this write would get a mismatch.
                    self._restore(target, previous, current)
                    raise
                return self._current()
        except CompanyGitError as exc:
            raise OSError(str(exc)) from exc

    def committed(self, commit_id: str) -> str | None:
        """The version a write with ``commit_id`` committed for this profile, or None if none did."""
        try:
            return self._committed(commit_id)
        except CompanyGitError as exc:
            raise OSError(str(exc)) from exc

    def _committed(self, commit_id: str) -> str | None:
        sha = self.git.find_commit(self.path, f"Commit-Id: {commit_id}")
        return None if sha is None else self.git.blob_id(self.path, sha) or EMPTY_BLOB

    def _current(self) -> str:
        """The blob id of the profile at HEAD; a missing profile is the empty blob."""
        return self.git.blob_id(self.path) or EMPTY_BLOB

    def _blob(self, version: str) -> bytes | None:
        # The empty blob is only in the object store once some empty file was committed.
        return b"" if version == EMPTY_BLOB else self.git.read_blob(version)

    def _target(self) -> Path:
        """The profile's path in the clone; ValueError if it leaves the person's directory."""
        target = self.git.root / self.path
        if target.is_symlink() or target.parent.resolve() != self.git.root.resolve() / "people" / self.person_id:
            raise ValueError(f"{self.path} goes through a symlink; not writing it")
        return target

    def _put(self, target: Path, data: bytes) -> None:
        """Replace ``target`` with ``data`` through a temporary file in the same directory."""
        # mkstemp makes the file 0600; keep the profile's mode, or git's default for a new file.
        mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
        fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".profile.md.")
        try:
            with os.fdopen(fd, "wb") as handle:
                os.fchmod(handle.fileno(), mode)
                handle.write(data)
            os.replace(temporary, target)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    def _restore(self, target: Path, previous: bytes | None, current: str) -> None:
        """Put back the profile a failed commit left on disk, and unstage it; best effort."""
        try:
            if self._current() != current:  # the commit landed before the failure; keep it
                return
            if previous is None:
                target.unlink(missing_ok=True)
            else:
                self._put(target, previous)
            self.git.unstage([self.path])
        except (OSError, CompanyGitError):
            pass  # the caller needs the commit's error, not this one
