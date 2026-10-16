"""Starting and stopping one app-server: command, environment, process group, worker record."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from agent_corp.harness.codex import CodexMissing, codex_command, owner_load
from agent_corp.protocol.models import HarnessPolicy

CLIENT = Draft7Validator(json.loads(
    (Path(__file__).parent / "fixtures" / "codex" / "schema" / "ClientRequest.json").read_text()))


def test_owner_load_takes_the_persons_policy():
    assert owner_load("/w", HarnessPolicy(sandbox="workspace-write", network=True)) == {
        "cwd": "/w", "sandbox": "workspace-write", "approvalPolicy": "on-request", "approvalsReviewer": "user",
        "config": {"sandbox_workspace_write": {"network_access": True}}}
    assert owner_load("/w", None)["sandbox"] == "read-only"
    assert owner_load("/w", None)["config"] == {"sandbox_workspace_write": {"network_access": False}}
    for policy in (None, HarnessPolicy(sandbox="workspace-write", network=True)):  # loads Codex takes
        CLIENT.validate({"id": 1, "method": "thread/start", "params": owner_load("/w", policy)})
        CLIENT.validate({"id": 2, "method": "thread/resume", "params": {"threadId": "t", **owner_load("/w", policy)}})


def test_codex_command_finds_codex_on_the_office_path(tmp_path):
    (tmp_path / "codex").write_text("#!/bin/sh\n")
    (tmp_path / "codex").chmod(0o755)
    assert codex_command({"PATH": str(tmp_path)}) == [str(tmp_path / "codex"), "app-server", "--listen", "stdio://"]
    with pytest.raises(CodexMissing, match="isn't installed"):
        codex_command({"PATH": str(tmp_path / "empty")})
