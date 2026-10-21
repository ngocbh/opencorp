"""Question-card actions (answer, chat about this, send back, stop) and the side sessions they open and close."""

import logging
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from opencorp.chat.connections import OFFICE
from opencorp.chat.harness import Harness, HarnessError, RunSpec
from opencorp.chat.state import not_waiting
from opencorp.chat.turns import MAIN_CHAT
from opencorp.company.loader import load_repo
from opencorp.protocol import now
from opencorp.protocol.models import CompanyDefaults, DiscussionEntry, Event, Question, Session
from opencorp.questions.checker import InvalidAnswer, check_answer
from opencorp.questions.format import INTERRUPTED
from opencorp.questions.seed import build_seed, first_message
from opencorp.questions.side import (BACK_HINT, EXIT_WORDS, SIDE_CHAT, discussion, is_live, read_seed, side_spec,
                                      write_seed)
from opencorp.runs.outcomes import CARD_CLOSED
from opencorp.store import InvalidTransition, new_id

log = logging.getLogger(__name__)

_HARNESS_ONLY_ANSWER = "a Codex card takes only an answer; press Esc in the chat to interrupt Codex's turn"


class Cards:
    """What a question card can do, and the side sessions behind "Chat about this".

    A side session is a ``kind: side`` session of the person who asked, in the asker's
    folder at the asker's pinned commit. Its first turn gets the seed (kept in its run
    dir, not on the session) before the human's message. It ends when its question
    leaves ``open``; its discussion is copied onto the question at each side turn and
    before each answer. ``register`` wires these methods into the harness hooks.
    """

    def __init__(self, office: Any, harness: Harness) -> None:
        self.office, self.harness, self.store = office, harness, office.store
        self._lock = threading.Lock()
        # Held while a discussion is copied onto a question or a send-back note is added and
        # answered, so a side turn's copy can't replace the note before the answer lands.
        self._discussion = threading.Lock()
        # Store listeners must not block; closing a side session waits on the harness.
        self._pool = ThreadPoolExecutor(1, thread_name_prefix="cards")
        self._unlisten = self.store.add_listener(self._stored)

    # --- card actions ------------------------------------------------------------------

    def answer(self, question_id: str, answer: Any, kind: str, *, by: str | None = None) -> Question:
        """Answer a card: check and convert the answer, copy the discussion, then answer through the harness.

        ``by`` is the human answering.
        """
        question = self._open(question_id)
        try:
            value = check_answer(question, answer, kind)
        except InvalidAnswer as exc:
            raise HarnessError(422, "invalid_answer", str(exc)) from exc
        self.snapshot(question)
        return self.harness.answer(question_id, value, kind, by=by)

    def open_side(self, question_id: str, text: str, *, by: str | None = None) -> Session:
        """"Chat about this": send ``text`` to the question's side session, starting it if needed.

        ``by`` is the human sending it; one who opens or reopens the side session is in it now.
        """
        question = self._open(question_id)
        self._not_harness(question)
        if self._is_turn(question):
            raise HarnessError(422, "not_a_card", "a chat turn is not a question card; reply in the chat")
        refusal = self.refuse_exit(None, text)
        if refusal:
            raise HarnessError(422, "refused", refusal)
        with self._lock:  # one side session per question
            question = self._open(question_id)
            side = self.store.get_session(question.side_session_id) if question.side_session_id else None
            if side is None:
                side, spec = self._create_side(question, opened_by=by)
                self.harness.start_run(side, spec, parent_run_id=question.run_id)
            elif not is_live(side):  # ended or failed: a new run continues its stored memory
                side = side.model_copy(update={"opened_by": by or side.opened_by})  # whoever reopens it is in it now
                spec = side_spec(self.harness, side)
                side = self.store.update_session(side.id, status="starting", opened_by=side.opened_by)
                self.harness.start_run(side, spec, parent_run_id=question.run_id)
        if self.store.get_question(question_id).status != "open":  # answered while it started
            try:
                self.harness.end(side.id)
            except HarnessError:
                pass  # its run is already gone
            raise HarnessError(409, "not_open", f"question {question_id} is no longer open")
        self.harness.prompt(side.id, text, by=by)
        return self.store.get_session(side.id)

    def send_back(self, question_id: str, note: str, *, by: str | None = None) -> Question:
        """Send the discussion back undecided as ``by``; a non-blank ``note`` is the human's last message in it."""
        question = self._open(question_id)
        self._not_harness(question)
        if question.source == "human_input":
            raise HarnessError(422, "cannot_send_back", "a flow's own question can't be sent back")
        with self._discussion:
            question = self.snapshot(self._open(question_id))
            if not question.discussion and not question.carried_from:
                raise HarnessError(422, "no_discussion", "chat about the question before sending it back")
            if note.strip():
                self.store.update_question(question_id, discussion=[*question.discussion,
                                                                    DiscussionEntry(role="user", text=note)])
            return self.harness.answer(question_id, None, "sent_back", by=by)

    def stop(self, question_id: str, *, by: str | None = None) -> Question:
        """Stop the asker from the card: it gets ``[interrupted by the user]`` with the discussion.

        A model question in a live chat is Esc on that chat (the reply stops too), which is no
        one's; any other model question is answered as ``by`` and its run carries on.
        """
        question = self._open(question_id)
        self._not_harness(question)
        if question.source == "human_input":
            raise HarnessError(422, "cannot_stop", "a flow's own question can't be stopped")
        self.snapshot(question)
        asker = self.store.get_session(question.session_id)
        if question.source == "ask_user" and asker is not None and asker.kind == "main" and is_live(asker):
            try:
                self.harness.interrupt(asker.id)
                return self.store.get_question(question_id)
            except HarnessError:
                pass  # its run is gone; answer the question alone
        return self.harness.answer(question_id, INTERRUPTED, "interrupted", by=by)

    def dismiss_carried(self, question_id: str) -> Question:
        """Stop carrying an expired question's discussion into this card and its answer."""
        self._open(question_id)
        return self.store.update_question(question_id, carried_from=None)

    def snapshot(self, question: Question) -> Question:
        """Copy the side session's discussion onto ``question``; return the question as stored."""
        if not question.side_session_id:
            return question
        entries = discussion(self.store, question.side_session_id)
        if entries == question.discussion:
            return question
        return self.store.update_question(question.id, discussion=entries)

    # --- hooks -------------------------------------------------------------------------

    def check(self, question: Question, answer: Any, kind: str) -> str | None:
        """``answer_check``: refuse an answer that doesn't fit its card (turn questions aren't cards)."""
        if self._is_turn(question):
            return None
        try:
            check_answer(question, answer, kind)
        except InvalidAnswer as exc:
            return str(exc)
        return None

    def refuse_exit(self, session: Session | None, text: str) -> str | None:
        """``prompt_check``: only the office ends a side chat (``session`` None means one being opened)."""
        if (session is None or session.kind == "side") and text.strip().casefold() in EXIT_WORDS:
            return BACK_HINT
        return None

    def first_turn(self, session: Session, question: Question, text: str) -> str | None:
        """``turn_text``: a side session's first human turn gets the seed before the message."""
        if session.kind != "side":
            return None
        seed = read_seed(self.office.paths.run_dir(session.id))
        if not seed:
            return None
        # The seed is in the session's memory once a turn the human answered (only the office
        # answers with the exit command) has a later turn in its run: the loop asks again only
        # after the reply finished and its memory was written. A reply that died before then
        # sends the seed again, so the worst case is the seed twice in the history.
        turns = [q for q in self.store.list_questions(session_id=session.id, source="human_input")
                 if SIDE_CHAT.is_turn(q.node_id)]
        for n, done in enumerate(turns):
            if done.status in ("answered", "consumed") and done.answer != SIDE_CHAT.exit \
                    and any(later.run_id == done.run_id for later in turns[n + 1:]):
                return None
        return first_message(seed, text)

    def stored(self, question: Question) -> None:
        """``question_stored``: a side turn copies the discussion; a new card may carry an expired one's."""
        session = self.store.get_session(question.session_id)
        if session is None:
            return
        if session.kind == "side":
            with self._discussion:
                parent = self.store.get_question(session.question_id) if session.question_id else None
                if parent is not None and parent.status == "open":
                    self.snapshot(parent)
            return
        if self._is_turn(question):
            return
        earlier = [q for q in self.store.list_questions(session_id=question.session_id)
                   if q.id != question.id and q.created_at <= question.created_at and not self._is_turn(q)]
        if earlier and earlier[-1].status == "stale" and earlier[-1].discussion:
            self.store.update_question(question.id, carried_from=earlier[-1].id)

    def ended(self, session: Session) -> None:
        """``session_ended``: an ended or failed run answers nothing more, so its open questions expire."""
        for q in self.store.list_questions(session_id=session.id, status="open"):
            try:
                self.store.set_question_status(q.id, "stale")
            except InvalidTransition:
                pass  # answered meanwhile

    # --- life of side sessions -----------------------------------------------------------

    def sweep(self) -> None:
        """At start, after the harness resumed what it could: expire open questions of sessions with no
        live run, and end side sessions whose question is closed."""
        for q in self.store.list_questions(status="open"):
            session = self.store.get_session(q.session_id)
            if session is not None and not is_live(session):
                self.ended(session)
        for side in self.store.list_sessions(kind="side", status=("starting", "idle", "busy", "waiting"), limit=None):
            question = self.store.get_question(side.question_id) if side.question_id else None
            if question is None or question.status != "open":
                self._close(side.id, question)

    def close(self) -> None:
        """Stop reacting to question changes."""
        self._unlisten()
        self._pool.shutdown(wait=True, cancel_futures=True)

    def _stored(self, event: Event) -> None:
        if event.type == "question.updated" and event.data.get("side_session_id") \
                and event.data.get("status") != "open":
            question = Question.model_validate(event.data)
            self._pool.submit(self._close, question.side_session_id, question)

    def _close(self, side_id: str, question: Question | None) -> None:
        side = self.store.get_session(side_id)
        if question is not None and question.status == "stale":
            self.snapshot(self.store.get_question(question.id))  # the expired card keeps its discussion
        if is_live(side):
            try:
                self.harness.end(side_id)
            except HarnessError as exc:
                # A failed wake for the end has already failed it, a stopping office leaves it to the next start, a
                # run finishing on its own stores its end and outcome itself, and open_side ends a side chat that is
                # still starting once its start returns (it checks the question then), including one whose start
                # registered its live run after the 409.
                current = self.store.get_session(side_id)
                if exc.code == "stopping" or side_id in self.harness._finishing or side_id in self.harness._starting \
                        or side_id in self.harness._live or not is_live(current) or current.status == "starting":
                    return
                log.warning("side session %s has no live run to end", side_id)
                with self.store.transaction():  # the side run's outcome commits with the session's end
                    side = self.store.update_session(side_id, **not_waiting("ended"))
                    if side.run_ids:
                        self.store.end_run(side.run_ids[-1], "interrupted", reason=CARD_CLOSED)
                self.ended(side)

    # --- helpers -------------------------------------------------------------------------

    def _create_side(self, question: Question, *, opened_by: str | None = None) -> tuple[Session, RunSpec]:
        asker = self.store.get_session(question.session_id)
        if asker is None:
            raise HarnessError(409, "not_open", f"question {question.id} has no session")
        repo = load_repo(self.office.git.pin(asker.repo_commit))
        defaults = (repo.company.defaults if repo.company else None) or CompanyDefaults()
        seed = build_seed(self.store, repo, question, max_chars=defaults.side_seed_max_chars,
                          carried=self.harness.answers.carried(question))
        t = now()
        side = Session(id=new_id(), person=question.asker, harness="composer", office=socket.gethostname(),
                       cwd=asker.cwd, repo_commit=asker.repo_commit, status="starting", kind="side",
                       question_id=question.id, cost_cap_usd=defaults.side_chat_cost_cap_usd, opened_by=opened_by,
                       connection=asker.connection or OFFICE, model=asker.model, created_at=t, updated_at=t)
        spec = side_spec(self.harness, side)  # refuse a missing flow or folder before anything is stored
        write_seed(self.office.paths.run_dir(side.id), seed)
        side = self.store.create_session(side)
        self.store.update_question(question.id, side_session_id=side.id)
        return side, spec

    def _open(self, question_id: str) -> Question:
        question = self.store.get_question(question_id)
        if question is None:
            raise HarnessError(404, "not_found", f"no question {question_id}")
        if question.status != "open":
            raise HarnessError(409, "not_open", f"question {question_id} is {question.status}")
        return question

    def _not_harness(self, question: Question) -> None:
        """Raise ``422 harness_card`` for a harness card, which a side chat, send back or stop can't reach."""
        if question.source == "harness":
            raise HarnessError(422, "harness_card", _HARNESS_ONLY_ANSWER)

    def _is_turn(self, question: Question) -> bool:
        # Both chat flows the office runs share the turn path chat/ask.
        return question.source == "human_input" and MAIN_CHAT.is_turn(question.node_id)
