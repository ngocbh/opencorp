"""The company tool group: tools every person has."""

from collections.abc import Callable

from agent_corp.tools.company import work
from agent_corp.tools.context import ToolContext


def tools(ctx: ToolContext) -> dict[str, Callable[..., str]]:
    """The ``company`` group: each company topic's tools that ``ctx`` can support."""
    return {**work.tools(ctx)}
