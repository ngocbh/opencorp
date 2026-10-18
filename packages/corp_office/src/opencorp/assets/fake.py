"""The ``fake`` asset kind, for tests and demos: ``echo`` returns its text."""

from collections.abc import Mapping
from typing import Any

from opencorp.assets.registry import KindTool
from opencorp.protocol.models import Asset


def echo(asset: Asset, args: dict[str, Any], secrets: Mapping[str, str]) -> str:
    """Return ``text`` unchanged."""
    return args["text"]


TOOLS = {
    "echo": KindTool(
        echo,
        description="Echo the text back.",
        parameters={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    ),
}
