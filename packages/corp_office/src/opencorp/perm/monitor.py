"""The reference monitor: asset tools checked against the company repo, run with office secrets, audited."""

import base64
import functools
import json
import re
from collections.abc import Callable, Collection, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, quote_plus

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
    it reads escaped inside JSON (up to three times), a Python repr (or a repr of one), or a
    URL (``quote`` and ``quote_plus``, once or twice), in any letter case (``ß`` as ``SS``
    too). A whole secret is also scrubbed hex-encoded, and base64- and base32-encoded at any
    offset (inside ``Basic`` credentials, say), base64 in either alphabet; a block of base64
    wrapped at 64 or 76 columns that holds one is scrubbed whole, its lines indented or not,
    its line breaks plain or escaped. All are scrubbed longest first, so a secret inside a
    longer one never leaves the longer one's ends behind.
    """
    return _scrub(value, keys, _needles(values))


def redactor(values: Iterable[str]) -> Callable[[Any], Any]:
    """``redact(value, (), values)`` as a function with its needles built once, for scrubbing many values with one set
    of secrets (every record of a run log)."""
    needles = _needles(values)
    return lambda value: _scrub(value, (), needles)


_FOLD = str.maketrans("-_", "+/")
"""Folds the URL-safe base64 alphabet into the standard one, for the quick tests."""
_B64 = "A-Za-z0-9+/_-"
_BREAK = r"(?:\r?\n|(?:\\{1,15}r)?\\{1,15}n)[ \t]*"  # plain or escaped up to 4 times, and the next line's indent
_WRAPPED = re.compile(rf"(?<![{_B64}])(?:(?:[{_B64}]{{76}}|[{_B64}]{{64}}){_BREAK})+[={_B64}]{{0,76}}")
"""Base64 wrapped at 76 columns, as MIME (``base64.encodebytes``) writes it, or at 64, as openssl and PEM do."""
_BREAKS = re.compile(_BREAK)
_WRAP_ENDS = (re.compile(rf"\n(?<=[{_B64}]{{64}}\n)"), re.compile(rf"\r(?<=[{_B64}]{{64}}\r)\n"),
              re.compile(rf"\\(?<=[{_B64}]{{64}}\\)\\{{0,14}}(?:r\\{{1,15}})?n"))
"""A full line of wrapped base64 and its break, found from the break (a literal, so quick) before ``_WRAPPED``,
which has none to look for, runs."""
_PIECE = 8
_PIECES = re.compile(f".{{{_PIECE}}}", re.DOTALL)
"""A text cut into pieces of ``_PIECE`` characters from its start: a form at least ``2 * _PIECE - 1`` long that the
text holds holds one of them at one of its first ``_PIECE`` offsets."""


@dataclass(frozen=True)
class _Needles:
    """What ``_scrub`` looks for, built once per set of secrets."""

    forms: list[tuple[str, str, bool]]
    """Each form of a secret, longest first: its text, the text casefolded and with ``-_`` as ``+/`` (a quick test on
    the value folded the same way, before the search), and whether it is a base64 core, searched for exactly but for
    the alphabet rather than case-blind (``_pattern``)."""
    starts: dict[str, list[int]]
    """The piece at each of the first ``_PIECE`` offsets of each form whose quick test has at least
    ``2 * _PIECE - 1`` characters, with the forms (indexes into ``forms``) holding it there: one set lookup per piece
    of a value finds every such form it may hold, however many forms there are."""
    pieces: frozenset[str]
    """The keys of ``starts``."""
    short: tuple[int, ...]
    """The other forms, tested by substring search."""
    cores: frozenset[str]
    """Each secret's base64 core, in the standard alphabet, looked for in wrapped base64."""
    shortest: int
    """The length of the shortest form: a shorter string holds none."""
    joins: bool
    """Whether no form holds NUL, so strings joined by it can be tested at once."""


def _needles(values: Iterable[str]) -> _Needles:
    plain: set[str] = set()
    whole: set[str] = set()
    for value in values:
        whole.update((value, value.strip()))
        plain.update((value, value.strip()))
        plain.update(line.strip() for line in value.splitlines() if len(line.strip()) >= SECRET_LINE_CHARS)
    texts = set()
    for needle in plain:
        level = {needle}
        for _ in range(3):  # JSON inside JSON inside JSON
            level = {json.dumps(n, ensure_ascii=ascii)[1:-1] for n in level for ascii in (True, False)}
            texts |= level
        once = quote(needle, safe="")
        texts.update((needle, repr(needle)[1:-1], repr(repr(needle)[1:-1])[1:-1], once, quote(once, safe=""),
                      quote(needle), quote_plus(needle), quote_plus(quote_plus(needle))))
    texts |= {text.casefold() for text in texts if text.casefold() != text.lower()}  # ß as ss, matching SS
    for value in whole:
        texts.add(value.encode().hex())
        texts |= _base32(value)
    cores = frozenset().union(*map(_base64, whole))
    forms = {(text, False) for text in texts if text} | {(core, True) for core in cores}
    found = sorted(((text, text.casefold().translate(_FOLD), core) for text, core in forms),
                   key=lambda n: (-len(n[0]), n[0], n[2]))
    starts: dict[str, list[int]] = {}
    short = []
    for i, (_, quick, _) in enumerate(found):
        if len(quick) < 2 * _PIECE - 1:
            short.append(i)
            continue
        for at in range(_PIECE):
            starts.setdefault(quick[at:at + _PIECE], []).append(i)
    return _Needles(found, starts, frozenset(starts), tuple(short), cores, min((len(n[0]) for n in found), default=0),
                    not any("\0" in n[1] for n in found))


