"""Company tools every person has, bound to the caller: ask_manager, create_work_item, comment."""

from collections.abc import Callable
from typing import Annotated, Any

from pydantic import Field

from agent_corp.company.loader import CompanyRepo
from agent_corp.protocol import now
from agent_corp.protocol.models import Comment, Question, Session, WorkItem
from agent_corp.questions.ask import Carried, OnQuestion
from agent_corp.questions.format import format_answer
from agent_corp.questions.normalize import normalize_options
from agent_corp.store import Store, new_id

TITLE_CHARS = 80


def company_tools(store: Store, repo: CompanyRepo, session: Session, run_id: str, on_question: OnQuestion, *,
                  carried: Carried | None = None) -> dict[str, Callable[..., str]]:
    """The ``company`` tool group for ``session.person``'s run ``run_id``.

    ``repo`` is the run's pinned company repo (for the caller's manager and valid
    assignees). ``ask_manager`` blocks in ``on_question`` until the manager answers. A
    tool's exception reaches the model as ``error: <message>``.
    """
    caller = repo.people.get(session.person)
    names = (caller.id, caller.handle, caller.name) if caller else (session.person,)

    def ask_manager(
        question: str,
        options: Annotated[Any, Field(description="Optional 2-4 short answer choices. Your manager can "
                                                  "always type a different answer.")] = None,
    ) -> str:
        """Ask your manager a question and wait for the answer.

        Use it for a decision or information your manager must give. Put the context
        they need in one or two sentences.
        """
        manager = caller.manager if caller else None
        if manager is None:
            raise ValueError("you have no manager to ask")
        title = " ".join(question.split())[:TITLE_CHARS] or "Question"
        item = store.create_work_item(_work_item(title=title, kind="question", requester=session.person,
                                                 assignee=manager, parent_id=session.work_item_id))
        t = now()
        answered = on_question(Question(
            id=new_id(), session_id=session.id, run_id=run_id, node_id=None, source="ask_manager",
            asker=session.person, work_item_id=item.id, question=question,
            options=normalize_options(options, names=names), status="open", created_at=t, updated_at=t))
        store.update_work_item(item.id, status="done", resolved_by=answered.answered_by)
        return format_answer(answered, carried(answered) if carried else ())

    def create_work_item(title: str, summary: str | None = None, assignee: str | None = None) -> str:
        """Create a work item (a task) under the one you are working on.

        `assignee` is a person id; leave it out to leave the task unassigned.
        """
        if assignee is not None and assignee not in repo.people:
            raise ValueError(f"no person {assignee!r}")
        item = store.create_work_item(_work_item(title=title, kind="task", requester=session.person,
                                                 assignee=assignee, parent_id=session.work_item_id, summary=summary))
        return f"created work item {item.id}"

    def comment(work_item_id: str, body: str) -> str:
        """Add a comment to a work item."""
        if store.get_work_item(work_item_id) is None:
            raise ValueError(f"no work item {work_item_id!r}")
        store.add_comment(Comment(id=new_id(), work_item_id=work_item_id, author=session.person, body=body,
                                  created_at=now()))
        return f"commented on {work_item_id}"

    return {"ask_manager": ask_manager, "create_work_item": create_work_item, "comment": comment}


def _work_item(**fields: Any) -> WorkItem:
    t = now()
    return WorkItem.model_validate({"id": new_id(), "status": "open", "created_at": t, "updated_at": t, **fields})
