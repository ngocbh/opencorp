import json
from pathlib import Path

import pytest
from yian.memory.storage.markdown import FileMarkdownStore, MarkdownStore, MarkdownVersionMismatch

from opencorp.worker.remote_store import RemoteMarkdownStore
from opencorp.worker.rpc import BaseHandlers

from tests.worker.conftest import office_end


@pytest.fixture
def local(tmp_path):
    (tmp_path / "profile.md").write_text("# Minh\n")
    return FileMarkdownStore(tmp_path / "profile.md")


@pytest.fixture
def remote(local):
    with office_end(BaseHandlers(stores={"profile": local})) as rpc:
        yield RemoteMarkdownStore(rpc, "profile")


def test_it_is_a_markdown_store(remote):
    assert isinstance(remote, MarkdownStore)


def test_read_and_write_round_trip(remote, local):
    text, version = remote.read()
    assert (text, version) == local.read()
    new = remote.write("# Minh\nTerse.\n", base_version=version)
    assert remote.read() == ("# Minh\nTerse.\n", new) == local.read()
    assert remote.read(version) == ("# Minh\n", version)


def test_an_unknown_version_is_a_lookup_error(remote):
    with pytest.raises(LookupError, match="unknown document version"):
        remote.read("sha256:" + "0" * 64)


def test_a_stale_base_is_a_mismatch_with_both_versions(remote, local):
    _, old = remote.read()
    current = local.write("changed\n", base_version=old)
    with pytest.raises(MarkdownVersionMismatch) as caught:
        remote.write("mine\n", base_version=old)
    assert (caught.value.expected, caught.value.current) == (old, current)


def test_provenance_arrives_as_json(remote, tmp_path):
    _, version = remote.read()
    remote.write("x\n", base_version=version, provenance={"run_id": "r1", "frame": ("a", 1), "log": Path("/l")})
    [line] = (tmp_path / ".profile.md.writes.jsonl").read_text().splitlines()
    assert json.loads(line)["provenance"] == {"run_id": "r1", "frame": ["a", 1], "log": "/l"}


def test_an_undecodable_document_is_a_value_error(tmp_path):
    (tmp_path / "profile.md").write_bytes(b"\xff\xfe")
    with office_end(BaseHandlers(stores={"profile": FileMarkdownStore(tmp_path / "profile.md")})) as rpc:
        with pytest.raises(ValueError) as caught:
            RemoteMarkdownStore(rpc, "profile").read()
    assert not isinstance(caught.value, OSError)


def test_any_other_failure_is_an_os_error(local):
    with office_end(BaseHandlers(stores={"profile": local})) as rpc:
        with pytest.raises(OSError, match="no store named 'notes'"):
            RemoteMarkdownStore(rpc, "notes").read()
