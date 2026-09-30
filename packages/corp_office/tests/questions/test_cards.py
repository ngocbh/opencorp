"""Card actions and side sessions, run on the chat harness with a scripted model."""

import json
import os
import signal
import stat
import threading
from importlib.resources import files

import pytest

from agent_corp.chat.harness import HarnessError
from agent_corp.extensions.questions import register
from agent_corp.questions.format import CARRIED_NOTE, INTERRUPTED, SENT_BACK
from agent_corp.questions.seed import FRAMING
from agent_corp.questions.side import BACK_HINT, SEED_FILE, SIDE_CHAT_FLOW
from tests.chat.conftest import fake_llm, make_harness, status, texts, wait_for, workspace  # noqa: F401
from tests.company.conftest import _isolate_git, person  # noqa: F401

SIDE_FLOW = (files("agent_corp.company_template") / "shared" / "flows" / "side_chat.yaml").read_text()
ASK = {"tool_calls": [{"name": "ask_user", "arguments": {"question": "Retry or back off?",
                                                         "options": ["Retry", "Back off"]}}]}
GATE = """\
id: gate
name: gate
nodes:
  setup:
    kind: human_input
    questions:
      - question: Which database?
        header: db
        options: [{label: Postgres}, {label: SQLite}]
      - question: Which features?
        header: features
        multi_select: true
        options: [{label: auth}, {label: search}]
output: ${setup.output}
"""


@pytest.fixture
def office(make_harness):  # noqa: F811
    office = wire(make_harness(files={SIDE_CHAT_FLOW: SIDE_FLOW}))
    yield office
    stop(office)


def wire(h):
    """Give the test office what ``build_office`` gives a real one, then load the extension."""
    h.office.extras, h.office.on_start, h.office.on_stop = {"harness": h}, [], []
    register(h.office)
    return h.office


def stop(office):
    for callback in reversed(office.on_stop):
        callback()


def asked(fake_llm, n):  # noqa: F811
    return json.dumps(fake_llm.wait_for_requests(n)[n - 1]["messages"])


def last_user(fake_llm, n):  # noqa: F811
    return [m for m in fake_llm.wait_for_requests(n)[n - 1]["messages"] if m["role"] == "user"][-1]["content"]


def ask(office, fake_llm, workspace):  # noqa: F811
    """Start minh's chat and have its reply ask the scripted question; return (session id, question)."""
    h = office.extras["harness"]
    session = h.start_session("minh", str(workspace))
    wait_for(lambda: status(h, session.id) == "idle", what="the first turn")
    h.prompt(session.id, "fix the build")
    q = wait_for(lambda: h.store.list_questions(session_id=session.id, status="open", source="ask_user"),
                 what="the question")[0]
    return session.id, q


def chat(office, q, text, n_replies):
    """Send ``text`` in the question's side chat and wait for its reply number ``n_replies``."""
    cards, h = office.extras["cards"], office.extras["harness"]
    side = cards.open_side(q.id, text)
    wait_for(lambda: len(texts(h, side.id)) == n_replies and status(h, side.id) == "idle", what="the side reply")
    return side


def test_chat_about_this_opens_a_seeded_side_session_and_the_answer_carries_it(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "The sandbox is rate-limited."}, {"content": "Each retry costs a call."},
                    {"content": "Backing off."})
    h, cards = office.extras["harness"], office.extras["cards"]
    sid, q = ask(office, fake_llm, workspace)

    side = chat(office, q, "why not fail fast?", 1)
    assert (side.kind, side.question_id, side.person, side.cwd, side.cost_cap_usd, side.seed) == (
        "side", q.id, "minh", os.path.realpath(workspace), 1, None)
    seed_file = h.office.paths.run_dir(side.id) / SEED_FILE
    seed = seed_file.read_text()
    assert seed.startswith(FRAMING) and "Retry or back off?" in seed
    assert stat.S_IMODE(seed_file.stat().st_mode) == 0o600
    assert h.store.get_question(q.id).side_session_id == side.id
    first = last_user(fake_llm, 2)
    assert first.startswith(FRAMING) and first.endswith("why not fail fast?")
    assert "ask_user" not in json.dumps(fake_llm.wait_for_requests(2)[1].get("tools", []))

    chat(office, q, "and retries?", 2)
    assert last_user(fake_llm, 3) == "and retries?"
    assert asked(fake_llm, 3).count(FRAMING) == 1  # the seed, once, from the side session's memory
    assert texts(h, side.id, "user") == ["why not fail fast?", "and retries?"]
    assert [(e.role, e.text) for e in h.store.get_question(q.id).discussion] == [
        ("user", "why not fail fast?"), ("assistant", "The sandbox is rate-limited."),
        ("user", "and retries?"), ("assistant", "Each retry costs a call.")]

    for say in (lambda: cards.open_side(q.id, "/exit"), lambda: h.prompt(side.id, " /Quit ")):
        with pytest.raises(HarnessError) as err:
            say()
        assert (err.value.status, err.value.code, err.value.message) == (422, "refused", BACK_HINT)

    # The seed stays out of the session, so its updates (one per model call) don't carry it to every client.
    updates = [e.data for e in h.store.events_after() if e.type == "session.updated" and e.subject_id == side.id]
    assert len(updates) > 2 and not any(FRAMING in json.dumps(d) for d in updates)

    cards.answer(q.id, "Back off", "option")
    result = asked(fake_llm, 4)
    assert 'The user chose \\"Back off\\" (option 2 of the 2 shown).' in result
    assert "why not fail fast?" in result and "Each retry costs a call." in result
    wait_for(lambda: status(h, side.id) == "ended", what="the side session to end")
    wait_for(lambda: texts(h, sid)[-1:] == ["Backing off."], what="the asker's reply")


