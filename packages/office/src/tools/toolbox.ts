/** The toolbox tool group: the asset tools the run's person holds grants for (the grants are perm/monitor's). */
import type { ToolboxTool } from "../perm/monitor.ts"
import type { ToolContext } from "./context.ts"

/** `ctx.monitor`'s asset tools for `ctx.session`'s person in run `ctx.runId`; none without a monitor and session. */
export function tools(ctx: ToolContext): Record<string, ToolboxTool> {
  if (ctx.monitor === undefined || ctx.session === undefined) return {}
  return ctx.monitor.tools(ctx.session.person, { runId: ctx.runId ?? null, sessionId: ctx.session.id })
}
