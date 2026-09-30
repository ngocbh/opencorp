"""The options normalizer: question-card §7.3 rules, then the office's action labels."""

import pytest

from agent_corp.questions.normalize import normalize_options


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, []),
        (["A", "B"], ["A", "B"]),
        ('["A","B"]', ["A", "B"]),
        ('["A", 2]', ["A"]),
        ("A, B", ["A, B"]),
        ("[broken", ["[broken"]),
        (["A", 3, None, {"label": "x"}], ["A"]),
        ({"label": "x"}, []),
        (42, []),
        ([], []),
        (["  two\n  lines ", "", "   "], ["two lines"]),
        (["Yes", "yes", "YES", "No"], ["Yes", "No"]),
        ([str(i) for i in range(9)], ["0", "1", "2", "3", "4", "5"]),
        (["x" * 100], ["x" * 79 + "…"]),
    ],
)
def test_section_7_3_rules(value, expected):
    assert normalize_options(value) == expected


def test_action_labels_are_dropped():
    got = normalize_options(["Type an answer", "chat about this", "SEND DISCUSSION BACK", "Stop", "Keep going"])
    assert got == ["Keep going"]


def test_stop_the_asker_is_dropped_but_other_stops_stay():
    got = normalize_options(["Stop minh", "Stop Minh Tran", "Stop the deploy"], names=("minh", "Minh Tran"))
    assert got == ["Stop the deploy"]


def test_the_six_are_kept_before_action_labels_are_dropped():
    # composer has already cut a model ask_user's options to six; the office does the same.
    labels = ["Chat about this", *(f"o{i}" for i in range(6))]
    assert normalize_options(labels) == ["o0", "o1", "o2", "o3", "o4"]
