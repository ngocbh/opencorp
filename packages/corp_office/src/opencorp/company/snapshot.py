"""The company at one commit of the office's clone: the company file, people and groups, read from git objects."""

import asyncio

import yaml
from pydantic import BaseModel, ValidationError

from opencorp.company.git import CompanyGit
from opencorp.company.secret_keys import blank_secrets
from opencorp.protocol.models import Company, CompanyView, Group, Person, RepoIssue


def _invalid(exc: ValidationError) -> str:
    """What's wrong, by field: never an input value, since a file can hold a password hash."""
    return "; ".join(f"{'.'.join(map(str, e['loc'])) or 'file'}: {e['msg']}"
                     for e in exc.errors(include_url=False, include_input=False, include_context=False))


def _parse[M: BaseModel](path: str, data: bytes | None, model: type[M], issues: list[RepoIssue]) -> M | None:
    """``data`` as ``model``; a file that doesn't parse becomes an issue and None."""
    try:
        return model.model_validate(yaml.safe_load(data or b""))
    except ValidationError as exc:
        issues.append(RepoIssue(path=path, code="repo.schema", message=_invalid(exc)))
    except (yaml.YAMLError, UnicodeDecodeError) as exc:
        # YAML errors quote the offending line, so only its number is kept.
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark is not None else ""
        issues.append(RepoIssue(path=path, code="repo.unreadable", message=f"isn't valid YAML{where}"))
    except RecursionError:  # the YAML parser recurses once per nesting level
        issues.append(RepoIssue(path=path, code="repo.unreadable", message="is nested too deeply to read"))
    return None


def load_company_at(git: CompanyGit, sha: str) -> CompanyView:
    """The company at commit ``sha``, read in one batch from git objects, so uncommitted edits don't count.

    People come without their devices and password hash.
    """
    company_blob = git.blob_id("company.yaml", sha)
    people = {path: blob for path, blob in git.files("people", sha).items()
              if path.count("/") == 2 and path.endswith("/person.yaml")}
    groups = {path: blob for path, blob in git.files("groups", sha).items()
              if path.count("/") == 1 and path.endswith(".yaml")}
    # One read for every file: a git call per person would make each load grow with the company.
    data = git.read_blobs([b for b in (company_blob, *people.values(), *groups.values()) if b])
    issues: list[RepoIssue] = []
    company = None
    if company_blob is None:
        issues.append(RepoIssue(path="company.yaml", code="repo.unreadable", message="company.yaml is missing"))
    else:
        company = _parse("company.yaml", data.get(company_blob), Company, issues)
    found: list[Person] = []
    for path in sorted(people):
        person = _parse(path, data.get(people[path]), Person, issues)
        folder = path.split("/")[1]
        if person is not None and person.handle != folder:
            issues.append(RepoIssue(path=path, code="person.dir_mismatch",
                                    message=f"the handle must match its directory {folder!r}"))
        elif person is not None:
            # The view goes to browsers, and the schema can't keep these out since it reuses Person.
            found.append(blank_secrets(person))
    teams: list[Group] = []
    for path in sorted(groups):
        group = _parse(path, data.get(groups[path]), Group, issues)
        stem = path.removeprefix("groups/").removesuffix(".yaml")
        if group is not None and group.id != stem:
            issues.append(RepoIssue(path=path, code="repo.file_mismatch",
                                    message=f"the id must match its file name {stem!r}"))
        elif group is not None:
            teams.append(group)
    return CompanyView(sha=sha, company=company, people=found, groups=teams, issues=issues)


class CompanySnapshots:
    """``load_company_at`` by sha, loaded once however many callers ask at the same time; use it on the office loop.

    Every HQ request checks its person at the newest HEAD, so a HEAD move would otherwise start one load per
    request. The last ``KEEP`` loads are kept.
    """

    KEEP = 4

    def __init__(self, git: CompanyGit) -> None:
        self.git = git
        self._done: dict[str, CompanyView] = {}
        self._loading: dict[str, asyncio.Future[CompanyView]] = {}

    async def at(self, sha: str) -> CompanyView:
        """The company at ``sha``."""
        if (view := self._done.get(sha)) is not None:
            return view
        future = self._loading.get(sha)
        if future is None:
            future = asyncio.ensure_future(asyncio.to_thread(load_company_at, self.git, sha))
            self._loading[sha] = future
            future.add_done_callback(lambda done: self._finished(sha, done))
        # Shielded: one caller going away (a closed connection) mustn't cancel the load the others wait on.
        return await asyncio.shield(future)

    def _finished(self, sha: str, future: asyncio.Future[CompanyView]) -> None:
        self._loading.pop(sha, None)
        if future.cancelled() or future.exception() is not None:
            return
        self._done[sha] = future.result()
        while len(self._done) > self.KEEP:
            self._done.pop(next(iter(self._done)))

    async def head(self) -> CompanyView | None:
        """The company at the clone's HEAD; None before its first commit."""
        try:
            # Called on the loop, not in a thread: usually two small file reads. Only the slow path (no commit yet,
            # or a ref missing from packed-refs) runs `git rev-parse`.
            sha = self.git.read_head()
        except ValueError:
            return None
        return await self.at(sha)
