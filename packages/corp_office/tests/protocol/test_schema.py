"""The protocol schema is valid Draft 2020-12 and every fixture validates."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[4]
SCHEMA_PATH = ROOT / "packages/protocol/schema/protocol.schema.json"
FIXTURES = ROOT / "packages/protocol/fixtures"
ENTITIES = {"Company", "Person", "Group", "Asset", "WorkItem", "Comment", "Session", "Message",
            "Permission", "Question", "Profile", "ProfileProposal", "Debrief", "Feedback", "Event",
            "LiveEvent"}


def _schema():
    return json.loads(SCHEMA_PATH.read_text())


def test_schema_is_valid():
    Draft202012Validator.check_schema(_schema())


def test_objects_are_closed_and_have_no_format():
    schema = _schema()
    assert "$id" not in schema
    assert '"format"' not in SCHEMA_PATH.read_text()
    for name, sub in schema["$defs"].items():
        if sub.get("type") == "object":
            assert sub.get("additionalProperties") is False, name


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_fixture_validates(path):
    sub = {"$ref": f"#/$defs/{path.stem}", "$defs": _schema()["$defs"]}
    Draft202012Validator(sub).validate(json.loads(path.read_text()))


def test_every_entity_has_a_fixture():
    assert ENTITIES <= {p.stem for p in FIXTURES.glob("*.json")}


BODIES = {"CreateSessionRequest", "PromptRequest", "Ack", "CostCapRequest", "RepoIssue", "HireRequest",
          "HireResponse", "ApiError", "AnswerRequest", "SideChatRequest", "SendBackRequest",
          "ProfileWriteRequest", "VersionConflict", "ProfileManagerRequest", "FeedbackRequest",
          "ConfirmFollowUpsRequest", "AddDeviceRequest", "LoginRequest", "SetPasswordRequest", "Connection",
          "ConnectionList", "ModelOption", "ModelList", "SetModelRequest", "AddConnectionRequest",
          "SetDefaultConnectionRequest", "StartLoginRequest", "ConnectionLogin"}


def test_every_route_body_has_a_fixture():
    assert BODIES <= {p.stem for p in FIXTURES.glob("*.json")}


SETUP = {"SetupAsk", "SetupChoose", "SetupSecret", "SetupSay", "SetupStep", "SetupAnswer"}


def test_every_setup_message_has_a_fixture():
    assert SETUP <= {p.stem for p in FIXTURES.glob("*.json")}


def test_optional_fields_default():
    # Every optional field has a default (null when nothing else fits), so a plain
    # model_dump() of a generated model is always schema-valid.
    for name, sub in _schema()["$defs"].items():
        for field, prop in sub.get("properties", {}).items():
            if field not in sub.get("required", []):
                assert "default" in prop, f"{name}.{field}"
