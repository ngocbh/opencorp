/** Claude Code's stream-json stdio, one JSON object per line: what its CLI writes (`--output-format stream-json`), and
 *  what it reads (`--input-format stream-json`), with the control requests and responses the Agent SDK sends over the
 *  same pipes (`initialize`, `interrupt`), as the upstream TUI's recordings hold them. These control messages aren't
 *  documented as a stable API, which is why the office has a version floor and doctor's probe.
 *
 *  A control request is `{type: "control_request", request_id, request: {subtype, ...}}`; its answer is
 *  `{type: "control_response", response: {subtype: "success", request_id, response?}}`, or `subtype: "error"` with
 *  `error`. Claude Code sends its own control requests the same way. */
import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"

/** The longest line, in bytes without its newline, read from Claude Code. */
export const MAX_LINE = 16 * 1024 * 1024

const UTF8 = new TextDecoder("utf-8", { fatal: true })
const UTF8_LOOSE = new TextDecoder("utf-8")

/** A JSON object on the wire. */
export type Msg = Record<string, unknown>

/** Claude Code answered a control request with an error. The message is Claude Code's, which can quote what was
 *  sent: say it only where its sender may see it. */
export class ControlError extends Error {
  override name = "ControlError"
}

/** The stream closed before an answer came, or before a write. */
export class StreamClosed extends Error {
  override name = "StreamClosed"
}

/** What a `StreamJson` calls. `kill` stops Claude Code (its process group) and must not throw; `log` defaults to
 *  `console.error`. */
export type StreamHandlers = {
  /** Every line that is neither a control request nor a control response: the conversation and its bookkeeping. */
  onMessage(msg: Msg): void
  /** Claude Code's own control request `id`, which must be answered (`answer` or `refuse`). */
  onRequest(id: string, request: Msg): void
  onClosed(): void
  kill(): void
  log?: (line: string) => void
}

type Waiter = { subtype: string; answer(response: Msg): void; fail(error: Error): void }

/** `error`'s `name`: what a log line says of a failure, since its message can quote a secret. */
export function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** `error`'s `code`, or `unknown`. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/** Control requests with answers, Claude Code's own requests, and every other line, in arrival order.
 *
 *  Handlers must hand work off rather than block. A handler that throws is logged by the error's name and the reading
 *  goes on; a request whose handler threw is refused. Lines that aren't JSON objects are logged, cut to 200 characters,
 *  and skipped. A line over `MAX_LINE` bytes is a protocol failure: the reading stops, `kill()` runs, and pending
 *  requests fail. `onClosed()` runs once, when stdout ends or on that failure. Writes resolve once the stream took the
 *  bytes, and reject with `StreamClosed` when stdin is broken. */
export class StreamJson {
  readonly #in: Writable
  readonly #out: Readable
  readonly #handlers: StreamHandlers
  readonly #log: (line: string) => void
  readonly #waiting = new Map<string, Waiter>()
  #closed = false
  #broken: string | null = null
  #chunks: Buffer[] = []
  #size = 0

  /** `stdout` must stay in binary mode (never `setEncoding` it), since lines are split and capped as bytes. */
  constructor(stdin: Writable, stdout: Readable, handlers: StreamHandlers) {
    this.#in = stdin
    this.#out = stdout
    this.#handlers = handlers
    this.#log = handlers.log ?? ((line) => console.error(line))
    // An EPIPE event without a listener would crash the office; later writes reject at once.
    stdin.on("error", (error) => {
      this.#broken ??= codeOf(error)
    })
  }

  /** Starts reading stdout. */
  start(): void {
    this.#out.on("data", this.#onData)
    this.#out.on("end", this.#onEnd)
    this.#out.on("close", this.#onEnd)
    this.#out.on("error", this.#onEnd)
  }