def test_send_back_needs_a_discussion_and_returns_it_undecided(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "It depends on the quota."}, {"content": "I'll ask better."})
    h, cards = office.extras["harness"], office.extras["cards"]
    sid, q = ask(office, fake_llm, workspace)
    with pytest.raises(HarnessError) as err:
        cards.send_back(q.id, "")
    assert (err.value.status, err.value.code) == (422, "no_discussion")

    side = chat(office, q, "what quota?", 1)
    answered = cards.send_back(q.id, "list the quotas as options")
    assert (answered.answer_kind, answered.discussion[-1].text) == ("sent_back", "list the quotas as options")
    result = asked(fake_llm, 3)
    assert SENT_BACK in result and "It depends on the quota." in result and "list the quotas as options" in result
    wait_for(lambda: status(h, side.id) == "ended", what="the side session to end")
    with pytest.raises(HarnessError) as err:
        cards.send_back(q.id, "")
    assert (err.value.status, err.value.code) == (409, "not_open")


def test_a_side_turn_stored_during_send_back_keeps_the_note(office, fake_llm, workspace, monkeypatch):  # noqa: F811
    fake_llm.script(ASK, {"content": "It depends on the quota."}, {"content": "I'll ask better."})
    h, cards = office.extras["harness"], office.extras["cards"]
    _, q = ask(office, fake_llm, workspace)
    side = chat(office, q, "what quota?", 1)
    turn = h.store.list_questions(session_id=side.id, status="open", source="human_input")[0]
    answer, late = h.answer, []

    def answer_after_a_side_turn(question_id, value, kind):
        # A side turn is stored after the note is added and before the answer lands.
        late.append(threading.Thread(target=cards.stored, args=(turn,)))
        late[0].start()
        late[0].join(0.3)
        return answer(question_id, value, kind)

    monkeypatch.setattr(h, "answer", answer_after_a_side_turn)
    cards.send_back(q.id, "list the quotas as options")
    late[0].join(5)
    assert [e.text for e in h.store.get_question(q.id).discussion] == [
        "what quota?", "It depends on the quota.", "list the quotas as options"]


def test_stop_is_esc_on_the_asking_chat(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "Because of the quota."})
    h, cards = office.extras["harness"], office.extras["cards"]
    sid, q = ask(office, fake_llm, workspace)
    side = chat(office, q, "why?", 1)
    stopped = cards.stop(q.id)
    assert (stopped.answer, stopped.answer_kind) == (INTERRUPTED, "interrupted")
    assert [e.text for e in stopped.discussion] == ["why?", "Because of the quota."]
    wait_for(lambda: status(h, sid) == "idle", what="the asker to wait for the next message")
    wait_for(lambda: status(h, side.id) == "ended", what="the side session to end")


