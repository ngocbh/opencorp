"""Secret values never leave the monitor, whatever shape a kind's result or error takes."""

import base64
import json
import random
import re
import time
from urllib.parse import quote, quote_plus

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


CONN = "conn-key-5f3a9c1e7b2d4a60"
URLISH = "a b/c+key-0123"
QUOTED = 'qu"ote-secret-99'


def b64(text, alphabet=base64.b64encode):
    return alphabet(text.encode()).decode()


@pytest.mark.parametrize("text, gone", [
    (b64(CONN), b64(CONN)),
    ("Basic " + b64(f"user:{CONN}"), b64(f"user:{CONN}")[8:-4]),  # the secret at each offset in its group of 3
    ("Basic " + b64(f"u:{CONN}"), b64(f"u:{CONN}")[4:-4]),
    ("Basic " + b64(f"ab:{CONN}"), b64(f"ab:{CONN}")[4:-4]),
    (b64(f"??{CONN}>>", base64.urlsafe_b64encode), b64(f"??{CONN}>>", base64.urlsafe_b64encode)[4:-4]),
    (CONN.upper(), CONN.upper()),
    ("Conn-Key-5F3A9c1e7b2d4a60", "5F3A9c1e7b2d4a60"),
    ("https://h/?k=" + quote_plus(URLISH), "c%2Bkey"),
    ("https://h/?k=" + quote(URLISH), "c%2Bkey"),
    ("https://h/?k=" + quote(URLISH, safe="").lower(), "c%2bkey"),
    (json.dumps(json.dumps({"k": QUOTED})), "ote-secret-99"),
    (json.dumps(json.dumps({"k": QUOTED}, ensure_ascii=False), ensure_ascii=False), "ote-secret-99"),
])
def test_encoded_and_recased_forms_of_a_secret_are_scrubbed(text, gone):
    out = redact(f"said: {text}.", (), [CONN, URLISH, QUOTED])
    assert "[redacted]" in out and gone not in out


@pytest.mark.parametrize("prefix", [0, 50, 56, 300])
def test_a_secret_in_base64_wrapped_at_76_columns_is_scrubbed(prefix):
    data = ("x" * prefix + CONN + "y" * 80).encode()
    for wrapped in (base64.encodebytes(data).decode(), base64.encodebytes(data).decode().replace("\n", "\r\n"),
                    json.dumps(base64.encodebytes(data).decode())):
        out = redact(f"attachment:\n{wrapped}", (), [CONN])
        assert "[redacted]" in out
        lines = [line for line in out.replace("\\n", "\n").splitlines() if len(line) > 8]
        joined = "".join(lines).replace("\r", "")
        assert not any(core in joined for core in (b64("x" * prefix + CONN)[-28:-4],)), out


def test_wrapped_base64_without_a_secret_is_kept():
    text = base64.encodebytes(b"z" * 400).decode()
    assert redact(text, (), [CONN]) == text
    coded = base64.b64encode(b"z" * 400).decode()
    text = "\n".join("    " + coded[i:i + 64] for i in range(0, len(coded), 64))
    assert redact(text, (), [CONN]) == text


def wrap(data, width, indent="", sep="\n"):
    coded = base64.b64encode(data).decode()
    return sep.join(indent + coded[i:i + width] for i in range(0, len(coded), width))


@pytest.mark.parametrize("prefix", [0, 50, 56, 300])
@pytest.mark.parametrize("form", [
    lambda d: wrap(d, 64),  # openssl and PEM
    lambda d: wrap(d, 64, sep="\r\n"),
    lambda d: wrap(d, 64, indent="    "),  # inside a YAML block
    lambda d: wrap(d, 76, indent="\t"),
    lambda d: json.dumps(wrap(d, 64, indent="  ")),
    lambda d: json.dumps(json.dumps(wrap(d, 64))),  # line breaks escaped twice
    lambda d: json.dumps(json.dumps(wrap(d, 76, sep="\r\n"))),
    lambda d: json.dumps(json.dumps(json.dumps(wrap(d, 64, indent="  ")))),
], ids=["64", "64 crlf", "64 indented", "76 tab", "64 json", "64 json twice", "76 crlf json twice", "64 json thrice"])
def test_a_secret_in_base64_wrapped_at_64_columns_indented_or_escaped_is_scrubbed(prefix, form):
    data = ("x" * prefix + CONN + "y" * 80).encode()
    text = form(data)
    out = redact(f"cert:\n{text}\nend", (), [CONN])
    assert "[redacted]" in out
    joined = re.sub(r"\\+[rnt]|\s", "", out)
    assert b64("x" * prefix + CONN)[-28:-4] not in joined, out