  /** Sends control request `subtype` with `body`, and resolves with its answer's `response` (`{}` when it has none);
   *  `ControlError` for an error answer, `StreamClosed` if Claude Code goes or the write fails, an `Error` named
   *  `TimeoutError` after `timeout` ms. */
  request(subtype: string, body: Msg = {}, { timeout = 60_000 } = {}): Promise<Msg> {
    if (this.#closed) return Promise.reject(new StreamClosed(`Claude Code closed before answering ${subtype}`))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.#waiting.delete(id)
      }
      const timer = setTimeout(() => {
        done()
        const error = new Error(`${subtype} got no answer in ${(timeout / 1000).toFixed(0)}s`)
        error.name = "TimeoutError"
        reject(error)
      }, timeout)
      const fail = (error: Error) => {
        done()
        reject(error)
      }
      this.#waiting.set(id, {
        subtype,
        answer: (response) => {
          done()
          if (response.subtype === "success") return resolve(isObj(response.response) ? response.response : {})
          reject(new ControlError(typeof response.error === "string" ? response.error : `${subtype} failed`))
        },
        fail,
      })
      this.send({ type: "control_request", request_id: id, request: { subtype, ...body } }).catch(fail)
    })
  }

  /** Answers Claude Code's control request `id` with `response`. */
  answer(id: string, response: Msg): Promise<void> {
    return this.send({ type: "control_response", response: { subtype: "success", request_id: id, response } })
  }

  /** Answers Claude Code's control request `id` with an error. */
  refuse(id: string, error: string): Promise<void> {
    return this.send({ type: "control_response", response: { subtype: "error", request_id: id, error } })
  }

  /** Writes `msg` as one line. */
  send(msg: Msg): Promise<void> {
    const stdin = this.#in
    return new Promise((resolve, reject) => {
      const broken =
        this.#broken ??
        (stdin.errored
          ? codeOf(stdin.errored)
          : stdin.destroyed
            ? "ERR_STREAM_DESTROYED"
            : stdin.writableEnded
              ? "ERR_STREAM_WRITE_AFTER_END"
              : null)
      if (broken) return reject(new StreamClosed(`Claude Code's stdin is closed (${broken})`))
      stdin.write(JSON.stringify(msg) + "\n", (error) => {
        if (!error) return resolve()
        this.#broken ??= codeOf(error)
        reject(new StreamClosed(`Claude Code's stdin is closed (${codeOf(error)})`))
      })
    })
  }

  #onData = (chunk: Buffer): void => {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      // Counted before the newline comes, so a runaway line without one is stopped too.
      this.#size += end - start
      if (this.#size > MAX_LINE) return this.#overCap()
      if (end > start) this.#chunks.push(chunk.subarray(start, end))
      if (newline === -1) return
      this.#takeLine()
      start = newline + 1
    }
  }

  #onEnd = (): void => {
    if (this.#closed) return
    this.#closed = true
    if (this.#size > 0) this.#takeLine()
    this.#failAll((subtype) => new StreamClosed(`Claude Code closed before answering ${subtype}`))
    this.#runOnClosed()
  }

  #overCap(): void {
    this.#closed = true
    this.#chunks = []
    this.#size = 0
    const out = this.#out
    out.off("data", this.#onData)
    out.off("end", this.#onEnd)
    out.off("close", this.#onEnd)
    out.off("error", this.#onEnd)
    out.on("error", () => {})
    out.destroy()
    this.#log("claude: a line over the 16 MiB limit; stopping Claude Code")
    // A throw here would escape the stream callback as an uncaught exception and leave the requests pending.
    try {
      this.#handlers.kill()
    } catch (error) {
      this.#log(`claude: stopping Claude Code failed (${nameOf(error)})`)
    }
    this.#failAll(() => new StreamClosed("Claude Code sent a line over the 16 MiB limit"))
    this.#runOnClosed()
  }

  #runOnClosed(): void {
    try {
      this.#handlers.onClosed()
    } catch (error) {
      this.#log(`claude: the closed handler failed (${nameOf(error)})`)
    }
  }

  #failAll(error: (subtype: string) => Error): void {
    for (const waiter of [...this.#waiting.values()]) waiter.fail(error(waiter.subtype))
  }

  #takeLine(): void {
    const bytes = Buffer.concat(this.#chunks, this.#size)
    this.#chunks = []
    this.#size = 0
    let text: string | null = null
    let msg: unknown
    try {
      text = UTF8.decode(bytes)
      msg = JSON.parse(text)
    } catch {
      msg = undefined
    }
    if (!isObj(msg)) {
      const shown = JSON.stringify((text ?? UTF8_LOOSE.decode(bytes)).slice(0, 200))
      this.#log(`claude: a line that isn't a JSON object: ${shown}`)
      return
    }
    if (msg.type === "control_response") {
      const response = isObj(msg.response) ? msg.response : {}
      const id = response.request_id
      if (typeof id === "string") this.#waiting.get(id)?.answer(response)
      return
    }
    if (msg.type === "control_request" && typeof msg.request_id === "string" && isObj(msg.request)) {
      return this.#handleRequest(msg.request_id, msg.request)
    }
    try {
      this.#handlers.onMessage(msg)
    } catch (error) {
      this.#log(`claude: the ${String(msg.type).slice(0, 200)} handler failed (${nameOf(error)})`)
    }
  }

  #handleRequest(id: string, request: Msg): void {
    try {
      this.#handlers.onRequest(id, request)
    } catch (error) {
      const shown = String(request.subtype).slice(0, 200)
      this.#log(`claude: the ${shown} handler failed (${nameOf(error)})`)
      // Claude Code would wait for this answer forever.
      this.refuse(id, `the office couldn't handle ${shown}`).catch(() =>
        this.#log(`claude: couldn't answer ${shown}: Claude Code's stdin is closed`),
      )
    }
  }
}

/** A plain JSON object. */
export function isObj(value: unknown): value is Msg {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
