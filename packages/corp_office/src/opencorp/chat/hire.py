"""Hiring: preview a new agent's files and lint them in a scratch copy, then commit them on confirm."""

import difflib
import os
import shutil
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path

import yaml

from opencorp.company.git import CompanyGit, CompanyGitError
from opencorp.company.lint import lint
from opencorp.company.loader import load_repo
from opencorp.protocol.models import HireRequest, HireResponse, Person, RepoIssue

NEW_AGENT = {"kind": "agent", "main": "../../shared/flows/chat.yaml", "harnesses": ["composer"],
             "harness_policy": {"sandbox": "workspace-write", "network": False}}
"""What a hire from the short form gets besides its name, handle, title, and manager."""
_FORM = ("name", "handle", "title", "manager")


class HireRefused(Exception):
    """A confirm that can't be committed; ``code`` is ``lint_failed``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


class Hiring:
    """``POST /people``: a preview writes nothing; a confirm of an unchanged, clean preview commits.

    Previews are kept in memory by handle, so a confirm after an office restart must
    preview again. Only the latest ``max_previews`` are kept; an older one must preview again too.
    """

    def __init__(self, git: CompanyGit, max_previews: int = 100) -> None:
        self.git = git
        self.max_previews = max_previews
        self._lock = threading.Lock()
        self._previews: dict[str, tuple[str, ...]] = {}  # oldest first

    def hire(self, request: HireRequest) -> HireResponse:
        """Preview ``request``, or with ``confirm`` commit its preview; raise ``HireRefused`` if a confirm can't."""
        return self.confirm(request) if request.confirm else self.preview(request)

    def preview(self, request: HireRequest) -> HireResponse:
        """The person, diff, and lint issues the hire would make; nothing is written.

        Only issues the hire brings are errors; ones the repo already had are warnings.
        """
        with self.git.lock:  # the scratch copy shouldn't catch a commit half done
            person, files, issues = self._draft(request)
        with self._lock:
            self._previews.pop(request.handle, None)
            self._previews[request.handle] = _form(request)
            while len(self._previews) > self.max_previews:
                del self._previews[next(iter(self._previews))]
        return HireResponse(person=person, diff=_diff(files), issues=issues, commit=None)

    def confirm(self, request: HireRequest) -> HireResponse:
        """Write and commit the previewed hire, unless its fields changed or it brings a lint error."""
        with self._lock:
            previewed = self._previews.get(request.handle)
        if previewed != _form(request):
            raise HireRefused("lint_failed", "the hire changed since its preview (or was never previewed); "
                                             "preview it again")
        with self.git.lock:
            self.git.commit_hand_edits()
            person, files, issues = self._draft(request)
            errors = [i for i in issues if i.severity == "error"]
            if errors:
                raise HireRefused("lint_failed", errors[0].message)
            head = self.git.head()
            try:
                for rel, text in files.items():
                    path = self.git.root / rel
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text)
                commit = self.git.commit(list(files), _subject(person))
            except BaseException:
                # Left on disk, the profile would be committed later as a hand edit.
                self._undo(request.handle, list(files), head)
                raise
        with self._lock:
            self._previews.pop(request.handle, None)
        return HireResponse(person=person, diff=_diff(files), issues=issues, commit=commit)

    def _undo(self, handle: str, paths: list[str], head: str) -> None:
        """Remove the files a failed hire commit left, and unstage them; best effort."""
        try:
            if self.git.head() != head:  # the commit landed before the failure; keep it
                return
            shutil.rmtree(self.git.root / "people" / handle, ignore_errors=True)
            self.git.unstage(paths)
        except (OSError, CompanyGitError):
            pass  # the caller needs the commit's error, not this one

    def _draft(self, request: HireRequest) -> tuple[Person, dict[str, str], list[RepoIssue]]:
        person, files = agent_files(request)
        base = f"people/{person.handle}"
        with tempfile.TemporaryDirectory() as tmp:
            scratch = Path(tmp) / "company"
            shutil.copytree(self.git.root, scratch, ignore=shutil.ignore_patterns(".git"), symlinks=True)
            before = load_repo(scratch)
            if os.path.lexists(scratch / base):
                return person, files, [RepoIssue(path=f"{base}/person.yaml", code="person.duplicate_handle",
                                                 message=f"@{person.handle} is already taken")]
            for rel, text in files.items():
                # A symlink in the repo (people/ itself, say) could point the write elsewhere.
                target = Path(os.path.realpath(scratch / rel))
                if not target.is_relative_to(os.path.realpath(scratch)):
                    return person, files, [RepoIssue(path=rel, code="person.outside_repo",
                                                     message=f"{rel} would be written outside the company repo")]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            # An error the repo already had isn't this hire's to fix; it shows as a warning.
            known = {(i.path, i.code, i.message) for i in lint(before)}
            issues = [RepoIssue(**asdict(i) | ({"severity": "warning"} if (i.path, i.code, i.message) in known
                                               and not i.path.startswith(f"{base}/") else {}))
                      for i in lint(load_repo(scratch))]
        return person, files, issues


def agent_files(request: HireRequest, about: str = "") -> tuple[Person, dict[str, str]]:
    """The agent ``request`` hires and its files by repo path: ``person.yaml``, and a ``profile.md``
    headed with its name and title, followed by ``about`` if given."""
    person = Person.model_validate({**request.model_dump(include=set(_FORM)), **NEW_AGENT})
    body = person.model_dump(mode="json", exclude_defaults=True)
    base = f"people/{person.handle}"
    profile = f"# {person.name}, {person.title}\n" + (f"\n{about.strip()}\n" if about.strip() else "")
    return person, {f"{base}/person.yaml": yaml.safe_dump(body, sort_keys=False), f"{base}/profile.md": profile}


def _subject(person: Person) -> str:
    # One line: a newline in the name or title could forge a Commit-Id trailer.
    return " ".join(f"hire(@{person.handle}): {person.name}, {person.title}".split())


def _form(request: HireRequest) -> tuple[str, ...]:
    return tuple(getattr(request, key) for key in _FORM)


def _diff(files: dict[str, str]) -> str:
    return "".join("".join(difflib.unified_diff([], text.splitlines(keepends=True), "/dev/null", f"b/{rel}"))
                   for rel, text in files.items())
