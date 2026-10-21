import base64
import json
import time
from importlib.resources import files

import pytest
import yaml
from pydantic import BaseModel

from opencorp.company.secret_keys import (SECRET_KEYS, UnsafeYaml, blank_secrets, check_clean, find_json_secrets,
                                          find_secrets, is_secret_key, key_name, scrub_text)
from opencorp.protocol.models import Device, Person

HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
TOKEN = "act_" + "A" * 20 + "-_" + "b" * 21
SHA = "c" * 64

FLOWS = sorted([*(files("opencorp.company_template") / "shared" / "flows").iterdir(),
                *(files("opencorp.install") / "flows").iterdir()], key=lambda f: f.name)
"""Every flow file the office ships, typed with tags such as ``!Person`` and ``!str``."""


def test_secret_keys_cover_every_secret_person_and_device_field():
    assert {"devices", "password_hash"} <= SECRET_KEYS
    assert "token_sha256" in SECRET_KEYS
    assert all(is_secret_key(f) for f in ("devices", "password_hash"))
    assert [f for f in Person.model_fields if is_secret_key(f)] == ["devices", "password_hash"]
    assert [f for f in Device.model_fields if is_secret_key(f)] == ["token_sha256"]


@pytest.mark.parametrize("key", ["devices", "password", "passwd", "Password-Hash", "TOKEN", "secret", "client secret",
                                 "api_key", "apikey", "access_token", "refresh_token", "private_key", "db_password",
                                 "github_token", "app_secret", "openai_api_key", "ssh_private_key", "token_sha256"])
def test_secret_key_names(key):
    assert is_secret_key(key)


@pytest.mark.parametrize("key", ["accessToken", "clientSecret", "privateKey", "apiKey", "refreshToken", "APIKey",
                                 "XApiKey", "passwordHash", "tokenSha256", "dbPassword", "GitHubToken", "idToken",
                                 "OPENAI_API_KEY", "ApiKey", "AccessToken", "client-Secret", "api.key", "db.password",
                                 "spring.datasource.password", "HTTPSProxyPassword"])
def test_camel_case_and_dotted_secret_key_names(key):
    assert is_secret_key(key)


@pytest.mark.parametrize("key", ["secret_key", "SECRET_KEY", "secretKey", "aws_secret_access_key",
                                 "AWS_SECRET_ACCESS_KEY", "secretAccessKey", "awsSecretKey", "passphrase",
                                 "ssh_passphrase", "keyPassphrase", "accesstoken", "ACCESSTOKEN", "apikey", "APIKEY",
                                 "clientsecret", "privatekey", "refreshtoken", "githubtoken", "dbpassword",
                                 "openaiapikey", "\u212aEY_PASSWORD", "api\u212aey", "\uff21ccess\uff34oken"])
def test_more_secret_key_names_and_names_without_separators(key):
    assert is_secret_key(key)


def test_key_name_splits_words_and_is_linear():
    assert key_name("HTTPSProxyPassword") == "https_proxy_password"
    assert key_name("ABCDefGHi") == "abc_def_g_hi" and key_name("aB1Cd") == "a_b1_cd"
    assert key_name("spring.datasource.password") == "spring_datasource_password"
    start = time.perf_counter()
    key_name("A" * 1_000_000)
    key_name("Ab" * 500_000)
    assert time.perf_counter() - start < 0.1


@pytest.mark.parametrize("key", ["secrets", "max_tokens", "api_key_env", "name", "tokens", "password_hint", 3, None,
                                 "tokens_used", "secretary", "maxTokens", "totalTokens", "promptTokens", "tokenType",
                                 "TokenCount", "apiKeyEnv", "passwordHint", "Secretary", "keyboard", "monkey",
                                 "MAX_TOKENS", "passwordless_login", "maxtokens", "tokensused", "secret_name",
                                 "keyName", "access_key_id", "secretariat", "passwordPolicy", "tokenizer"])
