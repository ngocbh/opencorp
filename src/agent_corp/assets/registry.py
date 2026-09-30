"""The asset-kind registry: for each ``Asset.kind``, the tools it implements."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from agent_corp.protocol.models import Asset


@dataclass(frozen=True)
class KindTool:
    """One tool of an asset kind.

    ``run(asset, args, secrets)`` executes a call in the office and returns JSON data.
    ``secrets`` maps each of ``asset.secrets`` to its value. What ``run`` raises becomes
    an ``error:`` result.
    """

    run: Callable[[Asset, dict[str, Any], Mapping[str, str]], Any]
    description: str = ""
    parameters: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})


Kinds = Mapping[str, Mapping[str, KindTool]]
"""``{asset kind: {tool name: KindTool}}``."""


def builtin_kinds() -> dict[str, dict[str, KindTool]]:
    """The asset kinds that ship with the office."""
    from agent_corp.assets import fake

    return {"fake": fake.TOOLS}
