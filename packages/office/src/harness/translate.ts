/** Codex app-server items and server requests, as the office's transcript parts and question cards.
 *
 *  A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
 *  starts then opens a new message, so what Codex does after reading the steer follows it. An item that started
 *  before the steer keeps writing to the message it started in, so its later deltas, its completion and any decision
 *  on it land on its own part. An interrupted turn ends with `[interrupted]`. */
import fs from "node:fs"
import path from "node:path"
import { type ErrorPart, type Message, now, type TextPart, type ToolPart } from "@opencorp/protocol"
import { splitLines } from "../perm/redact.ts"
import { newId } from "../store/store.ts"
import type { HarnessEvent } from "./adapter.ts"

/** The longest command output a part keeps, in code points. */
export const OUTPUT_MAX_CHARS = 20_000
/** What ends an output cut to `OUTPUT_MAX_CHARS`. */
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
    // Node's realpath throws for a cwd that is gone; then only cwd itself is tried.
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

/** A JSON object from Codex: `any`, since the translator reads whatever Codex sent. */
type Obj = Record<string, any>

/** Python's truth test: an empty object, array or string, `0`, `null` and a missing value are false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

/** The notification methods the translator writes. */
const NOTIFIED = new Set(["item/agentMessage/delta", "item/started", "item/completed", "error"])

/** Writes one Codex thread's items as live message, part and delta events. */
export class Translator {
  private readonly live: Live
  private readonly streamed = new Map<string, string>()  // agent message item id -> the text its deltas streamed so far
  private readonly items = new Map<string, Obj>()  // tool item id -> its latest item, for cards and decisions
  private readonly approvals = new Map<string, Obj>()  // tool part id -> the decision on it and who made it
  private readonly segments = new Map<string, string[]>()  // turn id -> the node of each of its messages
  private readonly nodes = new Map<string, string>()  // item or request part id -> the node of the message it started in
  private readonly shown = new Map<string, string>()  // turn id -> the last error message shown for it
  private readonly afterError = new Set<string>()  // turn ids whose next item goes below an error shown mid-turn
  private readonly finished: string[] = []  // the latest 16 finished turns, whose late messages are dropped

  /** `cwd` is the session's: file changes under it are named relative to it. */
  constructor(
    sessionId: string,
    private readonly cwd: string | null,
    onEvent: (e: HarnessEvent) => void,
    private readonly log: (line: string) => void = console.error,
  ) {
    this.live = new Live(sessionId, onEvent)
  }

  /** Adds a user message; `author` is the human who sent it. A message mid-turn is a steer. */
  user(text: string, author: string): void {
    this.live.user(text, author)
  }

  /** Adds an assistant message saying why a turn or the session failed. */
  error(text: string): void {
    this.live.error(text)
  }

  /** Writes an item notification; false for a method that isn't the translator's. */
  notification(method: string, params: Obj): boolean {
    if (!NOTIFIED.has(method)) return false
    if (this.finished.includes(params.turnId)) return true  // its messages are closed: writing would open a new one
    if (method === "item/agentMessage/delta") {
      const node = this.node(params.turnId, params.itemId)
      this.streamed.set(params.itemId, (this.streamed.get(params.itemId) ?? "") + params.delta)
      this.live.stream({ node, exchange: params.itemId, chunk: params.delta })
    } else if (method === "item/started" || method === "item/completed") {
      this.item(params.turnId, params.item, method === "item/completed")
    } else {
      this.errorNotice(params)
    }
    return true
  }

  /** Closes the turn's messages: running tools become interrupted, and an interrupted turn gets the marker on its
   *  newest message (a new one when nothing ran, or when a steer came after the newest). */
  turnCompleted(turnId: string, status: string, error: Obj | null): void {
    if (this.finished.includes(turnId)) return  // already closed: closing again would open a message for the marker
    const interrupted = status === "interrupted"
    if (interrupted) this.live.open(this.current(turnId))
    const shown = this.shown.get(turnId)
    this.finish(turnId, interrupted)
    const why = truthy(error?.message) ? error!.message : "no reason given"
    // Codex often sends the same message as an error first.
    if (status === "failed" && why !== shown) this.live.error(`Codex's turn failed: ${why}`)
  }

