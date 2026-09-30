"""Check an answer against its question, and convert typed text to the value a ``human_input`` node takes."""

import json
import math
from datetime import date, datetime
from typing import Any

from agent_corp.protocol.models import AnswerField, Question

_TRUE = {"true", "yes", "y"}
_FALSE = {"false", "no", "n"}


class InvalidAnswer(ValueError):
    """The answer doesn't fit the question; the message says why, for the person answering."""


def check_answer(question: Question, answer: Any, kind: str) -> Any:
    """Return the value to store for ``answer`` to ``question``, or raise ``InvalidAnswer``.

    ``sent_back`` and ``interrupted`` answers are the office's own and pass unchanged. A
    model question (``ask_user``, ``ask_manager``) takes text, and an ``option`` answer
    must be one of its options. A ``human_input`` question with pages takes a record
    keyed by each page's ``header``: a label, or a list of labels for a multi-select
    page. One without pages takes what its ``answer_schema`` says; text is converted to
    the field's type (numbers, ISO dates, yes/no, one list item per line). Nothing looser
    than the engine's own check is returned, and a converted value converts to itself.
    """
    if kind in ("sent_back", "interrupted"):
        return answer
    if question.source != "human_input":
        if not isinstance(answer, str) or not answer.strip():
            raise InvalidAnswer("the answer must be text")
        if kind == "option" and answer not in question.options:
            raise InvalidAnswer(f"{answer!r} is not one of the options")
        return answer
    if question.questions:
        return _pages(question, answer)
    schema = question.answer_schema
    if not schema:
        if not isinstance(answer, str):
            raise InvalidAnswer("the answer must be text")
        return answer
    if len(schema) == 1 and schema[0].name == "answer":
        return _field(schema[0], answer, "answer")
    return _record(schema, answer, "answer")


def _pages(question: Question, answer: Any) -> dict[str, Any]:
    if not isinstance(answer, dict):
        raise InvalidAnswer("the answer must be a record with one entry per question header")
    headers = [page.header for page in question.questions]
    if extra := sorted(set(answer) - set(headers)):
        raise InvalidAnswer(f"no question has the header {extra[0]!r}")
    enums = {f.name: f.enum for f in question.answer_schema if f.enum is not None}
    record: dict[str, Any] = {}
    for page in question.questions:
        if page.header not in answer:
            raise InvalidAnswer(f"{page.header!r} has no answer")
        value, allowed = answer[page.header], enums.get(page.header)
        values = value if page.multi_select else [value]
        if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
            shape = "a list of labels" if page.multi_select else "one label"
            raise InvalidAnswer(f"{page.header!r} takes {shape}")
        if not page.multi_select and not values:
            raise InvalidAnswer(f"{page.header!r} takes one label")
        if allowed is not None and (bad := [v for v in values if v not in allowed]):
            raise InvalidAnswer(f"{page.header!r} must be one of {allowed}, not {bad[0]!r}")
        record[page.header] = value
    return record


def _record(fields: list[AnswerField], value: Any, where: str) -> dict[str, Any]:
    if isinstance(value, str):
        value = _json(value)
    if not isinstance(value, dict):
        raise InvalidAnswer(f"{where} must be a record")
    names = {f.name for f in fields}
    if extra := sorted(set(value) - names):
        raise InvalidAnswer(f"{where} has no field {extra[0]!r}")
    record: dict[str, Any] = {}
    for f in fields:
        item = value.get(f.name)
        if _blank(item):
            if f.required:
                raise InvalidAnswer(f"{where}.{f.name} is required")
            continue  # an optional field left blank is omitted
        record[f.name] = _field(f, item, f"{where}.{f.name}")
    return record


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _field(f: AnswerField, value: Any, where: str) -> Any:
    if value is None or (f.type != "str" and _blank(value)):
        if f.required and f.type != "None":
            raise InvalidAnswer(f"{where} is required")
        return None
    if f.type == "None":
        raise InvalidAnswer(f"{where} must be empty")
    if f.type == "object" and f.fields:
        return _record(f.fields, value, where)
    if f.type.startswith("list["):
        # Typed text is one item per line; blank lines are skipped.
        items = [line for line in value.splitlines() if line.strip()] if isinstance(value, str) else value
        if not isinstance(items, list):
            raise InvalidAnswer(f"{where} must be a list")
        return [_scalar(f.type[5:-1], f.enum, item, f"{where}[{n}]") for n, item in enumerate(items)]
    return _scalar(f.type, f.enum, value, where)


def _scalar(kind: str, enum: list[str] | None, value: Any, where: str) -> Any:
    if enum is not None:
        if value not in enum:
            raise InvalidAnswer(f"{where} must be one of {enum}")
        return value
    if kind in ("str", "Any"):
        if kind == "str" and not isinstance(value, str):
            raise InvalidAnswer(f"{where} must be text")
        return value
    if kind == "object":
        if isinstance(value, str):
            value = _json(value)
        if not isinstance(value, dict):
            raise InvalidAnswer(f"{where} must be a record")
        return value
    if isinstance(value, bool):
        if kind == "bool":
            return value
    elif isinstance(value, int) and kind in ("int", "float"):
        return float(value) if kind == "float" else value
    elif isinstance(value, float) and kind == "float" and math.isfinite(value):
        return value
    elif isinstance(value, str):
        parsed = _parse(kind, value.strip())
        if parsed is not None:
            return parsed
    raise InvalidAnswer(f"{where} must be {_EXPECTED.get(kind, f'a {kind}, which a card cannot answer')}")


_EXPECTED = {"bool": "yes or no", "int": "a whole number", "float": "a number",
             "date": "an ISO-8601 date", "datetime": "an ISO-8601 datetime"}


def _parse(kind: str, text: str) -> Any:
    """``text`` as a ``kind`` value, or ``None`` if it isn't one."""
    try:
        if kind == "bool":
            folded = text.casefold()
            return folded in _TRUE if folded in _TRUE | _FALSE else None
        if kind == "int":
            return int(text)
        if kind == "float":
            number = float(text)
            return number if math.isfinite(number) else None
        if kind == "date":
            return date.fromisoformat(text).isoformat()
        if kind == "datetime":
            return datetime.fromisoformat(text).isoformat()
    except ValueError:
        return None
    return None


def _json(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return text
