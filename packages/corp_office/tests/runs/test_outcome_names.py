"""A run's end as the office writes it: every reason pattern-scrubbed, since a failure message may echo a secret."""

from opencorp.runs.outcomes import RunEnd, flow_label


def test_a_reason_loses_every_secret_of_a_known_shape():
    end = RunEnd("failed", "AuthError: 401 Bearer abcdefgh12345 for sk-unconfigured0123456789", "chat#0/reply")
    assert end.reason == "AuthError: 401 Bearer (hidden) for (hidden)" and end.failed_node == "chat#0/reply"
    assert RunEnd("finished").reason is None


def test_each_session_kind_has_a_flow_label():
    assert [flow_label(k) for k in ("main", "side", "profile_manager", "other")] == [
        "chat", "side_chat", "profile_manager", "other"]