  /** Closes every message of `turnId`; only the newest gets the marker. */
  private finish(turnId: string, interrupted: boolean): void {
    const segments = this.segments.get(turnId) ?? []
    this.segments.delete(turnId)
    for (const node of segments) this.live.end(node, interrupted && node === segments.at(-1))
    for (const [key, node] of this.nodes) {
      if (!segments.includes(node)) continue
      this.items.delete(key)
      this.streamed.delete(key)
      this.approvals.delete(key)
      this.nodes.delete(key)
    }
    this.shown.delete(turnId)
    this.afterError.delete(turnId)
    this.finished.push(turnId)
    if (this.finished.length > 16) this.finished.shift()
  }

  /** The node of the turn's newest message, or of a new one when there is none, or a steer or an error message
   *  came after it. */
  private current(turnId: string): string {
    let segments = this.segments.get(turnId)
    if (!segments) this.segments.set(turnId, segments = [])
    if (segments.length === 0 || this.live.isSteered(segments.at(-1)!) || this.afterError.has(turnId)) {
      this.afterError.delete(turnId)
      segments.push(segments.length === 0 ? turnId : `${turnId}~${segments.length}`)
    }
    return segments.at(-1)!
  }

  /** The node `key` (an item, or a request's own part) writes under: the message it started in. */
  private node(turnId: string, key: string): string {
    let node = this.nodes.get(key)
    if (node === undefined) this.nodes.set(key, node = this.current(turnId))
    return node
  }

  private item(turnId: string, item: Obj, done: boolean): void {
    const kind = item.type
    if (!TOOL_ITEMS.has(kind) && kind !== "agentMessage" && kind !== "reasoning") return
    const node = this.node(turnId, item.id)
    if (kind === "agentMessage" && done) {
      const sent = this.streamed.get(item.id) ?? ""
      this.streamed.delete(item.id)
      const text: string = item.text
      const leads = text.startsWith(sent)
      // The part already shows what streamed, so only an ending can be added.
      if (!leads) this.log(`codex: message ${item.id} completed with text its deltas didn't lead to`)
      this.live.stream({ node, exchange: item.id, chunk: leads ? text.slice(sent.length) : "", final: true })
    } else if (kind === "reasoning" && done && truthy(item.summary)) {
      this.live.stream({ node, exchange: item.id, chunk: "(thinking) " + item.summary.join("\n"), final: true })
    }
  }

  private errorNotice(params: Obj): void {
    const message = truthy(params.error?.message) ? params.error.message : "an error with no message"
    if (truthy(params.willRetry)) return
    this.shown.set(params.turnId, message)
    this.live.error(`Codex: ${message}`)
    this.afterError.add(params.turnId)  // what Codex does next goes below the error, not above it
  }
}

/** A tool part's states. */
type ToolState = ToolPart["state"]

/** One session's messages and parts, as live events.
 *
 *  A node gets an assistant message when it opens or first writes. Each exchange is a text part, emitted at its first
 *  and last chunk and as deltas in between; each tool call is a tool part. When the node ends, a tool part still
 *  running is `interrupted`, and a node an interrupt stopped ends with `INTERRUPTED_TEXT`. A user message that comes
 *  in while a node's message is open (a steer) closes that message when the node next opens. */
class Live {
  private readonly messages = new Map<string, string>()  // node -> message id
  private readonly texts = new Map<string, { node: string; part: TextPart }>()  // node + "\0" + exchange -> part
  private readonly tools = new Map<string, { node: string; part: ToolPart }>()  // node + "\0" + call id -> part
  private readonly steered = new Set<string>()  // nodes with a user message after their message
  private readonly tails = new Map<string, TextPart | ToolPart>()  // node -> its message's last part

  constructor(private readonly sessionId: string, private readonly emit: (e: HarnessEvent) => void) {}

  user(text: string, author: string): void {
    const message: Message = { id: newId(), session_id: this.sessionId, role: "user", author,
      parts: [{ id: newId(), type: "text", text }], created_at: now() }
    for (const node of this.messages.keys()) this.steered.add(node)
    this.emit({ type: "message", message })
  }

