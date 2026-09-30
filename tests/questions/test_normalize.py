"""The options normalizer: composer's label cleaning, then dropping the card's own action labels."""

import pytest
from agent_composer.tools.registry import _normalize_options

from agent_corp.questions.normalize import _labels, normalize_options

CASES = [
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
]


@pytest.mark.parametrize(("value", "expected"), CASES)
def test_labels_are_parsed_squeezed_cut_deduplicated_and_at_most_six(value, expected):
    assert normalize_options(value) == expected


@pytest.mark.parametrize("value", [value for value, _ in CASES])
def test_labels_match_composers_cleaning(value):
    # The office copies composer's private cleaning; this catches the two drifting apart.
    assert _labels(value) == (_normalize_options(value) or [])


def test_action_labels_are_dropped():
    got = normalize_options(["Type an answer", "chat about this", "SEND DISCUSSION BACK", "Stop", "Keep going"])
    assert got == ["Keep going"]


def test_stop_the_asker_is_dropped_but_other_stops_stay():
    got = normalize_options(["Stop minh", "Stop Minh Tran", "Stop the deploy"], names=("minh", "Minh Tran"))
    assert got == ["Stop the deploy"]


@pytest.mark.parametrize("label", ["Stop.", "Stop!", "Chat about this?", "Type an answer…", "Ｓｔｏｐ", "St\u200bop",
                                   "Send discussion-back", "\u201cStop\u201d", "Stop, minh", "stop\u00a0MINH"])
def test_action_labels_match_through_punctuation_width_and_invisible_characters(label):
    assert normalize_options([label, "Keep going"], names=("minh",)) == ["Keep going"]


@pytest.mark.parametrize("label", ["Stopwatch", "Stop the deploy", "Stop minh's job", "Chat about that"])
def test_labels_that_only_look_like_actions_stay(label):
    assert normalize_options([label], names=("minh",)) == [label]


def test_the_six_are_kept_before_action_labels_are_dropped():
    # composer has already cut a model ask_user's options to six; the office does the same.
    labels = ["Chat about this", *(f"o{i}" for i in range(6))]
    assert normalize_options(labels) == ["o0", "o1", "o2", "o3", "o4"]
