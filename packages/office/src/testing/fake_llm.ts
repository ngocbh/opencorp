/** A scripted OpenAI-compatible chat server for tests that run yian flows in-process or in worker processes. */
import http from "node:http"
import type { AddressInfo } from "node:net"

export const LLM_CONFIG: Readonly<{ provider: "vllm"; model: "stub" }> = Object.freeze({
  provider: "vllm",
  model: "stub",
})
/** yian (like the OpenAI SDK) retries 5xx replies; this header turns that off. */
export const NO_RETRY: Readonly<{ "x-should-retry": "false" }> = Object.freeze({ "x-should-retry": "false" })

export interface ScriptedToolCall {
  name: string
  arguments?: unknown
  id?: string
}

/** One scripted answer: any of `content`, `tool_calls`, `usage`; `match`, a substring the request's messages must
 *  contain; `error`, an HTTP status to return instead; `hold`, `true` to wait until `release()`, or at most that
 *  many seconds. */
export interface ScriptedReply {
  content?: string
  tool_calls?: ScriptedToolCall[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  match?: string
  error?: number
  hold?: boolean | number
}

/** A JSON body from the wire: `any`, since its shape is whatever the client sent. */
type Obj = Record<string, any>
/** A held reply's waiter, and its timer when the hold has a limit. */
type Hold = { resolve: () => void; timer?: ReturnType<typeof setTimeout> }

const ROUTES: Record<string, string> = {
  "/v1/chat/completions": "POST",
  "/v1/models": "GET",
  "/_script": "POST",
  "/_requests": "GET",
  "/_release": "POST",
}
const PIECES = /\S+\s*|\s+/g

/** Answers `status` with `body` as JSON, unless the client has gone. */
function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed) return
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function usageOf(reply: ScriptedReply): Obj {
  const prompt = reply.usage?.prompt_tokens ?? 10
  const completion = reply.usage?.completion_tokens ?? 5
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

/** A chat-completions server on `127.0.0.1:<free port>` that answers from a script.
 *
 *  A request takes the first queued reply it matches; an unmatched request gets a `500` carrying the request.
 *  Error replies are never retried. `GET /v1/models` lists the one model `LLM_CONFIG` names, and isn't recorded as
 *  a request. Tests script it in-process, or over HTTP with `POST /_script`, `GET /_requests` and `POST
 *  /_release`. */
export class FakeLLM {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string
  readonly #server: http.Server
  #script: ScriptedReply[] = []
  #requests: Obj[] = []
  #authorizations: (string | null)[] = []
  #holds: Hold[] = []
  #ids = 0

  private constructor(server: http.Server, baseUrl: string) {
    this.#server = server
    this.baseUrl = baseUrl
  }

  /** Starts a server listening on 127.0.0.1 at a free port. */
  static async start(): Promise<FakeLLM> {
    let fake: FakeLLM | undefined
    const server = http.createServer((req, res) => void fake!.#handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    fake = new FakeLLM(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    return fake
  }

  /** Lets every held reply go, ends open connections and stops listening; a second call does nothing. */
  async close(): Promise<void> {
    this.release()
    // Bun's closeAllConnections also stops the listener, so close() then reports it isn't running.
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
      ),
    )
  }

  /** The environment that points yian's `vllm` provider at this server. */
  env(): Record<string, string> {
    return { VLLM_BASE_URL: `${this.baseUrl}/v1` }
  }

  /** Queues replies, in order. */
  script(...replies: ScriptedReply[]): void {
    this.#script.push(...replies.map((reply) => structuredClone(reply)))
  }

  /** Every chat request body received so far, one per HTTP request. */
  requests(): Record<string, unknown>[] {
    return structuredClone(this.#requests)
  }

  /** The `Authorization` header of each chat request, in order; null where there was none. */
  authorizations(): (string | null)[] {
    return [...this.#authorizations]
  }

  /** Drops the requests received so far, so the next one is `requests()[0]`. */
  forget(): void {
    this.#requests = []
    this.#authorizations = []
  }

  /** The replies still queued. */
  pending(): ScriptedReply[] {
    return structuredClone(this.#script)
  }

  /** Lets every held reply go. */
  release(): void {
    const holds = this.#holds
    this.#holds = []
    for (const hold of holds) {
      clearTimeout(hold.timer)
      hold.resolve()
    }
  }

  /** Waits until `count` requests have arrived and returns them; throws after `timeout` ms. */
  async waitForRequests(count: number, timeout = 10_000): Promise<Record<string, unknown>[]> {
    const deadline = performance.now() + timeout
    for (;;) {
      const seen = this.requests()
      if (seen.length >= count) return seen
      if (performance.now() > deadline) throw new Error(`${seen.length} of ${count} requests arrived`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A client that has gone makes writes fail; its reply is dropped quietly.
    res.on("error", () => {})
    try {
      const route = new URL(req.url ?? "/", this.baseUrl).pathname
      const method = ROUTES[route]
      if (method === undefined) return send(res, 404, { detail: "Not Found" }, NO_RETRY)
      if (req.method !== method) return send(res, 405, { detail: "Method Not Allowed" }, NO_RETRY)
      if (route === "/v1/chat/completions") return await this.#completions(req, res)
      if (route === "/v1/models") {
        return send(res, 200, { object: "list", data: [{ id: LLM_CONFIG.model, object: "model" }] })
      }
      if (route === "/_script") {
        this.script(...(JSON.parse(await readBody(req)) as Obj).replies)
        return send(res, 200, { queued: this.#script.length })
      }
      if (route === "/_requests") return send(res, 200, this.requests())
      this.release()
      send(res, 200, {})
    } catch {
      if (!res.headersSent) send(res, 500, { error: { message: "the fake LLM failed", type: "server_error" } }, NO_RETRY)
      else res.end()
    }
  }

  async #completions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Obj
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, { error: { message: "the request body isn't JSON", type: "invalid_request" } }, NO_RETRY)
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return send(res, 400, { error: { message: "the request body isn't an object", type: "invalid_request" } }, NO_RETRY)
    }
    this.#requests.push(body)
    this.#authorizations.push(req.headers.authorization ?? null)
    const reply = this.#take(body)
    if (reply === undefined) {
      const error = { message: "no scripted reply matches this request", type: "server_error", request: body }
      return send(res, 500, { error }, NO_RETRY)
    }
    if (reply.hold) await this.#hold(reply.hold)
    if (reply.error) {
      const error = { message: `scripted error ${reply.error}`, type: "server_error" }
      return send(res, Number(reply.error), { error }, NO_RETRY)
    }
    const calls = (reply.tool_calls ?? []).map((call) => this.#toolCall(call))
    const finish = calls.length ? "tool_calls" : "stop"
    const created = Math.floor(Date.now() / 1000)
    const model = body.model ?? "stub"
    if (body.stream) {
      if (res.destroyed) return
      const head = { id: "chatcmpl-fake", object: "chat.completion.chunk", created, model }
      const chunk = (delta: Obj, finishReason: string | null = null) => ({
        ...head,
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
      })
      const frames: Obj[] = [chunk({ role: "assistant", content: "" })]
      for (const piece of (reply.content ?? "").match(PIECES) ?? []) frames.push(chunk({ content: piece }))
      calls.forEach((call, index) => frames.push(chunk({ tool_calls: [{ index, ...call }] })))
      frames.push(chunk({}, finish))
      if (body.stream_options?.include_usage) frames.push({ ...head, choices: [], usage: usageOf(reply) })
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n")
      return
    }
    const message: Obj = { role: "assistant", content: reply.content || (calls.length ? null : "") }
    if (calls.length) message.tool_calls = calls
    send(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
      usage: usageOf(reply),
    })
  }

  /** Removes and returns the first queued reply whose `match` (if any) is in the request's messages. */
  #take(body: Obj): ScriptedReply | undefined {
    const text = JSON.stringify(body.messages ?? [])
    const index = this.#script.findIndex((reply) => reply.match === undefined || text.includes(reply.match))
    return index === -1 ? undefined : this.#script.splice(index, 1)[0]
  }

  /** Waits until `release()`, or at most `hold` seconds when it is a positive number. */
  #hold(hold: boolean | number): Promise<void> {
    return new Promise((resolve) => {
      const waiter: Hold = { resolve }
      const seconds = Number(hold)
      if (hold !== true && Number.isFinite(seconds) && seconds > 0) {
        waiter.timer = setTimeout(() => {
          this.#holds = this.#holds.filter((other) => other !== waiter)
          resolve()
        }, seconds * 1000)
      }
      this.#holds.push(waiter)
    })
  }

  #toolCall(call: ScriptedToolCall): Obj {
    const args = call.arguments ?? {}
    return {
      id: call.id || `call_${++this.#ids}`,
      type: "function",
      function: { name: call.name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    }
  }
}
