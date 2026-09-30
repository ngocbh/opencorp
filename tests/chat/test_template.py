from importlib.resources import files

from agent_corp.company.flows import load_confined


def test_chat_template_loads():
    root = files("agent_corp.company_template")
    flow = load_confined(root, root / "shared" / "flows" / "chat.yaml")
    assert flow.name == "chat"
