"""Work items and comments."""

import pytest

import agent_corp.store.store as store_module
from agent_corp.protocol.models import WorkItem

from agent_corp.store import DuplicateKey, NotFound, StaleVersion, StoreError
from tests.store.conftest import comment, work_item


def test_work_item_round_trips(store):
    item = work_item(assignee="minh", groups=["eng"], gate=True, summary="s", cost=1.5)
    got = store.create_work_item(item)
    assert got == item == store.get_work_item(item.id)
    assert got.model_dump(mode="json") == item.model_dump(mode="json")


def test_null_fields_come_back_unset(store):
    got = store.create_work_item(work_item())
    assert got.assignee is None and "assignee" not in got.model_fields_set


def test_duplicate_id(store):
    item = store.create_work_item(work_item())
    with pytest.raises(DuplicateKey):
        store.create_work_item(item)


def test_update_bumps_version_and_emits(store):
    item = store.create_work_item(work_item())
    got = store.update_work_item(item.id, status="done", resolved_by="ngocbh")
    assert (got.status, got.resolved_by, got.version) == ("done", "ngocbh", 2)
    assert got.updated_at >= item.updated_at and got.created_at == item.created_at
    assert store.events_after()[-1].type == "work_item.updated"


def test_update_with_stale_base_version(store):
    item = store.create_work_item(work_item())
    store.update_work_item(item.id, base_version=1, status="in_progress")
    with pytest.raises(StaleVersion) as err:
        store.update_work_item(item.id, base_version=1, status="done")
    assert (err.value.expected, err.value.current) == (1, 2)


def test_update_rejects_bad_fields(store):
    item = store.create_work_item(work_item())
    with pytest.raises(StoreError):
        store.update_work_item(item.id, version=9)
    with pytest.raises(ValueError):
        store.update_work_item(item.id, status="nope")
    with pytest.raises(ValueError):
        store.update_work_item(item.id, colour="red")
    with pytest.raises(NotFound):
        store.update_work_item("01K6A0000000000000000000ZZ", status="done")


def test_list_work_items(store):
    a = store.create_work_item(work_item(assignee="minh"))
    b = store.create_work_item(work_item(assignee="minh", status="done"))
    store.create_work_item(work_item(assignee="lan"))
    assert [i.id for i in store.list_work_items(assignee="minh")] == [b.id, a.id]
    assert [i.id for i in store.list_work_items(assignee="minh", status=["open", "in_progress"])] == [a.id]


def test_comments(store):
    item = store.create_work_item(work_item())
    c1 = store.add_comment(comment(item.id, on_behalf_of="ngocbh"))
    c2 = store.add_comment(comment(item.id))
    assert store.list_comments(item.id) == [c1, c2]
    assert store.events_after()[-1].type == "comment.created"


def test_comment_needs_its_work_item(store):
    with pytest.raises(NotFound):
        store.add_comment(comment("01K6A0000000000000000000ZZ"))


def test_model_field_without_a_column_needs_a_migration(store, monkeypatch):
    class Grown(WorkItem):
        new_field: str | None = None

    monkeypatch.setattr(store_module, "WORK_ITEMS", store_module._Table("work_items", Grown, json=frozenset({"groups"})))
    item = Grown.model_validate(work_item().model_dump())
    with pytest.raises(StoreError, match=r"work_items has no column 'new_field'.*migration"):
        store.create_work_item(item)
    assert store.list_work_items() == [] and store.events_after() == []
