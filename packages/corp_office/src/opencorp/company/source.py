"""The company repo's files at the HEADs the office served, for HQ's read-only Source view, with secrets hidden."""

import asyncio
import fnmatch
import re
from collections import OrderedDict
from dataclasses import dataclass

import yaml
from pydantic import ValidationError

from opencorp.company.git import CompanyGit, TreeEntry, is_commit_id
from opencorp.company.secret_keys import (HIDDEN, NotYaml, UnsafeYaml, YamlSecrets, check_clean, find_json_secrets,
                                          find_secrets, is_secret_key, scrub_text)
from opencorp.protocol.models import CommitInfo, CompanyFile, CompanyTree, CompanyTreeEntry, Person

RING = 8
"""How many served HEADs a file can be read at."""
RENDERED = 32
"""How many rendered files are kept, by commit and path."""
TREE_CAP = 5000
"""The most entries a tree response carries."""
MAX_FILE = 1 << 20
"""The largest file read, in bytes; a bigger one is ``too_large``."""
MAX_PARSED = 256 << 10
"""The largest YAML or JSON file read, in bytes, since it is parsed; a bigger one is ``too_large``."""
MAX_LINK = 4 << 10
"""The largest symlink target read, in bytes; a bigger one is ``too_large``."""

CREDENTIAL_NAMES = (".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_dsa*", "id_ecdsa*",
                    "id_ed25519*", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".htpasswd")
"""File names, matched case-insensitively, that are hidden without being read."""

REWRITABLE = ("devices", "password_hash")
"""The only secret keys a human's ``person.yaml`` can be re-rendered without."""

# Fixed reasons: never a quote of the file.
CREDENTIALS = "may hold credentials"
UNSAFE_YAML = "couldn't read this YAML safely"
SECRET_KEY = "holds a secret-named key"
NOT_REMOVED = "a secret couldn't be removed"

_PERSON = re.compile(r"people/[^/]+/person\.yaml")
_QUOTED_KEY = re.compile(r"""["']([A-Za-z0-9_][A-Za-z0-9_ .-]{0,63})["']\s*:""")
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
    """A HEAD the tree route listed: its readable entries by path, the tree response and its known secrets."""

    listing: dict[str, TreeEntry]
    tree: CompanyTree
    known: frozenset[str]


def person_secrets(git: CompanyGit, entries: list[TreeEntry]) -> frozenset[str]:
    """Every string under a secret key in each ``people/<h>/person.yaml`` of ``entries`` that parses: the known values a
    browser must never see."""
    people = [e.blob for e in entries
              if e.type == "file" and _PERSON.fullmatch(e.path) and (e.size or 0) <= MAX_PARSED]
    found: set[str] = set()
    for data in git.read_blobs(people).values():
        try:
            found |= find_secrets(data.decode("utf-8")).values
        except (UnicodeDecodeError, UnsafeYaml):
            continue
    return frozenset(found)


def load(git: CompanyGit, sha: str) -> Served:
    """The listing, tree response and known secret values at ``sha``, a HEAD the office read itself."""
    entries = git.list_tree(sha)
    known = person_secrets(git, entries)
    listing: dict[str, TreeEntry] = {}
    skipped = 0
    for entry in entries:
        if not _utf8(entry.path) or bad_path(entry.path) or not check_clean(entry.path, known):
            skipped += 1
        else:
            listing[entry.path] = entry
    info = git.commit_info(sha)
    info = CommitInfo(id=info.id, time=info.time,
                      subject=info.subject if check_clean(info.subject, known) else HIDDEN,
                      author=info.author if check_clean(info.author, known) else HIDDEN)
    ordered = sorted(listing.values(), key=lambda e: (e.path.count("/"), e.path))
    tree = CompanyTree(commit=info, truncated=len(ordered) > TREE_CAP, skipped=skipped,
                       entries=[CompanyTreeEntry(path=e.path, type=e.type, size=e.size)
                                for e in ordered[:TREE_CAP]])
    return Served(listing=listing, tree=tree, known=known)


