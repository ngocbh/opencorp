"""Session routes."""

import pytest

from tests.daemon.test_app import ULID


@pytest.mark.parametrize(("path", "body"), [
    ("/sessions", {"person": "minh", "cwd": "/w/app"}),
    (f"/sessions/{ULID}/prompt", {"text": "hi"}),
    (f"/sessions/{ULID}/steer", {"text": "hi"}),
    (f"/sessions/{ULID}/interrupt", None),
    (f"/sessions/{ULID}/end", None),
    (f"/sessions/{ULID}/cost-cap", {"cost_cap_usd": 10}),
])
async def test_session_actions_are_not_implemented_yet(client, path, body):
    r = await client.post(path, json=body)
    assert r.status_code == 501 and r.json()["error"] == "not_implemented"
