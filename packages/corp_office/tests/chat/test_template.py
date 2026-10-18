from importlib.resources import files

import pytest

from opencorp.company.flow_yaml import read_flow
from opencorp.company.flows import load_confined

ROOT = files("opencorp.company_template")
CHAT = ROOT / "shared" / "flows" / "chat.yaml"
SIDE = ROOT / "shared" / "flows" / "side_chat.yaml"


def test_chat_template_loads():
    flow = load_confined(ROOT, CHAT)
    assert flow.name == "chat"


def test_chat_template_takes_the_person_into_the_replys_system_prompt():
    flow = read_flow(CHAT.read_text())
    assert "person" in flow["input"]
    reply = flow["defs"]["turn"]["nodes"]["reply"]
    assert reply["system_prompt"].startswith("You are ${person.name} (@${person.handle})")


@pytest.mark.parametrize("path", [CHAT, SIDE])
def test_chat_templates_say_who_the_person_is_talking_with(path):
    flow = read_flow(path.read_text())
    turn = flow["defs"]["turn"]
    reply = turn["nodes"]["reply"]
    assert flow["input"]["talking_to"] == turn["input"]["talking_to"] == "!str"
    assert reply["input"]["talking_to"] == turn["output"]["talking_to"] == "${input.talking_to}"
    assert flow["nodes"]["chat"]["input"]["talking_to"] == "${input.talking_to}"
    assert reply["system_prompt"].splitlines()[0].endswith("${person.reports_to} ${talking_to}")
    assert load_confined(ROOT, path).name == flow["name"]
