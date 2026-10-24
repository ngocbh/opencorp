/** Codex app-server items and server requests, as the office's transcript parts and question cards.
 *
 *  A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
 *  starts then opens a new message, so what Codex does after reading the steer follows it. An item that started
 *  before the steer keeps writing to the message it started in, so its later deltas, its completion and any decision
 *  on it land on its own part. An interrupted turn ends with `[interrupted]`. */
import fs from "node:fs"
import path from "node:path"
import { splitLines } from "../perm/redact.ts"

export const OUTPUT_MAX_CHARS = 20_000
export const OUTPUT_CUT = "\n[output cut here; Codex keeps all of it]"
/** Tool names of Codex's parts; the debrief and the TUI key on the `codex.` prefix. */
export const COMMAND = "codex.command"
export const FILE_CHANGE = "codex.file_change"
export const MCP_TOOL = "codex.mcp_tool_call"
export const REQUEST = "codex.request"
/** The tool name of each Codex item type that becomes a tool part. */
export const TOOL_ITEMS: ReadonlyMap<string, string> = new Map([
  ["commandExecution", COMMAND], ["fileChange", FILE_CHANGE], ["mcpToolCall", MCP_TOOL],
])
/** What a message an interrupt stopped ends with. */
export const INTERRUPTED_TEXT = "\n\n[interrupted]"

/** `text` cut to `OUTPUT_MAX_CHARS` code points with a marker; Codex keeps the whole of it. */
export function cap(text: string | null | undefined): string {
  const whole = text || ""
  if (whole.length <= OUTPUT_MAX_CHARS) return whole
  let points = 0
  for (let i = 0; i < whole.length; i++) {
    if (whole.codePointAt(i)! > 0xffff) i++  // a surrogate pair is one code point, as Python counts
    if (++points === OUTPUT_MAX_CHARS) return i + 1 < whole.length ? whole.slice(0, i + 1) + OUTPUT_CUT : whole
  }
  return whole
}

/** `p` relative to `cwd` when it lies under it, else as sent: Codex sends a file change's absolute path. */
export function relative(p: string, cwd: string | null | undefined): string {
  if (!cwd || !path.isAbsolute(p)) return p
  let real = cwd
  try {
    real = fs.realpathSync(cwd)  // Codex may report /private/tmp for /tmp
  } catch {
    // A cwd that is gone has no other name.
  }
  for (const root of new Set([cwd, real])) {
    if (p.startsWith(root.replace(/\/+$/, "") + "/")) return path.relative(root, p) || "."
  }
  return p
}

/** Lines one Codex file change adds and removes, as `[added, removed]`.
 *
 *  Codex sends a new or deleted file's whole content as `diff`, and a unified diff only for an update. */
export function changeCounts(kind: string | null | undefined, diff: string | null | undefined): [number, number] {
  const lines = splitLines(diff || "")
  if (kind === "add") return [lines.length, 0]
  if (kind === "delete") return [0, lines.length]
  const hunks = lines.findIndex((x) => x.startsWith("@@"))
  // What comes before the first hunk is the ---/+++ header, not changed lines.
  const body = hunks === -1 ? [] : lines.slice(hunks)
  return [body.filter((x) => x.startsWith("+")).length, body.filter((x) => x.startsWith("-")).length]
}

/** Server requests that become cards. */
export const SERVED: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request",
])
/** Server requests the office answers with a JSON-RPC error: the pinned schema's others (the drift test checks). */
export const REFUSED: ReadonlySet<string> = new Set([
  "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read",
  "applyPatchApproval", "execCommandApproval",
])
/** The pinned response schema each served request's reply must match. */
export const REPLY_SCHEMAS: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse",
  "item/permissions/requestApproval": "PermissionsRequestApprovalResponse",
  "item/tool/requestUserInput": "ToolRequestUserInputResponse",
  "mcpServer/elicitation/request": "McpServerElicitationRequestResponse",
}
export const MCP_APPROVAL_PREFIX = "mcp_tool_call_approval"
/** Run id prefix of a request with no turn (`codex-<app-server pid>-<id made per app-server>`). */
export const TURNLESS = "codex-"

/** A server request the office doesn't turn into a card; it gets a JSON-RPC error. */
export class Unserved extends Error {
  override name = "Unserved"
}
