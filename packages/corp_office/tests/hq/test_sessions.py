"""Browser sessions: hashed, 30 days, checked against the person at HEAD on every request."""

import asyncio
import hashlib
import re
import threading
from datetime import UTC, datetime, timedelta

import pytest
import yaml

from opencorp.auth.passwords import hash_password
from opencorp.daemon.http import HTTPError
from opencorp.hq import sessions as sessions_module
from opencorp.hq.sessions import TTL, BrowserSessions, password_fp
from tests.company.conftest import _git

T0 = datetime(2026, 10, 19, 10, 0, tzinfo=UTC)


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now


def sessions_for(office, clock):
    return BrowserSessions(office.store, office.extras["hq"].snapshots, clock=clock)


def hand_edit(company, handle, **changes):
    path = company / "people" / handle / "person.yaml"
    data = {**yaml.safe_load(path.read_text()), **changes}
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    _git(company, "commit", "-qam", f"edit {handle}")


async def test_issue_keeps_only_the_secrets_hash_and_check_finds_it(office, hq):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label="Safari")
    sid, secret = cookie.split(".")
    row = office.store.get_hq_session(sid)
    assert sid == public.id and re.fullmatch(r"web-[a-z0-9]{6}", public.name)
    assert row.secret_sha256 == hashlib.sha256(secret.encode()).hexdigest() and secret not in repr(row)
    assert public.expires_at == (T0 + TTL).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    who = await s.check(cookie)
    assert (who.id, who.person, who.name) == (sid, "ngocbh", public.name)
    assert await s.check(f"{sid}.wrong") is None and await s.check("junk") is None and await s.check(None) is None


async def test_a_wrong_secret_for_a_real_id_revokes_nothing(office, hq):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert await s.check(f"{public.id}.forged") is None
    assert (await s.check(cookie)).id == public.id


async def test_the_cookies_id_must_be_the_rows(office, hq):
    s = sessions_for(office, Clock())
    _, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    other, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert await s.check(f"{other.id}.{cookie.split('.')[1]}") is None


async def test_only_a_human_at_head_gets_a_session(office, hq):
    s = sessions_for(office, Clock())
    for handle in ("minh", "nobody"):
        with pytest.raises(HTTPError) as caught:
            await s.issue(handle, issued_by="ngocbh", label=None)
        assert (caught.value.status, caught.value.code) == (422, "not_a_human")  # as on the socket


async def test_an_expired_session_is_refused_and_the_next_issue_deletes_it(office, hq):
    clock = Clock()
    s = sessions_for(office, clock)
    old, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    clock.now = T0 + TTL
    assert await s.check(cookie) is None
    await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert office.store.get_hq_session(old.id) is None


async def test_a_password_set_by_any_writer_ends_sessions_issued_before_it(office, hq, company):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    hand_edit(company, "ngocbh", password_hash=hash_password("a new password"))
    assert await s.check(cookie) is None and office.store.get_hq_session(public.id) is None


async def test_a_session_issued_after_the_password_lives(office, hq, company):
    hand_edit(company, "ngocbh", password_hash=hash_password("a new password"))
    s = sessions_for(office, Clock())
    _, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert await s.check(cookie) is not None


async def test_a_person_file_that_doesnt_validate_refuses_without_ending_the_session(office, hq, company):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    hand_edit(company, "ngocbh", nickname="typo")  # a field Person doesn't know
    assert await s.check(cookie) is None and office.store.get_hq_session(public.id) is not None
    with pytest.raises(HTTPError):
        await s.issue("ngocbh", issued_by="ngocbh", label=None)
    path = company / "people" / "ngocbh" / "person.yaml"
    data = yaml.safe_load(path.read_text())
    del data["nickname"]
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    _git(company, "commit", "-qam", "fix ngocbh")
    assert (await s.check(cookie)).id == public.id


async def test_deleting_the_person_ends_the_session(office, hq, company):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    _git(company, "rm", "-q", "people/ngocbh/person.yaml")
    _git(company, "commit", "-qm", "offboard ngocbh")
    assert await s.check(cookie) is None and office.store.get_hq_session(public.id) is None


async def test_offboarding_ends_the_session(office, hq, company):
    s = sessions_for(office, Clock())
    _, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    hand_edit(company, "ngocbh", kind="agent")
    assert await s.check(cookie) is None


async def test_last_used_is_written_at_most_once_an_hour(office, hq):
    clock = Clock()
    s = sessions_for(office, clock)
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    await s.check(cookie)
    first = office.store.get_hq_session(public.id).last_used_at
    assert first is not None
    clock.now = T0 + timedelta(minutes=30)
    await s.check(cookie)
    assert office.store.get_hq_session(public.id).last_used_at == first
    clock.now = T0 + timedelta(hours=2)
    await s.check(cookie)
    assert office.store.get_hq_session(public.id).last_used_at != first


def test_password_fp_is_16_hex_of_the_hash_or_empty():
    assert password_fp(None) == hashlib.sha256(b"").hexdigest()[:16]
    assert password_fp("$scrypt$x") == hashlib.sha256(b"$scrypt$x").hexdigest()[:16]


