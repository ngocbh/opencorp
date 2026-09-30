"""The reference monitor: asset tools checked against the company repo, run with office secrets, audited."""

import json
from collections.abc import Callable, Collection, Iterable, Mapping
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool

from agent_corp.assets.registry import Kinds, builtin_kinds
from agent_corp.company.loader import CompanyRepo, load_repo
from agent_corp.company.naming import asset_tool_name
from agent_corp.protocol.models import Asset, Grant
from agent_corp.secrets import MIN_VALUE_CHARS, SecretStore
from agent_corp.store import Store
from agent_corp.tools.workspace import WorkspaceTools

REDACTED = "[redacted]"
DETAIL_CHARS = 2000
"""Characters of a result kept in its audit row."""
SECRET_LINE_CHARS = MIN_VALUE_CHARS
"""Lines of a multi-line secret this long or longer are scrubbed on their own."""
REASON_CHARS = 200
"""Characters of a killed workspace call's reason kept in its audit row."""


class Monitor:
    """The only holder of asset credentials: every asset-tool call is checked, run, and audited here.

    Grants are read from the company repo at ``root`` on every call, so a revocation
    applies to the next call. ``kinds`` maps ``Asset.kind`` to its tools (default: the
    built-in kinds).
    """

    def __init__(self, root: Path, store: Store, secrets: SecretStore, kinds: Kinds | None = None) -> None:
        self.root = Path(root)
        self.store = store
        self.secrets = secrets
        self.kinds = builtin_kinds() if kinds is None else kinds

    def tools(self, person_id: str, *, run_id: str | None = None,
              session_id: str | None = None) -> dict[str, BaseTool]:
        """The asset tools ``person_id`` holds grants for, as ``{name: tool}``: the ``toolbox`` group.

        Pass the dict to ``group_specs`` for ``Job.groups`` and to ``BaseHandlers(tools=...)``.
        Each tool calls ``call`` with ``run_id`` and ``session_id``. Gated tools and tools
        of unknown kinds are never listed.
        """
        repo = load_repo(self.root)
        subjects = _subjects(repo, person_id)
        found: dict[str, BaseTool] = {}
        for aid, asset in sorted(repo.assets.items()):
            for tool, spec in asset.tools.items():
                impl = self.kinds.get(asset.kind, {}).get(tool)
                if impl is None or spec.risk == "gated" or not _grants(asset, tool, subjects):
                    continue
                name = asset_tool_name(aid, tool)
                found[name] = StructuredTool.from_function(
                    func=self._bound(person_id, run_id, session_id, name), name=name,
                    description=impl.description or name, args_schema=impl.parameters)
        return found

    def _bound(self, person_id: str, run_id: str | None, session_id: str | None, name: str) -> Callable[..., Any]:
        def run(**args: Any) -> Any:
            return self.call(person_id, run_id, name, args, session_id=session_id)

        return run

    def call(self, person_id: str, run_id: str | None, name: str, args: Mapping[str, Any], *,
             session_id: str | None = None) -> Any:
        """Check, run, and audit one asset-tool call; return its result.

        A denial is the result ``permission denied: <reason>`` and a failure is
        ``error: <reason>``, so the model sees them and the run goes on. Secret values
        are redacted from the result and the audit row, and so are arguments named after
        the asset's secrets.
        """
        args = dict(args)
        repo = load_repo(self.root)
        asset, tool = _find(repo, name)
        keys = set(asset.secrets) if asset else set()
        values: list[str] = []

        def audit(outcome: str, detail: str) -> None:
            self.store.record_audit(person=person_id, kind="asset", tool=name, args=redact(args, keys, values),
                                    outcome=outcome, session_id=session_id, run_id=run_id,
                                    detail=redact(detail, keys, values)[:DETAIL_CHARS])

        denial = _denial(repo, person_id, asset, tool, name, args)
        if denial:
            audit("denied", denial)
            return f"permission denied: {denial}"
        impl = self.kinds.get(asset.kind, {}).get(tool)
        if impl is None:
            return _error(audit, f"asset kind {asset.kind!r} has no tool {tool!r}")
        try:
            secrets = {key: self.secrets.get(key) for key in asset.secrets}
        except (KeyError, ValueError) as exc:
            return _error(audit, exc.args[0])
        values.extend(v for v in secrets.values() if v)
        try:
            result = redact(impl.run(asset, args, secrets), keys, values)
        except Exception as exc:
            return _error(audit, redact(f"{type(exc).__name__}: {exc}", keys, values))
        audit("ok", result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str))
        return result

    def workspace(self, tools: WorkspaceTools, person_id: str, run_id: str | None, *,
                  session_id: str | None = None) -> Callable[[str, dict[str, Any]], str]:
        """A ``call(name, args)`` for ``workspace_tool_functions`` that audits each workspace call.

        The row's outcome is ``ok`` for exit 0 and ``error`` otherwise. A call with no exit
        status (timed out, interrupted, or bad arguments) has the reason from its output
        in the detail. A call that raises is recorded as ``error`` and raised again.
        """

        def call(name: str, args: dict[str, Any]) -> str:
            try:
                outcome = tools.call(name, args)
            except Exception as exc:
                self.store.record_audit(person=person_id, kind="workspace", tool=name, args={}, outcome="error",
                                        session_id=session_id, run_id=run_id, detail=f"{type(exc).__name__}: {exc}")
                raise
            a = outcome.audit
            detail = f"exit={a.exit} duration={a.duration:.3f}s"
            if a.exit is None:
                detail += f": {_last_line(outcome.output)[:REASON_CHARS]}"
            self.store.record_audit(person=person_id, kind="workspace", tool=a.tool, args={"summary": a.args_summary},
                                    outcome="ok" if a.exit == 0 else "error", session_id=session_id,
                                    run_id=run_id, detail=detail)
            return outcome.output

        return call


