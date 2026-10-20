"""The run-log scrub: secret keys, secret shapes, known values, and a final check that withholds."""

import json

import pytest

from opencorp.company.secret_keys import HIDDEN
from opencorp.runs.scrub import WITHHELD, Scrubber

KEY = "conn-key-5f3a9c1e7b2d4a60"  # no secret shape: only the known-values step can catch it


def record(payload):
    return {"kind": "node_failed", "payload": payload, "run_id": "R", "schema": 9, "seq": 4}


def test_a_secret_key_hides_its_value_at_any_depth_and_in_tool_arguments():
    out = Scrubber([]).record(record({"evidence": {"interactions": [{"tool_call": {"args": {
        "password": "hunter2222", "Authorization": "Basic abcdefgh", "set-cookie": "sid=1", "path": "a.txt"}}}]}}))
    args = out["payload"]["evidence"]["interactions"][0]["tool_call"]["args"]
    assert args == {"password": HIDDEN, "Authorization": HIDDEN, "set-cookie": HIDDEN, "path": "a.txt"}


@pytest.mark.parametrize("text, secret", [
    ("Bearer abcdefgh12345", "abcdefgh12345"),
    ("authorization: bearer abcdefgh12345", "abcdefgh12345"),
    ("sk-ant-api03-abcdefghijklmnopqrstu", "abcdefghijklmnopqrstu"),
    ("sk-unconfigured0123456789", "unconfigured0123456789"),
    ("api-key: 0123456789abcdef", "0123456789abcdef"),
    ('{"api-key": "0123456789abcdef"}', "0123456789abcdef"),
    ("https://u:pa55word@host/x", "pa55word"),
    ("act_" + "A" * 43, "A" * 43),
])
def test_secret_shapes_are_removed_from_every_string(text, secret):
    out = Scrubber([]).record(record({"failure": {"message": f"provider said: {text}"}}))
    assert secret not in json.dumps(out) and HIDDEN in out["payload"]["failure"]["message"]


def test_a_scrubbed_value_is_not_scrubbed_again():
    once = Scrubber([]).record(record({"m": "Bearer abcdefgh12345"}))
    assert Scrubber([]).record(once) == once


def test_known_values_are_removed_plain_json_escaped_and_url_quoted():
    tricky = 'quote"slash\\key-0123'
    payload = {"failure": {"traceback": f"key={KEY}", "message": json.dumps({"k": tricky}),
                           "url": "https://h/?k=quote%22slash%5Ckey-0123"}}
    text = json.dumps(Scrubber([KEY, tricky, "short"]).record(record(payload)))
    assert KEY not in text and "quote" not in text and "[redacted]" in text