@pytest.mark.parametrize("text", [
    CONN.encode().hex(), CONN.encode().hex().upper(), ("ab:" + CONN).encode().hex(),
    *(base64.b32encode(("?" * pad + CONN + "!").encode()).decode() for pad in range(5)),
    base64.b32encode(CONN.encode()).decode().lower(),
])
def test_a_secret_in_hex_or_base32_is_scrubbed(text):
    out = redact(f"said: {text}.", (), [CONN])
    assert "[redacted]" in out and text[len(text) // 3:2 * len(text) // 3] not in out


def test_hex_and_base32_dont_scrub_ordinary_text():
    text = f"sha {'ab' * 32} and {base64.b32encode(b'conn-key-0000000000').decode()}"
    assert redact(text, (), [CONN]) == text


@pytest.mark.parametrize("text", ["STRASSE-geheim-0123", "strasse-GEHEIM-0123", "Strasse-Geheim-0123"])
def test_a_secret_with_a_sharp_s_is_scrubbed_uppercased(text):
    assert redact(f"said: {text}.", (), ["Straße-geheim-0123"]) == "said: [redacted]."


@pytest.mark.parametrize("encode", [
    lambda s: json.dumps(json.dumps(json.dumps(s))), lambda s: repr(repr(s)),
    lambda s: quote(quote(s, safe=""), safe=""), lambda s: quote_plus(quote_plus(s)),
], ids=["json thrice", "repr of repr", "quoted twice", "quote_plus twice"])
def test_a_secret_escaped_three_times_or_quoted_twice_is_scrubbed(encode):
    out = redact(f"said: {encode(QUOTED + ' ü')}.", (), [QUOTED + " ü"])
    assert "[redacted]" in out and "ote-secret-99" not in out


def test_encoded_forms_dont_scrub_ordinary_text():
    text = "hello conn-key world, Y29ubi1rZXk= and https://h/?q=conn"
    assert redact(text, (), [CONN]) == text


def test_scrubbing_known_values_stays_fast():
    scrub = redactor([f"secret-value-{i:04d}-abcdefghij" for i in range(40)])
    blob = "x" * 1_000_000
    many = [f"line {i} with nothing secret in it" for i in range(20_000)]
    start = time.perf_counter()
    scrub(blob)
    scrub(many)
    assert time.perf_counter() - start < 2


def test_the_piece_lookup_finds_every_form_a_text_holds():
    from opencorp.perm import monitor

    rng = random.Random(5)
    alphabet = "abcXYZ019-_+/%\\\"' üß"
    values = ["".join(rng.choice(alphabet) for _ in range(rng.randint(8, 40))) for _ in range(30)]
    needles = monitor._needles(values)
    for _ in range(5000):
        form = rng.choice(needles.forms)[0]
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 20))) + form + "".join(
            rng.choice(alphabet) for _ in range(rng.randint(0, 20)))
        folded = text.casefold().translate(monitor._FOLD)
        held = {i for i, (_, quick, _) in enumerate(needles.forms) if quick in folded}
        assert held <= set(monitor._candidates(folded, needles)), text


@pytest.mark.parametrize("blob", [
    "A" * 64 + "\\" * 1_000_000,  # a full line, then a run of backslashes
    ("A" * 64 + "\\n") * 15_000,  # one block of wrapped base64
    ("A" * 64 + "\\" * 16 + "x") * 12_000,  # escapes too deep to be a break
    ("A" * 64 + "\n" + " " * 1000) * 900,
    ("A" * 63 + "\n") * 15_000,  # lines one short
    ("A" * 76 + "\r\n" + "B" * 65 + "\n") * 6_000,
    ("A" * 64 + "\\\\r\\") * 13_000,  # an escaped CR without its LF
], ids=["backslashes", "block", "deep escapes", "indents", "short lines", "mixed widths", "lone cr"])
def test_hostile_text_is_scrubbed_in_linear_time(blob):
    scrub = redactor([CONN, "Straße-geheim-0123", QUOTED])
    start = time.perf_counter()
    scrub({"m": blob})
    assert time.perf_counter() - start < 1


def test_a_redactor_scrubs_as_redact_does_with_its_needles_built_once(monkeypatch):
    from opencorp.perm import monitor

    value = {"a": "x hunter2hunter2 y", "b": ["hunter2hunter2"], "c": 3}
    built = []
    real = monitor._needles
    monkeypatch.setattr(monitor, "_needles", lambda values: (built.append(1), real(values))[1])
    scrub = redactor(["hunter2hunter2"])
    assert scrub(value) == scrub(value) == redact(value, (), ["hunter2hunter2"]) and len(built) == 2
