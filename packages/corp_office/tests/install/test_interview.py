from agent_composer import load_flow

from agent_corp.install.interview import FLOW


def test_the_flow_loads_and_takes_what_init_knows_a_draft_and_changes():
    flow = load_flow(FLOW.read_text(), source_label=str(FLOW))
    assert {p.name: p.contract.type.kind.value for p in flow.input} == {"known": "str", "draft": "str",
                                                                         "changes": "str"}
