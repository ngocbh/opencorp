/** Codex app-server items and server requests, as the office's transcript parts and question cards.
 *
 *  A turn's items share one assistant message until a user message comes in mid-turn (a steer): the next item that
 *  starts then opens a new message, so what Codex does after reading the steer follows it. An item that started
 *  before the steer keeps writing to the message it started in, so its later deltas, its completion and any decision
 *  on it land on its own part. An interrupted turn ends with `[interrupted]`. */
import fs from "node:fs"
import path from "node:path"
import type { z } from "zod"
import { type ErrorPart, type Message, now, Question, type TextPart, type ToolPart } from "@opencorp/protocol"
import { pyJson, splitLines } from "../perm/redact.ts"
import { newId } from "../store/store.ts"
import type { Card, HarnessEvent } from "./adapter.ts"

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
/** A tool part's states. */
type ToolState = ToolPart["state"]
/** The part state of each Codex item status; any other status is still running. */
const STATES: ReadonlyMap<string, ToolState> = new Map([
  ["inProgress", "running"], ["completed", "completed"], ["failed", "error"], ["declined", "error"],
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

/** Python's `str()` of a value put into a card's text: `None` for a missing one. */
function pyStr(value: unknown): string {
  return value == null ? "None" : String(value)
}

/** A Codex server request as a card, and the reply each answer makes. */
export type Issued = {
  card: Card
  /** The tool part a decision is written on: the item's id, else a request part of its own. */
  callId: string
  runId: string
  nodeId: string
  /** The JSON-RPC result for `answer` (as the answer check returns it), and the decision's variant name. */
  reply(answer: unknown): [Record<string, unknown>, string]
}

/** Where a request's card is asked: its run (the turn) and its node. */
type Asked = { runId: string; nodeId: string }

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
    } else if (TOOL_ITEMS.has(kind)) {
      if (kind === "fileChange") {  // named once here, so the card, the part, the debrief and the TUI all agree
        item = { ...item, changes: (item.changes ?? []).map((c: Obj) => this.relativeChange(c)) }
      }
      this.items.set(item.id, item)
      this.put(turnId, item.id)
    }
  }

  private errorNotice(params: Obj): void {
    const message = truthy(params.error?.message) ? params.error.message : "an error with no message"
    if (truthy(params.willRetry)) return
    this.shown.set(params.turnId, message)
    this.live.error(`Codex: ${message}`)
    this.afterError.add(params.turnId)  // what Codex does next goes below the error, not above it
  }

  /** `change` with its path, and where it moved to, relative to the session's cwd. */
  private relativeChange(change: Obj): Obj {
    const to = movedTo(change)
    const kind = truthy(to) ? { ...change.kind, move_path: relative(to!, this.cwd) } : change.kind ?? null
    return { ...change, path: relative(change.path, this.cwd), kind }
  }

  /** The card for a server request; `Unserved` for a method that isn't one. */
  card(method: string, params: Obj, asked: Asked): Issued {
    if (method === "item/commandExecution/requestApproval") {
      const network = params.networkApprovalContext
      let title: string, text: string
      if (truthy(network)) {  // a managed-network prompt: Codex sends no command or cwd, only the host
        title = "Codex wants network access"
        text = `${network.protocol} to ${network.host}`
      } else {
        const item = this.items.get(params.itemId) ?? {}
        const command = truthy(params.command) ? params.command : truthy(item.command) ? item.command : "?"
        const cwd = truthy(params.cwd) ? params.cwd : item.cwd
        title = COMMAND_TITLES.get(params.kind) ?? COMMAND_TITLES.get("command")!
        text = `$ ${command}\nin ${pyStr(cwd)}`
        const permissions = pruned(params.additionalPermissions)
        if (truthy(permissions)) text += `\nand asks for ${pyJson(permissions, true)}`
      }
      return approval("command", params, asked, title, text, offered(params.availableDecisions, APPROVE))
    }
    if (method === "item/fileChange/requestApproval") {
      const changes: Obj[] = this.items.get(params.itemId)?.changes ?? []
      let text = changes.map((c) => {
        const [added, removed] = changeCounts(changeType(c), c.diff)
        return `${changeName(c)} (${pyStr(changeType(c))}, +${added}/-${removed})`
      }).join("\n")
      if (truthy(params.grantRoot)) text += `\nand write access under ${params.grantRoot} for this session`
      return approval("file_change", params, asked, "Codex wants to change files", text || "(no diff yet)",
        offered(params.availableDecisions, APPROVE))
    }
    if (method === "item/permissions/requestApproval") {
      const wanted = Object.fromEntries(Object.entries(params.permissions).filter(([, v]) => v != null))
      const text = `${pyJson(wanted, true)}\nin ${pyStr(params.cwd)}`
      const grant = (d: string) =>
        d === "decline" ? { permissions: {}, scope: "turn" } : { permissions: wanted, scope: d }
      return issue("permissions", params.itemId, asked, { title: "Codex asks for more permissions",
        question: withReason(text, params), options: PERMISSIONS.map(([label]) => label) }, choice(PERMISSIONS, grant))
    }
    return this.other(method, params, asked)
  }

  /** The card for a request that isn't an approval: questions, MCP approvals and elicitations. */
  private other(method: string, _params: Obj, _asked: Asked): Issued {
    throw new Unserved(method)
  }

  /** (Re)writes `callId`'s tool part from its item, with the decision on it. */
  private put(turnId: string, callId: string): void {
    const item = this.items.get(callId)!
    const [tool, input, output, error] = view(item)
    this.live.tool(this.node(turnId, callId), callId, tool, {
      state: STATES.get(item.status) ?? "running",
      input: this.approvals.has(callId) ? { ...input, approval: this.approvals.get(callId) } : input,
      output, error,
    })
  }
}

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

