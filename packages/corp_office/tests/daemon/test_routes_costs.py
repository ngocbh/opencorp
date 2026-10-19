"""GET /costs: spend per person since a time."""

import pytest

from tests.store.conftest import session


async def test_since_is_normalized_to_utc(client):
    r = await client.get("/costs", params={"since": "2026-10-19T02:00:00+02:00"})
    assert r.status_code == 200 and r.json() == {"since": "2026-10-19T00:00:00.000Z", "people": {}}


async def test_the_report_has_each_persons_spend(client, office):
    s = office.store.create_session(session(person="minh"))
    office.store.record_usage(session_id=s.id, run_id="r", model="m", input_tokens=1, output_tokens=1, usd=0.5)
    r = await client.get("/costs", params={"since": "2026-01-01T00:00:00Z"})
    assert r.json()["people"] == {"minh": {"usd": 0.5, "unpriced_sessions": 0}}


@pytest.mark.parametrize("since", [None, "", "yesterday", "2026-10-19T00:00:00",  # no offset
                                   "0001-01-01T00:00:00+05:00"])  # before year 1 in UTC
async def test_a_missing_or_bad_since_is_422(client, since):
    r = await client.get("/costs", params={} if since is None else {"since": since})
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"
