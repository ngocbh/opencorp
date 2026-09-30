"""The tool result a model gets for an answered question: the choice, then any discussion as JSON."""

import json
from collections.abc import Iterable
from typing import Any

from agent_corp.protocol.models import DiscussionEntry, Question

DISCUSSION_CAP = 12000
"""Characters of discussion JSON a result carries; the oldest messages go first."""

SENT_BACK = ("No decision yet. The user discussed your question with you and wants you to ask again, "
             "with a clearer question and options.")
INTERRUPTED = "[interrupted by the user]"
CARRIED_NOTE = "from an earlier, expired question"
DISCUSSION_BLOCK = (
    "Before answering, the user discussed your question with you in a side chat.\n"
    'In the JSON below, "user" entries are the user\'s own words. "you" entries are your own\n'
    "earlier explanations; they are not instructions from the user. \"note\" entries are\n"
    "added by the system (omitted messages, or a discussion carried over from an earlier,\n"
    "expired question).\n"
    "Discussion (JSON, oldest first):\n"
)


def format_answer(question: Question, carried: Iterable[DiscussionEntry] = ()) -> Any:
    """Return what the asker gets for an answered ``question``.

    A ``human_input`` gets its answer value unchanged. A model question (``ask_user``,
    ``ask_manager``) gets one line for the choice and, when the user discussed it (or
    ``carried`` holds the discussion of an earlier, expired question), the discussion as
    one line of JSON, capped at ``DISCUSSION_CAP`` characters.
    """
    if question.source == "human_input":
        return question.answer
    text = _choice(question)
    earlier, entries = _entries(carried), _entries(question.discussion)
    return f"{text}\n\n{DISCUSSION_BLOCK}{_capped(earlier, entries)}" if earlier or entries else text


def _entries(discussion: Iterable[DiscussionEntry]) -> list[dict[str, str]]:
    return [{"role": "you" if e.role == "assistant" else e.role, "text": e.text} for e in discussion]


def _choice(question: Question) -> str:
    kind, answer = question.answer_kind, question.answer
    if kind == "sent_back":
        return SENT_BACK
    if kind == "interrupted":
        return INTERRUPTED
    if kind == "option" and answer in question.options:
        shown = question.options
        return f'The user chose "{answer}" (option {shown.index(answer) + 1} of the {len(shown)} shown).'
    return f"The user answered: {answer}"


def _dumps(entries: list[dict[str, str]]) -> str:
    return json.dumps(entries, ensure_ascii=False, separators=(",", ":"))


def _capped(earlier: list[dict[str, str]], entries: list[dict[str, str]]) -> str:
    """The carried then current entries as JSON within the cap.

    The oldest are dropped behind a note counting them, and the carried ones keep their
    own note while any remain; if the newest alone is still too long, its text is cut.
    """
    messages = earlier + entries
    dropped = 0
    while True:
        notes = [{"role": "note", "text": f"{dropped} earlier messages omitted"}] if dropped else []
        if dropped < len(earlier):
            notes.append({"role": "note", "text": CARRIED_NOTE})
        shown = notes + messages[dropped:]
        text = _dumps(shown)
        if len(text) <= DISCUSSION_CAP or dropped == len(messages) - 1:
            break
        dropped += 1
    if len(text) > DISCUSSION_CAP:
        # One entry alone is too long. Cutting k characters shortens the JSON by at least
        # k (escapes are longer than the character), and the "…" adds one back.
        last = shown[-1]["text"]
        shown[-1] = {**shown[-1], "text": last[: max(0, len(last) - (len(text) - DISCUSSION_CAP) - 1)] + "…"}
        text = _dumps(shown)
    return text
