/** Request/reply calls over a worker channel, and the office-side handler interface. */
import { MarkdownVersionMismatch, type MarkdownStore } from "@ngocbh/yian"
import { repr } from "../perm/redact.ts"
import { ChannelClosed, type Channel, type Frame } from "./channel.ts"
import type { DeclaredTool, Job } from "./job.ts"

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

/** A tool the office runs for a worker: its declared description and schema, and the call itself. */
export interface OfficeTool extends DeclaredTool {
  call(args: Record<string, unknown>): unknown
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
  /** A Yian stream chunk's fields. */
  stream(worker: W, frame: Frame): void
  /** Steer messages the run did not read before `nodeId` finished. */
  steerLeft(worker: W, nodeId: string, texts: string[]): void
  /** The job finished: `status`, `run_id`, `output`, `failure`, `backward`. */
  result(worker: W, frame: Frame): void
  /** The job threw before it could finish. */
  error(worker: W, frame: Frame): void
  /** The worker process is gone; called once, last. */
  exited(worker: W, returncode: number | null): void
  /** Answers a question for `worker.job.session_id`. */
  askUser(worker: W, request: AskRequest): unknown
  /** Runs tool `name` of `group` with `args`; the result must be JSON data. */
  toolCall(worker: W, group: string, name: string, args: Record<string, unknown>): unknown
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

  steerLeft(_worker: unknown, _nodeId: string, _texts: string[]): void {}

  result(_worker: unknown, _frame: Frame): void {}

  error(_worker: unknown, _frame: Frame): void {}

  exited(_worker: unknown, _returncode: number | null): void {}

  askUser(_worker: unknown, _request: AskRequest): unknown {
    throw new Error("nobody is here to answer")
  }

  async toolCall(_worker: unknown, group: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const named = Object.hasOwn(this.tools, group) ? this.tools[group]! : {}
    if (!Object.hasOwn(named, name)) throw new Error(noTool(group, name))
    return await named[name]!.call(args)
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
 * The reply frame for a worker's request `frame`, from `handlers`, after checking it against `worker.job`.
 *
 * A malformed request, a tool not in the job's groups, or a failing tool or question is `{error: "failed",
 * message}`. A store error is `mismatch` (with `expected` and `current`) for `MarkdownVersionMismatch`;
 * `unknown_version` for a `RangeError` from a read and `invalid` for one from a write; `invalid` for a `TypeError`;
 * and `unavailable` for anything else, a store the job doesn't name included. Throws a `TypeError` for a frame
 * whose type isn't a request type.
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
      case "ask_user":
        return { ...head, answer: (await handlers.askUser(worker, args.request)) ?? null }
      case "tool_call":
        return { ...head, result: (await handlers.toolCall(worker, args.group, args.name, args.args)) ?? null }
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
  | { kind: "ask_user"; request: AskRequest }
  | { kind: "tool_call"; group: string; name: string; args: Record<string, unknown> }
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
      return { kind, request: Object.fromEntries(ASK_KEYS.map((key) => [key, pick(key)])) as AskRequest }
    }
    case "tool_call":
      return {
        kind,
        group: need("group", isString),
        name: need("name", isString),
        args: maybe("args", isPlainObject) ?? {},
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

/** Throws the handlers' own refusal for a tool not in `job.groups` or a store no `job.memory` spec names; `ask_user`
 *  needs no grant. */
function checkJob(job: Job, args: RequestArgs): void {
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
function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    const name: unknown = error.name
    return typeof name === "string" && NAME.test(name) ? name : "Error"
  } catch {
    return "Error"
  }
}

/** A thrown value's message for a reply; never throws. `String(value)` can, so another non-`Error` gets fixed text. */
function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  try {
    if (!(error instanceof Error)) return "a non-Error value was thrown"
    const message: unknown = error.message
    if (typeof message === "string" && message !== "") return message
  } catch {}
  return errorName(error)
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
