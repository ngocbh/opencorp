"""The compatibility key and the built app's id."""

import hashlib
import json
import shutil
import subprocess

import pytest

from opencorp.hq.version import CHECKOUT, BuildInfo, office_api


def test_in_a_checkout_the_key_is_the_version_and_the_schema_hash(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "opencorp"\nversion = "1.2.3"\n')
    schema = tmp_path / "packages/protocol/schema/protocol.schema.json"
    schema.parent.mkdir(parents=True)
    schema.write_text('{"$defs": {}}')
    assert office_api(tmp_path) == "1.2.3+" + hashlib.sha256(b'{"$defs": {}}').hexdigest()[:12]


def test_a_docs_only_change_keeps_the_key(tmp_path):
    test_in_a_checkout_the_key_is_the_version_and_the_schema_hash(tmp_path)
    before = office_api(tmp_path)
    (tmp_path / "README.md").write_text("more docs")
    assert office_api(tmp_path) == before


def test_without_a_checkout_the_key_is_the_installed_version(tmp_path):
    assert "+" not in office_api(tmp_path)


def test_build_json_is_parsed_again_only_when_its_content_changes(tmp_path):
    info = BuildInfo(tmp_path)
    assert info.read() is None
    path = tmp_path / "build.json"
    # Same size and, on Linux's coarse inode clock, often the same mtime: only the bytes tell b1 and b2 apart.
    path.write_text(json.dumps({"build": "b1", "api": "0.0.1+abc"}))
    first = info.read()
    assert first.build == "b1"
    assert info.read() is first  # unchanged bytes: the parsed copy is kept
    path.write_text(json.dumps({"build": "b2", "api": "0.0.1+abc"}))
    assert info.read().build == "b2"
    path.write_text("{")
    assert info.read() is None
    path.unlink()
    assert info.read() is None
    assert BuildInfo(None).read() is None


@pytest.mark.skipif(shutil.which("bun") is None or not (CHECKOUT / "packages/app/vite.hq.ts").exists(),
                    reason="needs bun and packages/app")
def test_the_app_build_and_the_office_compute_the_same_key():
    out = subprocess.run(["bun", "--eval", 'import { apiId } from "./packages/app/vite.hq.ts"; console.log(apiId())'],
                         cwd=CHECKOUT, capture_output=True, text=True, check=True)
    assert out.stdout.strip() == office_api()
