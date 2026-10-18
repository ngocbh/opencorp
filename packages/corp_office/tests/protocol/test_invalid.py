"""Both the schema and the generated models reject each invalid fixture."""

import json
from pathlib import Path

import pydantic
import pytest
from jsonschema import Draft202012Validator, ValidationError

from opencorp.protocol import models

ROOT = Path(__file__).resolve().parents[4]
SCHEMA_PATH = ROOT / "packages/protocol/schema/protocol.schema.json"
INVALID = ROOT / "packages/protocol/fixtures/invalid"
CASES = sorted(INVALID.glob("*.json"))


def _def_name(path):
    # invalid/<Def>.<case>.json
    return path.name.split(".", 1)[0]


def test_there_are_invalid_fixtures():
    assert CASES


@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_schema_rejects(path):
    defs = json.loads(SCHEMA_PATH.read_text())["$defs"]
    validator = Draft202012Validator({"$ref": f"#/$defs/{_def_name(path)}", "$defs": defs})
    with pytest.raises(ValidationError):
        validator.validate(json.loads(path.read_text()))


@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_model_rejects(path):
    with pytest.raises(pydantic.ValidationError):
        getattr(models, _def_name(path)).model_validate_json(path.read_text())
