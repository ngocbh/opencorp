"""Check a loaded company repo for problems the schema can't express."""

from collections.abc import Iterator
from pathlib import Path

from agent_composer import LoadError
from agent_composer.compose.skills import load_skill_dir
from agent_composer.skills import SkillError

from agent_corp.company.flows import FlowOutsideRepo, load_confined
from agent_corp.company.issues import RepoIssue
from agent_corp.company.loader import CompanyRepo
from agent_corp.company.naming import TOOL_NAME, asset_tool_name


def lint(repo: CompanyRepo) -> list[RepoIssue]:
    """Return load errors plus every lint finding, errors and warnings."""
    issues = list(repo.errors)
    for check in CHECKS:
        issues.extend(check(repo))
    return issues


def _person_path(handle: str) -> str:
    return f"people/{handle}/person.yaml"


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
    """Group or asset ids don't differ only by case (their files collide on macOS).

    Slugs are lowercase and ULIDs uppercase, so the clash is a ULID and its lowercase spelling.
    Handles are lowercase only, so people can't clash.
    """
    for items, path in ((repo.groups, lambda i: f"groups/{i}.yaml"),
                        (repo.assets, lambda i: f"assets/{i}.yaml")):
        first: dict[str, str] = {}
        for item_id in sorted(items):
            key = item_id.casefold()
            if key in first:
                yield RepoIssue(path(item_id), "repo.id_case_clash",
                                f"{first[key]} and {item_id} differ only by case")
            else:
                first[key] = item_id


