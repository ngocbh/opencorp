/** Request/reply calls over a worker channel, and the office-side handler interface. */
import { MarkdownVersionMismatch, type MarkdownStore } from "@ngocbh/yian"
import { type AskHandler, type FunctionTool, isPending, pending, ReportedToolError, tool } from "@ngocbh/yian/tools"
import { z } from "zod"
import { repr } from "../perm/redact.ts"
import { ChannelClosed, type Channel, type Frame } from "./channel.ts"
import type { DeclaredTool, Job, ToolSpec } from "./job.ts"

/** JSON object data, as a store write's provenance holds it. */
export type JsonObject = NonNullable<Parameters<MarkdownStore["write"]>[1]["provenance"]>

/** The keys Yian passes to an `ask_user` handler. */
export const ASK_KEYS = ["question", "questions", "answer_schema", "title", "node_id", "options"] as const
/** An `ask_user` request: each of the `ASK_KEYS`, `null` when absent. */
export type AskRequest = Record<(typeof ASK_KEYS)[number], unknown>

/** Worker -> office request frame type -> office -> worker reply frame type. */
export const REQUEST_REPLIES = {
  ask_user: "answer",
  tool_call: "tool_result",
  store_read: "store_reply",
  store_write: "store_reply",
} as const
/** A worker -> office request frame type. */
export type RequestType = keyof typeof REQUEST_REPLIES
/** The office -> worker reply frame types. */
export const REPLY_TYPES: ReadonlySet<string> = new Set(Object.values(REQUEST_REPLIES))

/** Whether `type` is a request frame type: an own key of `REQUEST_REPLIES`, so `toString` or `__proto__` is not. */
export function isRequest(type: unknown): type is RequestType {
  return typeof type === "string" && Object.hasOwn(REQUEST_REPLIES, type)
}

/** The office answered a request with an error reply; `code` is its `error`. */
export class RemoteError extends Error {
  /** The reply's `error` code. */
  readonly code: string
  /** A copy of the error reply. */
  readonly reply: Frame

  constructor(reply: Frame) {
    super(String(reply.message || reply.error))
    this.name = "RemoteError"
    this.code = String(reply.error)
    this.reply = { ...reply }
  }
}

/** The office refuses a model's `ask_user` request the model can fix (a blank question, or a question or options that
 *  aren't valid text); the message names only the field, never its value. The reply is `{error: "refused"}`, which
 *  the model reads as the call's result. */
export class AskRefused extends Error {
  override name = "AskRefused"
}

/** Numbered requests over a channel, on the worker side; a reader loop hands replies to `deliver`. In the worker
 *  process the process exits when its channel closes; in process, the reader calls `close`. */
export class Rpc {
  #lastId = 0
  readonly #waiting = new Map<number, { resolve: (reply: Frame) => void; reject: (error: unknown) => void }>()
  #closed: { error: unknown } | undefined

  constructor(readonly channel: Channel) {}