def test_a_manager_question_is_stopped_by_answering_it(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script({"tool_calls": [{"name": "ask_manager", "arguments": {"question": "Budget?"}}]},
                    {"content": "Carrying on."})
    h, cards = office.extras["harness"], office.extras["cards"]
    session = h.start_session("minh", str(workspace))
    wait_for(lambda: status(h, session.id) == "idle", what="the first turn")
    h.prompt(session.id, "plan it")
    q = wait_for(lambda: h.store.list_questions(session_id=session.id, status="open", source="ask_manager"),
                 what="the manager question")[0]
    cards.stop(q.id)
    assert INTERRUPTED in asked(fake_llm, 2)
    wait_for(lambda: texts(h, session.id)[-1:] == ["Carrying on."], what="the asker to carry on")


def test_a_gate_takes_a_record_keyed_by_header_and_offers_no_send_back_or_stop(make_harness, workspace):  # noqa: F811
    h = make_harness(files={SIDE_CHAT_FLOW: SIDE_FLOW, "people/minh/gate.yaml": GATE,
                            "people/minh/person.yaml": person("minh", main="gate.yaml")})
    office = wire(h)
    cards, outcomes = office.extras["cards"], []
    h.hooks.run_finished.append(lambda session, run_id, outcome: outcomes.append(outcome))
    try:
        session = h.start_session("minh", str(workspace))
        q = wait_for(lambda: h.store.list_questions(session_id=session.id, status="open"), what="the gate")[0]
        assert (q.source, q.node_id, [p.header for p in q.questions]) == ("human_input", "setup", ["db", "features"])
        for action, code in [(lambda: cards.send_back(q.id, "x"), "cannot_send_back"),
                             (lambda: cards.stop(q.id), "cannot_stop"),
                             (lambda: cards.answer(q.id, {"db": "SQLite"}, "option"), "invalid_answer"),
                             (lambda: h.answer(q.id, "SQLite", "text"), "invalid_answer")]:
            with pytest.raises(HarnessError) as err:
                action()
            assert err.value.code == code
        answer = {"db": "SQLite", "features": ["auth", "search"]}
        assert cards.answer(q.id, answer, "option").answer == answer
        wait_for(lambda: status(h, session.id) == "ended", what="the flow to finish")
        assert outcomes[-1]["output"] == answer
    finally:
        stop(office)


def test_an_expired_question_hands_its_discussion_to_the_next_card(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "Retries hide flakes."}, ASK, {"content": "OK."})
    h, cards = office.extras["harness"], office.extras["cards"]
    sid, q1 = ask(office, fake_llm, workspace)
    side = chat(office, q1, "why ask?", 1)
    os.killpg(h._live[sid].worker.pgid, signal.SIGKILL)  # the run resumes and its agent node asks again
    wait_for(lambda: h.store.get_question(q1.id).status == "stale", what="the old question to expire")
    q2 = wait_for(lambda: [q for q in h.store.list_questions(session_id=sid, status="open", source="ask_user")],
                  what="the new question")[0]
    wait_for(lambda: h.store.get_question(q2.id).carried_from == q1.id, what="the carry-over")
    wait_for(lambda: status(h, side.id) == "ended", what="the old side session to end")
    assert [e.text for e in h.store.get_question(q1.id).discussion] == ["why ask?", "Retries hide flakes."]

    cards.answer(q2.id, "Retry", "option")
    result = asked(fake_llm, 4)
    assert CARRIED_NOTE in result and "Retries hide flakes." in result


def test_a_dismissed_carry_over_stays_out_of_the_answer(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "Retries hide flakes."}, ASK, {"content": "OK."})
    h, cards = office.extras["harness"], office.extras["cards"]
    sid, q1 = ask(office, fake_llm, workspace)
    chat(office, q1, "why ask?", 1)
    os.killpg(h._live[sid].worker.pgid, signal.SIGKILL)
    q2 = wait_for(lambda: [q for q in h.store.list_questions(session_id=sid, status="open", source="ask_user")
                           if q.carried_from], what="the carried card")[0]
    assert cards.dismiss_carried(q2.id).carried_from is None
    cards.answer(q2.id, "Retry", "option")
    assert CARRIED_NOTE not in asked(fake_llm, 4)


def test_a_session_that_fails_for_good_leaves_a_stale_card_with_its_discussion(office, fake_llm, workspace):  # noqa: F811
    fake_llm.script(ASK, {"content": "Because."}, ASK)
    h = office.extras["harness"]
    sid, q = ask(office, fake_llm, workspace)
    side = chat(office, q, "why?", 1)
    first = h._live[sid].worker
    os.killpg(first.pgid, signal.SIGKILL)
    second = wait_for(lambda: (w := h._live[sid].worker) not in (None, first) and w, what="the resume")
    q2 = wait_for(lambda: h.store.list_questions(session_id=sid, status="open", source="ask_user"), what="q2")[0]
    os.killpg(second.pgid, signal.SIGKILL)
    wait_for(lambda: status(h, sid) == "failed", what="the failure")
    wait_for(lambda: h.store.get_question(q2.id).status == "stale", what="the open card to expire")
    assert [e.text for e in h.store.get_question(q.id).discussion] == ["why?", "Because."]
    wait_for(lambda: status(h, side.id) == "ended", what="the side session to end")


def test_the_start_sweep_expires_cards_of_dead_sessions_and_ends_their_side_chats(office, fake_llm, workspace):  # noqa: F811
    from tests.store.conftest import question, session

    h, cards = office.extras["harness"], office.extras["cards"]
    dead = h.store.create_session(session(status="failed", cwd=str(workspace)))
    q = h.store.add_question(question(dead.id))
    orphan = h.store.create_session(session(kind="side", status="idle", question_id=q.id, cwd=str(workspace)))
    h.store.update_question(q.id, side_session_id=orphan.id)
    cards.sweep()
    assert h.store.get_question(q.id).status == "stale"
    wait_for(lambda: status(h, orphan.id) == "ended", what="the orphaned side session to end")


def test_the_seed_goes_once_when_no_ceo_answers_for_the_human(make_harness, fake_llm, workspace):  # noqa: F811
    # An unreadable company.yaml leaves the turns with no answered_by: "first" can't rest on it.
    office = wire(make_harness(files={SIDE_CHAT_FLOW: SIDE_FLOW, "company.yaml": "ceo: [unclosed\n"}))
    fake_llm.script(ASK, {"content": "Quota."}, {"content": "Per hour."})
    try:
        _, q = ask(office, fake_llm, workspace)
        chat(office, q, "why?", 1)
        assert last_user(fake_llm, 2).startswith(FRAMING)
        chat(office, q, "how often?", 2)
        assert last_user(fake_llm, 3) == "how often?"
    finally:
        stop(office)