/** A change's kind (add, delete, update), or null. */
function changeType(change: Obj): string | null {
  return (truthy(change.kind) ? change.kind : {}).type ?? null
}

/** Where a change moved the file to, or null. */
function movedTo(change: Obj): string | null {
  return (truthy(change.kind) ? change.kind : {}).move_path ?? null
}

/** A change's path, with where it moved to: `a.py → b.py`. */
function changeName(change: Obj): string {
  return truthy(movedTo(change)) ? `${change.path} → ${movedTo(change)}` : change.path
}

/** A tool item's part fields: tool, input, output, error. */
function view(item: Obj): [string, Obj, unknown, string | null] {
  const type = item.type
  const error = item.status === "declined" ? "declined" : null
  if (type === "commandExecution") {
    return [COMMAND, { command: item.command, cwd: item.cwd ?? null, exit_code: item.exitCode ?? null },
      cap(item.aggregatedOutput), error]
  }
  if (type === "fileChange") {
    const changes = (item.changes ?? []).map((c: Obj) => ({ path: c.path, kind: changeType(c),
      ...(truthy(movedTo(c)) ? { move_path: movedTo(c) } : {}), diff: cap(c.diff) }))
    return [FILE_CHANGE, { changes }, "", error]
  }
  const result = item.result, failure = item.error
  const output = truthy(result) ? cap(pyJson(result.content ?? null)) : ""
  return [MCP_TOOL, { server: item.server, tool: item.tool, arguments: item.arguments ?? null }, output,
    truthy(failure) ? failure.message ?? null : error]
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

/** A card's options: each label, and the decision it makes. */
type Options = readonly (readonly [string, string])[]

const APPROVE: Options = [["Approve", "accept"], ["Approve for this session", "acceptForSession"],
  ["Deny so Codex continues", "decline"], ["Deny and stop", "cancel"]]
const COMMAND_TITLES: ReadonlyMap<unknown, string> = new Map([
  ["command", "Codex wants to run a command"], ["writeStdin", "Codex wants to send input to a running command"],
])
const PERMISSIONS: Options = [["Approve for this turn", "turn"], ["Approve for this session", "session"],
  ["Deny", "decline"]]
/** What an answer that makes no reply throws; it never echoes the answer. */
const NOT_AN_OPTION = "the answer isn't one of the card's options"
/** The fields of a Question a card shows, checked as Python's `Question.model_validate` checks them. */
const CARD = Question.pick({ title: true, question: true, options: true, questions: true, answer_schema: true })

/** The card checked and parsed, with the reply each answer makes. */
function issue(kind: Card["kind"], callId: string, { runId, nodeId }: Asked, shown: z.input<typeof CARD>,
  reply: Issued["reply"]): Issued {
  const parsed = CARD.safeParse(shown)
  // The parse error quotes what Codex sent, so only a fixed text leaves.
  if (!parsed.success) throw new Error("the request can't be shown as a card")
  return { card: { kind, ...parsed.data }, callId, runId, nodeId, reply }
}

/** An approval card: the reply is the picked option's decision. */
function approval(kind: Card["kind"], params: Obj, asked: Asked, title: string, text: string, options: Options):
  Issued {
  return issue(kind, params.itemId, asked, { title, question: withReason(text, params),
    options: options.map(([label]) => label) }, choice(options, (d) => ({ decision: d })))
}

/** A reply made from the decision of the picked label; a label the card doesn't hold makes none. */
function choice(options: Options, result: (decision: string) => Record<string, unknown>): Issued["reply"] {
  const mapping = new Map<unknown, string>(options)
  return (answer) => {
    const decision = mapping.get(answer)
    if (decision === undefined) throw new RangeError(NOT_AN_OPTION)
    return [result(decision), decision]
  }
}

/** The options whose decisions Codex lists; all of them when it lists none (a missing or null list). */
function offered(available: unknown[] | null | undefined, options: Options): Options {
  // Persistent decisions are objects (amendments) and write the owner's Codex config: never offered.
  if (available == null) return options
  const names = new Set(available.filter((d) => typeof d === "string"))
  return options.filter(([, d]) => names.has(d))
}

function withReason(text: string, params: Obj): string {
  return truthy(params.reason) ? `${text}\n${params.reason}` : text
}

function isPlain(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** `value` without its null or empty-object entries, at any depth: Codex sends every field it could have asked
 *  for. Arrays are kept as they are. */
function pruned(value: unknown): unknown {
  if (!isPlain(value)) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pruned(v)] as const)
    .filter(([, v]) => v != null && !(isPlain(v) && Object.keys(v).length === 0)))
}

/** A server request the office doesn't turn into a card; it gets a JSON-RPC error. */
export class Unserved extends Error {
  override name = "Unserved"
}
