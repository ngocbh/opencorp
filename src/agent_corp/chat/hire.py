"""Hiring: preview a new agent's files and lint them in a scratch copy, then commit them on confirm."""

import difflib
import shutil
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path

import yaml

from agent_corp.company.git import CompanyGit, CompanyGitError
from agent_corp.company.lint import lint
from agent_corp.company.loader import load_repo
from agent_corp.protocol.models import HireRequest, HireResponse, Person, RepoIssue
from agent_corp.store import new_id

NEW_AGENT = {"kind": "agent", "main": "../../shared/flows/chat.yaml", "harnesses": ["composer"],
             "harness_policy": {"sandbox": "workspace-write", "network": False}}
"""What a hire from the short form gets besides its name, handle, title, and manager."""
_FORM = ("name", "handle", "title", "manager")


class HireRefused(Exception):
    """A confirm that can't be committed: ``code`` is ``invalid_body`` or ``lint_failed``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


class Hiring:
    """``POST /people``: a preview writes nothing; a confirm of an unchanged, clean preview commits.

    Previews are kept in memory by person id, so a confirm after an office restart must
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
        pid = request.id or new_id()
        with self.git.lock:  # the scratch copy shouldn't catch a commit half done
            person, files, issues = self._draft(request, pid)
        with self._lock:
            self._previews.pop(pid, None)
            self._previews[pid] = _form(request)
            while len(self._previews) > self.max_previews:
                del self._previews[next(iter(self._previews))]
        return HireResponse(person=person, diff=_diff(files), issues=issues, commit=None)

    def confirm(self, request: HireRequest) -> HireResponse:
        """Write and commit the previewed hire, unless its fields changed or it brings a lint error."""
        if request.id is None:
            raise HireRefused("invalid_body", "a confirm needs the preview's id")
        with self._lock:
            previewed = self._previews.get(request.id)
        if previewed != _form(request):
            raise HireRefused("lint_failed", "the hire changed since its preview (or was never previewed); "
                                             "preview it again")
        with self.git.lock:
            self.git.commit_hand_edits()
            person, files, issues = self._draft(request, request.id)
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
                self._undo(request.id, list(files), head)
                raise
        with self._lock:
            self._previews.pop(request.id, None)
        return HireResponse(person=person, diff=_diff(files), issues=issues, commit=commit)

    def _undo(self, pid: str, paths: list[str], head: str) -> None:
        """Remove the files a failed hire commit left, and unstage them; best effort."""
        try:
            if self.git.head() != head:  # the commit landed before the failure; keep it
                return
            shutil.rmtree(self.git.root / "people" / pid, ignore_errors=True)
            self.git.unstage(paths)
        except (OSError, CompanyGitError):
            pass  # the caller needs the commit's error, not this one

    def _draft(self, request: HireRequest, pid: str) -> tuple[Person, dict[str, str], list[RepoIssue]]:
        person = Person.model_validate({"id": pid, **request.model_dump(include=set(_FORM)), **NEW_AGENT})
        body = person.model_dump(mode="json", exclude_defaults=True)
        body["manager"] = person.manager  # required, even when null
        base = f"people/{pid}"
        files = {f"{base}/person.yaml": yaml.safe_dump(body, sort_keys=False),
                 f"{base}/profile.md": f"# {person.name}, {person.title}\n"}
        with tempfile.TemporaryDirectory() as tmp:
            scratch = Path(tmp) / "company"
            shutil.copytree(self.git.root, scratch, ignore=shutil.ignore_patterns(".git"), symlinks=True)
            before = load_repo(scratch)
            if (scratch / base).exists():
                return person, files, [RepoIssue(path=f"{base}/person.yaml", code="person.exists",
                                                 message=f"{pid} already exists")]
            for rel, text in files.items():
                (scratch / rel).parent.mkdir(parents=True, exist_ok=True)
                (scratch / rel).write_text(text)
            # An error the repo already had isn't this hire's to fix; it shows as a warning.
            known = {(i.path, i.code, i.message) for i in lint(before)}
            issues = [RepoIssue(**asdict(i) | ({"severity": "warning"} if (i.path, i.code, i.message) in known
                                               and not i.path.startswith(f"{base}/") else {}))
                      for i in lint(load_repo(scratch))]
        # Lint names the later of two people sharing a handle; the new hire is the one to blame.
        owner = next((other for other, p in sorted(before.people.items()) if p.handle == person.handle), None)
        if owner is not None:
            issues = [i for i in issues if i.code != "person.duplicate_handle"
                      or f"@{person.handle} " not in i.message]
            issues.insert(0, RepoIssue(path=f"{base}/person.yaml", code="person.duplicate_handle",
                                       message=f"@{person.handle} is already used by {owner}"))
        return person, files, issues


def _subject(person: Person) -> str:
    # One line: a newline in the name or title could forge a Commit-Id trailer.
    return " ".join(f"hire(@{person.handle}): {person.name}, {person.title}".split())


def _form(request: HireRequest) -> tuple[str, ...]:
    return tuple(getattr(request, key) for key in _FORM)


def _diff(files: dict[str, str]) -> str:
    return "".join("".join(difflib.unified_diff([], text.splitlines(keepends=True), "/dev/null", f"b/{rel}"))
                   for rel, text in files.items())
