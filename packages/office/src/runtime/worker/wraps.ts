/** The tool modules' tools a granted flow's own steps call: what the office's gate weighs before an agent's call of
 *  the flow runs, since those steps run ungated. */
import type { ComposedFlow } from "@ngocbh/yian"
import { staticNodes, staticPathOf } from "@ngocbh/yian/run"
import type { ModuleTool } from "./rpc.ts"

/**
 * The module tools the flow tool `tool`, which the agent at node `node` of `flow` granted, calls with its own steps: a
 * `call:`, `map` or `loop` of one, in it and in the flows it calls in turn, each once, in the order they are written.
 * An agent inside it is left out, as its model's calls are gated on their own. Null when they can't be read: the flow
 * tool's nodes aren't found, or yian can't say which tool a step calls.
 *
 * It reads yian's static graph (`staticNodes`): a flow tool's nodes sit under `<agent>/<tool>/`, and a step that calls
 * a module's tool names the module (`toolModules()`) and the tool (`hostToolCall()`).
 */
export function flowModuleTools(flow: ComposedFlow, node: string, tool: string): ModuleTool[] | null {
  try {
    const root = `${staticPathOf(node)}/${tool}/`
    const inside = staticNodes(flow).filter(([at]) => at.startsWith(root))
    if (inside.length === 0) return null
    const agents = inside.filter(([, step]) => step.kind === "agent").map(([at]) => `${at}/`)
    const found = new Map<string, ModuleTool>()
    for (const [at, step] of inside) {
      if (step.kind === "agent" || agents.some((agent) => at.startsWith(agent))) continue
      for (const module of step.toolModules()) {
        // A one-export alias names its export in its ref (`./tools.ts:quote`); a group's call names the tool.
        const colon = module.ref.indexOf(":")
        const name = colon >= 0 ? module.ref.slice(colon + 1).trim() : step.hostToolCall()?.toolId
        if (name === undefined || name === "") return null
        found.set(`${module.alias}\0${name}`, { alias: module.alias, export: name })
      }
    }
    return [...found.values()]
  } catch {
    return null
  }
}
