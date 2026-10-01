"""Device tokens: their format, the bearer header, and the hash table built from people at HEAD."""

import hashlib
import re
import time

import pytest
import yaml

from agent_corp.auth.roster import Roster, load_roster
from agent_corp.auth.tokens import AuthError, authenticate, new_token, token_sha256
from agent_corp.company.git import CompanyGit
from agent_corp.protocol.models import Device, Person
from tests.company.conftest import _git, company  # noqa: F401


def human(handle: str, *devices: tuple[str, str], kind: str = "human") -> Person:
    return Person(handle=handle, name=handle, kind=kind, title="T", manager=None,
                  devices=[Device(name=n, token_sha256=h) for n, h in devices])


def roster(*people: Person, ceo: str = "ngocbh") -> Roster:
    return Roster.of("h", ceo, people)


def test_a_token_is_act_and_32_random_bytes_in_base64url():
    tokens = {new_token() for _ in range(100)}
    assert len(tokens) == 100
    assert all(re.fullmatch(r"act_[A-Za-z0-9_-]{43}", t) for t in tokens)


def test_the_hash_is_the_hex_sha256_of_the_whole_token():
    token = new_token()
    assert token_sha256(token) == hashlib.sha256(token.encode()).hexdigest()


def test_a_known_token_acts_as_its_person_and_device():
    token = new_token()
    r = roster(human("ngocbh", ("mac", token_sha256(token))))
    assert authenticate(f"Bearer {token}", r) == ("ngocbh", "mac")
    assert authenticate(f"bearer  {token}", r) == ("ngocbh", "mac")  # the scheme is case-insensitive


def test_an_unknown_token_is_a_bad_token():
    r = roster(human("ngocbh", ("mac", token_sha256(new_token()))))
    with pytest.raises(AuthError) as exc:
        authenticate(f"Bearer {new_token()}", r)
    assert exc.value.code == "bad_token"


@pytest.mark.parametrize("header", ["", "Bearer", "Bearer ", "Basic abc", "Token act_x", "Bearer act_short",
                                    "Bearer " + "x" * 47, "act_" + "a" * 43])
def test_a_malformed_header_is_a_bad_token(header):
    with pytest.raises(AuthError) as exc:
        authenticate(header, roster())
    assert exc.value.code == "bad_token"


def test_errors_never_contain_the_token():
    token = new_token()
    for header in (f"Bearer {token}", f"Bearer {token}x", f"Basic {token}"):
        with pytest.raises(AuthError) as exc:
            authenticate(header, roster())
        assert token not in str(exc.value) and token not in exc.value.message


def test_no_header_is_unauthenticated():
    with pytest.raises(AuthError) as exc:
        authenticate(None, roster())
    assert exc.value.code == "unauthenticated"


def test_agents_devices_are_ignored():
    token = new_token()
    r = roster(human("minh", ("box", token_sha256(token)), kind="agent"))
    assert not r.enforced
    with pytest.raises(AuthError):
        authenticate(f"Bearer {token}", r)


def test_a_hash_listed_by_two_people_is_left_out():
    shared, own = new_token(), new_token()
    r = roster(human("ngocbh", ("mac", token_sha256(shared))),
               human("ava", ("mac", token_sha256(shared)), ("pc", token_sha256(own))))
    with pytest.raises(AuthError):
        authenticate(f"Bearer {shared}", r)
    assert authenticate(f"Bearer {own}", r) == ("ava", "pc")
    assert r.enforced


def test_enforced_once_any_human_has_a_device():
    assert not roster(human("ngocbh")).enforced
    assert roster(human("ngocbh"), human("ava", ("pc", token_sha256(new_token())))).enforced


def test_the_roster_is_read_at_a_commit(company):
    git = CompanyGit(company, company.parent / "wt")
    token = new_token()
    path = company / "people/ngocbh/person.yaml"
    data = yaml.safe_load(path.read_text())
    data["devices"] = [{"name": "mac", "token_sha256": token_sha256(token)}]
    path.write_text(yaml.safe_dump(data))
    before = load_roster(git, git.read_head())
    assert (before.ceo, before.enforced) == ("ngocbh", False)  # the edit isn't committed
    _git(company, "commit", "-qam", "device")
    after = load_roster(git, git.read_head())
    assert after.head == git.head() and after.enforced
    assert authenticate(f"Bearer {token}", after) == ("ngocbh", "mac")


def test_a_broken_person_file_lets_no_one_in_through_it(company):
    git = CompanyGit(company, company.parent / "wt")
    (company / "people/ngocbh/person.yaml").write_text("handle: [")
    _git(company, "commit", "-qam", "break")
    r = load_roster(git, git.read_head())
    assert (r.ceo, r.tokens) == ("ngocbh", {})


def test_checking_a_token_takes_well_under_a_millisecond():
    tokens = [new_token() for _ in range(50)]
    r = roster(human("ngocbh", *((f"d{i}", token_sha256(t)) for i, t in enumerate(tokens))))
    headers = [f"Bearer {t}" for t in tokens] * 20
    start = time.perf_counter()
    for header in headers:
        authenticate(header, r)
    assert (time.perf_counter() - start) / len(headers) < 50e-6