  error(text: string): void {
    const part: ErrorPart = { id: newId(), type: "error", message: text }
    this.emit({ type: "message", message: { id: newId(), session_id: this.sessionId, role: "assistant", author: null,
      parts: [part], created_at: now() } })
  }

  /** Opens `node`'s message; when a steer came after it, the old message is closed first. */
  open(node: string): void {
    if (this.steered.has(node)) this.close(node)
    this.message(node)
  }

  /** Adds the tool part `callId` to `node`'s message, or replaces it in place. */
  tool(node: string, callId: string, tool: string,
    { state, input, output, error }: { state: ToolState; input: Record<string, unknown>; output?: unknown;
      error?: string | null }): void {
    const key = node + "\0" + callId
    const part: ToolPart = { id: this.tools.get(key)?.part.id ?? newId(), type: "tool", call_id: callId, tool, state,
      input, output: output ?? {}, error: error ?? null }
    this.tools.set(key, { node, part })
    this.put(node, part)
  }

  /** Whether a user message came in after `node`'s message. */
  isSteered(node: string): boolean {
    return this.steered.has(node)
  }

  /** Adds `chunk` to the exchange's text part; `final` stores the part as it stands. */
  stream({ node, exchange, chunk, final = false }: { node: string; exchange: string; chunk: string;
    final?: boolean }): void {
    const key = node + "\0" + exchange
    const open = this.texts.get(key)
    if (!open) {
      if (!chunk) return
      const part: TextPart = { id: newId(), type: "text", text: chunk }
      this.texts.set(key, { node, part })
      this.put(node, part)
    } else if (chunk) {
      open.part.text += chunk
      this.emit({ type: "delta", messageId: this.messages.get(node)!, partId: open.part.id, text: chunk })
    }
    const done = final ? this.texts.get(key) : undefined
    if (done) {
      this.texts.delete(key)
      this.put(node, done.part)
    }
  }

  /** Stores what `node` left open, marks an interrupt, and closes its message. */
  end(node: string, interrupted: boolean): void {
    if (!this.messages.has(node)) return
    for (const [key, open] of this.texts) {
      if (open.node !== node) continue
      this.texts.delete(key)
      this.put(node, open.part)
    }
    for (const [key, held] of this.tools) {
      if (held.node !== node) continue
      this.tools.delete(key)
      if (held.part.state === "running") this.put(node, { ...held.part, state: "interrupted" })
    }
    if (interrupted) {
      const tail = this.tails.get(node)
      this.put(node, tail?.type === "text" ? { ...tail, text: tail.text + INTERRUPTED_TEXT }
        : { id: newId(), type: "text", text: INTERRUPTED_TEXT.trimStart() })
    }
    this.close(node)
  }

  private message(node: string): string {
    let id = this.messages.get(node)
    if (id === undefined) {
      this.messages.set(node, id = newId())
      this.emit({ type: "message", message: { id, session_id: this.sessionId, role: "assistant", author: null,
        parts: [], created_at: now() } })
    }
    return id
  }

  private put(node: string, part: TextPart | ToolPart): void {
    const messageId = this.message(node)
    this.tails.set(node, part)
    this.emit({ type: "part", messageId, part: structuredClone(part) })  // Live keeps changing its own
  }

  private close(node: string): void {
    // Called between model calls or once end stored what was open, so this drops nothing open.
    for (const [key, held] of this.tools) if (held.node === node) this.tools.delete(key)
    this.steered.delete(node)
    this.tails.delete(node)
    this.messages.delete(node)
  }
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
/** The question id prefix Codex gives an MCP tool-call approval. */
export const MCP_APPROVAL_PREFIX = "mcp_tool_call_approval"
/** Run id prefix of a request with no turn (`codex-<app-server pid>-<id made per app-server>`). */
export const TURNLESS = "codex-"

/** A server request the office doesn't turn into a card; it gets a JSON-RPC error. */
export class Unserved extends Error {
  override name = "Unserved"
}
