"""Work-item routes."""

from tests.daemon.test_app import ULID
from tests.store.conftest import comment, work_item


async def test_get_work_item_and_comments(client, office):
    item = office.store.create_work_item(work_item())
    c = office.store.add_comment(comment(item.id))
    assert (await client.get(f"/work-items/{item.id}")).json() == item.model_dump(mode="json")
    assert (await client.get(f"/work-items/{item.id}/comments")).json() == [c.model_dump(mode="json")]


async def test_missing_work_item_is_404(client):
    for path in (f"/work-items/{ULID}", f"/work-items/{ULID}/comments"):
        r = await client.get(path)
        assert r.status_code == 404 and r.json()["error"] == "not_found"
