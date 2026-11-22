/** The Claude Code instrument: one chat's Claude Code sessions, by name, as its host binds them, the harness
 *  instrument (`../harness/instrument.ts`) in Claude Code's words; each session's record in the host's folder for it,
 *  with each tool call Claude Code made, and what came of it, in the trace. */
import type { ToolPart } from "@opencorp/protocol"
import { type HarnessHost, HarnessInstrument } from "../harness/instrument.ts"
import { type RecordFile, markRecordInterrupted, outputText, readRecord } from "../harness/record.ts"
import type { Harness } from "../harness/tools.ts"
import { TOOL_PREFIX } from "./translate.ts"

/** Claude Code, as its tool group (`claude`: `claude_start` and the rest), instrument and record name it. */
export const CLAUDE: Harness = {
  kind: "claude",
  title: "Claude Code",
  traced: "each tool call with its input and what came of it, and each error",
  toolText,
}

/** One chat's Claude Code sessions, as its host binds them, and the tools the agent works them with. */
export class ClaudeInstrument extends HarnessInstrument {
  constructor(host: HarnessHost) {
    super(CLAUDE, host)
  }
}

/** The Claude Code record in `dir`, read from its meta.json; null when `dir` holds none. */
export function readClaudeRecord(dir: string): RecordFile | null {
  return readRecord(dir, "claude")
}

/** Marks the Claude Code record in `dir` interrupted if it is still running; whether it marked it. */
export function markClaudeInterrupted(dir: string): boolean {
  return markRecordInterrupted(dir, "claude")
}

/** A Claude Code tool part as the trace shows it: the tool, a command as `$ command`, any other input whole, and its
 *  result, or why it failed. */
function toolText(part: ToolPart): string {
  const tool = part.tool.startsWith(TOOL_PREFIX) ? part.tool.slice(TOOL_PREFIX.length) : part.tool
  const input = part.input as Record<string, unknown>
  const state = part.state === "completed" ? "" : ` (${part.state})`
  const asked = tool === "Bash" && typeof input.command === "string" ? `$ ${input.command}` : JSON.stringify(input)
  const came = part.state === "error" ? (part.error ?? "") : outputText(part.output)
  return `[${tool}${state}] ${asked}\n${came}`.trimEnd()
}
