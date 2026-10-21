"""The run-log scrub: secret keys, secret shapes, known values, and a final check that withholds."""

import base64
import json
import random
import re
import time
from urllib.parse import quote_plus

import pytest

from opencorp.company.secret_keys import HIDDEN
from opencorp.runs import scrub as scrub_mod
from opencorp.runs.scrub import WITHHELD, Scrubber

KEY = "conn-key-5f3a9c1e7b2d4a60"  # no secret shape: only the known-values step can catch it


def record(payload):
    return {"kind": "node_failed", "payload": payload, "run_id": "R", "schema": 9, "seq": 4}


def test_a_secret_key_hides_its_value_at_any_depth_and_in_tool_arguments():
    out = Scrubber([]).record(record({"evidence": {"interactions": [{"tool_call": {"args": {
        "password": "hunter2222", "Authorization": "Basic abcdefgh", "set-cookie": "sid=1", "path": "a.txt",
        "Proxy-Authorization": "Basic proxy-abc", "Cookie": "sid=2"}}}]}}))
    args = out["payload"]["evidence"]["interactions"][0]["tool_call"]["args"]
    assert args == {"password": HIDDEN, "Authorization": HIDDEN, "set-cookie": HIDDEN, "path": "a.txt",
                    "Proxy-Authorization": HIDDEN, "Cookie": HIDDEN}


def test_the_key_rule_reads_keys_as_written_even_when_a_known_value_is_a_key_name():
    out = Scrubber(["password"]).record({"kind": "x", "seq": 1, "payload": {"args": {
        "password": "other-real-pw-123", "db_password": "another-pw-456"}}})
    assert "other-real-pw-123" not in json.dumps(out) and "another-pw-456" not in json.dumps(out)
    assert sorted(out["payload"]["args"].values()) == [HIDDEN, HIDDEN]
    out = Scrubber(["Authorization"]).record(record({"headers": {"Authorization": "Basic dXNlcjpwYXNzd29yZA"}}))
    assert "dXNlcjpwYXNzd29yZA" not in json.dumps(out) and list(out["payload"]["headers"].values()) == [HIDDEN]


def test_keys_that_scrub_to_the_same_text_keep_every_value():
    out = Scrubber([KEY]).record(record({"sk-aaaaaaaaaaaaaaaaaaaaaa": 1, "sk-bbbbbbbbbbbbbbbbbbbbbb": 2,
                                         f"k-{KEY}": 3, "k-[redacted]": 4}))
    assert sorted(out["payload"].values()) == [1, 2, 3, 4]


@pytest.mark.parametrize("text, secret", [
    ("Bearer abcdefgh12345", "abcdefgh12345"),
    ("authorization: bearer abcdefgh12345", "abcdefgh12345"),
    ("sk-ant-api03-abcdefghijklmnopqrstu", "abcdefghijklmnopqrstu"),
    ("sk-unconfigured0123456789", "unconfigured0123456789"),
    ("api-key: 0123456789abcdef", "0123456789abcdef"),
    ('{"api-key": "0123456789abcdef"}', "0123456789abcdef"),
    ("Headers({'api-key': '0123456789abcdef', 'x': 'y'})", "0123456789abcdef"),
    ("{'x-api-key': 'abcdef0123456789'}", "abcdef0123456789"),
    ("Authorization: Basic dXNlcjpzZWNyZXRwYXNzd29yZA==", "dXNlcjpzZWNyZXRwYXNzd29yZA=="),
    ("proxy-authorization: token ghp-0123456789", "ghp-0123456789"),
    ("https://u:pa55word@host/x", "pa55word"),
    ("act_" + "A" * 43, "A" * 43),
])
def test_secret_shapes_are_removed_from_every_string(text, secret):
    out = Scrubber([]).record(record({"failure": {"message": f"provider said: {text}"}}))
    assert secret not in json.dumps(out) and HIDDEN in out["payload"]["failure"]["message"]


AZ = "0123456789abcdef0123456789abcdef"
DIGEST = ('Digest username="bob", realm="api", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/x", '
          'response="6629fae49393a05397450978507c4ef1"')


