"""The first message of a side chat: framing, what the asker was doing, and the question card."""

import json
from collections.abc import Iterable

from agent_corp.company.loader import CompanyRepo
from agent_corp.protocol.models import DiscussionEntry, Message, Question, Session
from agent_corp.questions.format import capped_json
from agent_corp.store import Store
from agent_corp.worker import person_flow

FRAMING = ("You are now talking directly with the person you asked the question below, before they answer it. "
           'Speak to them as "you"; never call them "the user" or "they". They want to understand your question: '
           "explain it; do not decide for them, and do not change anything.")
TOOL_OUTPUT_CHARS = 2000
"""Characters of one tool call's input or output the seed keeps."""
FIRST_MESSAGE = "# Their first message to you\n\n"
CUT = "… [the rest of the context is cut]"
_VIA = {"ask_user": "with ask_user", "ask_manager": "with ask_manager, to your manager",
        "human_input": "at a human_input step of your flow"}


def build_seed(store: Store, repo: CompanyRepo, question: Question, *, max_chars: int,
               carried: Iterable[DiscussionEntry] = ()) -> str:
    """The side chat's seed for ``question``: framing, context, then the card; at most ``max_chars``.

    The context is who asked, the asker's flow at its session's pinned commit (``repo``
    is that commit's checkout), the question's work item and its parents with their comments,
    and the asker session's transcript before the question. The transcript is shortened
    to fit first: its oldest and newest events are kept around an ``…N events omitted…``
    marker, and each tool input and output is cut to ``TOOL_OUTPUT_CHARS``. If the rest
    is still too long, the comments go, then the context is cut from its end; the card
    always stays. ``carried`` is the discussion of an earlier, expired question.
    """
    asker = store.get_session(question.session_id)
    card = card_text(question, carried)
    for comments in (True, False):
        head = "\n\n".join(part for part in (FRAMING, _who(repo, question), _flow(repo, asker),
                                             _work(store, question.work_item_id, comments)) if part)
        if len(head) + 2 + len(card) <= max_chars:
            break
    events = _events(store.list_messages(asker.id), question.created_at) if asker else []
    return _fit(head, events, card, max_chars)


def first_message(seed: str, text: str) -> str:
    """The first turn's text: the seed, then the human's first message."""
    return f"{seed}\n\n{FIRST_MESSAGE}{text}"


def card_text(question: Question, carried: Iterable[DiscussionEntry] = ()) -> str:
    """The question as its card shows it, with any discussion carried over from an expired question."""
    lines = [f"# The question you asked ({_VIA[question.source]})", ""]
    if question.title:
        lines.append(f"Title: {question.title}")
    if question.question:
        lines.append(question.question)
    for n, option in enumerate(question.options, 1):
        lines.append(f"  {n}. {option}")
    for n, page in enumerate(question.questions or [], 1):
        lines.append(f"Question {n} of {len(question.questions)} · {page.header}"
                     f"{' (pick any)' if page.multi_select else ''}: {page.question}")
        lines += [f"  - {o.label}{f': {o.description}' if o.description else ''}" for o in page.options]
    if not question.questions:
        for field in question.answer_schema:
            allowed = f", one of {field.enum}" if field.enum else ""
            lines.append(f"Answer field {field.name}: {field.type}{allowed}"
                         f"{'' if field.required else ', optional'}")
    carried = list(carried)
    if carried:
        lines += ["", "You discussed an earlier question with them before it expired (JSON, oldest first):",
                  capped_json(carried)]
    return "\n".join(lines)


def _who(repo: CompanyRepo, question: Question) -> str:
    person = repo.people.get(question.asker)
    if person is None:
        return f"# Who asked\n\nYou are {question.asker}."
    title = f", {person.title}" if person.title else ""
    return f"# Who asked\n\nYou are {person.name} (@{person.handle}){title}."


def _flow(repo: CompanyRepo, asker: Session | None) -> str:
    person = repo.people.get(asker.person) if asker else None
    if asker is None or asker.kind != "main" or person is None or not person.main:
        return ""
    rel = person_flow(person.handle, person.main)
    try:
        text = (repo.root / rel).read_text()
    except OSError:
        return ""
    return f"# Your instructions: the flow {rel} at commit {asker.repo_commit[:12]}\n\n```yaml\n{text.rstrip()}\n```"


def _work(store: Store, work_item_id: str | None, comments: bool = True) -> str:
    blocks, seen = [], set()
    while work_item_id and work_item_id not in seen:
        seen.add(work_item_id)
        item = store.get_work_item(work_item_id)
        if item is None:
            break
        lines = [f'Work item "{item.title}" ({item.kind}, {item.status}), requested by {item.requester}'
                 f"{f', assigned to {item.assignee}' if item.assignee else ''}"]
        if item.summary:
            lines.append(item.summary)
        if comments:
            lines += [f"- {c.author}: {c.body}" for c in store.list_comments(item.id)]
        blocks.append("\n".join(lines))
        work_item_id = item.parent_id
    return "# The work\n\n" + "\n\n".join(blocks) if blocks else ""


def _events(messages: list[Message], before: str) -> list[str]:
    events = []
    for message in messages:
        if message.created_at >= before:
            break
        who = "user" if message.role == "user" else "you"
        for part in message.parts:
            if part.type == "text" and part.text:
                events.append(f"[{who}] {part.text}")
            elif part.type == "tool":
                result = part.error if part.error else part.output
                events.append(f"[tool {part.tool}, {part.state}] input: {_cut(part.input)}\n"
                              f"  output: {_cut(result)}")
    return events


def _cut(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= TOOL_OUTPUT_CHARS else text[:TOOL_OUTPUT_CHARS] + f"… [{len(text)} chars]"


def _fit(head: str, events: list[str], card: str, max_chars: int) -> str:
    title = "# What you did before asking (oldest first)"
    parts = [head, title, *events, card] if events else [head, card]
    text = "\n\n".join(parts)
    if len(text) <= max_chars:
        return text
    budget = max_chars - len("\n\n".join([head, title, card])) - 64
    if budget <= 0:  # no room for any event: drop them, then cut the context; keep the card
        if len(head) + 2 + len(card) <= max_chars:
            return f"{head}\n\n{card}"
        room = max_chars - len(card) - len(CUT) - 2
        return f"{head[:room]}{CUT}\n\n{card}" if room > 0 else card[:max_chars]
    tail: list[str] = []
    used = 0
    # The newest events matter most: they take up to three quarters of the room.
    for event in reversed(events):
        if used + len(event) + 2 > budget * 3 // 4:
            break
        tail.insert(0, event)
        used += len(event) + 2
    kept: list[str] = []
    for event in events[: len(events) - len(tail)]:
        if used + len(event) + 2 > budget:
            break
        kept.append(event)
        used += len(event) + 2
    omitted = len(events) - len(kept) - len(tail)
    return "\n\n".join([head, title, *kept, f"…{omitted} events omitted…", *tail, card])[:max_chars]
