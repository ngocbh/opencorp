"""protocol.now() and stamp() yield schema-valid, sortable timestamps."""

import json
import time
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from jsonschema import Draft202012Validator

from opencorp.protocol import now, stamp

ROOT = Path(__file__).resolve().parents[4]
SCHEMA_PATH = ROOT / "packages/protocol/schema/protocol.schema.json"


def test_now_is_a_valid_timestamp():
    defs = json.loads(SCHEMA_PATH.read_text())["$defs"]
    Draft202012Validator({"$ref": "#/$defs/Timestamp", "$defs": defs}).validate(now())


def test_now_is_current_utc():
    parsed = datetime.strptime(now(), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
    assert abs((datetime.now(UTC) - parsed).total_seconds()) < 5


def test_string_order_is_time_order():
    stamps = []
    for _ in range(3):
        stamps.append(now())
        time.sleep(0.002)
    assert stamps == sorted(stamps) and len(set(stamps)) == 3
    assert len({len(s) for s in stamps}) == 1


def test_stamp_writes_any_aware_time_in_utc_like_now():
    at = datetime(2026, 10, 19, 17, 0, 0, 123456, tzinfo=timezone(timedelta(hours=7)))
    assert stamp(at) == "2026-10-19T10:00:00.123Z"
    assert len(stamp(datetime.now(UTC))) == len(now())