def test_names_that_are_not_secret_keys(key):
    assert not is_secret_key(key)


def test_blank_secrets_empties_devices_and_the_password_hash():
    person = Person(handle="a", name="A", kind="human", title="t", manager=None,
                    devices=[Device(name="mac", token_sha256=SHA)], password_hash=HASH)
    assert blank_secrets(person).devices == [] and blank_secrets(person).password_hash is None


@pytest.mark.parametrize("text", [
    f"hash {HASH} here", f"'{HASH}'", f"# password_hash: {HASH}", "$argon2id$v=19$m=65536$abc$def",
    f"glued{TOKEN}glued", f"token={TOKEN}", "url https://bob:hunter22@example.com/x",
])
def test_scrub_hides_each_pattern_and_leaves_a_clean_text(text):
    out = scrub_text(text)
    assert "(hidden)" in out and check_clean(out, set())
    assert HASH not in out and TOKEN not in out and "hunter22" not in out


def test_scrub_keeps_ordinary_text():
    text = "name: Nguyễn Văn Ánh\nprompt: ${message}\nurl: https://example.com:8080/a\ncost $5 a day\n"
    assert scrub_text(text) == text and check_clean(text, set())


def test_check_finds_known_values_and_patterns():
    assert not check_clean(f"note {SHA} end", {SHA})
    assert not check_clean(HASH, set())
    assert not check_clean("https://bob:pw@host", set())
    assert check_clean("short", {"short"[:4]})  # values under 8 characters are ignored


def _found(text):
    return find_secrets(text)


def test_find_secrets_with_no_secret_keys():
    found = _found("name: x\nsecrets: [OPENAI_KEY]\nmax_tokens: 100\napi_key_env: K\n")
    assert found.keys == [] and found.values == set()


def test_find_secrets_collects_top_level_keys_and_their_values():
    text = yaml.safe_dump({"handle": "a", "password_hash": HASH,
                           "devices": [{"name": "macbook-pro", "token_sha256": SHA}]}, sort_keys=False)
    found = _found(text)
    assert found.keys == [("password_hash",), ("devices",)]
    # Device names aren't secrets: only the token hash under devices counts.
    assert found.values == {HASH, SHA}


def test_find_secrets_collects_a_nested_key_and_everything_under_it():
    found = _found("a:\n  b:\n    - api_key: {x: verylongvalue1, y: [verylongvalue2]}\n")
    assert found.keys == [("a", "b", 0, "api_key")]
    assert found.values == {"x", "y", "verylongvalue1", "verylongvalue2"}


def test_find_secrets_follows_aliases_and_merges():
    found = _found("x: &h 'longsecretvalue'\npassword_hash: *h\n")
    assert found.values == {"longsecretvalue"}
    found = _found("base: &b {password_hash: mergedsecret}\nalice:\n  <<: *b\n")
    assert ("alice", "password_hash") in found.keys and "mergedsecret" in found.values


def test_a_harmless_alias_is_fine():
    found = _found("defaults: &d {model: gpt}\nminh: *d\nanh: *d\n")
    assert found.keys == [] and found.data["anh"] == {"model": "gpt"}


def test_find_secrets_reads_block_scalars_and_a_bom():
    found = _found("password_hash: |\n  $scrypt$CCCCCCCC\n\nkind: human\n")
    assert found.values == {"$scrypt$CCCCCCCC\n"}
    found = _found("\ufeffname: Ánh\npassword_hash: $scrypt$HHHHHHHH\n")
    assert found.keys == [("password_hash",)]


@pytest.mark.parametrize("text", [
    "a: &a [*a]\n",
    "a: &a {x: *a}\n",
    "a: 1\n---\nb: 2\n",
    "a: [\n",
    "a: \x07\n",
    "[" * 5000 + "]" * 5000,
])
def test_hostile_yaml_raises(text):
    with pytest.raises(UnsafeYaml):
        _found(text)