@pytest.mark.parametrize("text, secret", [
    ("OPENAI_KEY_sk-ABCDEFGHIJKLMNOPQRSTUV", "ABCDEFGHIJKLMNOPQRSTUV"),
    ("key9sk-proj-ABCDEFGHIJKLMNOPQRST0123", "ABCDEFGHIJKLMNOPQRST0123"),
    ("keysk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV", "ABCDEFGHIJKLMNOPQRSTUV"),
    (f"Authorization: {DIGEST}", "6629fae49393a05397450978507c4ef1"),
    (f"proxy-authorization: {DIGEST}", "dcd98b7102dd2f0e8b11d0f600bfb0c093"),
    (json.dumps({"headers": f"Authorization: {DIGEST}"}), "6629fae49393a05397450978507c4ef1"),
    (json.dumps(json.dumps({"api-key": AZ})), AZ),
    (json.dumps(json.dumps(json.dumps({"x-api-key": AZ}))), AZ),
    (json.dumps(json.dumps({"Authorization": "Basic dXNlcjpzZWNyZXRwYXNzd29yZA=="})), "dXNlcjpzZWNyZXRwYXNzd29yZA"),
    (json.dumps(json.dumps({"Authorization": "Token ghp-0123456789"})), "ghp-0123456789"),
    (json.dumps({"clientSecret": "cs-unknown-123456789"}), "cs-unknown-123456789"),
    (json.dumps(json.dumps({"auth": {"accessToken": "tok-unknown-123456789"}})), "tok-unknown-123456789"),
    (str({"refreshToken": "rt-unknown-123456789", "n": 1}), "rt-unknown-123456789"),
    (json.dumps({"password": 98765432109}), "98765432109"),
    (json.dumps({"spring.datasource.password": "pw-unknown-123456789"}), "pw-unknown-123456789"),
    (str({"api.key": "ak-unknown-123456789"}), "ak-unknown-123456789"),
    (json.dumps({"password": "pw-unknown-123456789\\"}), "pw-unknown-123456789"),  # ends in an escaped backslash
    (json.dumps(json.dumps({"password": "pw-unknown-123456789\\"})), "pw-unknown-123456789"),
    (repr({"password": "pw-unknown-123456789\\"}), "pw-unknown-123456789"),
    (f'Authorization: Digest username="u",\r\n\tresponse="{AZ}"', AZ),  # a folded header's next line
    (f'Authorization: Digest username="u",\n  nonce="n",\n  response="{AZ}"\nnext: 1', AZ),
    (json.dumps(f'Authorization: Digest username="u",\r\n\tresponse="{AZ}"'), AZ),
    (json.dumps({"m": json.dumps({"token": "x-secret-123"})}), "x-secret-123"),  # inside another pair's value
    (str({"m": str({"token": "x-secret-123"})}), "x-secret-123"),
    (json.dumps({"set-cookie": "sid=abcdef123456"}), "abcdef123456"),
])
def test_glued_digest_double_encoded_and_quoted_pair_secrets_are_removed(text, secret):
    out = Scrubber([]).record(record({"failure": {"message": f"provider said: {text}"}}))
    assert secret not in json.dumps(out) and "withheld" not in out and HIDDEN in out["payload"]["failure"]["message"]


@pytest.mark.parametrize("text", [
    "risk-assessment-pipeline-for-the-company", "task-runner-for-everyone-here", "desk-0123456789ab",
    "task-0123456789abcdef0123456789abcdef", "flask-0123456789abcdef01234567", "kiosk-modeenabledforeverything123",
    json.dumps({"max_tokens": 100, "tokens_used": 5, "secretary": "Ánh Nguyễn", "maxTokens": 7, "token_type": "x"}),
    str({"totalTokens": 12, "promptTokens": 3}), "authorization required", "the api key is configured",
])
def test_ordinary_text_is_kept(text):
    out = Scrubber([]).record(record({"failure": {"message": text}}))
    assert out["payload"]["failure"]["message"] == text


SLOW_PROVIDER_KEY = re.compile(r"(?:(?<![A-Za-z0-9])|(?=sk-[A-Za-z0-9_-]{0,64}?(?=[A-Za-z0-9]{16})[A-Za-z0-9]{0,15}"
                               r"[A-Z]))sk-(?:ant-)?[A-Za-z0-9_-]{16,}")
"""PROVIDER_KEY's rule written the plain way: a lookahead at every position, so no literal to search for first."""


def test_provider_key_matches_as_its_plain_form_does():
    rng = random.Random(11)
    texts = ["".join(rng.choice("sk-a1_XA ") for _ in range(rng.randint(0, 48))) for _ in range(60_000)]
    for n in range(55, 70):
        for m in (15, 16, 17):
            texts += ["x" + "sk-" + "-" * n + "A" * m, "sk-" + "-" * n + "a" * m, "a_sk-" + "b-" * n + "C" * m,
                      "9sk-" + "a" * (m - 1) + "B" + "-" * n, "xsk-" + "a" * m * 2, "xsk-" + "a" * m + "B" * m]
    for text in texts:
        assert [m.span() for m in scrub_mod.PROVIDER_KEY.finditer(text)] == [
            m.span() for m in SLOW_PROVIDER_KEY.finditer(text)], text


def test_a_hidden_value_ending_in_a_backslash_keeps_the_pairs_after_it():
    out = Scrubber([]).text(json.dumps({"password": "pw-unknown-123456789\\", "a": "b"}))
    assert out == '{"password": "(hidden)", "a": "b"}'
    out = Scrubber([]).text('Authorization: Digest username="u",\n\tresponse="r"\nHost: example.com')
    assert out == "Authorization: Digest (hidden)\nHost: example.com"


def test_camel_case_secret_keys_and_credential_headers_hide_their_values():
    out = Scrubber([]).record(record({"result": {"accessToken": "tok-unknown-123456789", "clientSecret": "cs-1",
                                                 "setCookie": "sid=1", "proxyAuthorization": "Basic x",
                                                 "maxTokens": 100, "tokens_used": 5, "secretary": "Ánh"}}))
    assert out["payload"]["result"] == {"accessToken": HIDDEN, "clientSecret": HIDDEN, "setCookie": HIDDEN,
                                        "proxyAuthorization": HIDDEN, "maxTokens": 100, "tokens_used": 5,
                                        "secretary": "Ánh"}


