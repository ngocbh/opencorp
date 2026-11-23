/** Request/reply calls over a worker channel, and the office-side handler interface. */
import { type MemoryBase, memoryErrorKind } from "@ngocbh/yian"
import { AuthError } from "@ngocbh/yian/llm_clients"
import type { JsonObject } from "@ngocbh/yian/run"
import {
  type AskHandler,
  type FunctionTool,
  type GateContext,
  type GatedCall,
  type GateDecision,
  isPending,
  isPermanentToolError,
  isReportedToolError,
  pending,
  ReportedToolError,
  tool,
} from "@ngocbh/yian/tools"
import { z } from "zod"
import { repr } from "../../util/redact.ts"
import { ChannelClosed, type Channel, type Frame } from "./channel.ts"
import type { DeclaredTool, Job, ToolSpec } from "./job.ts"
import { MemoryHost, type MemoryRequest, noMemory } from "./memory_host.ts"

export type { JsonObject }

/** The keys Yian passes to an `ask_user` handler. */
export const ASK_KEYS = ["question", "questions", "answer_schema", "title", "node_id", "options"] as const
/** An `ask_user` request: each of the `ASK_KEYS`, `null` when absent. */
export type AskRequest = Record<(typeof ASK_KEYS)[number], unknown>

/** Worker -> office request frame type -> office -> worker reply frame type. A `memory_<op>` request is the memory
 *  call `op` (`MemoryRequest`): a worker only reads a memory, so no request changes one. A `gate_call` asks whether a
 *  model's tool call may run (`gateHook`). */
export const REQUEST_REPLIES = {
  ask_user: "answer",
  tool_call: "tool_result",
  gate_call: "gate_decision",
  memory_open: "memory_reply",
  memory_snapshot: "memory_reply",
  memory_call: "memory_reply",
  memory_close: "memory_reply",
} as const
/** A worker -> office request frame type. */
export type RequestType = keyof typeof REQUEST_REPLIES
/** The office -> worker reply frame types. */
export const REPLY_TYPES: ReadonlySet<string> = new Set(Object.values(REQUEST_REPLIES))
/** The worker -> office frame `{type, id}` saying the agent that made tool call request `id` took an interrupt while
 *  the call runs (yian's `ToolContext.interrupted`): the office aborts that call's `interrupted` signal. It needs no
 *  reply. A call sent while the agent already holds one says `interrupted: true` in its own frame. */