  /** Sends a `type` request frame with `fields` and resolves to its reply; rejects with `RemoteError` for an error
   *  reply, with the send's own error, with `signal.reason` once `signal` aborts (a later reply is dropped), or
   *  with the error `close` was given. */
  async request(type: RequestType, fields: Frame = {}, { signal }: { signal?: AbortSignal } = {}): Promise<Frame> {
    if (this.#closed) throw this.#closed.error
    if (signal?.aborted) throw signal.reason
    const id = ++this.#lastId
    let onAbort: (() => void) | undefined
    let reply: Frame
    try {
      // Registered before the send, so a reply that arrives at once finds its waiter.
      const replied = new Promise<Frame>((resolve, reject) => {
        this.#waiting.set(id, { resolve, reject })
        if (signal) {
          onAbort = () => {
            this.#waiting.delete(id)
            reject(signal.reason)
          }
          signal.addEventListener("abort", onAbort, { once: true })
        }
      })
      // Observed at once: an abort while the send is pending, or after it failed, must not be unhandled.
      replied.catch(() => {})
      await this.channel.send({ ...fields, type, id })
      reply = await replied
    } finally {
      this.#waiting.delete(id)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }
    if (Object.hasOwn(reply, "error")) throw new RemoteError(reply)
    return reply
  }

  /** Rejects every pending request with `error`, and every later one. */
  close(error: unknown): void {
    this.#closed ??= { error }
    const waiting = [...this.#waiting.values()]
    this.#waiting.clear()
    for (const { reject } of waiting) reject(error)
  }

  /** Completes the request `frame` answers; `false` if none is waiting. */
  deliver(frame: Frame): boolean {
    const waiter = typeof frame.id === "number" ? this.#waiting.get(frame.id) : undefined
    if (waiter === undefined) return false
    waiter.resolve(frame)
    return true
  }
}

/** A zod type for one JSON Schema property. `integer` and `number` take a `bigint` too, as Yian hands an integer
 *  past 2^53. */
function zodType(schema: Record<string, unknown>): z.ZodType {
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.map((option) => zodType(isPlainObject(option) ? option : {}))
    return options.length === 1 ? options[0]! : z.union(options)
  }
  const kind = schema.type
  if (Array.isArray(kind)) return z.union(kind.map((type) => zodType({ ...schema, type })))
  if (Array.isArray(schema.enum)) return z.literal(schema.enum as z.core.util.Literal[])
  switch (kind) {
    case "array":
      return z.array(zodType(isPlainObject(schema.items) ? schema.items : {}))
    case "string":
      return z.string()
    case "integer":
      return z.union([z.int(), z.bigint()])
    case "number":
      return z.union([z.number(), z.bigint()])
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "object":
      // Not z.record, which rebuilds the object and drops an own `__proto__` key.
      return z.custom<Record<string, unknown>>(isPlainObject)
    default:
      return z.unknown()
  }
}

/** A zod object for a JSON Schema object: its properties, in order, with their descriptions; a property not
 *  `required` defaults to its `default`, else `null`. `name` is unused (Python names its model). zod skips a
 *  property named `__proto__`: the parsed value lacks it (pydantic refuses such a name outright). */
export function modelFromSchema(
  _name: string,
  schema: Record<string, unknown>,
): z.ZodObject<Record<string, z.ZodType>> {
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(properties)) {
    const prop = isPlainObject(value) ? value : {}
    let field = zodType(prop)
    if (typeof prop.description === "string") field = field.describe(prop.description)
    if (!required.includes(key)) field = field.default(prop.default ?? null)
    // Defined, not assigned, so a property named `__proto__` can't replace the shape's prototype.
    Object.defineProperty(shape, key, { value: field, enumerable: true, writable: true, configurable: true })
  }
  return z.object(shape)
}

/**
 * A tool that runs `spec` in the office: one `tool_call` request per call, with the call's id. The model sees
 * `spec.parameters` unchanged; Yian checks a call against it, then `modelFromSchema` fills the defaults. A pending
 * reply returns Yian's pending marker: the office answers the call later.
 *
 * An error reply throws `ReportedToolError` (`error: <message>`), which an AGENT's model reads as the call's result.
 * The request ends when the call's signal aborts, as it does when the run stops.
 */
export function remoteTool(rpc: Rpc, group: string, spec: ToolSpec): FunctionTool {
  return tool({
    name: spec.name,
    description: spec.description || spec.name,
    parameters: modelFromSchema(`${spec.name}_args`, spec.parameters),
    // The job's schema already checked that the parameters are a JSON object.
    parametersJsonSchema: spec.parameters as JsonObject,
    execute: async (args, ctx) => {
      try {
        const fields = { group, name: spec.name, args, call_id: ctx.callId }
        const reply = await rpc.request("tool_call", fields, { signal: ctx.signal })
        return reply.pending === true ? pending() : (reply.result ?? null)
      } catch (error) {
        if (isInstance(error, RemoteError)) throw new ReportedToolError(`error: ${error.message}`)
        throw error
      }
    },
  })
}

/** Yian's ask handler, answered by the office through an `ask_user` request with the six `ASK_KEYS`, the call's id
 *  and its deadline; a pending reply returns Yian's pending marker. A `refused` reply to a model's call (no node id)
 *  throws `ReportedToolError` (`error: <message>`), which the model reads as the call's result; any other error reply
 *  throws a plain `Error`. The request ends when the call's signal aborts, as it does when the run stops. */
export function askUserStub(rpc: Rpc): AskHandler {
  return async ({ question, questions, answerSchema, title, nodeId, options, callId, deadline }, ctx) => {
    const request = {
      question: question ?? null,
      questions: questions ?? null,
      answer_schema: answerSchema ?? null,
      title: title ?? null,
      node_id: nodeId ?? null,
      options: options ?? null,
    }
    try {
      const reply = await rpc.request("ask_user", { request, call_id: callId, deadline }, { signal: ctx.signal })
      return reply.pending === true ? pending() : (reply.answer ?? null)
    } catch (error) {
      if (isInstance(error, RemoteError)) {
        // Only the model can fix its own request; a flow's `ask` node, or an office failure, fails as before.
        if (error.code === "refused" && !nodeId) throw new ReportedToolError(`error: ${error.message}`)
        throw new Error(`ask_user failed: ${error.message}`)
      }
      throw error
    }
  }
}

/** What an office tool's call gets beside its arguments: the yian call id, and a signal that aborts the call. */
export interface ToolCallOptions {
  readonly callId?: string
  readonly signal?: AbortSignal
}

/** A tool the office runs for a worker: its declared description and schema, and the call itself. */
export interface OfficeTool extends DeclaredTool {
  call(args: Record<string, unknown>, options?: ToolCallOptions): unknown
}

/** What `answerRequest` checks a request against: the worker's job. */
export interface JobWorker {
  readonly job: Job
}

/**
 * What the office does with a worker's frames. `worker` is the worker the frame came from.
 *
 * Notifications (`event` through `exited`) must not block. Requests (`askUser` through `storeWrite`) may: what they
 * return (or resolve to) is the reply, and what they throw becomes an error reply.
 */
export interface WorkerHandlers<W extends JobWorker = JobWorker> {
  /** A Yian run event: `{name, data}`. */
  event(worker: W, frame: Frame): void
  /** A live frame of the run: `{type: "stream", frame}`, `frame` a yian `LiveFollowFrame` (a `record` possibly
   *  without its `line`, when the frame would exceed the channel's limit). */
  stream(worker: W, frame: Frame): void
  /** A delivery's answer: `{id, seq, closed?}`, `{id, refused}` or `{id, failed}`; never a message text. */
  deliverReply(worker: W, frame: Frame): void
  /** The job finished: `status`, `run_id`, `output`, `failure`, `waits`; a `check` job's is `{problem}`. */
  result(worker: W, frame: Frame): void
  /** The job threw before it could finish. */
  error(worker: W, frame: Frame): void
  /** The worker kept its process after the job's `kept` result and answered every delivery sent before; it runs no
   *  job until `next`, which hands its frames to other handlers. */
  parked(worker: W): void
  /** The worker process is gone; called once, last. */
  exited(worker: W, returncode: number | null): void
  /**
   * Answers a question for `worker.job.session_id`; `callId` is the yian call id (it starts with
   * `${worker.job.run_id}/`). It may return Yian's `pending()` instead: the reply is then `{pending: true}`, and the
   * office answers the call later by `complete` on `callId`.
   */
  askUser(worker: W, request: AskRequest, callId: string): unknown
  /**
   * Runs tool `name` of `group` with `args`; the result must be JSON data. `callId` is the yian call id (it starts
   * with `${worker.job.run_id}/`). It may return Yian's `pending()` instead: the reply is then `{pending: true}`, and
   * the office answers the call later by `complete` on `callId`.
   */
  toolCall(worker: W, group: string, name: string, args: Record<string, unknown>, callId: string): unknown
  /** `MarkdownStore.read` on the office store named `store`. */
  storeRead(
    worker: W,
    store: string,
    version: string | null,
  ): readonly [string, string] | Promise<readonly [string, string]>
  /** `MarkdownStore.write` on the office store named `store`. */
  storeWrite(
    worker: W,
    store: string,
    text: string,
    baseVersion: string,
    provenance: JsonObject | null,
  ): string | Promise<string>
}

/** Handlers that ignore notifications, refuse questions, and serve the given tools and stores.
 *  `tools` is `{group: {name: tool}}`; `stores` is `{name: store}`. Subclass it and override what you need. */
export class BaseHandlers implements WorkerHandlers {
  /** A copy of the given tools, each group copied too. */
  readonly tools: Record<string, Record<string, OfficeTool>>
  /** A copy of the given stores. */
  readonly stores: Record<string, MarkdownStore>

