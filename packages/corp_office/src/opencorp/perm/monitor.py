"""The reference monitor: asset tools checked against the company repo, run with office secrets, audited."""

import json
from collections.abc import Callable, Collection, Iterable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import quote

from langchain_core.tools import BaseTool, StructuredTool

from opencorp.assets.registry import Kinds, builtin_kinds
from opencorp.company.loader import CompanyRepo, load_repo
from opencorp.company.naming import asset_tool_name
from opencorp.protocol.models import Asset, Grant
from opencorp.secrets import MIN_VALUE_CHARS, SecretStore
from opencorp.store import Store
from opencorp.tools.workspace import WorkspaceTools

REDACTED = "[redacted]"
DETAIL_CHARS = 2000
"""Characters of a result kept in its audit row."""
SECRET_LINE_CHARS = MIN_VALUE_CHARS
"""Lines of a multi-line secret this long or longer are scrubbed on their own."""
REASON_CHARS = 200
"""Characters of a killed workspace call's reason kept in its audit row."""


class _MonitorError(Exception):
    """A failure the monitor words itself, shown to the model as ``error: <message>``."""


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

    def tools(self, person: str, *, run_id: str | None = None,
              session_id: str | None = None) -> dict[str, BaseTool]:
        """The asset tools ``person`` holds grants for, as ``{name: tool}``: the ``toolbox`` group.

        Pass the dict to ``group_specs`` for ``Job.groups`` and to ``BaseHandlers(tools=...)``.
        Each tool calls ``call`` with ``run_id`` and ``session_id``. Gated tools and tools
        of unknown kinds are never listed.
        """
        repo = load_repo(self.root)
        covering = subjects(repo, person)
        found: dict[str, BaseTool] = {}
        for aid, asset in sorted(repo.assets.items()):
            for tool, spec in asset.tools.items():
                impl = self.kinds.get(asset.kind, {}).get(tool)
                if impl is None or spec.risk == "gated" or not grants(asset, tool, covering):
                    continue
                name = asset_tool_name(aid, tool)
                found[name] = StructuredTool.from_function(
                    func=self._bound(person, run_id, session_id, name), name=name,
                    description=impl.description or name, args_schema=impl.parameters)
        return found

    def _bound(self, person: str, run_id: str | None, session_id: str | None, name: str) -> Callable[..., Any]:
        def run(**args: Any) -> Any:
            return self.call(person, run_id, name, args, session_id=session_id)

        return run

    def call(self, person: str, run_id: str | None, name: str, args: Mapping[str, Any], *,
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
            self.store.record_audit(person=person, kind="asset", tool=name, args=_audit_args(args, keys, values),
                                    outcome=outcome, session_id=session_id, run_id=run_id,
                                    detail=redact(detail, keys, values)[:DETAIL_CHARS])

        denial = _denial(repo, person, asset, tool, name, args)
        if denial:
            audit("denied", denial)
            return f"permission denied: {denial}"
        try:
            impl = self.kinds.get(asset.kind, {}).get(tool)
            if impl is None:
                raise _MonitorError(f"asset kind {asset.kind!r} has no tool {tool!r}")
            secrets = {key: self._secret(key) for key in asset.secrets}
            values.extend(v for v in secrets.values() if v)
            # Plain JSON first, so a set, bytes, or an object's text is scrubbed too.
            result = redact(json.loads(json.dumps(impl.run(asset, args, secrets), default=str)), keys, values)
            detail = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        except BaseException as exc:
            reason = redact(_reason(exc), keys, values)
            audit("error", reason)
            if not isinstance(exc, Exception):  # an interrupt or exit still propagates, once audited
                raise
            return f"error: {reason}"
        audit("ok", detail)
        return result

    def _secret(self, name: str) -> str:
        try:
            return self.secrets.get(name)
        except KeyError as exc:
            raise _MonitorError(exc.args[0]) from None

    def workspace(self, tools: WorkspaceTools, person: str, run_id: str | None, *,
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
                self.store.record_audit(person=person, kind="workspace", tool=name, args={}, outcome="error",
                                        session_id=session_id, run_id=run_id, detail=f"{type(exc).__name__}: {exc}")
                raise
            a = outcome.audit
            detail = f"exit={a.exit} duration={a.duration:.3f}s"
            if a.exit is None:
                detail += f": {_last_line(outcome.output)[:REASON_CHARS]}"
            self.store.record_audit(person=person, kind="workspace", tool=a.tool, args={"summary": a.args_summary},
                                    outcome="ok" if a.exit == 0 else "error", session_id=session_id,
                                    run_id=run_id, detail=detail)
            return outcome.output

        return call


def redact(value: Any, keys: Collection[str], values: Iterable[str]) -> Any:
    """``value`` with entries under ``keys`` and every secret in ``values`` replaced by ``[redacted]``.

    Each secret is scrubbed as stored, without surrounding whitespace, and line by line
    for lines of at least ``SECRET_LINE_CHARS`` (one line of a PEM key; a line that is not
    secret, such as the key's armor, may be scrubbed too). Each of those is also scrubbed as
    it reads escaped inside JSON, a Python repr, or a URL. All are scrubbed longest first,
    so a secret inside a longer one never leaves the longer one's ends behind.
    """
    return _scrub(value, keys, _needles(values))


def redactor(values: Iterable[str]) -> Callable[[Any], Any]:
    """``redact(value, (), values)`` as a function with its needles built once, for scrubbing many values with one set
    of secrets (every record of a run log)."""
    needles = _needles(values)
    return lambda value: _scrub(value, (), needles)


def _needles(values: Iterable[str]) -> list[str]:
    plain: set[str] = set()
    for value in values:
        plain.update((value, value.strip()))
        plain.update(line.strip() for line in value.splitlines() if len(line.strip()) >= SECRET_LINE_CHARS)
    found = set()
    for needle in plain:
        found.update((needle, json.dumps(needle)[1:-1], json.dumps(needle, ensure_ascii=False)[1:-1],
                      repr(needle)[1:-1], quote(needle, safe="")))
    return sorted((n for n in found if n), key=lambda n: (-len(n), n))


def _scrub(value: Any, keys: Collection[str], needles: list[str]) -> Any:
    if isinstance(value, str):
        for needle in needles:
            value = value.replace(needle, REDACTED)
        return value
    if isinstance(value, Mapping):
        scrubbed: dict[Any, Any] = {}
        for k, v in value.items():
            key = new = _scrub(k, keys, needles)
            n = 1
            while new in scrubbed:  # two keys scrubbed to the same text: keep both values
                n += 1
                new = f"{key}#{n}"
            scrubbed[new] = REDACTED if k in keys else _scrub(v, keys, needles)
        return scrubbed
    if isinstance(value, list | tuple):
        return [_scrub(v, keys, needles) for v in value]
    if isinstance(value, int | float) and not isinstance(value, bool) and any(n in str(value) for n in needles):
        return REDACTED  # an all-digit secret
    return value


def _last_line(text: str) -> str:
    # A killed shell call ends its output with "[timed out after Ns]" or "[interrupted]";
    # a file tool's or a bad-arguments reply is one line.
    return next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")


def _audit_args(args: Mapping[str, Any], keys: Collection[str], values: Iterable[str]) -> dict[str, Any]:
    """``args`` redacted, or, when their JSON is longer than ``DETAIL_CHARS``, that JSON cut to fit."""
    redacted = redact(json.loads(json.dumps(args, default=str)), keys, values)
    text = json.dumps(redacted, ensure_ascii=False)
    return redacted if len(text) <= DETAIL_CHARS else {"truncated": text[:DETAIL_CHARS]}


def _reason(exc: BaseException) -> str:
    # The monitor's own failures (no such kind tool, a secret not set) read as plain
    # sentences; anything else, a kind's own error included, is named by its type.
    if isinstance(exc, _MonitorError):
        return str(exc)
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


def subjects(repo: CompanyRepo, person: str) -> set[str]:
    """The grantee names that cover ``person``: the handle, and ``group:<id>`` for each group
    the person is in, directly or through a child group."""
    found = repo.people.get(person)
    if found is None:
        return set()
    covering, todo = {person}, list(found.groups)
    while todo:
        gid = todo.pop()
        if f"group:{gid}" in covering:
            continue  # also stops a parent cycle, which lint reports
        covering.add(f"group:{gid}")
        if (group := repo.groups.get(gid)) is not None and group.parent is not None:
            todo.append(group.parent)
    return covering


def grants(asset: Asset, tool: str, covering: set[str]) -> list[Grant]:
    """The grants on ``asset`` that allow ``tool`` (by name or ``admin``) to any of the grantee names ``covering``."""
    return [g for g in asset.grants if g.who in covering and (tool in g.can or "admin" in g.can)]


def _find(repo: CompanyRepo, name: str) -> tuple[Asset | None, str | None]:
    for aid, asset in repo.assets.items():
        for tool in asset.tools:
            if asset_tool_name(aid, tool) == name:
                return asset, tool
    return None, None


def _same(value: Any, allowed: Any) -> bool:
    """Equal in value and type, all the way down, so ``True`` and ``1.0`` are not ``1``."""
    if type(value) is not type(allowed):
        return False
    if isinstance(value, Mapping):
        return value.keys() == allowed.keys() and all(_same(value[k], allowed[k]) for k in value)
    if isinstance(value, list):
        return len(value) == len(allowed) and all(map(_same, value, allowed))
    return value == allowed


def _denial(repo: CompanyRepo, person: str, asset: Asset | None, tool: str | None, name: str,
            args: Mapping[str, Any]) -> str | None:
    """Why ``person`` may not make this call, or None if a grant allows it."""
    allowing = grants(asset, tool, subjects(repo, person)) if asset and tool else []
    if not allowing:
        return f"no grant for {name}"
    if asset.tools[tool].risk == "gated":
        return f"{name} is gated"
    reasons = []
    for grant in allowing:
        failed = [key for key, allowed in (grant.where or {}).items()
                  if key not in args or not any(_same(args[key], a) for a in allowed)]
        if not failed:
            return None
        reasons.append(f"{failed[0]} must be one of {json.dumps(grant.where[failed[0]], ensure_ascii=False)}")
    return f"{name}: {reasons[0]}"
