"""The office side of a run's ``ask_user``, and storing questions until they are answered."""

import threading
from collections.abc import Callable, Iterable
from typing import Any, Protocol

from agent_corp.protocol import now
from agent_corp.protocol.models import DiscussionEntry, Event, Question, Session, WorkItem
from agent_corp.questions.format import format_answer
from agent_corp.questions.normalize import normalize_options
from agent_corp.store import DuplicateKey, InvalidTransition, Store, new_id

POLL_SECONDS = 30
"""How often a waiting ask re-reads its question, to see answers written by another process."""


class OnQuestion(Protocol):
    """Store an open question (with ``work_item``, if given), block until it is answered, and return it answered."""

    def __call__(self, question: Question, *, work_item: WorkItem | None = None) -> Question: ...


Carried = Callable[[Question], Iterable[DiscussionEntry]]
"""The discussion an answered question carries over from an earlier, expired one."""


class AnswersClosed(RuntimeError):
    """``Answers`` was closed before the question was answered."""


class QuestionExpired(RuntimeError):
    """The question went stale (its run restarted or was abandoned) before anyone answered."""


def make_ask_user(session: Session, run_id: str, on_question: OnQuestion, *,
                  names: Iterable[str] = (), carried: Carried | None = None) -> Callable[..., Any]:
    """Return a run's ``ask_user`` handler: composer's six keywords in, the answer out.

    A call with a ``node_id`` is a ``human_input`` node: its pages and answer schema are
    kept, and it gets the answer value. A call without one is the model's: its options
    are normalized (``names`` are the asker's names, for dropping ``Stop <name>``), and
    it gets the answer as text. The question is asked by ``session.person`` on
    ``session.work_item_id``.
    """
    names = tuple(names)

    def ask_user(**request: Any) -> Any:
        node_id = request.get("node_id")
        fields: dict[str, Any] = (
            {"source": "human_input", "questions": request.get("questions"),
             "answer_schema": request.get("answer_schema") or []}
            if node_id else
            {"source": "ask_user", "options": normalize_options(request.get("options"), names=names)}
        )
        t = now()
        question = Question.model_validate({
            "id": new_id(), "session_id": session.id, "run_id": run_id, "node_id": node_id,
            "asker": session.person, "work_item_id": session.work_item_id, "title": request.get("title"),
            "question": request.get("question") or "", "status": "open", "created_at": t, "updated_at": t,
            **fields,
        })
        answered = on_question(question)
        return format_answer(answered, carried(answered) if carried else ())

    return ask_user


class Answers:
    """Store questions and block callers until each is answered; one store listener wakes them all."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._closed = False
        self._waiting: dict[str, list[threading.Event]] = {}
        self._remove = store.add_listener(self._changed)

    def close(self) -> None:
        """Stop listening to the store; every waiting ``ask`` raises ``AnswersClosed``, as does any later one."""
        self._remove()
        with self._lock:
            self._closed = True
            waiting = [ready for events in self._waiting.values() for ready in events]
        for ready in waiting:
            ready.set()

    def ask(self, question: Question, *, work_item: WorkItem | None = None) -> Question:
        """Store ``question`` and return it once answered, marked ``consumed``.

        ``work_item``, if given, is stored in the same transaction as the question, and
        set to ``cancelled`` if the wait for the answer fails. A ``human_input`` asked
        again for the same run and node (after a restart) reuses the question already
        stored, and its answer if it has one.

        Raises:
            QuestionExpired: the question went stale first.
            AnswersClosed: this ``Answers`` was closed first.
        """
        qid, ready = question.id, threading.Event()
        # Wait before storing, so an answer that lands at once still wakes this call.
        self._watch(qid, ready)
        try:
            try:
                with self.store.transaction():
                    if work_item is not None:
                        self.store.create_work_item(work_item)
                    self.store.add_question(question)
            except DuplicateKey:
                work_item = None  # rolled back with the question
                self._unwatch(qid, ready)
                qid = self.store.get_question_by_node(question.run_id, question.node_id).id
                self._watch(qid, ready)
            try:
                return self._answered(qid, ready)
            except Exception:
                if work_item is not None:
                    self.store.update_work_item(work_item.id, status="cancelled")
                raise
        finally:
            self._unwatch(qid, ready)

    def carried(self, question: Question) -> list[DiscussionEntry]:
        """The discussion of the expired question ``question`` carries over, if any."""
        earlier = self.store.get_question(question.carried_from) if question.carried_from else None
        return list(earlier.discussion) if earlier else []

    def _answered(self, qid: str, ready: threading.Event) -> Question:
        while (current := self.store.get_question(qid)).status == "open":
            ready.wait(POLL_SECONDS)
            ready.clear()
            if self._closed:
                raise AnswersClosed(f"stopped waiting for question {qid}")
        if current.status == "stale":
            raise QuestionExpired(f"question {qid} expired before it was answered")
        if current.status == "answered":
            try:
                current = self.store.set_question_status(qid, "consumed")
            except InvalidTransition:  # consumed by another call meanwhile
                current = self.store.get_question(qid)
        return current

    def _watch(self, qid: str, ready: threading.Event) -> None:
        with self._lock:
            if self._closed:
                raise AnswersClosed("answers is closed")
            self._waiting.setdefault(qid, []).append(ready)

    def _unwatch(self, qid: str, ready: threading.Event) -> None:
        with self._lock:
            waiting = self._waiting.get(qid, [])
            if ready in waiting:
                waiting.remove(ready)
            if not waiting:
                self._waiting.pop(qid, None)

    def _changed(self, event: Event) -> None:
        if event.type == "question.updated":
            with self._lock:
                waiting = list(self._waiting.get(event.subject_id, ()))
            for ready in waiting:
                ready.set()
