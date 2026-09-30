"""Audit, usage, and worker rows (office bookkeeping, no events)."""


def test_audit_rows(store):
    a = store.record_audit(person="minh", kind="asset", tool="cluster_a__ssh", args={"host": "x"}, outcome="ok",
                           session_id="s1", run_id="r1")
    b = store.record_audit(person="minh", kind="workspace", tool="shell", args={"cmd": "ls"}, outcome="denied",
                           session_id="s2", detail="where")
    assert store.list_audit() == [a, b]
    assert store.list_audit(session_id="s2") == [b] and store.list_audit(person="lan") == []
    assert store.events_after() == []


def test_usage_rows_and_total(store):
    a = store.record_usage(session_id="s1", run_id="r1", model="m", input_tokens=10, output_tokens=5, usd=0.25)
    store.record_usage(session_id="s1", run_id="r1", model="m", input_tokens=1, output_tokens=1, usd=0.5)
    store.record_usage(session_id="s2", run_id="r2", model="m", input_tokens=1, output_tokens=1, usd=9)
    assert store.list_usage("s1")[0] == a and len(store.list_usage("s1")) == 2
    assert store.session_usage_usd("s1") == 0.75 and store.session_usage_usd("none") == 0
    assert store.events_after() == []


def test_worker_rows(store):
    store.record_worker("s1", pid=100, pgid=100, start_time=1.5)
    store.record_worker("s2", pid=200, pgid=200, start_time=2.5)
    store.record_worker("s1", pid=101, pgid=101, start_time=3.5)
    assert [(w.session_id, w.pid, w.start_time) for w in store.list_workers()] == [("s1", 101, 3.5), ("s2", 200, 2.5)]
    store.remove_worker("s1")
    store.remove_worker("s1")
    assert [w.session_id for w in store.list_workers()] == ["s2"]
