import pytest

from opencorp.protocol.models import Question
from opencorp.questions.checker import InvalidAnswer, check_answer

T = "2026-09-30T00:00:00.000Z"


def q(source="human_input", **fields):
    return Question.model_validate({"id": "01J0000000000000000000000Q", "session_id": "01J0000000000000000000000S",
                                    "run_id": "r1", "node_id": None if source != "human_input" else "gate",
                                    "source": source, "asker": "minh", "question": "Which?", "status": "open",
                                    "created_at": T, "updated_at": T, **fields})


PAGES = [{"question": "Which database?", "header": "db", "options": [{"label": "Postgres"}, {"label": "SQLite"}]},
         {"question": "Which features?", "header": "features", "multi_select": True,
          "options": [{"label": "auth"}, {"label": "search"}]}]


def fields(*entries):
    return [dict(zip(("name", "type", "required"), e[:3]), **(e[3] if len(e) > 3 else {})) for e in entries]


def test_a_model_question_takes_text_and_checks_options():
    ask = q("ask_user", options=["A", "B"])
    assert check_answer(ask, "B", "option") == "B"
    assert check_answer(ask, "Neither, C", "text") == "Neither, C"
    for answer, kind in [("C", "option"), ("", "text"), ({"a": 1}, "text")]:
        with pytest.raises(InvalidAnswer):
            check_answer(ask, answer, kind)


def test_office_answers_pass_unchanged():
    assert check_answer(q("ask_manager"), None, "sent_back") is None
    assert check_answer(q(questions=PAGES), "[interrupted by the user]", "interrupted") == "[interrupted by the user]"


def test_pages_take_a_record_keyed_by_header():
    gate = q(questions=PAGES)
    answer = {"db": "Postgres", "features": ["auth", "graphs, typed"]}
    assert check_answer(gate, answer, "text") == answer
    assert check_answer(gate, {"db": "MySQL, typed", "features": []}, "text") == {"db": "MySQL, typed",
                                                                                 "features": []}


@pytest.mark.parametrize(("answer", "message"), [
    ("Postgres", "a record"),
    ({"db": "Postgres"}, "'features' has no answer"),
    ({"db": "Postgres", "features": "auth"}, "'features' takes a list of labels"),
    ({"db": ["Postgres"], "features": []}, "'db' takes one label"),
    ({"db": " ", "features": []}, "'db' takes one label"),
    ({"db": "Postgres", "features": [], "extra": "x"}, "no question has the header 'extra'"),
])
def test_pages_refuse_other_shapes(answer, message):
    with pytest.raises(InvalidAnswer, match=message):
        check_answer(q(questions=PAGES), answer, "option")


def test_an_enum_in_the_schema_hides_free_text_on_its_page():
    gate = q(questions=PAGES, answer_schema=fields(("db", "str", True, {"enum": ["Postgres", "SQLite"]}),
                                                   ("features", "list[str]", True)))
    assert check_answer(gate, {"db": "SQLite", "features": ["x"]}, "option") == {"db": "SQLite", "features": ["x"]}
    with pytest.raises(InvalidAnswer, match="'db' must be one of"):
        check_answer(gate, {"db": "MySQL", "features": []}, "text")


def test_a_schema_entry_types_its_page():
    gate = q(questions=PAGES, answer_schema=fields(("db", "str", True), ("features", "str", True)))
    with pytest.raises(InvalidAnswer, match="'features' must be text"):
        check_answer(gate, {"db": "SQLite", "features": ["auth"]}, "option")
    counted = q(questions=[{"question": "How many?", "header": "n", "options": [{"label": "3"}]}],
                answer_schema=fields(("n", "int", True)))
    assert check_answer(counted, {"n": "3"}, "option") == {"n": 3}


def page(multi=False, **entry):
    """A one-page gate whose ``p`` page has the schema entry ``entry``."""
    return q(questions=[{"question": "Which?", "header": "p", "multi_select": multi,
                         "options": [{"label": "3"}, {"label": "yes"}]}],
             answer_schema=[{"name": "p", "required": True, **entry}])


@pytest.mark.parametrize(("multi", "entry", "label", "value"), [
    (False, {"type": "int"}, "3", 3),
    (False, {"type": "float"}, "3", 3.0),
    (False, {"type": "bool"}, "yes", True),
    (False, {"type": "date"}, "2026-09-30", "2026-09-30"),
    (False, {"type": "str", "enum": ["fast", "safe"]}, "safe", "safe"),
    (False, {"type": "list[str]"}, "a", ["a"]),
    (True, {"type": "list[str]", "enum": ["x", "y"]}, ["y", "x"], ["y", "x"]),
    (True, {"type": "list[int]"}, ["3", "5"], [3, 5]),
    (False, {"type": "None"}, "", None),
])
def test_a_typed_page_answer_converts_to_itself(multi, entry, label, value):
    gate = page(multi, **entry)
    assert check_answer(gate, {"p": label}, "option") == {"p": value}
    assert check_answer(gate, {"p": value}, "option") == {"p": value}  # the harness checks the stored value again


@pytest.mark.parametrize(("multi", "entry", "answer", "message"), [
    (False, {"type": "int"}, " ", "'p' has no answer"),
    (False, {"type": "int"}, "three", "'p' must be a whole number"),
    (False, {"type": "str", "enum": ["fast", "safe"]}, ["safe"], "'p' must be one of"),
    (True, {"type": "list[str]", "enum": ["x", "y"]}, ["z"], r"'p'\[0\] must be one of"),
])
def test_a_typed_page_refuses_what_its_entry_refuses(multi, entry, answer, message):
    with pytest.raises(InvalidAnswer, match=message):
        check_answer(page(multi, **entry), {"p": answer}, "option")


