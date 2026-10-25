/** Host tools for runs: the office's tool groups, built from what the run can offer. */
import { repr } from "../perm/redact.ts"
import type { OfficeTool } from "../worker/rpc.ts"
import * as work from "./company/work.ts"
import type { ToolContext } from "./context.ts"
import * as toolbox from "./toolbox.ts"
import * as workItems from "./work_items.ts"
import * as workspace from "./workspace.ts"

export type { ToolContext } from "./context.ts"

/** Each tool group's `tools(ctx)`, by group name. */
const GROUPS: Record<string, (ctx: ToolContext) => Record<string, OfficeTool>> = {
  toolbox: toolbox.tools,
  workspace: workspace.tools,
  // The company group is the company topics' tools; only work has a group.
  company: work.tools,
  work_items: workItems.tools,
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
