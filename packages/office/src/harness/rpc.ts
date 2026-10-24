/** A JSON-RPC client over a child's stdin and stdout, one JSON object per line: Codex app-server's stdio transport.
 *
 *  Codex's messages carry no `"jsonrpc"` key; requests are `{id, method, params}`. */
import type { Readable, Writable } from "node:stream"

/** The longest line, in bytes without its newline, read from the app-server. */
export const MAX_LINE = 16 * 1024 * 1024

const OVER_CAP = "the app-server sent a line over the 16 MiB limit"
const UTF8 = new TextDecoder("utf-8", { fatal: true })
const UTF8_LOOSE = new TextDecoder("utf-8")

/** The server answered a request with a JSON-RPC error. */
export class RpcError extends Error {
  readonly code: number
  readonly rpcMessage: string
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(`${message} (${code})`)
    this.name = "RpcError"
    this.code = code
    this.rpcMessage = message
    this.data = data
  }
}

/** The connection closed before an answer came, or before a write. */
export class RpcClosed extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RpcClosed"
  }
}

/** What a `JsonRpc` calls. `kill` stops the app-server (its process group) and must not throw; `log` defaults to
 *  `console.error`. */
export type RpcHandlers = {
  onNotification(method: string, params: unknown): void
  onRequest(id: unknown, method: string, params: unknown): void
  onClosed(): void
  kill(): void
  log?: (line: string) => void
}

type Msg = Record<string, unknown>

type Waiter = { method: string; answer(msg: Msg): void; fail(error: Error): void }

/** `error`'s `code`, or `unknown`. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/** `error`'s `name`: what a log line says of a handler's failure, since its message can quote a secret. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** Requests with answers, notifications, and the server's own requests and notifications.
 *
 *  `onNotification(method, params)` and `onRequest(id, method, params)` run in arrival order and must hand work off
 *  rather than block: a human-paced approval would stall every event. A handler that throws is logged and the reading
 *  goes on; a request whose handler threw is answered with a JSON-RPC internal error (-32603). Lines that aren't JSON
 *  objects are logged, cut to 200 characters, and skipped. A line over `MAX_LINE` bytes is a protocol failure: the
 *  reading stops, `kill()` runs, pending requests fail. `onClosed()` runs once, when stdout ends or on that failure.
 *
 *  Writes resolve once the stream took the bytes and reject with `RpcClosed` when stdin is broken. A small write to an
 *  app-server that closed its stdin can still succeed (the bytes sit in the pipe buffer): such a request is settled
 *  when stdout closes or its timeout fires. */
export class JsonRpc {
  readonly #in: Writable
  readonly #out: Readable
  readonly #handlers: RpcHandlers
  readonly #log: (line: string) => void
  #nextId = 1
  readonly #waiting = new Map<number, Waiter>()
  #closed = false
  #broken: string | null = null
  #chunks: Buffer[] = []
  #size = 0

  constructor(stdin: Writable, stdout: Readable, handlers: RpcHandlers) {
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

  /** Sends a request and resolves with its result; `RpcError` for an error answer, `RpcClosed` if the server goes or
   *  the write fails, an `Error` named `TimeoutError` after `timeout` ms. */
  request(method: string, params?: unknown, { timeout = 60_000 } = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RpcClosed(`the app-server closed before answering ${method}`))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.#waiting.delete(id)
      }
      const timer = setTimeout(() => {
        done()
        const error = new Error(`${method} got no answer in ${(timeout / 1000).toFixed(0)}s`)
        error.name = "TimeoutError"
        reject(error)
      }, timeout)
      const fail = (error: Error) => {
        done()
        reject(error)
      }
      this.#waiting.set(id, {
        method,
        answer: (msg) => {
          done()
          if (!Object.hasOwn(msg, "error")) return resolve(msg.result)
          const e = (msg.error || {}) as Msg
          reject(new RpcError((e.code as number) ?? 0, (e.message as string) ?? "", e.data))
        },
        fail,
      })
      this.#send({ id, method, params: params ?? {} }).catch(fail)
    })
  }

  /** Sends a notification; `params` is left out when undefined. */
  notify(method: string, params?: unknown): Promise<void> {
    return this.#send(params === undefined ? { method } : { method, params })
  }

  /** Answers the server's request `id` with `result`. */
  reply(id: unknown, result: unknown): Promise<void> {
    return this.#send({ id, result })
  }

  /** Answers the server's request `id` with a JSON-RPC error. */
  replyError(id: unknown, code: number, message: string): Promise<void> {
    return this.#send({ id, error: { code, message } })
  }

  #send(msg: Msg): Promise<void> {
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
      if (broken) return reject(new RpcClosed(`the app-server's stdin is closed (${broken})`))
      stdin.write(JSON.stringify(msg) + "\n", (error) => {
        if (!error) return resolve()
        this.#broken ??= codeOf(error)
        reject(new RpcClosed(`the app-server's stdin is closed (${codeOf(error)})`))
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
    this.#failAll((method) => new RpcClosed(`the app-server closed before answering ${method}`))
    this.#handlers.onClosed()
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
    this.#log("codex: a line over the 16 MiB limit; stopping the app-server")
    this.#handlers.kill()
    this.#failAll(() => new RpcClosed(OVER_CAP))
    this.#handlers.onClosed()
  }

  #failAll(error: (method: string) => Error): void {
    for (const waiter of [...this.#waiting.values()]) waiter.fail(error(waiter.method))
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
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      const shown = (text ?? UTF8_LOOSE.decode(bytes)).slice(0, 200)
      this.#log(`codex: a line that isn't a JSON object: ${JSON.stringify(shown)}`)
      return
    }
    const m = msg as Msg
    if (Object.hasOwn(m, "method")) {
      const method = m.method as string
      const params = m.params || {}
      if (Object.hasOwn(m, "id")) this.#handleRequest(m.id, method, params)
      else
        try {
          this.#handlers.onNotification(method, params)
        } catch (error) {
          this.#log(`codex: the ${String(method).slice(0, 200)} handler failed (${nameOf(error)})`)
        }
      return
    }
    this.#waiting.get(m.id as number)?.answer(m)
  }

  #handleRequest(id: unknown, method: string, params: unknown): void {
    try {
      this.#handlers.onRequest(id, method, params)
    } catch (error) {
      const shown = String(method).slice(0, 200)
      this.#log(`codex: the ${shown} handler failed (${nameOf(error)})`)
      // Codex would wait for this answer forever.
      this.replyError(id, -32603, `the office couldn't handle ${method}`).catch(() =>
        this.#log(`codex: couldn't answer ${shown}: the app-server's stdin is closed`),
      )
    }
  }
}