def redact(value: Any, keys: Collection[str], values: Iterable[str]) -> Any:
    """``value`` with entries under ``keys`` and every secret in ``values`` replaced by ``[redacted]``.

    Each secret is scrubbed as stored, without surrounding whitespace, and line by line
    for lines of at least ``SECRET_LINE_CHARS`` (one line of a PEM key), longest first,
    so a secret inside a longer one never leaves the longer one's ends behind.
    """
    return _scrub(value, keys, _needles(values))


def _needles(values: Iterable[str]) -> list[str]:
    found: set[str] = set()
    for value in values:
        found.update((value, value.strip()))
        found.update(line.strip() for line in value.splitlines() if len(line.strip()) >= SECRET_LINE_CHARS)
    return sorted((n for n in found if n), key=len, reverse=True)


def _scrub(value: Any, keys: Collection[str], needles: list[str]) -> Any:
    if isinstance(value, str):
        for needle in needles:
            value = value.replace(needle, REDACTED)
        return value
    if isinstance(value, Mapping):
        return {k: REDACTED if k in keys else _scrub(v, keys, needles) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_scrub(v, keys, needles) for v in value]
    return value


def _last_line(text: str) -> str:
    # A killed shell call ends its output with "[timed out after Ns]" or "[interrupted]";
    # a file tool's or a bad-arguments reply is one line.
    return next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")


def _error(audit: Callable[[str, str], None], reason: str) -> str:
    audit("error", reason)
    return f"error: {reason}"


def _subjects(repo: CompanyRepo, person_id: str) -> set[str]:
    """The grantee names that cover ``person_id``: the id, and ``group:<id>`` for each group
    the person is in, directly or through a child group."""
    person = repo.people.get(person_id)
    if person is None:
        return set()
    subjects, todo = {person_id}, list(person.groups)
    while todo:
        gid = todo.pop()
        if f"group:{gid}" in subjects:
            continue  # also stops a parent cycle, which lint reports
        subjects.add(f"group:{gid}")
        if (group := repo.groups.get(gid)) is not None and group.parent is not None:
            todo.append(group.parent)
    return subjects


def _grants(asset: Asset, tool: str, subjects: set[str]) -> list[Grant]:
    return [g for g in asset.grants if g.who in subjects and (tool in g.can or "admin" in g.can)]


def _find(repo: CompanyRepo, name: str) -> tuple[Asset | None, str | None]:
    for aid, asset in repo.assets.items():
        for tool in asset.tools:
            if asset_tool_name(aid, tool) == name:
                return asset, tool
    return None, None


def _denial(repo: CompanyRepo, person_id: str, asset: Asset | None, tool: str | None, name: str,
            args: Mapping[str, Any]) -> str | None:
    """Why ``person_id`` may not make this call, or None if a grant allows it."""
    grants = _grants(asset, tool, _subjects(repo, person_id)) if asset and tool else []
    if not grants:
        return f"no grant for {name}"
    if asset.tools[tool].risk == "gated":
        return f"{name} is gated"
    reasons = []
    for grant in grants:
        failed = [key for key, allowed in (grant.where or {}).items() if key not in args or args[key] not in allowed]
        if not failed:
            return None
        reasons.append(f"{failed[0]} must be one of {json.dumps(grant.where[failed[0]], ensure_ascii=False)}")
    return f"{name}: {reasons[0]}"
