"""Browser sessions on HQ: office-local rows holding a secret's hash, never the secret."""

import pytest

from opencorp.store import DuplicateKey, HqSessionRecord, new_id

NOW, LATER = "2026-10-19T10:00:00.000Z", "2026-11-18T10:00:00.000Z"


def record(**over) -> HqSessionRecord:
    base = dict(id=new_id(), person="ngocbh", name="web-abc123", label="Safari", secret_sha256="a" * 64,
                password_fp="0" * 16, issued_by="ngocbh", via="pair", created_at=NOW, expires_at=LATER,
                last_used_at=None)
    return HqSessionRecord(**{**base, **over})


def test_a_session_round_trips_and_is_found_by_its_secret_hash(store):
    r = record()
    store.add_hq_session(r)
    assert store.hq_session_by_secret("a" * 64) == r == store.get_hq_session(r.id)
    assert store.hq_session_by_secret("b" * 64) is None


def test_its_public_form_has_no_secret_hash_or_fingerprint(store):
    public = record().public().model_dump()
    assert "secret_sha256" not in public and "password_fp" not in public and public["via"] == "pair"


def test_a_secret_hash_is_unique(store):
    store.add_hq_session(record())
    with pytest.raises(DuplicateKey):
        store.add_hq_session(record())


def test_adding_one_prunes_the_expired(store):
    old = record(secret_sha256="c" * 64, expires_at="2026-10-01T00:00:00.000Z")
    store.add_hq_session(old)
    store.add_hq_session(record())
    assert store.get_hq_session(old.id) is None


def test_list_touch_delete_and_prune(store):
    a, b = record(person="ngocbh"), record(person="ann", secret_sha256="d" * 64)
    store.add_hq_session(a)
    store.add_hq_session(b)
    assert [r.id for r in store.list_hq_sessions("ann")] == [b.id] and len(store.list_hq_sessions()) == 2
    store.touch_hq_session(a.id, "2026-10-19T11:00:00.000Z")
    assert store.get_hq_session(a.id).last_used_at == "2026-10-19T11:00:00.000Z"
    assert store.delete_hq_session(a.id) is True and store.delete_hq_session(a.id) is False
    assert store.prune_hq_sessions("2999-01-01T00:00:00.000Z") == 1 and store.list_hq_sessions() == []


def test_no_event_is_emitted(store):
    store.add_hq_session(record())
    assert store.events_after() == []
