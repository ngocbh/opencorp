"""The reference monitor: which asset tools a person gets, and every call's check and audit."""

from tests.company.conftest import person
from tests.perm.conftest import TOKEN, cluster, set_file

GROUPS = {"groups/infra.yaml": {"id": "infra", "name": "Infra", "parent": "eng", "head": None}}


def names(monitor, pid):
    return sorted(monitor.tools(pid))


def test_the_toolbox_lists_granted_tools_only(make_monitor):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["submit_job"]}])})
    assert names(m, "minh") == ["cluster_a__submit_job", "fake__echo"]
    assert names(m, "ngocbh") == []
    assert names(m, "nobody") == []


def test_grants_reach_members_of_child_groups(make_monitor):
    m = make_monitor(**GROUPS, **{
        "people/minh/person.yaml": person("minh", groups=["infra"]),
        "assets/cluster-a.yaml": cluster([{"who": "group:eng", "can": ["read_logs"]}]),
    })
    assert names(m, "minh") == ["cluster_a__read_logs", "fake__echo"]


def test_a_group_head_is_not_a_member_unless_listed(make_monitor):
    m = make_monitor(**{
        "groups/eng.yaml": {"id": "eng", "name": "Engineering", "parent": None, "head": "ngocbh"},
        "assets/cluster-a.yaml": cluster([{"who": "group:eng", "can": ["read_logs"]}]),
    })
    assert names(m, "ngocbh") == []
    assert m.call("ngocbh", "r1", "cluster_a__read_logs", {}) == "permission denied: no grant for cluster_a__read_logs"


def test_admin_allows_every_tool_but_gated_ones_are_never_listed(make_monitor, store):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["admin"]}])})
    assert names(m, "minh") == ["cluster_a__broken", "cluster_a__read_logs", "cluster_a__submit_job", "fake__echo"]
    assert m.call("minh", "r1", "cluster_a__read_logs", {}) == "logs"
    assert m.call("minh", "r1", "cluster_a__delete_data", {}) == "permission denied: cluster_a__delete_data is gated"


def test_tools_of_an_unknown_kind_are_not_listed(make_monitor):
    m = make_monitor(**{"assets/odd.yaml": {"id": "odd", "kind": "nope", "tools": {"x": {}},
                                             "grants": [{"who": "minh", "can": ["x"]}]}})
    assert names(m, "minh") == ["fake__echo"]
    assert m.call("minh", "r1", "odd__x", {}) == "error: asset kind 'nope' has no tool 'x'"


def test_a_call_runs_with_secrets_and_the_result_and_audit_hide_them(make_monitor, store):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["submit_job"]}])})
    got = m.call("minh", "r1", "cluster_a__submit_job", {"job": "train", "vault_token": TOKEN}, session_id="s1")
    assert got == "ran train on None with [redacted]"
    [row] = store.list_audit(person="minh")
    assert (row.kind, row.tool, row.outcome, row.run_id, row.session_id) == (
        "asset", "cluster_a__submit_job", "ok", "r1", "s1")
    assert row.args == {"job": "train", "vault_token": "[redacted]"}
    assert TOKEN not in repr(row)


def test_where_violations_come_back_as_results(make_monitor, store):
    grant = {"who": "minh", "can": ["submit_job"], "where": {"partition": ["gpu-small"]}}
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([grant])})
    call = m.call
    assert call("minh", "r1", "cluster_a__submit_job", {"job": "a", "partition": "gpu-small"}).startswith("ran a")
    assert call("minh", "r1", "cluster_a__submit_job", {"job": "b", "partition": "gpu-big"}) == (
        'permission denied: cluster_a__submit_job: partition must be one of ["gpu-small"]')
    assert call("minh", "r1", "cluster_a__submit_job", {"job": "c"}) == (
        'permission denied: cluster_a__submit_job: partition must be one of ["gpu-small"]')
    assert [r.outcome for r in store.list_audit()] == ["ok", "denied", "denied"]


def test_where_limits_admin_grants_too(make_monitor):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["admin"],
                                                           "where": {"partition": ["gpu-small"]}}])})
    assert m.call("minh", "r1", "cluster_a__read_logs", {"partition": "gpu-small"}) == "logs"
    assert m.call("minh", "r1", "cluster_a__read_logs", {}) == (
        'permission denied: cluster_a__read_logs: partition must be one of ["gpu-small"]')


def test_any_matching_grant_allows_the_call(make_monitor):
    grants = [{"who": "minh", "can": ["submit_job"], "where": {"partition": ["gpu-small"]}},
              {"who": "group:eng", "can": ["submit_job"]}]
    m = make_monitor(**{"assets/cluster-a.yaml": cluster(grants)})
    assert m.call("minh", "r1", "cluster_a__submit_job", {"job": "a", "partition": "gpu-big"}).startswith("ran a")


def test_a_revocation_between_two_calls_denies_the_second(make_monitor, store):
    m = make_monitor()
    assert m.call("minh", "r1", "fake__echo", {"text": "one"}) == "one"
    set_file(m.root, "assets/fake.yaml", {"id": "fake", "kind": "fake", "tools": {"echo": {}}, "grants": []})
    assert m.call("minh", "r1", "fake__echo", {"text": "two"}) == "permission denied: no grant for fake__echo"
    assert [r.outcome for r in store.list_audit(person="minh")] == ["ok", "denied"]


def test_unknown_tools_and_people_are_denied_and_audited(make_monitor, store):
    m = make_monitor()
    assert m.call("minh", "r1", "nope__x", {}) == "permission denied: no grant for nope__x"
    assert m.call("ghost", "r1", "fake__echo", {"text": "x"}) == "permission denied: no grant for fake__echo"
    assert len(store.list_audit()) == 2


def test_a_failing_tool_is_an_error_result_without_the_secret(make_monitor, store):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["broken"]}])})
    got = m.call("minh", "r1", "cluster_a__broken", {})
    assert got == "error: RuntimeError: cannot reach host (token [redacted])"
    [row] = store.list_audit()
    assert row.outcome == "error" and TOKEN not in row.detail


def test_a_missing_secret_is_an_error_result(make_monitor, store, secrets):
    (secrets.root / "vault_token").unlink()
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["read_logs"]}])})
    assert m.call("minh", "r1", "cluster_a__read_logs", {}) == "error: secret 'vault_token' is not set"
    assert store.list_audit()[0].outcome == "error"


def test_toolbox_tools_carry_the_kind_schema_and_audit_the_run(make_monitor, store):
    m = make_monitor(**{"assets/cluster-a.yaml": cluster([{"who": "minh", "can": ["submit_job"]}])})
    toolbox = m.tools("minh", run_id="r1", session_id="s1")
    submit = toolbox["cluster_a__submit_job"]
    assert submit.description == "Submit a job." and submit.tool_call_schema["required"] == ["job"]
    assert toolbox["fake__echo"].invoke({"text": "hi"}) == "hi"
    assert [(r.run_id, r.session_id) for r in store.list_audit()] == [("r1", "s1")]
