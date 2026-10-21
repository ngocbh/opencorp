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
          "SetDefaultConnectionRequest", "StartLoginRequest", "ConnectionLogin", "CompanyView", "CostReport",
          "Health", "HqStatus", "PairCodeRequest", "PairCode", "PairRequest", "BrowserSession",
          "HqLoginRequest", "CompanyTree", "CompanyFile", "RunPage", "RunDetail", "RunNodePage", "RunEventPage",
          "RunEvent"}


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


def test_harness_session_fields_exist():
    defs = _schema()["$defs"]
    assert "harness" in defs["Question"]["properties"]["source"]["enum"]
    assert {"harness_model", "harness_usage", "parent_session_id"} <= defs["Session"]["properties"].keys()
    assert "author" in defs["Message"]["properties"] and "secret" in defs["QuestionPage"]["properties"]


HQ = {"CompanyView", "PersonCost", "CostReport", "ApiVersion", "AppBuild", "Health", "HqTcp", "HqStatus",
      "PairCodeRequest", "PairCode", "PairRequest", "BrowserSession", "HqLoginRequest"}


def test_hq_defs_exist_and_company_updated_is_an_event_type():
    defs = _schema()["$defs"]
    assert HQ <= defs.keys()
    assert "company.updated" in defs["Event"]["properties"]["type"]["enum"]
    assert defs["HqStatus"]["properties"]["socket_error"]["default"] is None


def test_a_browser_session_never_carries_its_secret_or_password_fingerprint():
    props = _schema()["$defs"]["BrowserSession"]["properties"]
    assert not {"secret", "secret_sha256", "password_fp"} & props.keys()
    assert props["via"]["enum"] == ["pair", "login"]


def test_a_login_request_is_closed_and_needs_a_password():
    sub = _schema()["$defs"]["HqLoginRequest"]
    assert sub["additionalProperties"] is False
    assert sub["required"] == ["handle", "password"]
    assert sub["properties"]["password"]["minLength"] == 1


SOURCE = {"CommitInfo", "CompanyTreeEntry", "CompanyTree", "CompanyFile"}


def test_source_defs_have_fixtures():
    assert SOURCE <= {p.stem for p in FIXTURES.glob("*.json")}
    assert SOURCE <= {p.name.split(".", 1)[0] for p in (FIXTURES / "invalid").glob("*.json")}


def test_source_entry_types_and_file_states():
    defs = _schema()["$defs"]
    assert defs["CompanyTreeEntry"]["properties"]["type"]["enum"] == ["file", "folder", "symlink", "submodule"]
    assert defs["CompanyFile"]["properties"]["content"]["enum"] == [
        "text", "binary", "too_large", "hidden", "symlink", "submodule"]
    assert defs["CompanyFile"]["required"] == ["path", "commit", "content"]
    assert defs["CompanyTree"]["required"] == ["commit", "entries", "truncated", "skipped"]


def test_a_commit_names_its_author_without_an_email():
    sub = _schema()["$defs"]["CommitInfo"]
    assert sub["required"] == ["id", "subject", "author", "time"]
    assert sub["properties"].keys() == {"id", "subject", "author", "time"}
    assert sub["properties"]["time"] == {"$ref": "#/$defs/Timestamp"}


RUNS = {"RunSummary", "RunPage", "RunUsage", "RunDetail", "RunNode", "RunDivider", "RunNodePage", "RunEvent",
        "RunEventPage", "RunUpdated"}
RUN_STATUSES = ["running", "waiting", "idle", "finished", "failed", "interrupted"]


def test_run_defs_have_fixtures():
    assert RUNS <= {p.stem for p in FIXTURES.glob("*.json")}
    assert RUNS <= {p.name.split(".", 1)[0] for p in (FIXTURES / "invalid").glob("*.json")}


def test_run_statuses_node_statuses_and_log_states():
    defs = _schema()["$defs"]
    assert defs["RunSummary"]["properties"]["status"]["enum"] == RUN_STATUSES
    assert defs["RunUpdated"]["properties"]["status"]["enum"] == RUN_STATUSES
    assert defs["RunNode"]["properties"]["status"]["enum"] == [
        "open", "succeeded", "routed", "expanded", "failed", "restarted"]
    assert defs["RunDetail"]["properties"]["log_state"]["enum"] == [
        "ok", "indexing", "missing", "not_started", "unsupported_schema"]


def test_run_updated_is_an_event_type():
    assert "run.updated" in _schema()["$defs"]["Event"]["properties"]["type"]["enum"]


def test_a_reason_and_a_node_error_are_capped_at_200_characters():
    defs = _schema()["$defs"]
    assert defs["RunSummary"]["properties"]["reason"]["anyOf"][0]["maxLength"] == 200
    assert defs["RunNode"]["properties"]["error"]["anyOf"][0]["maxLength"] == 200


def test_node_and_record_pages_can_say_the_log_is_still_being_read():
    defs = _schema()["$defs"]
    for name in ("RunNodePage", "RunEventPage"):
        props = defs[name]["properties"]
        assert (props["indexing"]["type"], props["indexing"]["default"]) == ("boolean", False)
        assert {"bytes_done", "bytes_total"} <= props.keys()


def test_a_node_kind_is_nullable_and_optional():
    kind = _schema()["$defs"]["RunNode"]["properties"]["kind"]
    assert kind["default"] is None and {"type": "null"} in kind["anyOf"]


def test_a_list_row_counts_its_children():
    props = _schema()["$defs"]["RunSummary"]["properties"]
    count = props["child_count"]
    assert (count["type"], count["minimum"], count["default"]) == ("integer", 0, 0)
    assert "child_count" not in _schema()["$defs"]["RunSummary"]["required"]
    assert "empty" in props["children"]["description"]
