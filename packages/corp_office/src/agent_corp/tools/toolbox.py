"""The toolbox tool group: the asset tools the run's person holds grants for (the grants are perm.monitor's)."""

from typing import Any

from agent_corp.tools.context import ToolContext


def tools(ctx: ToolContext) -> dict[str, Any]:
    """``ctx.monitor``'s asset tools for ``ctx.session``'s person in run ``ctx.run_id``; none without a monitor and session."""
    if ctx.monitor is None or ctx.session is None:
        return {}
    return dict(ctx.monitor.tools(ctx.session.person, run_id=ctx.run_id, session_id=ctx.session.id))
