"""Question routes."""

import pytest

from tests.daemon.test_app import ULID


@pytest.mark.parametrize(("path", "body"), [
    (f"/questions/{ULID}/side", {"text": "why?"}),
    (f"/questions/{ULID}/send-back", {"note": "more"}),
    (f"/questions/{ULID}/stop", None),
])
async def test_card_actions_are_not_implemented_yet(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"
