/** The Codex tool group as the model sees it (group `codex`: `codex_start` and the rest), a harness instrument's group
 *  (`../harness/tools.ts`) in Codex's words; and how Codex's tool parts read in its trace. */
import type { ToolPart } from "@opencorp/protocol"
import { outputText } from "../harness/record.ts"
import * as harness from "../harness/tools.ts"
import { COMMAND, FILE_CHANGE, MCP_TOOL } from "./translate.ts"

export { TOOLS, type ToolName, refusalText, type ReplyStatus, type Entry } from "../harness/tools.ts"

/** Codex, as its tool group, instrument and record name it. */
export const CODEX: harness.Harness = {
  kind: "codex",
  title: "Codex",
  traced: "each command with its output, each file change with its diff, and each error",
  toolText,
}

/** The five tools' descriptions and parameters. */
export function toolSpecs(): ReturnType<typeof harness.toolSpecs> {
  return harness.toolSpecs(CODEX)
}

/** `tool`'s arguments read, or why they can't be (`harness.parseArgs`); the session is named `codex`. */
export function parseArgs(tool: harness.ToolName, args: Record<string, unknown>): harness.Parsed | string {
  return harness.parseArgs(CODEX, tool, args)
}

/** `reply` as the model reads it: one JSON object naming its session `codex`. */
export function replyText(reply: harness.Reply): string {
  return harness.replyText(CODEX, reply)
}

/** A Codex tool part as the trace shows it: what Codex ran and what came of it. */
function toolText(part: ToolPart): string {
  const input = part.input as Record<string, any>
  const state = part.state === "completed" ? "" : ` (${part.state}${part.error ? `: ${part.error}` : ""})`
  if (part.tool === COMMAND) {
    const exit = input.exit_code == null ? "" : ` (exit ${input.exit_code})`
    return `[command${state}] $ ${input.command}${exit}\n${outputText(part.output)}`.trimEnd()
  }
  if (part.tool === FILE_CHANGE) {
    const changes: Record<string, any>[] = Array.isArray(input.changes) ? input.changes : []
    return changes
      .map((c) => `[file change${state}] ${c.path}${c.move_path ? ` → ${c.move_path}` : ""} (${c.kind})\n${c.diff ?? ""}`)
      .join("\n")
      .trimEnd()
  }
  if (part.tool === MCP_TOOL) {
    const call = `${input.server}/${input.tool} ${JSON.stringify(input.arguments ?? null)}`
    return `[mcp${state}] ${call}\n${outputText(part.output)}`.trimEnd()
  }
  return `[${part.tool}${state}] ${JSON.stringify(input)}`
}
