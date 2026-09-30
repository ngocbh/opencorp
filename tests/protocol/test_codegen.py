"""Generated pydantic models match the schema and round-trip every fixture."""

import json
import subprocess
from pathlib import Path

import pytest

from agent_corp.protocol import models

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages/protocol/fixtures"
GENERATED = ROOT / "src/agent_corp/protocol/models.py"


def test_generated_models_are_current(tmp_path):
    out = tmp_path / "models.py"
    subprocess.run([str(ROOT / "packages/protocol/scripts/gen_py.sh"), str(out)], check=True)
    assert out.read_text() == GENERATED.read_text(), "run packages/protocol/scripts/gen_py.sh"


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_fixture_round_trips(path):
    model = getattr(models, path.stem)
    data = json.loads(path.read_text())
    assert model.model_validate(data).model_dump(mode="json", exclude_unset=True) == data