  constructor({
    tools = {},
    stores = {},
  }: { tools?: Record<string, Record<string, OfficeTool>>; stores?: Record<string, MarkdownStore> } = {}) {
    this.tools = Object.fromEntries(Object.entries(tools).map(([group, named]) => [group, { ...named }]))
    this.stores = { ...stores }
  }

  event(_worker: unknown, _frame: Frame): void {}

  stream(_worker: unknown, _frame: Frame): void {}

  deliverReply(_worker: unknown, _frame: Frame): void {}

  result(_worker: unknown, _frame: Frame): void {}

  error(_worker: unknown, _frame: Frame): void {}

  parked(_worker: unknown): void {}

  exited(_worker: unknown, _returncode: number | null): void {}

  askUser(_worker: unknown, _request: AskRequest, _callId?: string): unknown {
    throw new Error("nobody is here to answer")
  }

  /** Calls tool `name` of `group` with `args` and `{ callId }`. */
  async toolCall(
    _worker: unknown,
    group: string,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<unknown> {
    const named = Object.hasOwn(this.tools, group) ? this.tools[group]! : {}
    if (!Object.hasOwn(named, name)) throw new Error(noTool(group, name))
    return await named[name]!.call(args, { callId })
  }

  storeRead(
    _worker: unknown,
    store: string,
    version: string | null,
  ): readonly [string, string] | Promise<readonly [string, string]> {
    return this.#store(store).read(version)
  }

  storeWrite(
    _worker: unknown,
    store: string,
    text: string,
    baseVersion: string,
    provenance: JsonObject | null,
  ): string | Promise<string> {
    return this.#store(store).write(text, { baseVersion, provenance })
  }

  #store(name: string): MarkdownStore {
    if (!Object.hasOwn(this.stores, name)) throw new Error(noStore(name))
    return this.stores[name]!
  }
}

/** Where `answerRequest` and `replyTo` write their log lines; never handed an error's message. */
export type RpcLog = (level: "INFO" | "WARNING", line: string) => void

/**
 * The reply frame for a worker's request `frame`, from `handlers`, after checking it against `worker.job`. A question
 * or tool call whose handler returns Yian's `pending()` is `{pending: true}`.
 *
 * A malformed request, a question or tool call whose `call_id` isn't of `worker.job`'s run, a tool not in the job's
 * groups, or a failing tool or question is `{error: "failed", message}`; a question the handler refuses with
 * `AskRefused` is `{error: "refused", message}`. A store error is `mismatch` (with `expected`
 * and `current`) for `MarkdownVersionMismatch`; `unknown_version` for a `RangeError` from a read and `invalid` for one
 * from a write; `invalid` for a `TypeError`; and `unavailable` for anything else, a store the job doesn't name
 * included. Throws a `TypeError` for a frame whose type isn't a request type.
 */
export async function answerRequest(
  frame: Frame,
  handlers: WorkerHandlers,
  worker: JobWorker,
  { log = noLog }: { log?: RpcLog } = {},
): Promise<Frame> {
  const kind = frame.type
  if (!isRequest(kind)) throw new TypeError("answerRequest was handed a frame that isn't a request")
  const head = { type: REQUEST_REPLIES[kind], id: frame.id ?? null }
  let args: RequestArgs
  try {
    args = requestArgs(kind, frame)
  } catch (error) {
    // Checked apart from the handler call, so a malformed request isn't taken for a store error.
    return { ...head, ...failed(kind, error, log) }
  }
  try {
    checkJob(worker.job, args)
    switch (args.kind) {
      case "ask_user": {
        const answer = await handlers.askUser(worker, args.request, args.callId)
        return isPending(answer) ? { ...head, pending: true } : { ...head, answer: answer ?? null }
      }
      case "tool_call": {
        const result = await handlers.toolCall(worker, args.group, args.name, args.args, args.callId)
        return isPending(result) ? { ...head, pending: true } : { ...head, result: result ?? null }
      }
      case "store_read": {
        const [text, version] = await handlers.storeRead(worker, args.store, args.version)
        return { ...head, text, version }
      }
      case "store_write": {
        const { store, text, baseVersion, provenance } = args
        return { ...head, version: await handlers.storeWrite(worker, store, text, baseVersion, provenance) }
      }
    }
  } catch (error) {
    if (isInstance(error, MarkdownVersionMismatch)) {
      const { expected, current } = error
      return { ...head, error: "mismatch", message: errorMessage(error), expected, current }
    }
    if (kind === "store_read" || kind === "store_write") {
      return { ...head, error: storeCode(kind, error), message: errorMessage(error) }
    }
    if (kind === "ask_user" && isInstance(error, AskRefused)) {
      write(log, "INFO", `worker ask_user request refused: ${errorName(error)}`)
      return { ...head, error: "refused", message: errorMessage(error) }
    }
    return { ...head, ...failed(kind, error, log) }
  }
}

/**
 * Answers the request `frame` on `channel`; never rejects. A frame that isn't a request is ignored. A reply to a
 * closed channel is dropped; a reply that can't be sent otherwise (too large, or not JSON data) is replaced by a
 * `failed` one, which is dropped in turn if it can't be sent either.
 */
export async function replyTo(
  channel: Pick<Channel, "send">,
  frame: Frame,
  handlers: WorkerHandlers,
  worker: JobWorker,
  { log = noLog }: { log?: RpcLog } = {},
): Promise<void> {
  const kind = frame.type
  if (!isRequest(kind)) return
  try {
    await channel.send(await answerRequest(frame, handlers, worker, { log }))
  } catch (error) {
    if (isInstance(error, ChannelClosed)) return
    const name = errorName(error)
    // Only the name and fixed text: the error's message could quote the reply.
    write(log, "WARNING", `worker could not answer a ${kind} request: ${name}`)
    const message = `the reply could not be sent (${name})`
    await channel.send({ type: REQUEST_REPLIES[kind], id: frame.id ?? null, error: "failed", message }).catch(() => {})
  }
}

type RequestArgs =
  | { kind: "ask_user"; request: AskRequest; callId: string }
  | { kind: "tool_call"; group: string; name: string; args: Record<string, unknown>; callId: string }
  | { kind: "store_read"; store: string; version: string | null }
  | { kind: "store_write"; store: string; text: string; baseVersion: string; provenance: JsonObject | null }

/** The handler arguments a request frame carries; throws a `TypeError` naming a missing or bad field, never its
 *  value. */
function requestArgs(kind: RequestType, frame: Frame): RequestArgs {
  const need = <T>(key: string, check: (value: unknown) => value is T): T => {
    const value = Object.hasOwn(frame, key) ? frame[key] : undefined
    if (value === undefined) throw new TypeError(`${kind} request is missing '${key}'`)
    if (!check(value)) throw new TypeError(`${kind} request has a bad '${key}'`)
    return value
  }
  const maybe = <T>(key: string, check: (value: unknown) => value is T): T | null => {
    const value = Object.hasOwn(frame, key) ? frame[key] : undefined
    return value === undefined || value === null ? null : need(key, check)
  }
  switch (kind) {
    case "ask_user": {
      const request = need("request", isPlainObject)
      const pick = (key: string) => (Object.hasOwn(request, key) ? (request[key] ?? null) : null)
      const asked = Object.fromEntries(ASK_KEYS.map((key) => [key, pick(key)])) as AskRequest
      return { kind, request: asked, callId: need("call_id", isString) }
    }
    case "tool_call":
      // `call_id` last, so a bad earlier field is still the one named.
      return {
        kind,
        group: need("group", isString),
        name: need("name", isString),
        args: maybe("args", isPlainObject) ?? {},
        callId: need("call_id", isString),
      }
    case "store_read":
      return { kind, store: need("store", isString), version: maybe("version", isString) }
    case "store_write":
      return {
        kind,
        store: need("store", isString),
        text: need("text", isString),
        baseVersion: need("base_version", isString),
        provenance: maybe("provenance", isPlainObject) as JsonObject | null,
      }
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Throws for a question or tool call whose call id isn't of `job`'s run, then the handlers' own refusal for a tool
 *  not in `job.groups` or a store no `job.memory` spec names; `ask_user` needs no grant. */
function checkJob(job: Job, args: RequestArgs): void {
  // A fixed text, so the reply never echoes the id sent.
  if ((args.kind === "ask_user" || args.kind === "tool_call") && !args.callId.startsWith(`${job.run_id}/`)) {
    throw new Error(`${args.kind} request's call_id is not this run's`)
  }
  if (args.kind === "tool_call") {
    const specs = Object.hasOwn(job.groups, args.group) ? job.groups[args.group]! : []
    if (!specs.some((spec) => spec.name === args.name)) throw new Error(noTool(args.group, args.name))
  } else if (args.kind !== "ask_user") {
    if (!Object.values(job.memory).some((spec) => spec.store === args.store)) throw new Error(noStore(args.store))
  }
}

/** A store error's reply code. A write's `RangeError` is never an unknown version (a lone surrogate, a non-finite
 *  provenance number or an undecodable current file), and a `TypeError` is a value the store refuses. */
function storeCode(kind: "store_read" | "store_write", error: unknown): string {
  if (isInstance(error, RangeError)) return kind === "store_read" ? "unknown_version" : "invalid"
  return isInstance(error, TypeError) ? "invalid" : "unavailable"
}

// The same texts whether the job check or the handlers refuse, so a worker can't tell which did.
function noTool(group: string, name: string): string {
  return `no tool ${repr(name)} in group ${repr(group)}`
}

function noStore(name: string): string {
  return `no store named ${repr(name)}`
}

function failed(kind: RequestType, error: unknown, log: RpcLog): Frame {
  // The name only: failed requests are routine, and the message can carry tool arguments.
  write(log, "INFO", `worker ${kind} request failed: ${errorName(error)}`)
  return { error: "failed", message: errorMessage(error) }
}

const NAME = /^[A-Za-z_$][\w$]{0,63}$/

/** A thrown value's name for a log line; never throws (a getter or a revoked `Proxy` can). */
export function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    const name: unknown = error.name
    return typeof name === "string" && NAME.test(name) ? name : "Error"
  } catch {
    return "Error"
  }
}

/** An errno code (`ENOENT`) and a syscall name (`realpath`): fixed tokens, never a value from the error's text. */
const ERRNO_CODE = /^E[A-Z0-9]{1,31}$/
const SYSCALL = /^[a-z][a-z0-9_]{0,31}$/

/** A thrown value's name for a log line, followed by its errno code and syscall when it has them (`Error ENOENT
 *  realpath`); never its message, and never throws. */
export function errorKind(error: unknown): string {
  const kind = [errorName(error)]
  try {
    const { code, syscall } = error as { code?: unknown; syscall?: unknown }
    if (typeof code === "string" && ERRNO_CODE.test(code)) {
      kind.push(code)
      if (typeof syscall === "string" && SYSCALL.test(syscall)) kind.push(syscall)
    }
  } catch {}
  return kind.join(" ")
}

/** A thrown value's message for a reply; never throws. `String(value)` can, so another non-`Error` gets fixed text. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  try {
    if (!(error instanceof Error)) return "a non-Error value was thrown"
    const message: unknown = error.message
    if (typeof message === "string" && message !== "") return message
  } catch {}
  return errorName(error)
}

/** The errno `code` (`EACCES`) and `syscall` (`mkdir`) of a failed system call, or of an `error` frame that carries
 *  them, each only when it reads as one: the office may log them, never the error's message. */
export function errnoFields(error: unknown): { code?: string; syscall?: string } {
  const { code, syscall } = (typeof error === "object" && error !== null ? error : {}) as NodeJS.ErrnoException
  return {
    ...(typeof code === "string" && /^E[A-Z0-9]{1,30}$/.test(code) ? { code } : {}),
    ...(typeof syscall === "string" && /^[a-z_]{1,30}$/.test(syscall) ? { syscall } : {}),
  }
}

/** Whether `error` is an instance of `type`; never throws (a revoked `Proxy` throws on `instanceof`). */
function isInstance<T>(error: unknown, type: abstract new (...args: never[]) => T): error is T {
  try {
    return error instanceof type
  } catch {
    return false
  }
}

function write(log: RpcLog, level: "INFO" | "WARNING", line: string): void {
  try {
    log(level, line)
  } catch {}
}

function noLog(): void {}