def test_known_values_are_removed_encoded_and_recased():
    for text in (f"Basic {base64.b64encode(f'user:{KEY}'.encode()).decode()}", KEY.upper(),
                 "https://h/?k=" + quote_plus(f"a b/{KEY}")):
        out = json.dumps(Scrubber([KEY]).record(record({"a": f"x {text} y"})))
        assert "[redacted]" in out and "withheld" not in out


def test_a_scrubbed_value_is_not_scrubbed_again():
    once = Scrubber([]).record(record({"m": "Bearer abcdefgh12345"}))
    assert Scrubber([]).record(once) == once


def test_known_values_are_removed_plain_json_escaped_and_url_quoted():
    tricky = 'quote"slash\\key-0123'
    payload = {"failure": {"traceback": f"key={KEY}", "message": json.dumps({"k": tricky}),
                           "url": "https://h/?k=quote%22slash%5Ckey-0123"}}
    text = json.dumps(Scrubber([KEY, tricky, "short"]).record(record(payload)))
    assert KEY not in text and "quote" not in text and "[redacted]" in text


@pytest.mark.parametrize("secret, parts", [
    ("hunter2-PREFIX$abc$defgh", ["hunter2", "PREFIX"]),  # a PHC-like tail the shape step would split off
    ("postgres://svc_user:pw0rd123@db.internal.corp:5432/prod", ["svc_user", "db.internal.corp"]),  # a DSN
])
def test_a_known_value_is_removed_whole_before_a_shape_splits_it(secret, parts):
    text = json.dumps(Scrubber([secret]).record(record({"m": f"connecting with {secret} failed"})))
    assert "[redacted]" in text and not any(part in text for part in parts)


def test_many_urls_with_ports_in_one_string_scrub_in_linear_time():
    blob = ",".join(f'"http://h{i}:80{i % 10}/p"' for i in range(50_000))  # about 1 MB, no whitespace
    start = time.perf_counter()
    Scrubber([KEY]).record(record({"result": blob}))
    assert time.perf_counter() - start < 1


@pytest.mark.parametrize("blob", [
    "\\" * 500_000,  # every start of an escaped quote
    '"token": "x", \\"k\\": \\"' * 40_000,
    "".join("\\" * i + '"k' + "\\" * i + '": ' + "\\" * i + '"' for i in range(1000)),  # a pair never closed per depth
    "xsk-" + "a-" * 300_000,
    "Authorization: Digest \\" * 40_000,
], ids=["backslashes", "pairs", "depths", "glued sk", "digest"])
def test_hostile_strings_scrub_in_linear_time(blob):
    start = time.perf_counter()
    Scrubber([KEY]).record(record({"result": blob}))
    assert time.perf_counter() - start < 1


def keeps_everything(values):
    return lambda value: value


def test_a_record_the_scrub_misses_is_withheld(monkeypatch):
    monkeypatch.setattr(scrub_mod, "redactor", keeps_everything)  # a scrub that misses known values
    out = Scrubber([KEY]).record(record({"node_id": "chat#1/reply", "failure": {"message": KEY}}))
    assert out == {"seq": 4, "kind": "node_failed", "node_id": "chat#1/reply", "withheld": WITHHELD}


def test_a_withheld_stub_drops_a_node_id_that_holds_a_secret(monkeypatch):
    monkeypatch.setattr(scrub_mod, "redactor", keeps_everything)
    out = Scrubber([KEY]).record(record({"node_id": f"chat#1/{KEY}", "failure": {"message": KEY}}))
    assert out == {"seq": 4, "kind": "node_failed", "withheld": WITHHELD}


def test_a_scrub_that_raises_withholds_only_that_record(monkeypatch):
    scrubber = Scrubber([])
    monkeypatch.setattr(scrubber, "value", lambda v: (_ for _ in ()).throw(RecursionError()))
    assert scrubber.record(record({"x": 1}))["withheld"] == WITHHELD


def test_one_string_is_scrubbed_or_withheld(monkeypatch):
    assert Scrubber([KEY]).text(f"401: {KEY}") == "401: [redacted]"
    assert Scrubber([]).text("401: Bearer abcdefgh12345") == "401: Bearer (hidden)"
    monkeypatch.setattr(scrub_mod, "redactor", keeps_everything)
    assert Scrubber([KEY]).text(f"401: {KEY}") == WITHHELD


def test_a_download_line_is_scrubbed_and_a_line_that_doesnt_parse_is_withheld():
    scrubber = Scrubber([KEY])
    out = scrubber.line(json.dumps(record({"failure": {"message": KEY}})).encode())
    assert KEY.encode() not in out and b"[redacted]" in out and out.endswith(b"\n")
    assert json.loads(scrubber.line(b"{not json")) == {"withheld": WITHHELD}
