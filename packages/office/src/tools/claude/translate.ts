/** Claude Code's stream-json lines, as the office's transcript parts: the live message, part and turn events a
 *  harness session reports (`HarnessEvent`).
 *
 *  A turn's lines share one assistant message until a user message comes in mid-turn (a steer): what Claude Code
 *  writes after it opens a new message, so what it does after reading the steer follows it. Each text block is a text
 *  part, each tool call a tool part (`claude.<Tool>`) that its result completes. A subagent's own lines are left out:
 *  its call's part shows it. An API error is shown once, from the turn's result, and an interrupted turn ends with
 *  `[interrupted]`. */
import { type ErrorPart, type HarnessUsage, type Message, now, type TextPart, type ToolPart } from "@opencorp/protocol"
import { newId } from "../../util/ids.ts"
import type { HarnessEvent } from "../harness/adapter.ts"
import { type Msg, isObj } from "./stream.ts"

/** The longest tool output a part keeps, in UTF-16 code units. */
export const OUTPUT_MAX_CHARS = 20_000
/** What ends an output cut to `OUTPUT_MAX_CHARS`. */
export const OUTPUT_CUT = "\n[output cut here; Claude Code keeps all of it]"
/** What a message an interrupt stopped ends with. */
export const INTERRUPTED_TEXT = "\n\n[interrupted]"
/** What starts a Claude Code tool part's name; the rest is Claude Code's own name for the tool. */
export const TOOL_PREFIX = "claude."
/** What Claude Code writes as the user when an interrupt stopped the turn. */
const INTERRUPTED_LINE = "[Request interrupted by user"

/** Writes one Claude Code session's lines as live message, part and turn events. */
export class Translator {
  #turn: string | null = null
  #message: string | null = null
  #tail: TextPart | ToolPart | null = null
  readonly #tools = new Map<string, ToolPart>()
  #steered = false
  #interrupted = false
  #model: string | null = null

  constructor(
    private readonly sessionId: string,
    private readonly emit: (e: HarnessEvent) => void,
  ) {}

  /** The running turn's id, or null between turns. */
  get turn(): string | null {
    return this.#turn
  }

  /** Adds a user message; `author` is the human who sent it. A message mid-turn is a steer: what Claude Code writes
   *  next opens a new assistant message. */
  user(text: string, author: string | null): void {
    const message: Message = { id: newId(), session_id: this.sessionId, role: "user", author, unread: false,
      parts: [{ id: newId(), type: "text", text }], created_at: now() }
    if (this.#message !== null) this.#steered = true
    this.emit({ type: "message", message })
  }

  /** Adds an assistant message saying why a turn or the session failed. */
  error(text: string): void {
    const part: ErrorPart = { id: newId(), type: "error", message: text }
    this.emit({ type: "message", message: { id: newId(), session_id: this.sessionId, role: "assistant", author: null,
      unread: false, parts: [part], created_at: now() } })
  }

  /** Esc dropped the messages sent before any turn took them: an assistant message of its own with the marker. */
  dropped(): void {
    if (this.#turn !== null) return
    this.#message = null
    this.#steered = false
    this.#put({ id: newId(), type: "text", text: INTERRUPTED_TEXT.trimStart() })
    this.#message = null
    this.#tail = null
  }

  /** Office stop: the running turn's running tools become interrupted, and its message gets the marker. */
  abort(): void {
    if (this.#turn === null) return
    this.#close(true)
    this.#turn = null
  }

  /** Writes one line Claude Code wrote; false for a line that isn't the translator's (control messages, lifecycle
   *  and stream events, rate limits). */
  line(msg: Msg): boolean {
    if (msg.type === "system") return this.#system(msg)
    if (msg.type === "assistant") {
      if (!isTop(msg) || msg.is_api_error_message === true) return true
      this.#begin()
      for (const block of contentOf(msg)) this.#assistantBlock(block)
      return true
    }
    if (msg.type === "user") {
      if (!isTop(msg)) return true
      for (const block of contentOf(msg)) this.#userBlock(block)
      return true
    }
    if (msg.type === "result") {
      this.#result(msg)
      return true
    }
    return false
  }

  #system(msg: Msg): boolean {
    if (msg.subtype === "init") {
      if (typeof msg.model === "string" && msg.model !== this.#model) {
        this.#model = msg.model
        this.emit({ type: "model", model: msg.model })
      }
      this.#begin()
      return true
    }
    if (msg.subtype === "session_state_changed") {
      if (msg.state === "running") this.#begin()
      return true
    }
    return false
  }

  /** Starts a turn unless one runs. */
  #begin(): void {
    if (this.#turn !== null) return
    this.#turn = newId()
    this.#interrupted = false
    this.emit({ type: "turn_started", turnId: this.#turn })
  }

  #assistantBlock(block: Msg): void {
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
      this.#put({ id: newId(), type: "text", text: block.text })
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      const part: ToolPart = { id: newId(), type: "tool", call_id: block.id, tool: TOOL_PREFIX + String(block.name),
        state: "running", input: isObj(block.input) ? block.input : {}, output: "", error: null }
      this.#tools.set(block.id, part)
      this.#put(part)
    }
  }

  #userBlock(block: Msg): void {
    if (block.type === "text" && typeof block.text === "string" && block.text.startsWith(INTERRUPTED_LINE)) {
      this.#interrupted = true
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const failed = block.is_error === true
      const text = cap(resultText(block.content))
      const held = this.#tools.get(block.tool_use_id)
      const part: ToolPart = { id: held?.id ?? newId(), type: "tool", call_id: block.tool_use_id,
        tool: held?.tool ?? `${TOOL_PREFIX}tool`, state: failed ? "error" : "completed", input: held?.input ?? {},
        output: failed ? "" : text, error: failed ? text : null }
      this.#tools.delete(block.tool_use_id)
      this.#put(part)
    }
  }

  /** Ends the turn: an API error or another failure shown, the running tools interrupted, the marker when an
   *  interrupt stopped it, and its usage. */
  #result(msg: Msg): void {
    this.#begin()
    const turnId = this.#turn!
    const aborted = msg.subtype === "error_during_execution" && String(msg.terminal_reason).startsWith("aborted")
    const interrupted = this.#interrupted || aborted
    this.#close(interrupted)
    if (msg.is_error === true && !interrupted) {
      const why = msg.subtype === "success" && typeof msg.result === "string" && msg.result !== ""
        ? msg.result
        : `it ended with ${String(msg.subtype)}`
      this.error(`Claude Code's turn failed: ${why}`)
    }
    this.#turn = null
    this.emit({ type: "turn_completed", turnId, usage: usageOf(msg.usage) })
  }

