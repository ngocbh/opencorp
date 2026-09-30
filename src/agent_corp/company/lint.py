"""Check a loaded company repo for problems the schema can't express."""

from collections.abc import Iterator

from agent_corp.company.issues import RepoIssue
from agent_corp.company.loader import CompanyRepo


def lint(repo: CompanyRepo) -> list[RepoIssue]:
    """Return load errors plus every lint finding, errors and warnings."""
    issues = list(repo.errors)
    for check in CHECKS:
        issues.extend(check(repo))
    return issues


def _person_path(pid: str) -> str:
    return f"people/{pid}/person.yaml"


def _cycles(links: dict[str, str | None]) -> list[list[str]]:
    """Return each cycle in a child → parent map once, as its sorted ids."""
    seen: set[frozenset[str]] = set()
    cycles = []
    for start in sorted(links):
        path: list[str] = []
        node: str | None = start
        while node is not None and node in links and node not in path:
            path.append(node)
            node = links[node]
        if node is not None and node in path:
            cycle = frozenset(path[path.index(node):])
            if cycle not in seen:
                seen.add(cycle)
                cycles.append(sorted(cycle))
    return cycles


def _check_id_case(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Ids of one kind don't differ only by case (their directories collide on macOS).

    Slugs are lowercase and ULIDs uppercase, so the clash is a ULID and its lowercase spelling.
    """
    for items, path in ((repo.people, _person_path),
                        (repo.groups, lambda i: f"groups/{i}.yaml"),
                        (repo.assets, lambda i: f"assets/{i}.yaml")):
        first: dict[str, str] = {}
        for item_id in sorted(items):
            key = item_id.casefold()
            if key in first:
                yield RepoIssue(path(item_id), "repo.id_case_clash",
                                f"{first[key]} and {item_id} differ only by case")
            else:
                first[key] = item_id


def _check_handles(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Handles are unique."""
    owner: dict[str, str] = {}
    for pid in sorted(repo.people):
        handle = repo.people[pid].handle
        if handle in owner:
            yield RepoIssue(_person_path(pid), "person.duplicate_handle",
                            f"@{handle} is already used by {owner[handle]}")
        else:
            owner[handle] = pid


def _check_managers(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Managers exist, and reporting lines have no cycles."""
    for pid, person in sorted(repo.people.items()):
        if person.manager is not None and person.manager not in repo.people:
            yield RepoIssue(_person_path(pid), "person.unknown_manager", person.manager)
    for cycle in _cycles({pid: p.manager for pid, p in repo.people.items()}):
        yield RepoIssue(_person_path(cycle[0]), "person.manager_cycle", " -> ".join(cycle))


def _check_ceo(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """The CEO exists and reports to nobody."""
    if repo.company is None:
        return
    ceo = repo.people.get(repo.company.ceo)
    if ceo is None:
        yield RepoIssue("company.yaml", "company.unknown_ceo", repo.company.ceo)
    elif ceo.manager is not None:
        yield RepoIssue("company.yaml", "company.ceo_has_manager",
                        f"{ceo.id} reports to {ceo.manager}")


def _check_groups(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Group parents and heads exist, and parents have no cycles."""
    for gid, group in sorted(repo.groups.items()):
        if group.parent is not None and group.parent not in repo.groups:
            yield RepoIssue(f"groups/{gid}.yaml", "group.unknown_parent", group.parent)
        if group.head is not None and group.head not in repo.people:
            yield RepoIssue(f"groups/{gid}.yaml", "group.unknown_head", group.head)
    for cycle in _cycles({gid: g.parent for gid, g in repo.groups.items()}):
        yield RepoIssue(f"groups/{cycle[0]}.yaml", "group.parent_cycle", " -> ".join(cycle))


def _check_person_groups(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """People belong only to groups that exist."""
    for pid, person in sorted(repo.people.items()):
        for gid in person.groups:
            if gid not in repo.groups:
                yield RepoIssue(_person_path(pid), "person.unknown_group", gid)


CHECKS = [_check_id_case, _check_handles, _check_managers, _check_ceo, _check_groups,
          _check_person_groups]
