"""Question cards: side chats, card actions, and answer checks, wired into the chat harness."""

import asyncio
from typing import Any

from agent_corp.questions.cards import Cards
from agent_corp.questions.side import side_spec


def register(office: Any) -> None:
    """Put ``Cards`` in ``office.extras["cards"]`` and hook it into the harness; no harness, no cards."""
    harness = office.extras.get("harness")
    if harness is None:
        return
    cards = Cards(office, harness)
    office.extras["cards"] = cards
    harness.restorers["side"] = lambda session: side_spec(harness, session)
    harness.hooks.answer_check.append(cards.check)
    harness.hooks.prompt_check.append(cards.refuse_exit)
    harness.hooks.turn_text.append(cards.first_turn)
    harness.hooks.question_stored.append(cards.stored)
    harness.hooks.session_ended.append(cards.ended)
    # After the harness's own on_start, which resumes the sessions it can.
    office.on_start.append(lambda: asyncio.to_thread(cards.sweep))
    office.on_stop.append(cards.close)
