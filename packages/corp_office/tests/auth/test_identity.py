"""The device identity file onboarding writes and ``opencorp`` reads."""

import os
import stat

import pytest

from opencorp.auth.identity import Identity, device_name, identity_path, read_identity, write_identity
from opencorp.auth.tokens import new_token
from opencorp.protocol.models import Device


@pytest.mark.parametrize(("host", "name"), [("Ngocs-MacBook-Pro.local", "ngocs-macbook-pro"), ("box", "box"),
                                            ("--Odd Host!", "odd-host-"), ("", "device"), ("___", "device"),
                                            ("x" * 80 + ".lan", "x" * 63)])
def test_a_device_name_is_the_sanitized_short_hostname(host, name):
    assert device_name(host) == name
    Device(name=name, token_sha256="0" * 64)  # the schema takes it


def test_the_identity_file_is_private_and_reads_back(tmp_path):
    me = Identity("ngocbh", "mac", new_token())
    path = identity_path(tmp_path)
    write_identity(path, me)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert read_identity(path) == me
    assert me.token not in repr(me)
    assert me.headers() == {"Authorization": f"Bearer {me.token}"}


def test_a_missing_or_broken_file_is_no_identity(tmp_path):
    assert read_identity(tmp_path / "identity.json") is None
    (tmp_path / "identity.json").write_text("{")
    assert read_identity(tmp_path / "identity.json") is None
