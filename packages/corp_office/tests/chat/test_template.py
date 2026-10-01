from importlib.resources import files

import yaml

from agent_corp.company.flows import load_confined

ROOT = files("agent_corp.company_template")
CHAT = ROOT / "shared" / "flows" / "chat.yaml"


def test_chat_template_loads():
    flow = load_confined(ROOT, CHAT)
    assert flow.name == "chat"


def test_chat_template_takes_the_person_into_the_replys_system_prompt():
    flow = yaml.safe_load(CHAT.read_text())
    assert "person" in flow["input"]
    reply = flow["defs"]["turn"]["nodes"]["reply"]
    assert reply["system_prompt"].startswith("You are ${person.name} (@${person.handle})")
