"""The office secret store: one 0600 file per secret in a 0700 directory."""

import stat

import pytest

from agent_corp.secrets import SecretStore

KEY = "-----BEGIN KEY-----\nabc\n"


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_set_and_get_round_trip_with_private_modes(tmp_path):
    secrets = SecretStore(tmp_path / "office" / "secrets")
    secrets.set("cluster_a_ssh_key", KEY)
    assert secrets.get("cluster_a_ssh_key") == KEY
    assert mode(tmp_path / "office" / "secrets") == 0o700
    assert mode(tmp_path / "office" / "secrets" / "cluster_a_ssh_key") == 0o600


def test_set_replaces_and_keeps_the_mode(tmp_path):
    secrets = SecretStore(tmp_path / "s")
    secrets.set("token", "first-value")
    secrets.set("token", "second-value")
    assert secrets.get("token") == "second-value" and mode(tmp_path / "s" / "token") == 0o600
    assert sorted(p.name for p in (tmp_path / "s").iterdir()) == ["token"]


def test_a_missing_secret_is_a_key_error_naming_it(tmp_path):
    with pytest.raises(KeyError, match="token"):
        SecretStore(tmp_path / "s").get("token")


def test_delete_removes_the_secret(tmp_path):
    secrets = SecretStore(tmp_path / "s")
    secrets.set("token", "first-value")
    secrets.delete("token")
    assert list((tmp_path / "s").iterdir()) == []
    with pytest.raises(KeyError, match="token"):
        secrets.get("token")
    with pytest.raises(KeyError, match="token"):
        secrets.delete("token")


@pytest.mark.parametrize("name", ["", "../x", "a/b", ".hidden", "x" * 129, "sp ace"])
def test_bad_names_are_refused(tmp_path, name):
    secrets = SecretStore(tmp_path / "s")
    for call in (lambda: secrets.set(name, "long-enough"), lambda: secrets.get(name), lambda: secrets.delete(name)):
        with pytest.raises(ValueError, match="secret name"):
            call()


@pytest.mark.parametrize("value", ["", "short", "1234567", "  abc   \n"])
def test_short_values_are_refused_without_being_shown(tmp_path, value):
    # Results are scrubbed of every secret value, so a short one would mangle them.
    secrets = SecretStore(tmp_path / "s")
    with pytest.raises(ValueError, match="at least 8 characters") as err:
        secrets.set("token", value)
    assert not value.strip() or value.strip() not in str(err.value)
    assert not (tmp_path / "s" / "token").exists()


def test_eight_characters_are_enough(tmp_path):
    secrets = SecretStore(tmp_path / "s")
    secrets.set("token", "12345678")
    assert secrets.get("token") == "12345678"


def test_values_never_show_in_repr(tmp_path):
    secrets = SecretStore(tmp_path / "s")
    secrets.set("token", "hunter2-hunter2")
    assert "hunter2" not in repr(secrets)
