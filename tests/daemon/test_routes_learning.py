"""Learning routes: profile manager, proposals, feedback, debriefs."""

import pytest

from tests.daemon.test_app import ULID


@pytest.mark.parametrize(("method", "path", "body"), [
    ("POST", "/profiles/minh/manager", {"text": "tidy"}),
    ("GET", "/profiles/minh/proposals", None),
    ("POST", f"/profile-proposals/{ULID}/apply", None),
    ("POST", "/feedback", {"session_id": ULID, "text": "be brief"}),
    ("GET", f"/debriefs/{ULID}", None),
    ("POST", f"/debriefs/{ULID}/confirm", {"follow_ups": []}),
])
async def test_learning_routes_are_not_implemented_yet(client, method, path, body):
    r = await client.request(method, path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"
