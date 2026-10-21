"""The office secret store: one 0600 file per secret in a 0700 directory."""

import os
import stat
import threading
from types import SimpleNamespace

import pytest

from opencorp import secrets as secrets_module
from opencorp.secrets import SecretStore

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


@pytest.mark.parametrize("loose", [0o644, 0o640, 0o400, 0o700], ids=oct)
def test_get_refuses_a_secret_file_without_mode_0600(tmp_path, stored, loose):
    os.chmod(tmp_path / "s" / "token", loose)
    with pytest.raises(PermissionError, match="'token' must be mode 0600"):
        stored.get("token")


def test_an_unreadable_secret_file_says_so(tmp_path, stored):
    os.chmod(tmp_path / "s" / "token", 0)
    with pytest.raises(PermissionError, match="'token' is not readable"):
        stored.get("token")


def test_get_refuses_a_secret_file_of_another_user(stored, monkeypatch):
    fstat = os.fstat

    def foreign_files(fd):
        st = fstat(fd)
        return SimpleNamespace(st_mode=st.st_mode, st_uid=st.st_uid + 1) if stat.S_ISREG(st.st_mode) else st

    monkeypatch.setattr(secrets_module.os, "fstat", foreign_files)
    with pytest.raises(PermissionError, match="'token' belongs to another user"):
        stored.get("token")


def test_get_refuses_a_value_too_short_to_scrub(tmp_path, stored):
    fd = os.open(tmp_path / "s" / "short", os.O_WRONLY | os.O_CREAT, 0o600)
    os.write(fd, b"abc\n")
    os.close(fd)
    with pytest.raises(PermissionError, match="'short' is shorter than 8 characters") as err:
        stored.get("short")
    assert "abc" not in str(err.value)


def swap_root_after_check(monkeypatch, secrets, tmp_path):
    """Once the root is opened and checked, move it aside and put a symlink to ``elsewhere`` in its place."""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    (elsewhere / "token").write_text("planted-value")
    opened = secrets._open_root

    def then_swap(**kw):
        fd = opened(**kw)
        if fd is not None:
            os.rename(secrets.root, tmp_path / "moved")
            os.symlink(elsewhere, secrets.root)
        return fd

    monkeypatch.setattr(secrets, "_open_root", then_swap)
    return elsewhere


def test_set_writes_into_the_root_it_checked(tmp_path, stored, monkeypatch):
    elsewhere = swap_root_after_check(monkeypatch, stored, tmp_path)
    stored.set("token", "second-value")
    assert (tmp_path / "moved" / "token").read_text() == "second-value"
    assert (elsewhere / "token").read_text() == "planted-value" and sorted(os.listdir(elsewhere)) == ["token"]


def test_get_reads_from_the_root_it_checked(tmp_path, stored, monkeypatch):
    swap_root_after_check(monkeypatch, stored, tmp_path)
    assert stored.get("token") == "first-value"


def test_delete_removes_from_the_root_it_checked(tmp_path, stored, monkeypatch):
    elsewhere = swap_root_after_check(monkeypatch, stored, tmp_path)
    stored.delete("token")
    assert not (tmp_path / "moved" / "token").exists() and (elsewhere / "token").exists()


def test_concurrent_sets_on_a_fresh_store_all_succeed(tmp_path):
    for attempt in range(20):
        secrets = SecretStore(tmp_path / f"s{attempt}")
        start, errors = threading.Barrier(8), []

        def put(i):
            start.wait()
            try:
                secrets.set(f"token{i}", f"value-number-{i}")
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=put, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []
        assert sorted(os.listdir(secrets.root)) == sorted(f"token{i}" for i in range(8))


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


def test_names_lists_what_could_be_a_secret_sorted(tmp_path):
    store = SecretStore(tmp_path / "secrets")
    assert SecretStore(tmp_path / "missing").names() == []
    store.set("b_token", "value-1234")
    store.set("a.key", "value-5678")
    (store.root / ".set-0123").write_text("a temporary file")
    (store.root / "Bad Name!").write_text("not a secret name")
    assert store.names() == ["a.key", "b_token"]


def test_read_private_refuses_a_fifo_without_waiting_for_a_writer(tmp_path):
    os.mkfifo(tmp_path / "fifo", 0o600)
    got = []
    read = lambda: secrets_module.read_private(tmp_path / "fifo")  # noqa: E731
    reader = threading.Thread(target=lambda: got.append(_raises(read)), daemon=True)
    reader.start()
    reader.join(2)
    blocked = reader.is_alive()
    if blocked:  # free the blocked open so the test run can end
        with open(tmp_path / "fifo", "wb"):
            pass
    assert not blocked and got == [PermissionError]


def _raises(call):
    try:
        call()
    except Exception as exc:
        return type(exc)
    return None


def test_names_refuses_a_loose_root(tmp_path):
    store = SecretStore(tmp_path / "secrets")
    store.set("token", "value-1234")
    store.root.chmod(0o755)
    with pytest.raises(PermissionError):
        store.names()
