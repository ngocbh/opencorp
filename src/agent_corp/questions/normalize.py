"""Clean the options a model sends with a question."""

import json
import unicodedata
from collections.abc import Iterable
from typing import Any

MAX_OPTIONS = 6
MAX_OPTION_CHARS = 80

# The card's own controls; a model option with one of these labels would look like one.
ACTION_LABELS = ("type an answer", "chat about this", "send discussion back", "stop")


def normalize_options(value: Any, *, names: Iterable[str] = ()) -> list[str]:
    """Return the option labels a card shows for a model's ``options`` argument.

    Any shape is accepted and none raises: a JSON list string is parsed, other strings
    are one label, non-string items are dropped, labels are squeezed to one line, cut to
    80 characters, deduplicated case-insensitively, and at most six are kept. Then labels
    matching a card action, or ``Stop <name>`` for one of the asker's ``names``, are
    dropped, compared by ``_key``.
    """
    actions = {*map(_key, ACTION_LABELS), *(_key(f"stop {name}") for name in names)}
    return [label for label in _labels(value) if _key(label) not in actions]


def _key(label: str) -> str:
    """``label`` for comparing with an action.

    NFKC-normalized, punctuation as spaces, invisible format characters removed, spaces
    collapsed, and casefolded.
    """
    kept = []
    for char in unicodedata.normalize("NFKC", label):
        category = unicodedata.category(char)
        if category == "Cf":
            continue
        kept.append(" " if category.startswith("P") else char)
    return " ".join("".join(kept).split()).casefold()


def _labels(value: Any) -> list[str]:
    # Mirrors agent_composer.tools.registry._normalize_options, which cleans a model's ask_user options.
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        value = parsed if isinstance(parsed, list) else [value]
    if not isinstance(value, list):
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        label = " ".join(item.split())
        if len(label) > MAX_OPTION_CHARS:
            label = label[: MAX_OPTION_CHARS - 1] + "…"
        if not label or label.casefold() in seen:
            continue
        seen.add(label.casefold())
        labels.append(label)
        if len(labels) == MAX_OPTIONS:
            break
    return labels
