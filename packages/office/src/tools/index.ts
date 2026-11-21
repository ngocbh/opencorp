/** Host tools for runs: the office's tool groups, built from what the run can offer. */
import { repr } from "../util/redact.ts"
import type { OfficeTool } from "../runtime/worker/rpc.ts"
import * as work from "./work.ts"
import type { ToolContext } from "./context.ts"
import * as toolbox from "./toolbox.ts"
import * as workItems from "./work_items.ts"
import * as workspace from "./workspace.ts"
import type { TerminalTool } from "./terminal/terminal.ts"

export type { ToolContext } from "./context.ts"

/** Each tool group's `tools(ctx)`, by group name. */
const GROUPS: Record<string, (ctx: ToolContext) => Record<string, OfficeTool>> = {
  toolbox: toolbox.tools,
  workspace: workspace.tools,
  terminal,
  codex,
  claude,
  // The company group is its topics' tools; only work's are in it (draft's are in no group).
  company: work.tools,
  work_items: workItems.tools,
}

/** The `terminal` group: the session's shells (`run`, `type`, `read`, `interrupt`, `close`, which a model calls
 *  `terminal_run` and so on), as its host bound them; none without a terminal. */
function terminal(ctx: ToolContext): Record<string, TerminalTool> {
  return ctx.terminal ? ctx.terminal.tools() : {}
}

/** The `codex` group: the session's Codex instrument (`start`, `send`, `interrupt`, `stop`, `history`, which a model
 *  calls `codex_start` and so on), as its host bound it; none without one. */
function codex(ctx: ToolContext): Record<string, OfficeTool> {
  return ctx.codex ? ctx.codex.tools() : {}
}

/** The `claude` group: the session's Claude Code instrument (`start`, `send`, `interrupt`, `stop`, `history`, which a
 *  model calls `claude_start` and so on), as its host bound it; none without one. */
function claude(ctx: ToolContext): Record<string, OfficeTool> {
  return ctx.claude ? ctx.claude.tools() : {}
}

/**
 * `{group: {tool name: tool}}` for each group in `names`, in that order: a run's groups.
 *
 * A group has the tools `ctx` can support; a group it supports none of is there empty, so a flow that grants it
 * still loads. Throws `RangeError` when a name is not a tool group.
 */
export function build(names: Iterable<string>, ctx: ToolContext): Record<string, Record<string, OfficeTool>> {
  const groups: Record<string, Record<string, OfficeTool>> = {}
  for (const name of names) {
    if (!Object.hasOwn(GROUPS, name)) throw new RangeError(`unknown tool group ${repr(name)}`)
    groups[name] = GROUPS[name]!(ctx)
  }
  return groups
}
