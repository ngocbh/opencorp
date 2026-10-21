"""The company repo's files at the HEADs the office served, for HQ's read-only Source view, shown as stored."""

import asyncio
import re
from collections import OrderedDict
from dataclasses import dataclass

from opencorp.company.git import CompanyGit, TreeEntry, is_commit_id
from opencorp.protocol.models import CompanyFile, CompanyTree, CompanyTreeEntry

RING = 8
"""How many served HEADs a file can be read at."""
RENDERED = 32
"""How many rendered files are kept, by commit and path."""
TREE_CAP = 5000
"""The most entries a tree response carries."""
MAX_FILE = 1 << 20
"""The largest file read, in bytes; a bigger one is ``too_large``."""
MAX_LINK = 4 << 10
"""The largest symlink target read, in bytes; a bigger one is ``too_large``."""

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class SourceError(Exception):
    """A file request the Source view refuses: ``status`` and ``code`` as the API returns them."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def bad_path(path: object) -> bool:
    """Whether ``path`` isn't a repo-relative, ``/``-separated path with no empty, ``.`` or ``..`` segment or NUL."""
    if not isinstance(path, str) or not path or "\0" in path:
        return True
    return any(seg in ("", ".", "..") for seg in path.split("/"))


def _utf8(path: str) -> bool:
    """Whether ``path`` came from valid UTF-8: surrogateescape turns any other byte into a lone surrogate."""
    try:
        path.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _text(data: bytes) -> str | None:
    """``data`` as text: strict UTF-8 with no C0 control character but tab, LF and CR; None means binary."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return None if _CONTROL.search(text) else text


@dataclass(frozen=True)
class Served:
    """A HEAD the tree route listed: its readable entries by path and the tree response."""

    listing: dict[str, TreeEntry]
    tree: CompanyTree


def load(git: CompanyGit, sha: str) -> Served:
    """The listing and tree response at ``sha``, a HEAD the office read itself."""
    listing: dict[str, TreeEntry] = {}
    skipped = 0
    for entry in git.list_tree(sha):
        if not _utf8(entry.path) or bad_path(entry.path):
            skipped += 1
        else:
            listing[entry.path] = entry
    info = git.commit_info(sha)
    ordered = sorted(listing.values(), key=lambda e: (e.path.count("/"), e.path))
    tree = CompanyTree(commit=info, truncated=len(ordered) > TREE_CAP, skipped=skipped,
                       entries=[CompanyTreeEntry(path=e.path, type=e.type, size=e.size)
                                for e in ordered[:TREE_CAP]])
    return Served(listing=listing, tree=tree)


def render(git: CompanyGit, sha: str, entry: TreeEntry) -> CompanyFile:
    """The file response for ``entry`` at ``sha``: its text as stored, or why it has none."""
    def out(content: str, **fields) -> CompanyFile:
        return CompanyFile(path=entry.path, commit=sha, content=content, **fields)

    if entry.type == "submodule":
        return out("submodule")
    if (entry.size or 0) > (MAX_LINK if entry.type == "symlink" else MAX_FILE):
        return out("too_large")
    data = git.read_blob(entry.blob)
    if data is None:
        raise RuntimeError(f"the clone has no blob for {entry.path!r} at {sha}")
    text = _text(data)
    if text is None:
        return out("binary")
    if entry.type == "symlink":  # shown, never followed
        return out("symlink", target=text)
    return out("text", text=text)


class CompanySource:
    """The Source view's reads: trees at HEADs, loaded once per commit off the loop, and files at the last ``RING``
    of them. Use it on the office loop.

    Only commits the tree route lists enter the ring, so a file read never reaches a commit, ref or revision
    expression from a request.
    """

    def __init__(self, git: CompanyGit) -> None:
        self.git = git
        self._ring: OrderedDict[str, Served] = OrderedDict()
        self._loading: dict[str, asyncio.Future[Served]] = {}
        self._rendered: OrderedDict[tuple[str, str], CompanyFile] = OrderedDict()

    async def tree(self, sha: str) -> CompanyTree:
        """The tree at ``sha``, a HEAD the office read itself; it becomes the newest commit files can be read at."""
        served = self._ring.get(sha)
        if served is None:
            future = self._loading.get(sha)
            if future is None:
                future = asyncio.ensure_future(asyncio.to_thread(load, self.git, sha))
                self._loading[sha] = future
                future.add_done_callback(lambda _: self._loading.pop(sha, None))
            # Shielded: one caller going away mustn't cancel the load the others wait on.
            served = await asyncio.shield(future)
        self._ring[sha] = served
        self._ring.move_to_end(sha)
        while len(self._ring) > RING:
            self._ring.popitem(last=False)
        return served.tree

    async def file(self, at: object, path: object) -> CompanyFile:
        """The file at ``path`` in the listing of served HEAD ``at``.

        ``SourceError``: 400 ``bad_path`` for a malformed path, 409 ``stale_commit`` when ``at`` isn't in the ring,
        404 ``no_file`` for a path not in that listing or a folder.
        """
        if bad_path(path):
            raise SourceError(400, "bad_path", "the path isn't a repo-relative file path")
        # A plain string match against commits the office listed: never resolved by git.
        served = self._ring.get(at) if is_commit_id(at) else None
        if served is None:
            raise SourceError(409, "stale_commit", "that commit isn't one the office served lately; refetch the tree")
        entry = served.listing.get(path)  # type: ignore[arg-type]
        if entry is None or entry.type == "folder":
            raise SourceError(404, "no_file", "no such file in that commit")
        key = (at, entry.path)
        if (done := self._rendered.get(key)) is not None:
            self._rendered.move_to_end(key)
            return done
        found = await asyncio.to_thread(render, self.git, at, entry)
        self._rendered[key] = found
        while len(self._rendered) > RENDERED:
            self._rendered.popitem(last=False)
        return found