  /** Closes the turn's message: its running tools become interrupted, and `interrupted` adds the marker. */
  #close(interrupted: boolean): void {
    for (const part of this.#tools.values()) this.#put({ ...part, state: "interrupted" })
    this.#tools.clear()
    if (interrupted) {
      const tail = this.#tail
      this.#put(tail?.type === "text" ? { ...tail, text: tail.text + INTERRUPTED_TEXT }
        : { id: newId(), type: "text", text: INTERRUPTED_TEXT.trimStart() })
    }
    this.#message = null
    this.#tail = null
    this.#steered = false
  }

  /** Adds `part` to the turn's message, or replaces the one with its id; a steer first opens a new message. */
  #put(part: TextPart | ToolPart): void {
    if (this.#steered) {
      this.#message = null
      this.#steered = false
    }
    if (this.#message === null) {
      this.#message = newId()
      this.emit({ type: "message", message: { id: this.#message, session_id: this.sessionId, role: "assistant",
        author: null, unread: false, parts: [], created_at: now() } })
    }
    this.#tail = part
    this.emit({ type: "part", messageId: this.#message, part: structuredClone(part) })
  }
}

/** Whether a line is the session's own, not one of a subagent's. */
function isTop(msg: Msg): boolean {
  return msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined
}

/** A message line's content blocks. */
function contentOf(msg: Msg): Msg[] {
  const message = isObj(msg.message) ? msg.message : {}
  const content = message.content
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content.filter(isObj) : []
}

/** A tool result's text: a string, or its text blocks joined, with other blocks named. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(isObj)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : `[${String(block.type)}]`))
    .join("\n")
}

/** `text` cut to `OUTPUT_MAX_CHARS` with a marker, never inside a surrogate pair; Claude Code keeps the whole of it. */
function cap(text: string): string {
  if (text.length <= OUTPUT_MAX_CHARS) return text
  const high = text.charCodeAt(OUTPUT_MAX_CHARS - 1)
  const end = high >= 0xd800 && high <= 0xdbff ? OUTPUT_MAX_CHARS - 1 : OUTPUT_MAX_CHARS
  return text.slice(0, end) + OUTPUT_CUT
}

/** A result's usage as the office counts it: input with what the cache served or stored, the cached part, and the
 *  output; null when the result has none. */
function usageOf(usage: unknown): HarnessUsage | null {
  if (!isObj(usage)) return null
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0)
  const cached = n(usage.cache_read_input_tokens)
  return {
    input_tokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + cached,
    cached_input_tokens: cached,
    output_tokens: n(usage.output_tokens),
  }
}