def test_a_prompt_gate_without_a_schema_takes_text():
    assert check_answer(q(), "go ahead", "text") == "go ahead"
    with pytest.raises(InvalidAnswer):
        check_answer(q(), 3, "text")


@pytest.mark.parametrize(("entry", "answer", "value"), [
    (("answer", "bool", True), "Yes", True),
    (("answer", "bool", True), False, False),
    (("answer", "str", True, {"enum": ["high", "low"]}), "low", "low"),
    (("answer", "list[str]", True, {"enum": ["a", "b"]}), ["b"], ["b"]),
    (("answer", "str", True), "  spaced  ", "  spaced  "),
    (("answer", "int", True), " 12 ", 12),
    (("answer", "float", True), "2.5", 2.5),
    (("answer", "float", True), 3, 3.0),
    (("answer", "date", True), "2026-09-30", "2026-09-30"),
    (("answer", "datetime", True), "2026-09-30T10:00:00+07:00", "2026-09-30T10:00:00+07:00"),
    (("answer", "list[int]", True), "1\n\n2\n", [1, 2]),
    (("answer", "list[str]", True), ["x", "y"], ["x", "y"]),
    (("answer", "int", False), "", None),
    (("answer", "str", False), "  ", None),
    (("answer", "str", False), None, None),
    (("answer", "object", True), '{"k": 1}', {"k": 1}),
])
def test_a_single_answer_is_converted_to_its_type(entry, answer, value):
    gate = q(answer_schema=fields(entry))
    assert check_answer(gate, answer, "text") == value
    assert check_answer(gate, value, "text") == value  # a converted value converts to itself


@pytest.mark.parametrize(("entry", "answer", "message"), [
    (("answer", "bool", True), "maybe", "yes or no"),
    (("answer", "str", True, {"enum": ["high", "low"]}), "medium", "must be one of"),
    (("answer", "int", True), "1.5", "a whole number"),
    (("answer", "int", True), True, "a whole number"),
    (("answer", "int", True), 2.0, "a whole number"),
    (("answer", "float", True), "nan", "a number"),
    (("answer", "date", True), "30/09/2026", "ISO-8601 date"),
    (("answer", "int", True), "", "is required"),
    (("answer", "str", True), "", "is required"),
    (("answer", "str", True), " \n ", "is required"),
    (("answer", "list[int]", True), "1\ntwo", r"answer\[1\] must be a whole number"),
    (("answer", "file", True), "x", "can't answer|cannot answer"),
])
def test_a_single_answer_that_does_not_fit_is_refused(entry, answer, message):
    with pytest.raises(InvalidAnswer, match=message):
        check_answer(q(answer_schema=fields(entry)), answer, "text")


def test_a_record_gate_converts_each_field_and_omits_blank_optional_ones():
    gate = q(answer_schema=fields(("days", "int", True), ("note", "str", False),
                                  ("who", "object", True, {"fields": fields(("name", "str", True))})))
    assert check_answer(gate, {"days": "3", "note": "", "who": {"name": "Ava"}}, "text") == {
        "days": 3, "who": {"name": "Ava"}}
    assert check_answer(gate, '{"days": 4, "who": {"name": "Bo"}}', "text") == {"days": 4, "who": {"name": "Bo"}}
    for answer, message in [({"note": "x", "who": {"name": "A"}}, r"answer.days is required"),
                            ({"days": 1, "who": {"name": "A"}, "zzz": 1}, "no field 'zzz'"),
                            ({"days": 1, "who": {}}, r"answer.who.name is required"),
                            ({"days": 1, "who": {"name": "  "}}, r"answer.who.name is required")]:
        with pytest.raises(InvalidAnswer, match=message):
            check_answer(gate, answer, "text")


def test_a_required_none_field_in_a_record_takes_blank():
    gate = q(answer_schema=fields(("done", "None", True), ("note", "str", False)))
    assert check_answer(gate, {"done": None}, "text") == {"done": None}
    assert check_answer(gate, {"done": ""}, "text") == {"done": None}
    with pytest.raises(InvalidAnswer, match=r"answer.done must be empty"):
        check_answer(gate, {"done": "x"}, "text")


def test_a_harness_approval_takes_one_of_its_options_only():
    card = q("harness", options=["Approve", "Deny and stop"])
    assert check_answer(card, "Approve", "option") == "Approve"
    # The office's own answers never reach Codex either: it waits on the reply an answer makes.
    for answer, kind in [("Approve", "text"), ("yes please", "text"), ("Maybe", "option"),
                         ("Approve", "interrupted"), ("", "sent_back")]:
        with pytest.raises(InvalidAnswer):
            check_answer(card, answer, kind)


def test_a_harness_card_with_pages_takes_a_record_with_typed_numbers():
    pages = [{"question": "Token?", "header": "Token", "options": [], "secret": True},
             {"question": "Env?", "header": "Env", "options": [{"label": "prod"}, {"label": "dev"}]},
             {"question": "Points?", "header": "points", "options": []}]
    card = q("harness", questions=pages, answer_schema=fields(("Env", "str", True, {"enum": ["prod", "dev"]}),
                                                              ("points", "int", True)))
    assert check_answer(card, {"Token": "s3cret", "Env": "dev", "points": "3"}, "text") == {
        "Token": "s3cret", "Env": "dev", "points": 3}
    for bad in ({"Token": "s3cret", "Env": "staging", "points": "3"}, {"Token": "s3cret", "Env": "dev", "points": "x"}):
        with pytest.raises(InvalidAnswer):
            check_answer(card, bad, "text")
    with pytest.raises(InvalidAnswer):
        check_answer(card, {"Token": "s3cret", "Env": "dev", "points": "3"}, "interrupted")
