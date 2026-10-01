from importlib.resources import files

import yaml

from agent_corp.chat.turns import MAIN_CHAT
from agent_corp.company.flows import load_confined

ROOT = files("agent_corp.company_template")
SIDE_CHAT = ROOT / "shared" / "flows" / "side_chat.yaml"


def test_side_chat_template_loads_and_has_the_chat_shape():
    assert load_confined(ROOT, SIDE_CHAT).name == "side_chat"
    flow = yaml.safe_load(SIDE_CHAT.read_text())
    turn = flow["defs"]["turn"]["nodes"]
    assert (flow["long_term_memory"], flow["nodes"]["chat"]["kind"]) == ("profile", "loop")
    assert turn["ask"]["kind"] == "human_input" and turn["route"]["cases"] == [{"when": MAIN_CHAT.exit,
                                                                                "then": "exit_turn"}]
    reply = turn["reply"]
    assert (reply["steerable"], reply["long_term_memory"], reply["output"]) == (True, "session", "str")


def test_side_chat_tools_are_read_only_lookups():
    reply = yaml.safe_load(SIDE_CHAT.read_text())["defs"]["turn"]["nodes"]["reply"]
    assert reply["tools"] == ["workspace", "work_items"]
    assert "skills" not in reply


def test_side_chat_takes_the_person_into_the_replys_system_prompt():
    flow = yaml.safe_load(SIDE_CHAT.read_text())
    assert "person" in flow["input"]
    reply = flow["defs"]["turn"]["nodes"]["reply"]
    assert reply["system_prompt"].startswith("You are ${person.name} (@${person.handle})")