def _check_managers(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Managers exist, and reporting lines have no cycles."""
    for handle, person in sorted(repo.people.items()):
        if person.manager is not None and person.manager not in repo.people:
            yield RepoIssue(_person_path(handle), "person.unknown_manager", person.manager)
    for cycle in _cycles({handle: p.manager for handle, p in repo.people.items()}):
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
                        f"{ceo.handle} reports to {ceo.manager}")


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
    for handle, person in sorted(repo.people.items()):
        for gid in person.groups:
            if gid not in repo.groups:
                yield RepoIssue(_person_path(handle), "person.unknown_group", gid)


def _check_assets(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Tool names fit the model's limits; grants name real subjects and tools."""
    for aid, asset in sorted(repo.assets.items()):
        path = f"assets/{aid}.yaml"
        for tool in asset.tools:
            if not TOOL_NAME.fullmatch(asset_tool_name(aid, tool)):
                yield RepoIssue(path, "asset.tool_name_invalid",
                                f"{asset_tool_name(aid, tool)!r} must match {TOOL_NAME.pattern}")
        gated = {t for t, spec in asset.tools.items() if spec.risk == "gated"}
        for grant in asset.grants:
            kind, _, name = grant.who.rpartition(":")
            known = repo.groups if kind == "group" else repo.people
            if name not in known:
                yield RepoIssue(path, "asset.unknown_grantee", grant.who)
            for tool in grant.can:
                if tool != "admin" and tool not in asset.tools:
                    yield RepoIssue(path, "asset.unknown_tool", tool)
                elif tool in gated:
                    yield RepoIssue(path, "asset.gated_tool_granted",
                                    f"{tool} is gated; gated tools are not exposed to agents yet",
                                    "warning")


def _check_flows(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Agents have a main flow; every main, SOP, and routine flow exists inside the repo and compiles."""
    for handle, person in sorted(repo.people.items()):
        if person.kind == "agent" and not person.main:
            yield RepoIssue(_person_path(handle), "person.no_main", "agents need a main flow")
        base = repo.root / "people" / handle
        refs = (([person.main] if person.main else []) + [sop.flow for sop in person.sops]
                + [routine.flow for routine in person.routines])
        for ref in refs:
            try:
                path = (base / ref).resolve()
            except (OSError, ValueError) as exc:  # e.g. a NUL byte in the path
                yield RepoIssue(_person_path(handle), "person.flow_invalid", f"{ref!r}: {exc}")
                continue
            if path.is_relative_to(repo.root) and not path.is_file():
                yield RepoIssue(_person_path(handle), "person.flow_missing", f"{ref} does not exist")
                continue
            try:
                load_confined(repo.root, path)
            except FlowOutsideRepo as exc:
                yield RepoIssue(_person_path(handle), "person.flow_outside_repo", f"{ref}: {exc}")
            except LoadError as exc:
                yield RepoIssue(_person_path(handle), "person.flow_invalid", f"{ref}: {exc}")
            except Exception as exc:  # OSError/ValueError from a child file, or a surprise
                yield RepoIssue(_person_path(handle), "person.flow_invalid",
                                f"{ref}: {type(exc).__name__}: {exc}")


def _skill_root(root: Path, rel: str, issues: list[RepoIssue]) -> set[str]:
    """Load each skill directory under one root; each bad one becomes a ``skill.invalid`` issue.

    Mirrors ``load_skills``: hidden entries and directories without ``SKILL.md`` are
    skipped, and two skills with one name in the same root are a problem. It loads
    each directory itself rather than catching ``load_skills`` warnings, which is
    not thread-safe.
    """
    names: set[str] = set()
    entries = sorted(root.iterdir()) if root.is_dir() else []
    for entry in entries:
        if entry.name.startswith(".") or not (entry / "SKILL.md").is_file():
            continue
        try:
            skill = load_skill_dir(entry)
        except (SkillError, OSError) as exc:
            issues.append(RepoIssue(f"{rel}/{entry.name}", "skill.invalid", str(exc)))
            continue
        if skill.name in names:
            issues.append(RepoIssue(f"{rel}/{entry.name}", "skill.invalid",
                                    f"skill name {skill.name!r} is used twice in {rel}"))
        names.add(skill.name)
    return names


def _check_skills(repo: CompanyRepo) -> list[RepoIssue]:
    """Granted skills exist in the person's own skills or in shared/skills."""
    issues: list[RepoIssue] = []
    shared = _skill_root(repo.root / "shared/skills", "shared/skills", issues)
    for handle, person in sorted(repo.people.items()):
        own = _skill_root(repo.root / "people" / handle / "skills", f"people/{handle}/skills", issues)
        for name in person.skills:
            if name not in own | shared:
                issues.append(RepoIssue(_person_path(handle), "person.unknown_skill", name))
    return issues


def _check_profiles(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Agents should have a profile; humans may skip it."""
    for handle, person in sorted(repo.people.items()):
        if person.kind == "agent" and not (repo.root / "people" / handle / "profile.md").is_file():
            yield RepoIssue(f"people/{handle}/profile.md", "person.no_profile",
                            "agents learn into profile.md; create one", "warning")


def _check_devices(repo: CompanyRepo) -> Iterator[RepoIssue]:
    """Only humans list devices or have a password, each device name once per person, and no token hash under
    two people."""
    owners: dict[str, set[str]] = {}
    for handle, person in sorted(repo.people.items()):
        if person.devices and person.kind != "human":
            yield RepoIssue(_person_path(handle), "person.agent_devices",
                            "agents act through the office, not from devices; remove devices")
        if person.password_hash and person.kind != "human":
            yield RepoIssue(_person_path(handle), "person.agent_password",
                            "agents act through the office and never log in; remove password_hash")
        names = [d.name for d in person.devices]
        for name in sorted({n for n in names if names.count(n) > 1}):
            yield RepoIssue(_person_path(handle), "person.duplicate_device", name)
        if person.kind == "human":
            for device in person.devices:
                owners.setdefault(device.token_sha256, set()).add(handle)
    # The office ignores a hash two people list, since it can't tell who acts.
    for handle, person in sorted(repo.people.items()):
        if person.kind == "human":
            for device in person.devices:
                others = sorted(owners[device.token_sha256] - {handle})
                if others:
                    yield RepoIssue(_person_path(handle), "person.shared_device_token",
                                    f"device {device.name}'s token is also listed by {', '.join(others)}")


CHECKS = [_check_id_case, _check_managers, _check_ceo, _check_groups,
          _check_person_groups, _check_assets, _check_flows, _check_skills, _check_profiles, _check_devices]
