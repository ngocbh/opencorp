"""Secret values never leave the monitor, whatever shape a kind's result or error takes."""

import pytest

from agent_corp.assets.registry import KindTool
from agent_corp.perm.monitor import Monitor, redact
from tests.perm.conftest import KINDS, TOKEN

PADDED = "p4dded-secret-value"
PIN = "20260930"
PEM = "-----BEGIN KEY-----\nAAAABBBBCCCCDDDD\nEEEEFFFFGGGGHHHH\n-----END KEY-----\n"

class Handle:
    """An object whose text holds the secret."""

    def __init__(self, secret):
        self.secret = secret

    def __repr__(self):
        return f"Handle({self.secret})"

    __str__ = __repr__


LEAKS = {
    "dict_key": lambda s: {s["vault_token"]: 1},
    "set": lambda s: {s["vault_token"]},
    "bytes": lambda s: s["vault_token"].encode(),
    "object": lambda s: Handle(s["vault_token"]),
    "number": lambda s: {"code": int(s["pin"])},
    "stripped": lambda s: f"used {s['padded'].strip()}",
    "pem_line": lambda s: "bad line: " + s["pem"].splitlines()[1],
    "raise_stripped": lambda s: (_ for _ in ()).throw(RuntimeError(f"auth failed for {s['padded'].strip()}")),
}


def leak(asset, args, secrets):
    return LEAKS[args["mode"]](secrets)


@pytest.fixture
def monitor(make_company, store, secrets):
    secrets.set("padded", PADDED + "\n")
    secrets.set("pem", PEM)
    secrets.set("pin", PIN)
    asset = {"id": "vault", "kind": "leaky", "secrets": ["vault_token", "padded", "pem", "pin"], "tools": {"leak": {}},
             "grants": [{"who": "minh", "can": ["leak"]}]}
    root = make_company(**{"assets/vault.yaml": asset})
    return Monitor(root, store, secrets, {**KINDS, "leaky": {"leak": KindTool(leak)}})


def leaked(text):
    return any(s in text for s in (TOKEN, PADDED, PIN, "AAAABBBBCCCCDDDD", "EEEEFFFFGGGGHHHH"))


@pytest.mark.parametrize("mode", sorted(LEAKS))
def test_no_form_of_a_secret_reaches_the_result_or_the_audit(monitor, store, mode):
    got = monitor.call("minh", "r1", "vault__leak", {"mode": mode})
    assert "[redacted]" in repr(got) and not leaked(repr(got))
    [row] = store.list_audit()
    assert not leaked(repr(row))


def test_a_secret_stored_with_a_trailing_newline_is_scrubbed_without_it():
    assert redact("used abcdefgh-1234.", set(), ["abcdefgh-1234\n"]) == "used [redacted]."


def test_each_long_line_of_a_multi_line_secret_is_scrubbed():
    assert redact("line AAAABBBBCCCCDDDD and x", set(), [PEM]) == "line [redacted] and x"


def test_short_lines_of_a_secret_are_left_alone():
    assert redact("ab and cd", set(), ["ab\ncd\nlong-enough-line"]) == "ab and cd"


def test_a_secret_inside_a_longer_one_is_scrubbed_longest_first():
    assert redact("xxabcdefghyy", set(), ["abcdefgh", "xxabcdefghyy"]) == "[redacted]"
    assert redact("xxabcdefghyy", set(), ["xxabcdefghyy", "abcdefgh"]) == "[redacted]"


def test_a_non_json_result_comes_back_as_plain_json(monitor):
    assert monitor.call("minh", "r1", "vault__leak", {"mode": "set"}) == "{'[redacted]'}"
    assert monitor.call("minh", "r1", "vault__leak", {"mode": "dict_key"}) == {"[redacted]": 1}


def test_mapping_keys_and_numbers_are_scrubbed():
    assert redact({"x-abcdefgh": 1, "pin": 12345678, "n": 7}, set(), ["abcdefgh", "12345678"]) == {
        "x-[redacted]": 1, "pin": "[redacted]", "n": 7}
