"""What a run can offer its host tools."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Types only: perm.monitor imports tools.workspace, which imports this module, so runtime imports would cycle.
    from agent_corp.company.loader import CompanyRepo
    from agent_corp.perm.monitor import Monitor
    from agent_corp.protocol.models import Question, Session
    from agent_corp.questions.ask import Carried, OnQuestion
    from agent_corp.store import Store
    from agent_corp.tools.workspace import WorkspaceTools


@dataclass(frozen=True)
class ToolContext:
    """What one run can offer its tools; each group offers only the tools whose needs are set.

    ``session.person`` is who the tools act for. ``repo`` is the run's pinned company repo.
    ``monitor`` audits workspace calls and holds the asset grants. ``read_only`` limits
    ``workspace`` to its read tools. ``question`` is what a side chat is about.
    """

    store: Store | None = None
    repo: CompanyRepo | None = None
    session: Session | None = None
    run_id: str | None = None
    on_question: OnQuestion | None = None
    carried: Carried | None = None
    monitor: Monitor | None = None
    workspace: WorkspaceTools | None = None
    read_only: bool = False
    question: Question | None = None
