"""Callback lists that extensions append to in ``register(office)``; the harness calls them in order."""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field, fields
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class Hooks:
    """The harness's extension points. Each is a list of callbacks, called in order.

    - ``question_stored(question)``: a question was stored (turn questions included).
    - ``answer_check(question, answer, answer_kind) -> str | None``: return a message to
      refuse an answer (the route answers ``422 invalid_answer``); ``None`` accepts it.
    - ``run_started(session, run_id)``: a worker started a run or a resume of one.
    - ``run_finished(session, run_id, result)``: a run ended; ``result`` is the worker's
      result frame (``status``, ``output``, ``failure``), or ``None`` after an error frame.
    - ``worker_exited(session, returncode)``: the session's worker is gone.
    - ``session_ended(session)``: the session reached ``ended`` or ``failed`` (see
      ``session.status``); it fires once, including for a session that failed before its
      worker started.

    A callback that raises is logged and skipped; the rest still run.
    """

    question_stored: list[Callable[..., Any]] = field(default_factory=list)
    answer_check: list[Callable[..., Any]] = field(default_factory=list)
    run_started: list[Callable[..., Any]] = field(default_factory=list)
    run_finished: list[Callable[..., Any]] = field(default_factory=list)
    worker_exited: list[Callable[..., Any]] = field(default_factory=list)
    session_ended: list[Callable[..., Any]] = field(default_factory=list)

    def fire(self, name: str, *args: Any) -> list[Any]:
        """Call every ``name`` callback with ``args``; return the results of those that didn't raise."""
        if name not in {f.name for f in fields(self)}:
            raise ValueError(f"no hook named {name!r}")
        results = []
        for callback in list(getattr(self, name)):
            try:
                results.append(callback(*args))
            except Exception:
                log.exception("%s callback %r failed", name, callback)
        return results
