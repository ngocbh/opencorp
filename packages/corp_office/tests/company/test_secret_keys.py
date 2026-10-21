import time

import pytest
from pydantic import BaseModel

from opencorp.company.secret_keys import SECRET_KEYS, blank_secrets, is_secret_key, key_name
from opencorp.protocol.models import Device, Person

HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
SHA = "c" * 64


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
                                 "MAX_TOKENS"])
def test_names_that_are_not_secret_keys(key):
    assert not is_secret_key(key)


def test_blank_secrets_empties_devices_and_the_password_hash():
    person = Person(handle="a", name="A", kind="human", title="t", manager=None,
                    devices=[Device(name="mac", token_sha256=SHA)], password_hash=HASH)
    assert blank_secrets(person).devices == [] and blank_secrets(person).password_hash is None


def test_blank_secrets_refuses_a_required_secret_field():
    class Leaky(BaseModel):
        token: str

    with pytest.raises(AssertionError):
        blank_secrets(Leaky(token="x"))
