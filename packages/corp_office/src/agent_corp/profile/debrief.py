"""Debriefs: the transcript a debrief run reads, the Debrief it makes, and confirming its follow-ups."""

from collections.abc import Iterable, Mapping
from typing import Any

from agent_corp.harness.translate import COMMAND, FILE_CHANGE, MCP_TOOL, REQUEST, change_counts
from agent_corp.protocol import now
from agent_corp.protocol.models import Debrief, FollowUp, Message, Session, WorkItem
from agent_corp.store import Store, new_id

DEBRIEF_FLOW = "shared/flows/debrief.yaml"
"""The debrief flow, relative to the session's pinned commit."""
TRANSCRIPT_MAX_CHARS = 100_000
"""How much of a transcript a debrief reads; the end of the session is kept."""
_CUT = "[earlier messages left out]"
_CUT_START = "[the start of this message left out]"
SUMMARY_MAX_CHARS = 300
"""How long one Codex tool summary may be in a debrief transcript."""
_KINDS = {"add": "added, ", "delete": "deleted, "}


def transcript_text(messages: Iterable[Message], max_chars: int = TRANSCRIPT_MAX_CHARS, *,
                    assistant: str = "assistant", header: str | None = None) -> str:
    """A session's messages as plain text blocks, with ``[called <tool>]`` for tool calls (Codex's summarized) and
    ``[error: <why>]`` for failed turns.

    A message with an ``author`` reads ``@<author>:``; other messages read ``user:``, or ``<assistant>:`` for the
    assistant's. Past ``max_chars`` the oldest messages are left out, so the debrief sees how the session ended;
    a newest message longer than ``max_chars`` keeps its end. ``header`` comes first, and its length counts against
    ``max_chars``, so the cut never drops it.
    """
    budget = max(0, max_chars - (len(header) + 2 if header else 0))
    blocks = []
    for message in messages:
        lines = [_line(p) for p in message.parts if p.type != "file"]
        label = f"@{message.author}" if message.author else assistant if message.role == "assistant" else "user"
        blocks.append(f"{label}: " + "\n".join(lines))
    kept: list[str] = []
    size = 0
    for block in reversed(blocks):
        size += len(block) + 2
        if size - 2 > budget:
            if not kept:
                kept.append(_CUT_START + (block[-budget:] if budget else ""))  # [-0:] would keep it all
            if len(kept) < len(blocks):
                kept.append(_CUT)
            break
        kept.append(block)
    text = "\n\n".join(reversed(kept))
    return f"{header}\n\n{text}" if header else text


def apprentice_header(*, owner: str, employee: str, cwd: str) -> str:
    """What a Codex session's debrief transcript starts with: who drove, who watched, and what "you" means there.

    It says "above" because ``debrief.yaml`` puts the transcript after its instructions.
    """
    return (f"In this session @{owner} drove Codex (an AI coding agent) in `{cwd}`; you, @{employee}, watched as an "
            f"apprentice. \"You\" and \"your work\" in the instructions above mean this session: list what was made or "
            f"changed in it, and record how @{owner} worked and decided, including their approvals.")


def _line(part: Any) -> str:
    if part.type == "tool":
        return _codex_line(part) if part.tool.startswith("codex.") else f"[called {part.tool}]"
    return f"[error: {part.message}]" if part.type == "error" else part.text


def _codex_line(part: Any) -> str:
    """One line for a Codex tool part: the command and its exit code, files with +/- lines, the MCP server and tool,
    or what Codex asked; then the decision on it and who made it."""
    i = part.input
    if part.tool == COMMAND:
        command = " ".join(str(i.get("command")).splitlines())  # a heredoc stays on its summary's one line
        line = f"$ {command}" + (f" (exit {i['exit_code']})" if i.get("exit_code") is not None else "")
    elif part.tool == FILE_CHANGE:
        line = "edited " + ", ".join(_change(c) for c in i.get("changes", []))
    elif part.tool == MCP_TOOL:
        line = f"[mcp {i.get('server')}/{i.get('tool')}]"
    elif part.tool == REQUEST:
        line = f"[asked: {i.get('kind')}: {i.get('summary')}]"
    else:
        return f"[called {part.tool}]"
    if len(line) > SUMMARY_MAX_CHARS:
        line = line[:SUMMARY_MAX_CHARS - 1] + "…"
    approval = i.get("approval")
    if not approval:
        return line
    return f"{line} [{approval['decision']}" + (f" by @{approval['by']}]" if approval.get("by") else "]")


def _change(change: Mapping[str, Any]) -> str:
    """One file change: ``a.py (+2/-1)``, ``a.py → b.py (+0/-0)``, or ``new.md (added, +2/-0)``."""
    added, removed = change_counts(change.get("kind"), change.get("diff"))
    moved = f" → {change['move_path']}" if change.get("move_path") else ""
    return f"{change['path']}{moved} ({_KINDS.get(change.get('kind'), '')}+{added}/-{removed})"


def ready_debrief(session: Session, output: Mapping[str, Any]) -> Debrief:
    """The ``ready`` Debrief of ``session`` from the debrief flow's output; blank follow-ups are dropped."""
    return Debrief(session_id=session.id, state="ready", summary=output["summary"], status=output["status"],
                   artifacts=output["artifacts"], decisions=output["decisions"],
                   follow_ups=[FollowUp(text=t.strip()) for t in output["follow_ups"] if t.strip()],
                   open_questions=output["open_questions"], cost=session.cost, updated_at=now())


def pending_debrief(session: Session) -> Debrief:
    """The ``pending`` Debrief of ``session``: its debrief hasn't succeeded yet."""
    return Debrief(session_id=session.id, state="pending", cost=session.cost, updated_at=now())


def confirm_follow_ups(store: Store, session: Session, indices: Iterable[int], *, requester: str) -> Debrief:
    """Confirm the follow-ups at ``indices``: one work item each, assigned to the session's person.

    A follow-up already confirmed keeps its work item. Raises ``LookupError`` when the
    debrief isn't ready and ``IndexError`` for an index out of range, before any write.
    Callers serialize calls for one session.
    """
    debrief = store.get_debrief(session.id)
    if debrief is None or debrief.state != "ready":
        raise LookupError(f"the debrief of session {session.id} is not ready")
    follow_ups = list(debrief.follow_ups)
    wanted = sorted(set(indices))
    for i in wanted:
        if i >= len(follow_ups):
            raise IndexError(f"no follow-up {i}; the debrief has {len(follow_ups)}")
    for i in wanted:
        if follow_ups[i].confirmed:
            continue
        t = now()
        item = store.create_work_item(WorkItem(
            id=new_id(), title=follow_ups[i].text, kind="task", status="open", requester=requester,
            assignee=session.person, parent_id=session.work_item_id, created_at=t, updated_at=t))
        follow_ups[i] = follow_ups[i].model_copy(update={"confirmed": True, "work_item_id": item.id})
    return store.save_debrief(debrief.model_copy(update={"follow_ups": follow_ups, "updated_at": now()}))
