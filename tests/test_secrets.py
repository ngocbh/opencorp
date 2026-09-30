"""The office secret store: one 0600 file per secret in a 0700 directory."""

import os
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


@pytest.mark.parametrize("name", ["", "../x", "a/b", ".hidden", "x" * 129, "sp ace", "Token", "TOKEN"])
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


@pytest.fixture
def stored(tmp_path):
    secrets = SecretStore(tmp_path / "s")
    secrets.set("token", "first-value")
    return secrets


def test_get_refuses_a_symlinked_secret_file(tmp_path, stored):
    (tmp_path / "outside").write_text("not-a-secret-value")
    os.symlink(tmp_path / "outside", tmp_path / "s" / "link")
    with pytest.raises(PermissionError, match="'link'"):
        stored.get("link")


@pytest.mark.parametrize("loose", [0o644, 0o640, 0o400, 0o000], ids=oct)
def test_get_refuses_a_secret_file_without_mode_0600(tmp_path, stored, loose):
    os.chmod(tmp_path / "s" / "token", loose)
    with pytest.raises(PermissionError, match="'token'"):
        stored.get("token")


@pytest.mark.parametrize("make", [os.mkdir, os.mkfifo])
def test_get_refuses_anything_but_a_regular_file(tmp_path, stored, make):
    make(tmp_path / "s" / "odd")
    with pytest.raises(PermissionError, match="'odd'"):
        stored.get("odd")


def test_a_symlinked_root_is_refused_and_its_target_left_alone(tmp_path):
    target = tmp_path / "shared"
    target.mkdir(mode=0o700)
    os.symlink(target, tmp_path / "s")
    secrets = SecretStore(tmp_path / "s")
    os.chmod(target, 0o755)
    for call in (lambda: secrets.set("token", "first-value"), lambda: secrets.get("token"),
                 lambda: secrets.delete("token")):
        with pytest.raises(PermissionError, match="symlink"):
            call()
    assert mode(target) == 0o755 and list(target.iterdir()) == []


@pytest.mark.parametrize("loose", [0o755, 0o750, 0o701], ids=oct)
def test_a_loose_root_is_refused(tmp_path, stored, loose):
    os.chmod(tmp_path / "s", loose)
    for call in (lambda: stored.set("token", "second-value"), lambda: stored.get("token"),
                 lambda: stored.delete("token")):
        with pytest.raises(PermissionError, match="0700"):
            call()
    assert mode(tmp_path / "s") == loose
    os.chmod(tmp_path / "s", 0o700)
    assert stored.get("token") == "first-value"


def test_a_root_that_is_a_file_is_refused(tmp_path):
    (tmp_path / "s").write_text("x")
    with pytest.raises(PermissionError, match="directory"):
        SecretStore(tmp_path / "s").set("token", "first-value")


def test_get_from_a_missing_root_is_a_key_error(tmp_path):
    with pytest.raises(KeyError, match="token"):
        SecretStore(tmp_path / "missing").get("token")