def _credentials(path: str) -> bool:
    """Whether ``path``'s file name is one of ``CREDENTIAL_NAMES``."""
    name = path.rpartition("/")[2].lower()
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in CREDENTIAL_NAMES)


def _secrets(path: str, text: str) -> YamlSecrets:
    """``find_secrets``, or for a JSON file PyYAML can't read (tab indents), ``find_json_secrets``."""
    try:
        return find_secrets(text)
    except NotYaml:
        if not path.lower().endswith(".json"):
            raise
    return find_json_secrets(text)


def _parsed(path: str, text: str, known: frozenset[str]) -> tuple[str | None, bool, set[str], str | None]:
    """Layer 1 for a YAML or JSON file: (text to show, rewritten, this file's secret values, hidden reason).

    Every other string is checked decoded too, so an escaped or split copy of a secret hides the file.
    """
    try:
        found = _secrets(path, text)
    except NotYaml:
        if path.lower().endswith(".json"):  # not JSON either (comments, trailing commas): no parse to walk
            if any(is_secret_key(m[1]) for m in _QUOTED_KEY.finditer(text)):
                return None, False, set(), SECRET_KEY
            return text, False, set(), None  # layers 2 and 3, as for any text file
        return None, False, set(), UNSAFE_YAML
    except UnsafeYaml:
        return None, False, set(), UNSAFE_YAML
    if not all(check_clean(s, known | found.values) for s in found.plain):
        return None, False, found.values, NOT_REMOVED
    if not found.keys:
        return text, False, found.values, None
    if (_PERSON.fullmatch(path) and isinstance(found.data, dict)
            and all(len(key) == 1 and key[0] in REWRITABLE for key in found.keys)):
        try:
            Person.model_validate(found.data)
            kept = {k: v for k, v in found.data.items() if k not in REWRITABLE}
            # The call the office writes person.yaml with, so its own files come out unchanged but for the keys.
            return yaml.safe_dump(kept, sort_keys=False), True, found.values, None
        except (ValidationError, yaml.YAMLError, RecursionError):
            pass
    return None, False, found.values, SECRET_KEY


def render(git: CompanyGit, sha: str, served: Served, entry: TreeEntry) -> CompanyFile:
    """The file response for ``entry`` at ``sha``, with all three secret layers applied, each failing closed."""
    def out(content: str, **fields) -> CompanyFile:
        return CompanyFile(path=entry.path, commit=sha, content=content, **fields)

    if entry.type == "submodule":
        return out("submodule")
    if _credentials(entry.path):
        return out("hidden", reason=CREDENTIALS)
    size = entry.size or 0
    parsed = entry.path.lower().endswith((".yaml", ".yml", ".json"))
    if size > (MAX_LINK if entry.type == "symlink" else MAX_PARSED if parsed else MAX_FILE):
        return out("too_large")
    data = git.read_blob(entry.blob)
    if data is None:
        raise RuntimeError(f"the clone has no blob for {entry.path!r} at {sha}")
    text = _text(data)
    if text is None:
        return out("binary")
    if entry.type == "symlink":  # shown, never followed
        return out("symlink", target=text) if check_clean(text, served.known) else out("hidden", reason=NOT_REMOVED)
    rewritten, own = False, set[str]()
    if parsed:
        shown, rewritten, own, reason = _parsed(entry.path, text, served.known)
        if shown is None:
            return out("hidden", reason=reason)
        text = shown
    text = scrub_text(text)
    if not check_clean(text, served.known | own):
        return out("hidden", reason=NOT_REMOVED)
    return out("text", text=text, rewritten=rewritten)


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
        found = await asyncio.to_thread(render, self.git, at, served, entry)
        self._rendered[key] = found
        while len(self._rendered) > RENDERED:
            self._rendered.popitem(last=False)
        return found
