"""Work item tools: read-only lookups of the work items a person can see."""

import json
from collections.abc import Callable
from typing import Any

from agent_corp.protocol.models import Question
from agent_corp.store import Store


def work_item_tools(store: Store, handle: str, question: Question | None) -> dict[str, Callable[..., str]]:
    """Read-only work item tools for a side chat of ``handle`` about ``question``.

    The person sees the question's work item and the work item of the session that
    asked, their parents, and their children, plus items they requested or are
    assigned. Anything else is "no work item".
    """
    roots = [question.work_item_id] if question and question.work_item_id else []
    asker = store.get_session(question.session_id) if question else None
    if asker and asker.work_item_id:
        roots.append(asker.work_item_id)
    chain: set[str] = set()
    for item_id in roots:
        while item_id and item_id not in chain and (item := store.get_work_item(item_id)) is not None:
            chain.add(item.id)
            item_id = item.parent_id

    def visible(item: Any) -> bool:
        return (item.id in chain or item.parent_id in chain
                or handle in (item.requester, item.assignee))

    def list_work_items() -> str:
        """List the work items you can see (yours, and those around this question), newest first, as JSON."""
        items = [i for i in store.list_work_items(limit=None) if visible(i)]
        return json.dumps([{"id": i.id, "title": i.title, "status": i.status, "assignee": i.assignee,
                            "parent_id": i.parent_id} for i in items], ensure_ascii=False)

    def read_work_item(work_item_id: str) -> str:
        """Read one work item with its comments and children, as JSON."""
        item = store.get_work_item(work_item_id)
        if item is None or not visible(item):
            raise ValueError(f"no work item {work_item_id}")
        children = [{"id": c.id, "title": c.title, "status": c.status}
                    for c in store.list_work_items(limit=None) if c.parent_id == item.id]
        return json.dumps(item.model_dump(mode="json", exclude={"version"})
                          | {"comments": [{"author": c.author, "body": c.body, "created_at": c.created_at}
                                          for c in store.list_comments(item.id)],
                             "children": children}, ensure_ascii=False)

    return {"list_work_items": list_work_items, "read_work_item": read_work_item}