export const TOOL_INTERRUPT = "tool_interrupt"

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
   *  with the error `close` was given. A request sent with `interrupted` already aborted says so (`interrupted:
   *  true`); once it aborts while the request waits for its reply, a `tool_interrupt` frame naming the request
   *  follows, once. Either way the request still waits for its reply. */
  async request(
    type: RequestType,
    fields: Frame = {},
    { signal, interrupted }: { signal?: AbortSignal; interrupted?: AbortSignal } = {},
  ): Promise<Frame> {
    if (this.#closed) throw this.#closed.error
    if (signal?.aborted) throw signal.reason
    const id = ++this.#lastId
    let onAbort: (() => void) | undefined
    let answered = false
    // Runs inside yian's interrupt call, so it never throws; a send that fails leaves the call to finish as it would.
    const onInterrupt = () => {
      if (!answered) this.channel.send({ type: TOOL_INTERRUPT, id }).catch(() => {})
    }
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
      const early = interrupted?.aborted === true
      await this.channel.send({ ...fields, type, id, ...(early ? { interrupted: true } : {}) })
      if (!early && interrupted?.aborted) onInterrupt()
      else if (!early) interrupted?.addEventListener("abort", onInterrupt, { once: true })
      reply = await replied
    } finally {
      answered = true
      this.#waiting.delete(id)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
      interrupted?.removeEventListener("abort", onInterrupt)
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
 * The request ends when the call's signal aborts, as it does when the run stops. An interrupt of the agent while the
 * call runs (`ctx.interrupted`) reaches the office as a `tool_interrupt` frame, and the office tool's own reply to it
 * is the call's result. A `resumable` spec lets yian send a call again, with its call id, when a crash or stop cut it
 * off before its result was recorded.
 */
export function remoteTool(rpc: Rpc, group: string, spec: ToolSpec): FunctionTool {
  return tool({
    name: spec.name,
    description: spec.description || spec.name,
    parameters: modelFromSchema(`${spec.name}_args`, spec.parameters),
    // The job's schema already checked that the parameters are a JSON object.
    parametersJsonSchema: spec.parameters as JsonObject,
    resumable: spec.resumable === true,
    execute: async (args, ctx) => {
      try {
        const fields = { group, name: spec.name, args, call_id: ctx.callId }
        const reply = await rpc.request("tool_call", fields, { signal: ctx.signal, interrupted: ctx.interrupted })
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

/** How long, in ms, a run waits for the office's gate to decide a call before the call is refused. The office
 *  decides at once, holding what waits for a person or a check, so only a stuck office reaches it. */
export const GATE_TIMEOUT_MS = 30_000

/** What a failed gate request's reply says, whatever failed in the office: it reaches the worker's log in yian's
 *  warning, so it never quotes the office's own error. */
export const GATE_FAILED = "the office's permission check failed"
/** What a call is refused with by handlers that don't gate their runs' calls (`BaseHandlers.gateCall`). */
export const UNGATED = "Not run: nothing here decides this session's calls."

/**
 * Yian's `beforeToolCall`, answered by the office: one `gate_call` request per model tool call, carrying the
 * `GatedCall` (`call`, in the wire's field names). The office's `{run: true}` runs the call, with its `note` when it
 * has one; `{refuse}` refuses it with that text; `{hold: true}` holds it (`pending()`) until the office releases or
 * completes it. An error reply, a reply of any other type or shape, a closed channel, a stop, or no reply within
 * `timeoutMs` makes the hook throw, and yian then refuses the call with its fixed text: the gate fails closed. The
 * request ends when the decision is no longer wanted (`ctx.signal`), and a late reply is dropped.
 */
export function gateHook(
  rpc: Rpc,
  {
    timeoutMs = GATE_TIMEOUT_MS,
    wraps,
  }: {
    timeoutMs?: number
    /** For a flow's call, the tool modules' tools the flow's own steps call (`wraps`): null when they can't be read,
     *  undefined for a call that isn't a flow's. */
    wraps?: (call: GatedCall) => Promise<readonly ModuleTool[] | null | undefined>
  } = {},
): (call: GatedCall, ctx: GateContext) => Promise<GateDecision> {
  return async (call, ctx) => {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
    const wrapped = call.source.kind === "flow" ? await readWraps(wraps, call) : undefined
    const request = { call: wireCall(call), ...(wrapped === undefined ? {} : { wraps: wrapped }) }
    return decisionOf(await rpc.request("gate_call", request, { signal }))
  }
}

/** A tool module's tool, by its `uses:` alias and export: what a flow's own step calls. */
export interface ModuleTool {
  readonly alias: string
  readonly export: string
}

/** The office's `GatedCall`: yian's, and, for a flow's call, the module tools the flow calls (`ModuleTool`); null or
 *  absent when they couldn't be read. */
export type OfficeGatedCall = GatedCall & { readonly wraps?: readonly ModuleTool[] | null }

/** `wraps(call)`, or null when there is none or it fails: what can't be read counts as every module tool. */
async function readWraps(
  wraps: ((call: GatedCall) => Promise<readonly ModuleTool[] | null | undefined>) | undefined,
  call: GatedCall,
): Promise<readonly ModuleTool[] | null> {
  try {
    return (await wraps?.(call)) ?? null
  } catch {
    return null
  }
}

/** The most module tools a `gate_call`'s `wraps` holds, and the longest alias or export: past them it is unread. */
const MAX_WRAPS = 1000
const MAX_WRAP_NAME = 256

/** A `gate_call` request's `wraps`: the module tools, or null for one that is null, malformed or too big. */
function wrapsOf(raw: unknown): readonly ModuleTool[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_WRAPS) return null
  const name = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= MAX_WRAP_NAME
  const tools: ModuleTool[] = []
  for (const item of raw) {
    const fields = isPlainObject(item) ? item : {}
    if (!name(fields.alias) || !name(fields.export)) return null
    tools.push({ alias: fields.alias as string, export: fields.export as string })
  }
  return tools
}

/** `call` in the wire's field names. */
function wireCall(call: GatedCall): Frame {
  return {
    call_id: call.callId,
    node: call.node,
    tool: call.tool,
    source: call.source,
    arguments: call.arguments,
    scopes: call.scopes.map(({ scope, callId }) => ({ scope, call_id: callId })),
    attempt: call.attempt,
  }
}

/** The yian decision a `gate_decision` reply says; throws a `TypeError` for a reply of any other type or shape. */
function decisionOf(reply: Frame): GateDecision {
  const { type, id: _id, ...fields } = reply
  if (type !== REQUEST_REPLIES.gate_call) throw new TypeError("the office's reply to a gate_call isn't a gate_decision")
  const keys = Object.keys(fields).sort().join(",")
  if (keys === "hold" && fields.hold === true) return pending()
  if (keys === "refuse" && typeof fields.refuse === "string") return { refuse: fields.refuse }
  if (keys === "run" && fields.run === true) return undefined
  if (keys === "note,run" && fields.run === true && typeof fields.note === "string") {
    return { run: true, note: fields.note }
  }
  throw new TypeError("the office's gate_decision reply is malformed")
}

/** The reply fields for the office's gate decision `decision`: `{run: true}` (with its `note`), `{refuse}` or
 *  `{hold: true}` for yian's `pending()`; throws a `TypeError` for anything else. */
function decisionFields(decision: unknown): Frame {
  if (isPending(decision)) return { hold: true }
  if (decision === undefined) return { run: true }
  if (isPlainObject(decision)) {
    const keys = Object.keys(decision).sort().join(",")
    if (keys === "refuse" && typeof decision.refuse === "string") return { refuse: decision.refuse }
    if ((keys === "run" || keys === "note,run") && decision.run === true) {
      if (decision.note === undefined) return { run: true }
      if (typeof decision.note === "string") return { run: true, note: decision.note }
    }
  }
  throw new TypeError("the gate's decision isn't a run, a refusal or pending()")
}

const nonEmpty = z.string().min(1)
/** A `GatedCall`'s `source` as the wire carries it: yian's `ToolSource`. */
const WireSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host"), group: nonEmpty.nullable(), tool: nonEmpty }),
  z.strictObject({ kind: z.literal("mcp"), server: nonEmpty, tool: nonEmpty }),
  z.strictObject({ kind: z.literal("module"), alias: nonEmpty, ref: nonEmpty, export: nonEmpty }),
  z.strictObject({ kind: z.literal("memory"), input: nonEmpty, tool: nonEmpty }),
  z.strictObject({ kind: z.literal("flow"), flow: nonEmpty, library: nonEmpty.nullable() }),
])
/** A `gate_call` request's `call`. `arguments` is the model's, kept as sent. */
const WireCall = z.strictObject({
  call_id: z.string(),
  node: z.string(),
  tool: z.string(),
  source: WireSource,
  arguments: z.custom<Record<string, unknown>>(isPlainObject),
  scopes: z.array(z.strictObject({ scope: z.string(), call_id: z.string() })),
  attempt: z.int().positive(),
})

/** The `GatedCall` a `gate_call` request's `call` carries; throws a `TypeError` naming the first bad field, never its
 *  value. */
function gatedCall(raw: unknown): GatedCall {
  const parsed = WireCall.safeParse(raw)
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.filter((key) => typeof key !== "symbol").join(".")
    throw new TypeError(`gate_call request has a bad 'call${where ? `.${where}` : ""}'`)
  }
  const call = parsed.data
  return {
    callId: call.call_id,
    node: call.node,
    tool: call.tool,
    source: call.source,
    arguments: call.arguments as GatedCall["arguments"],
    scopes: call.scopes.map(({ scope, call_id }) => ({ scope, callId: call_id })),
    attempt: call.attempt,
  }
}

/** What an office tool's call gets beside its arguments: the yian call id, a signal that aborts the call, and a
 *  signal that aborts when the agent that made the call takes an interrupt (Esc) while it runs. A tool that watches
 *  `interrupted` may stop early and reply with its own result, which the model reads; the agent then ends
 *  interrupted. */
export interface ToolCallOptions {
  readonly callId?: string
  readonly signal?: AbortSignal
  readonly interrupted?: AbortSignal
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
 * Notifications (`event` through `exited`) must not block. Requests (`askUser` through `memory`) may: what they
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
  /** The worker took its next job with other handlers: these get none of its frames after. */
  released(worker: W): void
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
   * the office answers the call later by `complete` on `callId`. `options.interrupted` aborts when the worker says the
   * agent that made the call took an interrupt while it runs.
   */
  toolCall(
    worker: W,
    group: string,
    name: string,
    args: Record<string, unknown>,
    callId: string,
    options?: { interrupted?: AbortSignal },
  ): unknown
  /**
   * Decides whether the model's tool call `call` may run, before it starts (`call.callId` starts with
   * `${worker.job.run_id}/`), as a yian `GateDecision`: `undefined` or `{run: true}` runs it, with `note` kept in the
   * run log; `{refuse: text}` refuses it, and the model reads `text`; yian's `pending()` holds it until the office
   * answers it with a `release` or `complete` delivery. The run waits for the answer, so it must come quickly: a
   * person's or a check's answer is a hold. A throw or any other answer refuses the call.
   */
  gateCall(worker: W, call: OfficeGatedCall): unknown
  /** Runs the memory call `request` on the office memory the job names, or on a session the worker opened on one;
   *  resolves to the reply's fields. */
  memory(worker: W, request: MemoryRequest): Frame | Promise<Frame>
}

/** Handlers that ignore notifications, refuse questions, and serve the given tools and memories.
 *  `tools` is `{group: {name: tool}}`; `memories` is `{name: memory}`, which the worker only reads. Subclass it and
 *  override what you need; a `released` or `exited` override calls this one, which closes the sessions left open. */
export class BaseHandlers implements WorkerHandlers {
  /** A copy of the given tools, each group copied too. */
  readonly tools: Record<string, Record<string, OfficeTool>>
  /** The given memories, and the sessions the worker opens on them. */
  readonly memories: MemoryHost

  constructor({
    tools = {},
    memories = {},
  }: { tools?: Record<string, Record<string, OfficeTool>>; memories?: Record<string, MemoryBase> } = {}) {
    this.tools = Object.fromEntries(Object.entries(tools).map(([group, named]) => [group, { ...named }]))
    this.memories = new MemoryHost(memories)
  }

  event(_worker: unknown, _frame: Frame): void {}

  stream(_worker: unknown, _frame: Frame): void {}

  deliverReply(_worker: unknown, _frame: Frame): void {}

  result(_worker: unknown, _frame: Frame): void {}

  error(_worker: unknown, _frame: Frame): void {}

  parked(_worker: unknown): void {}

  /** Closes the memory sessions the worker's job left open: they belong to it. */
  released(_worker: unknown): void {
    void this.memories.close()
  }

  /** Closes the memory sessions the worker left open: they belong to its connection. */
  exited(_worker: unknown, _returncode: number | null): void {
    void this.memories.close()
  }

  askUser(_worker: unknown, _request: AskRequest, _callId?: string): unknown {
    throw new Error("nobody is here to answer")
  }

  /** Calls tool `name` of `group` with `args` and `{ callId }`, and its `interrupted` signal when it has one. */
  async toolCall(
    _worker: unknown,
    group: string,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
    { interrupted }: { interrupted?: AbortSignal } = {},
  ): Promise<unknown> {
    const named = Object.hasOwn(this.tools, group) ? this.tools[group]! : {}
    if (!Object.hasOwn(named, name)) throw new Error(noTool(group, name))
    return await named[name]!.call(args, interrupted === undefined ? { callId } : { callId, interrupted })
  }

  /** Refuses every call: a host whose runs call tools decides each one (its gate), so one that doesn't fails closed. */
  gateCall(_worker: unknown, _call: OfficeGatedCall): unknown {
    return { refuse: UNGATED }
  }

  memory(_worker: unknown, request: MemoryRequest): Promise<Frame> {
    return this.memories.answer(request)
  }
}

/** Where `answerRequest` and `replyTo` write their log lines; never handed an error's message. */
export type RpcLog = (level: "INFO" | "WARNING", line: string) => void

/**
 * The reply frame for a worker's request `frame`, from `handlers`, after checking it against `worker.job`. A question
 * or tool call whose handler returns Yian's `pending()` is `{pending: true}`. A gate call's reply is `{run: true}`
 * (with its `note`), `{refuse}`, or `{hold: true}` for `pending()`.
 *
 * A malformed request, a question, tool call or gate call whose `call_id` isn't of `worker.job`'s run, a tool not in
 * the job's groups, a memory the job doesn't name, or a failing tool, question or memory call is `{error: "failed",
 * message}`; a gate that fails or decides nothing of the right shape is `{error: "failed", message: GATE_FAILED}`; a
 * question the handler refuses with `AskRefused` is `{error: "refused", message}`. A memory call's error branded by
 * yian is its kind (`busy`, `change_id_reused` or `missing`), and a refusal the model reads (a `ReportedToolError`)
 * is `{error: "refused", message, permanent}`. Throws a `TypeError` for a frame whose type isn't a request type.
 */
export async function answerRequest(
  frame: Frame,
  handlers: WorkerHandlers,
  worker: JobWorker,
  { log = noLog, interrupted }: { log?: RpcLog; interrupted?: AbortSignal } = {},
): Promise<Frame> {
  const kind = frame.type
  if (!isRequest(kind)) throw new TypeError("answerRequest was handed a frame that isn't a request")
  const head = { type: REQUEST_REPLIES[kind], id: frame.id ?? null }
  let args: RequestArgs
  try {
    args = requestArgs(kind, frame)
  } catch (error) {
    // Checked apart from the handler call, so a malformed request isn't taken for a memory's error.
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
        const options = interrupted === undefined ? {} : { interrupted }
        const result = await handlers.toolCall(worker, args.group, args.name, args.args, args.callId, options)
        return isPending(result) ? { ...head, pending: true } : { ...head, result: result ?? null }
      }
      case "gate_call":
        try {
          return { ...head, ...decisionFields(await handlers.gateCall(worker, args.call)) }
        } catch (error) {
          // The name only, here and in the reply's fixed text: yian's warning puts the reply's text in the worker's
          // log, and the message could quote the call.
          write(log, "INFO", `worker gate_call request failed: ${errorName(error)}`)
          return { ...head, error: "failed", message: GATE_FAILED }
        }
      case "memory":
        return { ...head, ...(await handlers.memory(worker, args.request)) }
    }
  } catch (error) {
    if (args.kind === "memory") {
      const memoryKind = memoryErrorKind(error)
      if (memoryKind !== null) return { ...head, error: memoryKind, message: errorMessage(error) }
      if (isReportedToolError(error)) {
        return { ...head, error: "refused", message: errorMessage(error), permanent: isPermanentToolError(error) }
      }
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
  { log = noLog, interrupted }: { log?: RpcLog; interrupted?: AbortSignal } = {},
): Promise<void> {
  const kind = frame.type
  if (!isRequest(kind)) return
  try {
    await channel.send(await answerRequest(frame, handlers, worker, { log, interrupted }))
  } catch (error) {
    if (isInstance(error, ChannelClosed)) return
    const name = errorName(error)
    // Only the name and fixed text: the error's message could quote the reply.
    write(log, "WARNING", `worker could not answer a ${kind} request: ${name}`)
    const message = `the reply could not be sent (${name})`
    await channel.send({ type: REQUEST_REPLIES[kind], id: frame.id ?? null, error: "failed", message }).catch(() => {})
  }
}

/** The office's end of a worker's requests on `channel`: each request frame is answered in the background
 *  (`replyTo`), a tool call with an `interrupted` signal of its own, which the worker's `tool_interrupt` frame naming
 *  that request aborts. */
export class OfficeRequests {
  /** Each tool call in flight's interrupt, by its request id. */
  readonly #interrupts = new Map<number, AbortController>()

  constructor(
    private readonly channel: Pick<Channel, "send">,
    private readonly options: { log?: RpcLog } = {},
  ) {}

  /** Takes `frame` from `worker`, answered by `handlers`: a request (never awaited, since it may wait for a person),
   *  a tool call that says `interrupted` starting with its signal aborted; or a tool interrupt, which aborts the
   *  signal of the tool call in flight it names and is otherwise ignored. False for any other frame, which is the
   *  caller's. */
  take(frame: Frame, handlers: WorkerHandlers, worker: JobWorker): boolean {
    const kind = frame.type
    if (kind === TOOL_INTERRUPT) {
      if (typeof frame.id === "number") this.#interrupts.get(frame.id)?.abort()
      return true
    }
    if (!isRequest(kind)) return false
    // A repeated id keeps the first call's interrupt: the worker numbers its requests once each.
    const id = kind === "tool_call" && typeof frame.id === "number" && !this.#interrupts.has(frame.id) ? frame.id : null
    const interrupt = id === null ? undefined : new AbortController()
    if (id !== null) this.#interrupts.set(id, interrupt!)
    if (frame.interrupted === true) interrupt?.abort()
    const done = () => {
      if (id !== null && this.#interrupts.get(id) === interrupt) this.#interrupts.delete(id)
    }
    void replyTo(this.channel, frame, handlers, worker, { ...this.options, interrupted: interrupt?.signal }).finally(done)
    return true
  }
}

type RequestArgs =
  | { kind: "ask_user"; request: AskRequest; callId: string }
  | { kind: "tool_call"; group: string; name: string; args: Record<string, unknown>; callId: string }
  | { kind: "gate_call"; call: OfficeGatedCall }
  | { kind: "memory"; request: MemoryRequest }

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
    case "gate_call": {
      const call = gatedCall(need("call", isPlainObject))
      // A flow's call names the module tools it calls; with none sent, they count as unread.
      return { kind, call: call.source.kind === "flow" ? { ...call, wraps: wrapsOf(frame.wraps) } : call }
    }
    default:
      return { kind: "memory", request: memoryRequest(kind, need, maybe) }
  }
}

/** The memory request a `memory_<op>` frame carries, its fields read with `need` and `maybe`. */
function memoryRequest(
  kind: Exclude<RequestType, "ask_user" | "tool_call" | "gate_call">,
  need: <T>(key: string, check: (value: unknown) => value is T) => T,
  maybe: <T>(key: string, check: (value: unknown) => value is T) => T | null,
): MemoryRequest {
  switch (kind) {
    case "memory_open":
      return {
        op: "open",
        memory: need("memory", isString),
        create: need("create", isBoolean),
        itemType: maybe("item_type", isPlainObject) as JsonObject | null,
      }
    case "memory_snapshot":
      return { op: "snapshot", session: need("session", isString) }
    case "memory_call": {
      const session = need("session", isString)
      const tool = need("tool", isString)
      return { op: "call", session, tool, args: need("args", isPlainObject) as JsonObject }
    }
    case "memory_close":
      return { op: "close", session: need("session", isString) }
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Throws for a question, tool call or gate call whose call id isn't of `job`'s run, then the handlers' own refusal
 *  for a tool not in `job.groups` or a memory `job.memory` doesn't name; `ask_user`, a gate call (which runs nothing)
 *  and a call on an open session need no grant (the handlers know the sessions they opened). */
function checkJob(job: Job, args: RequestArgs): void {
  const callId = args.kind === "gate_call" ? args.call.callId : args.kind === "memory" ? null : args.callId
  // A fixed text, so the reply never echoes the id sent.
  if (callId !== null && !callId.startsWith(`${job.run_id}/`)) {
    throw new Error(`${args.kind} request's call_id is not this run's`)
  }
  if (args.kind === "tool_call") {
    const specs = Object.hasOwn(job.groups, args.group) ? job.groups[args.group]! : []
    if (!specs.some((spec) => spec.name === args.name)) throw new Error(noTool(args.group, args.name))
  } else if (args.kind === "memory" && args.request.op === "open") {
    if (!job.memory.includes(args.request.memory)) throw new Error(noMemory(args.request.memory))
  }
}

// The same texts whether the job check or the handlers refuse, so a worker can't tell which did.
function noTool(group: string, name: string): string {
  return `no tool ${repr(name)} in group ${repr(group)}`
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

/** What the office says, in place of its message, of an auth error that isn't a plain `AuthError`. */
export const SIGN_IN_UNUSABLE = "the connection's sign-in can't be used"

/** Whether `error` is a plain `AuthError`: fixed text naming what failed and its HTTP status, never a path or a
 *  key. yian's credential store throws a subclass, whose message names the auth file and how to fix it. */
export function plainAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError && Object.getPrototypeOf(error) === AuthError.prototype
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
