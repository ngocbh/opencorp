"""Generated pydantic models match the schema and round-trip every fixture."""

import json
import subprocess
from pathlib import Path

import pydantic
import pytest
from jsonschema import Draft202012Validator

from agent_corp.protocol import models

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages/protocol/fixtures"
GENERATED = ROOT / "src/agent_corp/protocol/models.py"
SCHEMA_PATH = ROOT / "packages/protocol/schema/protocol.schema.json"


def _validator(name):
    defs = json.loads(SCHEMA_PATH.read_text())["$defs"]
    return Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": defs})


def test_generated_models_are_current(tmp_path):
    out = tmp_path / "models.py"
    subprocess.run([str(ROOT / "packages/protocol/scripts/gen_py.sh"), str(out)], check=True)
    assert out.read_text() == GENERATED.read_text(), "run packages/protocol/scripts/gen_py.sh"


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_fixture_round_trips(path):
    model = getattr(models, path.stem)
    data = json.loads(path.read_text())
    assert model.model_validate(data).model_dump(mode="json", exclude_unset=True) == data


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_full_dump_validates(path):
    # A plain dump, defaults and all, is what the office writes; it must stay schema-valid.
    dumped = getattr(models, path.stem).model_validate_json(path.read_text()).model_dump(mode="json")
    _validator(path.stem).validate(dumped)


def test_ids_and_enums_are_plain_str():
    person = models.Person.model_validate(json.loads((FIXTURES / "Person.json").read_text()))
    assert type(person.id) is str and type(person.manager) is str
    assert type(person.kind) is str and person.kind == "agent"
    assert {person.id: 1}[person.id] == 1


@pytest.mark.parametrize("change", [{"id": "a_b"}, {"manager": "a--b"}, {"colour": "blue"}])
def test_generated_models_keep_constraints(change):
    data = json.loads((FIXTURES / "Person.json").read_text())
    with pytest.raises(pydantic.ValidationError):
        models.Person.model_validate({**data, **change})


def test_parts_are_a_discriminated_union():
    data = json.loads((FIXTURES / "Message.json").read_text())
    data["parts"][0]["type"] = "image"
    with pytest.raises(pydantic.ValidationError) as caught:
        models.Message.model_validate(data)
    assert [e["type"] for e in caught.value.errors()] == ["union_tag_invalid"]
