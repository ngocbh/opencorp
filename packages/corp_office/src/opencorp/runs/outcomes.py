"""Who drives a run the office starts itself, each flow's label, and the outcomes and reasons the office writes when
a run ends."""

from dataclasses import dataclass

from opencorp.runs.scrub import scrub_string

OFFICE = "office"
"""The driver of the runs the office starts itself (debriefs)."""
FLOWS = {"main": "chat", "side": "side_chat", "profile_manager": "profile_manager"}
"""A session's runs' flow label, by the session's kind."""
DEBRIEF = "debrief"

LOOP_LIMIT = "stopped at its loop limit"
WORKER_STOPPED = "worker stopped"
COULDNT_START = "couldn't start"
COULDNT_RESUME = "couldn't resume"
OFFICE_STOPPED = "the office stopped"
OFFICE_REPLACED = "the office stopped; a fresh run replaced it"
WORKER_REPLACED = "its worker stopped; a fresh run replaced it"
NEW_MODEL = "replaced by a fresh run on the new model"
CARD_CLOSED = "its card closed while it wasn't running"
BAD_OUTPUT = "bad output"


@dataclass(frozen=True)
class RunEnd:
    """How a run ended, as its outcome is written. Every outcome whose reason carries a failure message is built as
    one: the reason loses every secret of a known shape here (the run page and the list remove known values when they
    show it)."""

    outcome: str
    reason: str | None = None
    failed_node: str | None = None

    def __post_init__(self) -> None:
        if self.reason is not None:
            object.__setattr__(self, "reason", scrub_string(self.reason))


def flow_label(kind: str) -> str:
    """The flow label of a session of ``kind``'s runs."""
    return FLOWS.get(kind, kind)
