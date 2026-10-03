"""Naming rules: person handles."""

from agent_corp.company.naming import handle_problem


def test_a_good_handle_has_no_problem():
    assert handle_problem("minh-anh") is None


def test_a_bad_handle_says_why():
    assert "pattern" in handle_problem("Hong Ngoc")
