import pytest

from agent_corp.auth.passwords import MIN_LENGTH, check_password, hash_password, password_problem
from agent_corp.protocol.models import Person


def test_a_hash_checks_its_password_and_no_other():
    phc = hash_password("correct horse")
    assert phc.startswith("$scrypt$ln=15,r=8,p=1$") and "correct horse" not in phc
    assert check_password("correct horse", phc)
    assert not check_password("correct hors", phc) and not check_password("", phc)


def test_each_hash_has_its_own_salt():
    assert hash_password("same password") != hash_password("same password")


def test_a_hash_fits_the_protocol():
    Person(handle="me", name="Me", kind="human", title="CEO", manager=None, password_hash=hash_password("12345678"))


@pytest.mark.parametrize("phc", [None, "", "plain", "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
                                 "$scrypt$ln=15,r=8,p=1$c2FsdA", "$scrypt$ln=15,r=8,p=1$!!!$aGFzaA",
                                 "$scrypt$ln=30,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
                                 "$scrypt$ln=15,r=8,p=500$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA",
                                 "$scrypt$ln=15,r=4096,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA"])
def test_an_unknown_or_unreasonable_hash_checks_nothing(phc):
    # A hash comes from the company repo, so it can't make the office spend unbounded time or memory.
    assert not check_password("anything", phc)


def test_a_password_needs_a_minimum_length():
    assert password_problem("a" * (MIN_LENGTH - 1)) == f"use at least {MIN_LENGTH} characters"
    assert password_problem("a" * MIN_LENGTH) is None
