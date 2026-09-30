"""The office package imports next to agent-composer."""

import agent_composer
import agent_corp


def test_office_and_composer_import():
    assert agent_corp.__version__ == "0.0.1"
    assert hasattr(agent_composer, "run_flow")
