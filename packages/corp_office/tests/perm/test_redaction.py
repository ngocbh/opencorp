"""Secret values never leave the monitor, whatever shape a kind's result or error takes."""

import json
from urllib.parse import quote

import pytest

from opencorp.assets.registry import KindTool
from opencorp.perm.monitor import Monitor, redact, redactor
from tests.perm.conftest import KINDS, TOKEN

PADDED = "p4dded-secret-value"
PIN = "20260930"
PEM = "-----BEGIN KEY-----\nAAAABBBBCCCCDDDD\nEEEEFFFFGGGGHHHH\n-----END KEY-----\n"
ESCAPED = 'pa\\ss"wörd-123'
ESCAPED_FORMS = (ESCAPED, json.dumps(ESCAPED)[1:-1], json.dumps(ESCAPED, ensure_ascii=False)[1:-1],
                 repr(ESCAPED)[1:-1], quote(ESCAPED, safe=""))

class Handle:
    """An object whose text holds the secret."""

    def __init__(self, secret):
        self.secret = secret

    def __repr__(self):
        return f"Handle({self.secret})"

    __str__ = __repr__


def circular(secrets):
    loop = {"token": secrets["vault_token"]}
    loop["self"] = loop
    return loop


LEAKS = {
    "dict_key": lambda s: {s["vault_token"]: 1},
    "set": lambda s: {s["vault_token"]},
    "bytes": lambda s: s["vault_token"].encode(),
    "object": lambda s: Handle(s["vault_token"]),
    "number": lambda s: {"code": int(s["pin"])},
    "stripped": lambda s: f"used {s['padded'].strip()}",
    "pem_line": lambda s: "bad line: " + s["pem"].splitlines()[1],
    "key_error": lambda s: str(KeyError(s["escaped"])),
    "repr": lambda s: f"bad password {s['escaped']!r}",
    "json_text": lambda s: json.dumps({"p": s["escaped"]}),
    "json_text_unicode": lambda s: json.dumps({"p": s["escaped"]}, ensure_ascii=False),
    "url": lambda s: "https://host/login?p=" + quote(s["escaped"], safe=""),
    "raise_repr": lambda s: (_ for _ in ()).throw(KeyError(s["escaped"])),
    "raise_stripped": lambda s: (_ for _ in ()).throw(RuntimeError(f"auth failed for {s['padded'].strip()}")),
}


def interrupt(secrets):
    raise KeyboardInterrupt


def leak(asset, args, secrets):
    return {**LEAKS, "circular": circular, "interrupt": interrupt}[args["mode"]](secrets)


@pytest.fixture
def monitor(make_company, store, secrets):
    secrets.set("padded", PADDED + "\n")
    secrets.set("pem", PEM)
    secrets.set("pin", PIN)
    secrets.set("escaped", ESCAPED)
    asset = {"id": "vault", "kind": "leaky", "secrets": ["vault_token", "padded", "pem", "pin", "escaped"],
             "tools": {"leak": {}}, "grants": [{"who": "minh", "can": ["leak"]}]}
    root = make_company(**{"assets/vault.yaml": asset})
    return Monitor(root, store, secrets, {**KINDS, "leaky": {"leak": KindTool(leak)}})


def leaked(text):
    return any(s in text for s in (TOKEN, PADDED, PIN, "AAAABBBBCCCCDDDD", "EEEEFFFFGGGGHHHH", *ESCAPED_FORMS))


@pytest.mark.parametrize("mode", sorted(LEAKS))
def test_no_form_of_a_secret_reaches_the_result_or_the_audit(monitor, store, mode):
    got = monitor.call("minh", "r1", "vault__leak", {"mode": mode})
    assert "[redacted]" in repr(got) and not leaked(repr(got)) and not leaked(str(got))
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


def test_a_result_that_is_not_json_is_an_audited_error(monitor, store):
    got = monitor.call("minh", "r1", "vault__leak", {"mode": "circular"})
    assert got == "error: ValueError: Circular reference detected"
    assert [r.outcome for r in store.list_audit()] == ["error"]


def test_a_kinds_own_key_error_is_named_by_its_type(monitor, store):
    assert monitor.call("minh", "r1", "vault__leak", {"mode": "raise_repr"}) == "error: KeyError: '[redacted]'"


def test_an_interrupt_inside_a_kind_is_audited_then_raised(monitor, store):
    with pytest.raises(KeyboardInterrupt):
        monitor.call("minh", "r1", "vault__leak", {"mode": "interrupt"})
    [row] = store.list_audit()
    assert (row.outcome, row.detail) == ("error", "KeyboardInterrupt")


def test_keys_that_scrub_to_the_same_text_keep_every_value():
    got = redact({"x-abcdefgh": 1, "x-12345678": 2, "[redacted]": 3, "abcdefgh": 4}, set(), ["abcdefgh", "12345678"])
    assert got == {"x-[redacted]": 1, "x-[redacted]#2": 2, "[redacted]": 3, "[redacted]#2": 4}


def test_a_redactor_scrubs_as_redact_does_with_its_needles_built_once(monkeypatch):
    from opencorp.perm import monitor

    value = {"a": "x hunter2hunter2 y", "b": ["hunter2hunter2"], "c": 3}
    built = []
    real = monitor._needles
    monkeypatch.setattr(monitor, "_needles", lambda values: (built.append(1), real(values))[1])
    scrub = redactor(["hunter2hunter2"])
    assert scrub(value) == scrub(value) == redact(value, (), ["hunter2hunter2"]) and len(built) == 2