@pytest.mark.parametrize("text,out", [
    ("https://bob:pa/ss@host/x", "https://bob:(hidden)@host/x"),
    ("https://bob:p@ss@host/x", "https://bob:(hidden)@host/x"),
    ("clone https://bob:p@ss@host and more", "clone https://bob:(hidden)@host and more"),
    ("url: 'https://bob:p@ss@host'", "url: 'https://bob:(hidden)@host'"),
])
def test_url_passwords_with_a_slash_or_an_at_sign_are_hidden_whole(text, out):
    assert scrub_text(text) == out and check_clean(out, set())


def test_find_secrets_collects_every_plain_string_decoded():
    found = _found('a: "\\x24scrypt\\x24abc\\x24def"\nb: >-\n  act_AAAA\n  BBBB\nkey "\\x41": [x]\n')
    assert {"$scrypt$abc$def", "act_AAAA BBBB", 'key "\\x41"', "a", "x"} <= found.plain
    assert not check_clean("$scrypt$abc$def", set())


def test_plain_strings_leave_out_secret_values():
    found = _found(f"password_hash: '{HASH}'\nname: Ánh\n")
    assert HASH not in found.plain and "Ánh" in found.plain


def test_blank_secrets_refuses_a_required_secret_field():
    class Leaky(BaseModel):
        token: str

    with pytest.raises(AssertionError):
        blank_secrets(Leaky(token="x"))


def test_an_alias_bomb_raises_quickly():
    bomb = "a: &a [x,x,x,x,x,x,x,x,x]\n" + "".join(
        f"{chr(98 + i)}: &{chr(98 + i)} [{','.join(['*' + chr(97 + i)] * 9)}]\n" for i in range(8))
    start = time.monotonic()
    with pytest.raises(UnsafeYaml):
        _found(bomb)
    assert time.monotonic() - start < 2


@pytest.mark.parametrize("flow", [f for f in FLOWS if f.name.endswith(".yaml")], ids=lambda f: f.name)
def test_every_packaged_flow_file_passes(flow):
    found = _found(flow.read_text())
    # init's flow, which the office runs and never copies into a company, names a node and an output after secrets.
    secret = [("nodes", "password"), ("output", "password_hash")] if flow.name == "init.yaml" else []
    assert found.keys == secret and found.plain


def test_custom_tags_dont_matter():
    found = _found("input:\n  person: !Person\n  talking_to: !str\n  kinds: !list(str) [a, b]\n")
    assert found.keys == [] and {"input", "person", "talking_to", "kinds", "a", "b"} <= found.plain


def test_a_tagged_mapping_holding_a_secret_key_is_caught():
    found = _found(f"user: !Person {{name: Ánh, password_hash: '{HASH}'}}\n")
    assert found.keys == [("user", "password_hash")] and found.values == {HASH}


def test_a_tagged_secret_key_is_caught():
    found = _found("!str password: hunter2hunter2\n")
    assert found.keys == [("password",)] and found.values == {"hunter2hunter2"}


def test_a_tagged_scalar_holding_a_hash_fails_the_decoded_check():
    found = _found(f'note: !str "{HASH}"\nother: !Secret "\\x24scrypt\\x24abc\\x24def"\n')
    assert found.keys == [] and {HASH, "$scrypt$abc$def"} <= found.plain
    assert not all(check_clean(s, set()) for s in found.plain)


def test_every_scalar_is_checked_whatever_it_resolves_to():
    found = _found("n: 12345678901\npassword: 98765432109\n")
    assert "12345678901" in found.plain and found.values == {"98765432109"}


def test_a_merge_list_and_a_tagged_merge_are_followed():
    found = _found("a: &a {x: 1}\nb: &b {token: mergedsecret}\nc:\n  <<: [*a, *b]\n")
    assert found.keys == [("b", "token"), ("c", "token")] and found.values == {"mergedsecret"}
    found = _found("b: &b !Thing {token: mergedsecret}\nc:\n  <<: *b\n")
    assert ("c", "token") in found.keys


