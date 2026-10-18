"""Read-only work item tools: what the asker can see."""

import json

import pytest

from opencorp.store import new_id
from opencorp.tools.work_items import work_item_tools
from tests.store.conftest import question, session, work_item


def test_work_item_tools_show_only_what_the_asker_can_see(store):
    top = store.create_work_item(work_item(title="Ship v2"))
    chat = store.create_work_item(work_item(title="Chat", parent_id=top.id))
    sibling = store.create_work_item(work_item(title="Docs", parent_id=top.id))
    mine = store.create_work_item(work_item(title="Mine", requester="ngocbh", assignee="minh"))
    other = store.create_work_item(work_item(title="Someone else's", assignee="lan"))
    asker = store.create_session(session(work_item_id=chat.id))
    q = store.add_question(question(asker.id))
    tools = work_item_tools(store, "minh", q)
    listed = {i["title"] for i in json.loads(tools["list_work_items"]())}
    assert listed == {"Ship v2", "Chat", "Docs", "Mine"}
    read = json.loads(tools["read_work_item"](top.id))
    assert read["title"] == "Ship v2" and {c["title"] for c in read["children"]} == {"Chat", "Docs"}
    assert json.loads(tools["read_work_item"](sibling.id))["parent_id"] == top.id
    assert json.loads(tools["read_work_item"](mine.id))["title"] == "Mine"
    for hidden in (other.id, new_id()):
        with pytest.raises(ValueError, match="no work item"):
            tools["read_work_item"](hidden)