async def test_revoking_ends_the_session(office, hq):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert await s.revoke(public.id) is True
    assert await s.check(cookie) is None and office.store.get_hq_session(public.id) is None


async def test_revoking_an_unknown_id_keeps_no_state(office, hq):
    s = sessions_for(office, Clock())
    assert await s.revoke("01JA1H0000000000000000000Z") is False
    assert s._live == {}


async def test_an_expired_session_is_forgotten(office, hq):
    clock = Clock()
    s = sessions_for(office, clock)
    _, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    clock.now = T0 + TTL
    assert await s.check(cookie) is None
    assert s._live == {}  # neither the expired entry nor a revoked marker for it stays


async def test_a_check_that_read_the_row_before_a_revoke_still_refuses(office, hq, monkeypatch):
    s = sessions_for(office, Clock())
    public, cookie = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    stale = office.store.get_hq_session(public.id)
    await s.revoke(public.id)
    # The row as read just before the delete.
    monkeypatch.setattr(office.store, "hq_session_by_secret", lambda sha, now: stale)
    assert await s.check(cookie) is None


async def test_a_revoke_marks_the_entry_a_check_made_while_it_read_the_row(office, hq, monkeypatch):
    public, cookie = await sessions_for(office, Clock()).issue("ngocbh", issued_by="ngocbh", label=None)
    s = sessions_for(office, Clock())  # nothing in memory yet, as after a restart
    entered, gate = threading.Event(), threading.Event()
    real = office.store.get_hq_session

    def gated(sid):
        entered.set()
        gate.wait(5)
        return real(sid)

    monkeypatch.setattr(office.store, "get_hq_session", gated)
    revoking = asyncio.create_task(s.revoke(public.id))
    await asyncio.to_thread(entered.wait, 5)
    assert await s.check(cookie) is not None
    made = s._live[public.id]
    gate.set()
    assert await revoking is True
    assert s._live[public.id] is made and made.revoked


async def test_fingerprints_are_loaded_once_per_recent_commit(office, hq, company, monkeypatch):
    loads = []
    real = sessions_module.password_fps
    monkeypatch.setattr(sessions_module, "password_fps", lambda git, sha: loads.append(sha) or real(git, sha))
    cache = sessions_for(office, Clock())._fingerprints
    first = office.git.read_head()
    await asyncio.gather(cache.at(first), cache.at(first))
    hand_edit(company, "ngocbh", title="Boss")
    second = office.git.read_head()
    for sha in (second, first, second):
        await cache.at(sha)
    assert loads == [first, second]


async def test_revoking_ends_registered_streams_and_alive_turns_false(office, hq):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    sub = office.bus.subscribe()
    s.register(public.id, sub)
    assert s.alive(public.id)
    await s.revoke(public.id)
    assert await sub.next(timeout=1) is None and not s.alive(public.id)


async def test_an_unregistered_stream_outlives_the_revoke(office, hq):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    sub = office.bus.subscribe()
    s.register(public.id, sub)
    s.unregister(public.id, sub)
    await s.revoke(public.id)
    assert office.bus.subscriber_count == 1
    sub.close()


async def test_registering_on_a_session_that_isnt_live_ends_the_stream(office, hq):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    await s.revoke(public.id)
    for sid in (public.id, "unknown"):
        sub = office.bus.subscribe()
        s.register(sid, sub)
        assert await sub.next(timeout=1) is None and not s.alive(sid)


async def test_alive_turns_false_at_expiry(office, hq):
    clock = Clock()
    s = sessions_for(office, clock)
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    clock.now = T0 + TTL
    assert not s.alive(public.id)


async def test_still_valid_rechecks_the_person_at_a_new_sha(office, hq, company):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    assert await s.still_valid(public.id, office.git.head())
    hand_edit(company, "ngocbh", password_hash=hash_password("changed it"))
    assert not await s.still_valid(public.id, office.git.head())
    assert office.store.get_hq_session(public.id) is None and not s.alive(public.id)


async def test_still_valid_is_false_for_a_session_that_isnt_live(office, hq):
    s = sessions_for(office, Clock())
    assert not await s.still_valid("unknown", office.git.head())


async def test_still_valid_refuses_without_ending_while_the_persons_file_cant_be_read(office, hq, company):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    hand_edit(company, "ngocbh", kind="robot")
    assert not await s.still_valid(public.id, office.git.head())
    assert office.store.get_hq_session(public.id) is not None and s.alive(public.id)


async def test_a_revoke_during_the_fingerprint_load_wins_over_a_match(office, hq, company, monkeypatch):
    s = sessions_for(office, Clock())
    public, _ = await s.issue("ngocbh", issued_by="ngocbh", label=None)
    hand_edit(company, "ngocbh", title="Boss")  # a new commit, whose fingerprints aren't loaded yet
    entered, gate = threading.Event(), threading.Event()
    real = sessions_module.password_fps

    def gated(git, sha):
        entered.set()
        gate.wait(5)
        return real(git, sha)

    monkeypatch.setattr(sessions_module, "password_fps", gated)
    checking = asyncio.create_task(s.still_valid(public.id, office.git.read_head()))
    assert await asyncio.to_thread(entered.wait, 5)
    await s.revoke(public.id)
    gate.set()
    assert await checking is False