def test_a_recursive_merge_raises():
    with pytest.raises(UnsafeYaml):
        _found("a: &a {<<: *a}\n")


@pytest.mark.parametrize("text", [
    "? [password, x]\n: v\n",
    "? {a: b}\n: v\n",
    "a:\n  password:\n    ? [x]\n    : v\n",
])
def test_a_non_scalar_key_raises(text):
    with pytest.raises(UnsafeYaml):
        _found(text)


def test_data_is_none_when_safeloader_cant_build_it():
    assert _found("person: !Person {name: x}\n").data is None
    assert _found("a: 1\n").data == {"a": 1}
    assert _found("").data is None


def b64(text):
    return base64.b64encode(text.encode()).decode()


def test_a_binary_scalar_is_checked_decoded():
    found = _found(f"note: !!binary {b64(HASH)}\n")
    assert HASH in found.plain and not all(check_clean(s, set()) for s in found.plain)
    found = _found(f"note: !!binary |\n  {b64('plainsecret_0123456789')}\n")
    assert not all(check_clean(s, {"plainsecret_0123456789"}) for s in found.plain)


def test_a_binary_value_under_a_secret_key_is_a_secret_value_decoded():
    found = _found(f"token: !!binary {b64('plainsecret_0123456789')}\n")
    assert found.keys == [("token",)] and "plainsecret_0123456789" in found.values


def test_a_binary_key_naming_a_secret_is_a_secret_key():
    found = _found(f"!!binary {b64('password')}: plainsecret_0123456789\n")
    assert found.keys == [(b64("password"),)] and found.values == {"plainsecret_0123456789"}
    assert {"password", b64("password")} <= found.plain


def test_a_binary_scalar_that_isnt_base64_raises():
    with pytest.raises(UnsafeYaml):
        _found("note: !!binary not*base64\n")


def test_find_json_secrets_walks_json_under_the_same_key_rule():
    text = ('{\n\t"name": "x",\n\t"auth": {"clientSecret": "plainsecret_0123456789", "n": 3},\n'
            '\t"note": "a\\u0024scrypt\\u0024b"\n}')
    with pytest.raises(UnsafeYaml):
        _found(text)  # PyYAML can't read tab indents
    found = find_json_secrets(text)
    assert found.keys == [("auth", "clientSecret")] and found.values == {"plainsecret_0123456789"}
    assert {"name", "x", "auth", "a$scrypt$b"} <= found.plain and found.data is None


def test_find_json_secrets_reads_numbers_as_written():
    found = find_json_secrets('{"pin": ' + "9" * 5000 + ', "x": 1.50, "y": -Infinity, "password": 0012}'.replace(
        "0012", "12"))
    assert {"9" * 5000, "1.50", "-Infinity"} <= found.plain and found.values == {"12"}


def test_find_json_secrets_keeps_every_duplicate_key():
    found = find_json_secrets('{"note": "first-copy-123456", "note": "second", "token": "t1-123456789", "token": 1}')
    assert "first-copy-123456" in found.plain and found.values == {"t1-123456789", "1"}


def test_find_json_secrets_reads_devices_and_scalars_as_yaml_does():
    found = find_json_secrets(json.dumps({"devices": [{"name": "mac", "token_sha256": SHA}], "n": 12345678901,
                                          "password": 98765432109}))
    assert found.keys == [("devices",), ("password",)] and found.values == {SHA, "98765432109"}
    assert {"mac", "12345678901"} <= found.plain


@pytest.mark.parametrize("text", ["{", "[" * 100_000 + "]" * 100_000, json.dumps([[0] * 400] * 400)])
def test_hostile_json_raises(text):
    with pytest.raises(UnsafeYaml):
        find_json_secrets(text)
