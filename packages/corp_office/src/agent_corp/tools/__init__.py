"""Host tools for composer runs: the office's tool groups, built from what the run can offer, and the tools in their
modules."""

from collections.abc import Callable, Iterable
from typing import Any

from agent_corp.tools import company, toolbox, work_items, workspace
from agent_corp.tools.context import ToolContext

__all__ = ["ToolContext", "build"]

_GROUPS: dict[str, Callable[[ToolContext], dict[str, Any]]] = {
    "toolbox": toolbox.tools,
    "workspace": workspace.tools,
    "company": company.tools,
    "work_items": work_items.tools,
}
"""Each tool group's ``tools(ctx) -> {tool name: tool}``, by group name."""


def build(names: Iterable[str], ctx: ToolContext) -> dict[str, dict[str, Any]]:
    """``{group: {tool name: tool}}`` for each group in ``names``, in that order: a ``RunSpec``'s groups.

    A group has the tools ``ctx`` can support; a group it supports none of is there
    empty, so a flow that grants it still loads.

    Raises:
        ValueError: a name is not a tool group.
    """
    groups: dict[str, dict[str, Any]] = {}
    for name in names:
        if name not in _GROUPS:
            raise ValueError(f"unknown tool group {name!r}")
        groups[name] = _GROUPS[name](ctx)
    return groups
