"""The side chat's seed: framing, the asker's context, and the question card."""

import pytest

from opencorp.company.loader import load_repo
from opencorp.protocol.models import DiscussionEntry
from opencorp.questions.format import DISCUSSION_CAP
from opencorp.questions.seed import FRAMING, build_seed, card_text, first_message
from opencorp.store import new_id
from tests.company.conftest import base_files, write_repo
from tests.store.conftest import comment, message, question, session, work_item
from tests.store.conftest import store  # noqa: F401


def at(n: int) -> str:
    return f"2026-09-30T10:00:{n:02d}.000Z"


def text(t: str) -> dict:
    return {"id": new_id(), "type": "text", "text": t}


def tool(name: str, output) -> dict:
    return {"id": new_id(), "type": "tool", "call_id": new_id(), "tool": name, "state": "completed",
            "input": {"path": "src/app.py"}, "output": output}


@pytest.fixture
def repo(tmp_path):
    return load_repo(write_repo(tmp_path / "company", base_files()))


@pytest.fixture
def asked(store):  # noqa: F811
    parent = store.create_work_item(work_item(title="Ship v2"))
    item = store.create_work_item(work_item(title="Fix the build", parent_id=parent.id, assignee="minh"))
    store.add_comment(comment(item.id, body="CI is red since Monday"))
    asker = store.create_session(session(work_item_id=item.id))
    store.add_message(message(asker.id, [text("fix the build")], role="user", created_at=at(1)))
    store.add_message(message(asker.id, [text("Looking."), tool("read_file", "x" * 5000)], created_at=at(2)))
    q = store.add_question(question(asker.id, work_item_id=item.id, question="Retry or back off?",
                                    options=["Retry", "Back off"], created_at=at(3), updated_at=at(3)))
    store.add_message(message(asker.id, [text("after the question")], created_at=at(4)))
    return q


def test_the_seed_frames_the_chat_then_gives_context_and_the_card(store, repo, asked):  # noqa: F811
    seed = build_seed(store, repo, asked, max_chars=200_000)
    assert seed.startswith(FRAMING)
    order = ["# Who asked", "Minh (@minh), Engineer", "people/minh/../../shared/flows/chat.yaml",
             "kind: human_input", '"Fix the build"', "CI is red since Monday", '"Ship v2"',
             "[user] fix the build", "[you] Looking.", "[tool read_file, completed]",
             "# The question you asked (with ask_user)", "Retry or back off?", "1. Retry", "2. Back off"]
    places = [seed.index(s) for s in order]
    assert places == sorted(places)
    assert "x" * 2000 + "… [5000 chars]" in seed and "x" * 2001 not in seed
    assert "after the question" not in seed


def test_a_long_transcript_keeps_its_start_and_end(store, repo):  # noqa: F811
    asker = store.create_session(session())
    for n in range(40):
        store.add_message(message(asker.id, [text(f"step {n:02d} " + "y" * 400)], created_at=at(n)))
    q = store.add_question(question(asker.id, created_at=at(59), updated_at=at(59)))
    seed = build_seed(store, repo, q, max_chars=8000)
    assert len(seed) <= 8000
    assert seed.startswith(FRAMING) and seed.rstrip().endswith("Which db?")
    kept = [n for n in range(40) if f"step {n:02d}" in seed]
    head = [n for n in kept if n < 20]
    tail = [n for n in kept if n >= 20]
    assert head == list(range(len(head))) and tail == list(range(40 - len(tail), 40))
    assert 0 < len(head) < len(tail)  # the newest events get more of the room
    assert f"…{40 - len(kept)} events omitted…" in seed


def test_an_oversized_header_loses_its_comments_first_and_never_the_card(store, repo, asked):  # noqa: F811
    for n in range(30):
        store.add_comment(comment(asked.work_item_id, body=f"comment {n} " + "z" * 300))
    seed = build_seed(store, repo, asked, max_chars=5000)
    assert len(seed) <= 5000
    assert seed.startswith(FRAMING) and seed.rstrip().endswith("2. Back off")
    assert "comment 0" not in seed and '"Fix the build"' in seed

    # Even a work item too long to show at all leaves the framing and the card.
    store.update_work_item(asked.work_item_id, summary="w" * 20_000)
    seed = build_seed(store, repo, asked, max_chars=3000)
    assert len(seed) <= 3000
    assert seed.startswith(FRAMING) and "# The question you asked" in seed and seed.rstrip().endswith("2. Back off")


def test_a_carried_discussion_is_capped_in_the_card():
    ask = question(new_id(), question="Retry?")
    carried = [DiscussionEntry(role="user" if n % 2 else "assistant", text=f"message {n:03d} " + "c" * 500)
               for n in range(100)]
    card = card_text(ask, carried)
    carried_json = card.splitlines()[-1]
    assert len(carried_json) <= DISCUSSION_CAP
    assert "earlier messages omitted" in carried_json and "message 099" in carried_json
    assert "message 000" not in carried_json


def test_the_card_lists_pages_and_fields_and_carries_an_earlier_discussion():
    gate = question(new_id(), source="human_input", node_id="gate", question="", title="Setup",
                    questions=[{"question": "Which database?", "header": "db",
                                "options": [{"label": "Postgres", "description": "server"}, {"label": "SQLite"}]},
                               {"question": "Which features?", "header": "features", "multi_select": True,
                                "options": [{"label": "auth"}]}])
    carried = [DiscussionEntry(role="user", text="why Postgres?"), DiscussionEntry(role="assistant", text="scale")]
    assert card_text(gate, carried) == (
        "# The question you asked (at a human_input step of your flow)\n\n"
        "Title: Setup\n"
        "Question 1 of 2 · db: Which database?\n"
        "  - Postgres: server\n"
        "  - SQLite\n"
        "Question 2 of 2 · features (pick any): Which features?\n"
        "  - auth\n\n"
        "You discussed an earlier question with them before it expired (JSON, oldest first):\n"
        '[{"role":"user","text":"why Postgres?"},{"role":"you","text":"scale"}]')
    typed = question(new_id(), source="human_input", node_id="gate", question="How many days?",
                     answer_schema=[{"name": "answer", "type": "int", "required": True}])
    assert card_text(typed).endswith("How many days?\nAnswer field answer: int")


def test_the_framing_has_the_asker_talk_to_the_person_directly():
    assert FRAMING == (
        "You are now talking directly with the person you asked the question below, before they answer it. "
        'Speak to them as "you"; never call them "the user" or "they". They want to understand your question: '
        "explain it; do not decide for them, and do not change anything.")


def test_the_first_message_is_the_seed_then_what_the_user_typed():
    assert first_message("SEED", "why?") == "SEED\n\n# Their first message to you\n\nwhy?"
