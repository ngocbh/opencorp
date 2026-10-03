"""Tools for working with the company. Its ``tools(ctx)`` is the office's ``company`` group, which every person has;
``draft`` holds tools for drafting a new company, which no group has."""

from collections.abc import Callable

from agent_corp.tools.company import work
from agent_corp.tools.context import ToolContext


def tools(ctx: ToolContext) -> dict[str, Callable[..., str]]:
    """The ``company`` group: each company topic's tools that ``ctx`` can support."""
    return {**work.tools(ctx)}
