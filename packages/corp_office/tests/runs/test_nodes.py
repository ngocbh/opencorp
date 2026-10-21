"""A run's open nodes from its worker's frames: every outcome frame ends a node, and only the deepest show."""

from opencorp.runs import nodes as nodes_mod
from opencorp.runs.nodes import OpenNodes


def frames(open_nodes, *pairs):
    return [open_nodes.apply(name, data) for name, data in pairs]


def test_every_outcome_frame_ends_a_node():
    n = OpenNodes()
    changed = frames(n, ("NodeStarted", {"node_id": "chat"}), ("NodeExpanded", {"node_id": "chat"}),
                     ("NodeStarted", {"node_id": "chat#0/route"}), ("NodeRouted", {"node_id": "chat#0/route"}),
                     ("NodeStarted", {"node_id": "chat#0/reply"}),
                     ("NodeFailed", {"failure": {"node_id": "chat#0/reply"}}),
                     ("NodeSkipped", {"node_id": "chat#0/exit_turn"}), ("StreamChunk", {"node_id": "x"}))
    assert changed == [True, True, True, True, True, True, False, False] and n.current() == []


def test_a_loop_driver_clone_opens_and_ends_like_any_node():
    n = OpenNodes()
    frames(n, ("NodeStarted", {"node_id": "chat~3"}))
    assert n.current() == ["chat~3"]
    frames(n, ("NodeExpanded", {"node_id": "chat~3"}), ("NodeStarted", {"node_id": "chat#3/reply"}))
    assert n.current() == ["chat#3/reply"]
    frames(n, ("NodeSucceeded", {"node_id": "chat#3/reply"}), ("NodeStarted", {"node_id": "chat~4"}),
           ("NodeSucceeded", {"node_id": "chat~4"}))
    assert n.current() == []


def test_only_the_deepest_open_nodes_show():
    n = OpenNodes()
    frames(n, ("NodeStarted", {"node_id": "chat"}), ("NodeStarted", {"node_id": "chat#12/reply"}),
           ("NodeStarted", {"node_id": "m"}), ("NodeStarted", {"node_id": "m#0/a"}),
           ("NodeStarted", {"node_id": "m#1/a"}),
           ("NodeStarted", {"node_id": "l"}), ("NodeStarted", {"node_id": "l~2"}), ("NodeStarted", {"node_id": "l2"}))
    assert n.current() == ["chat#12/reply", "m#0/a", "m#1/a", "l~2", "l2"]


def test_the_set_is_capped_and_cleared(monkeypatch):
    monkeypatch.setattr(nodes_mod, "CAP", 2)
    n = OpenNodes()
    frames(n, *[("NodeStarted", {"node_id": f"m#{i}/a"}) for i in range(3)])
    assert n.current() == ["m#1/a", "m#2/a"]
    n.clear()
    assert n.current() == []