@functools.lru_cache(maxsize=4096)
def _pattern(text: str, core: bool) -> re.Pattern[str]:
    """A form's search, compiled when a value first may hold it: case-blind, or for a base64 core exact but in either
    alphabet, so the URL-safe copy needs no form of its own."""
    if core:
        return re.compile(re.escape(text).replace(r"\+", "[+-]").replace("/", "[/_]"))
    return re.compile(re.escape(text), re.IGNORECASE)


def _base64(value: str) -> set[str]:
    """What the base64 of any text holding ``value`` holds, whatever ``value``'s offset in a 3-byte group: the
    characters made only of its bits, in the standard alphabet."""
    data = value.encode()
    found = set()
    for pad in range(3):
        coded = base64.b64encode(b"\0" * pad + data).decode()
        found.add(coded[-(-4 * pad // 3):8 * (pad + len(data)) // 6])
    return {core for core in found if len(core) >= SECRET_LINE_CHARS}


def _base32(value: str) -> set[str]:
    """``_base64`` for base32: what the base32 of any text holding ``value`` holds, at each of its 5 offsets."""
    data = value.encode()
    found = set()
    for pad in range(5):
        coded = base64.b32encode(b"\0" * pad + data).decode()
        found.add(coded[-(-8 * pad // 5):8 * (pad + len(data)) // 5])
    return {core for core in found if len(core) >= SECRET_LINE_CHARS}


def _scrub_text(value: str, needles: _Needles) -> str:
    if len(value) < needles.shortest:
        return value
    folded = value.casefold().translate(_FOLD)
    if found := _candidates(folded, needles):
        value = _scrub_forms(value, folded, needles, found)
    if needles.cores and any(end.search(value) for end in _WRAP_ENDS):
        value = _WRAPPED.sub(lambda m: REDACTED if _holds_core(m[0], needles.cores) else m[0], value)
    return value


def _candidates(folded: str, needles: _Needles) -> list[int]:
    """The forms (indexes into ``needles.forms``, so longest first) ``folded``, a value folded as quick tests are, may
    hold: those starting with one of its pieces, and the short ones it holds."""
    found = {i for piece in needles.pieces.intersection(_PIECES.findall(folded)) for i in needles.starts[piece]}
    found.update(i for i in needles.short if needles.forms[i][1] in folded)
    return sorted(found)


def _scrub_forms(value: str, folded: str, needles: _Needles, found: list[int]) -> str:
    for i in found:
        text, quick, core = needles.forms[i]
        if quick in folded:
            new = _pattern(text, core).sub(REDACTED, value)
            if new != value:
                value, folded = new, new.casefold().translate(_FOLD)
    return value


def _holds_core(block: str, cores: frozenset[str]) -> bool:
    joined = _BREAKS.sub("", block).translate(_FOLD)
    return any(core in joined for core in cores)


def _scrub(value: Any, keys: Collection[str], needles: _Needles) -> Any:
    if not keys and not _may_hold(value, needles):
        return value
    return _scrub_all(value, keys, needles)


def _may_hold(value: Any, needles: _Needles) -> bool:
    """Whether a string or number in ``value`` may hold a form of a secret: one test of all of them at once, joined by
    NUL, which no form holds, rather than every form against every string."""
    if not needles.joins:
        return True
    parts: list[str] = []
    _texts(value, parts)
    joined = "\0".join(parts)
    folded = joined.casefold().translate(_FOLD)
    return (not needles.pieces.isdisjoint(_PIECES.findall(folded))
            or any(needles.forms[i][1] in folded for i in needles.short)
            or bool(needles.cores and any(end.search(joined) for end in _WRAP_ENDS)))


def _texts(value: Any, parts: list[str]) -> None:
    if isinstance(value, str):
        parts.append(value)
    elif isinstance(value, Mapping):
        for k, v in value.items():
            _texts(k, parts)
            _texts(v, parts)
    elif isinstance(value, list | tuple):
        for v in value:
            _texts(v, parts)
    elif isinstance(value, int | float) and not isinstance(value, bool):
        parts.append(str(value))


def _scrub_all(value: Any, keys: Collection[str], needles: _Needles) -> Any:
    if isinstance(value, str):
        return _scrub_text(value, needles)
    if isinstance(value, Mapping):
        scrubbed: dict[Any, Any] = {}
        for k, v in value.items():
            key = new = _scrub_all(k, keys, needles)
            n = 1
            while new in scrubbed:  # two keys scrubbed to the same text: keep both values
                n += 1
                new = f"{key}#{n}"
            scrubbed[new] = REDACTED if k in keys else _scrub_all(v, keys, needles)
        return scrubbed
    if isinstance(value, list | tuple):
        return [_scrub_all(v, keys, needles) for v in value]
    if isinstance(value, int | float) and not isinstance(value, bool):
        text = str(value).casefold().translate(_FOLD)
        if any(needles.forms[i][1] in text for i in _candidates(text, needles)):
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
