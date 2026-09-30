"""A person's profile.md in the company clone as a composer MarkdownStore, versioned by git blob id."""

import hashlib
import re

from agent_corp.company.git import CompanyGit, CompanyGitError

EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
_ID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9](?:-?[a-z0-9])*")  # the protocol's Id
_ID_MAX = 64


def blob_id(data: bytes) -> str:
    """The git blob id of ``data``."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class GitProfileStore:
    """``people/<person_id>/profile.md`` in the company clone, as a composer ``MarkdownStore``.

    Versions are git blob ids, and every version handed out is committed, so it stays
    readable. The constructor does no I/O: the office builds one per request on its
    event loop.
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

    def _current(self) -> str:
        """The blob id of the profile at HEAD; a missing profile is the empty blob."""
        return self.git.blob_id(self.path) or EMPTY_BLOB

    def _blob(self, version: str) -> bytes | None:
        # The empty blob is only in the object store once some empty file was committed.
        return b"" if version == EMPTY_BLOB else self.git.read_blob(version)
