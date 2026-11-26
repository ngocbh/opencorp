import { z } from "zod"
import { GitId, Handle, Timestamp, Ulid } from "./common"

/**
 * One run the office launched, as the Run Logs list shows it: from the office's runs table, the session, its
 * questions and memory. No run log is read for it.
 */
export const RunSummary = z.strictObject({
  run_id: Ulid,
  session_id: Ulid,
  /** What ran: chat, side_chat, profile_manager or debrief; later SOPs and discussions. */
  flow: z.string().min(1),
  /** The flow's path in the company repo, at the session's pinned commit. */
  flow_path: z.string().min(1),
  /** The employee whose flow it is. */
  person: Handle,
  /**
   * Who started the run, fixed at launch: a human's handle, or `office` for runs the office starts itself.
   */
  driver: z.string().min(1),
  /**
   * Everyone else in it, the employee first: whoever answered its turns, cards or questions, or opened a side
   * chat on its cards. Never the driver.
   */
  participants: z.array(Handle).default(() => []),
  /**
   * The run it was started from: a side chat's card's run, a debrief's session's last run. Null for a
   * top-level run.
   */
  parent_run_id: Ulid.nullable().default(null),
  status: z.enum(["running", "waiting", "idle", "finished", "failed", "interrupted"]),
  /** Why it failed or was interrupted. */
  reason: z.string().max(200).nullable().default(null),
  /** The node it failed at, when it failed at one. */
  failed_node: z.string().min(1).nullable().default(null),
  /**
   * While running, waiting or idle: the node ids it is at now, deepest only. Empty while running means it is
   * starting.
   */
  current_nodes: z.array(z.string()).default(() => []),
  /** While waiting: a model question (one with no node) is open. */
  asking: z.boolean().default(false),
  /** While waiting: it is held at its cost cap, with nothing else open. */
  held: z.boolean().default(false),
  /** A debrief of a Codex session. */
  codex: z.boolean().default(false),
  launched_at: Timestamp,
  /** When the office learned it ended. Null while open, and for a run an office stop interrupted. */
  ended_at: Timestamp.nullable().default(null),
  /** The run of the same session this fresh run replaced. */
  replaces: Ulid.nullable().default(null),
  /** The fresh run of the same session that replaced this one. */
  replaced_by: Ulid.nullable().default(null),
  /**
   * On a top-level row of a list page and on a run's page: the newest 200 runs started from it, newest first.
   */
  // A getter lets the schema refer to itself; tsc needs the return type to type the cycle.
  get children(): z.ZodDefault<z.ZodArray<typeof RunSummary>> {
    return z.array(RunSummary).default(() => [])
  },
  /** How many runs were started from it, shown or not. */
  children_total: z.int().min(0).default(0),
})
export type RunSummary = z.input<typeof RunSummary>

/** One page of GET /runs: top-level runs, newest first, each with its children. */
export const RunPage = z.strictObject({
  runs: z.array(RunSummary),
  /** The `before` of the next page; null on the last. */
  next: Ulid.nullable().default(null),
})
export type RunPage = z.input<typeof RunPage>

/** What a run's model calls used, as the chat harness recorded them. */
export const RunUsage = z.strictObject({
  input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
  usd: z.number().min(0),
})
export type RunUsage = z.input<typeof RunUsage>

/** GET /runs/{id}: the run's summary, what its log's first record says, and whether the log can be read. */
export const RunDetail = z.strictObject({
  run: RunSummary,
  parent: RunSummary.nullable().default(null),
  /** The session's pinned commit: which version of the flow ran. */
  repo_commit: GitId,
  flow_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u).nullable().default(null),
  /** The model of each agent node, by static path, from the log's first record. */
  models: z.record(z.string(), z.string()).default(() => ({})),
  /** Null when not recorded: the office records usage only for runs the chat harness runs, not debriefs. */
  usage: RunUsage.nullable().default(null),
  log_state: z.enum(["ok", "missing", "not_started", "unsupported_schema"]),
  /** What to show for any log_state but ok. */
  log_message: z.string().nullable().default(null),
})
export type RunDetail = z.input<typeof RunDetail>

/** One node attempt, from its start record and its outcome record. */
export const RunNode = z.strictObject({
  /** The start record's seq. */
  seq: z.int().min(0),
  /** The outcome record's seq; null while open or once restarted. */
  end_seq: z.int().min(0).nullable().default(null),
  node_id: z.string().min(1),
  /**
   * The node's kind by static path, such as agent, case, loop, map or call, from the flow the run log recorded;
   * null when that flow doesn't load. Clients show nothing for null.
   */
  kind: z.string().nullable().default(null),
  status: z.enum(["open", "succeeded", "routed", "expanded", "failed", "restarted"]),
  /** For a routed case: the handle it took. */
  handle: z.string().nullable().default(null),
  /** For a failed node: its error. */
  error: z.string().max(200).nullable().default(null),
})
export type RunNode = z.input<typeof RunNode>

/** A run_resumed record: where the run was resumed and which nodes it retried. */
export const RunDivider = z.strictObject({
  seq: z.int().min(0),
  retried: z.array(z.string()),
})
export type RunDivider = z.input<typeof RunDivider>

/** GET /runs/{id}/nodes: node attempts, newest start first, and the resume dividers among them. */
export const RunNodePage = z.strictObject({
  nodes: z.array(RunNode),
  dividers: z.array(RunDivider).default(() => []),
  /** The `before` of the next (older) page; null on the oldest. */
  next_before: z.int().min(0).nullable().default(null),
  /** True when older attempts were dropped from the table (past 100,000): see Raw. */
  dropped: z.boolean().default(false),
})
export type RunNodePage = z.input<typeof RunNodePage>

/**
 * One value of a node attempt's detail: an output its success accepted, or an input its binding read. Each is a
 * pool_commit's value, in the display form an opened record shows.
 */
export const RunNodeValue = z.strictObject({
  /**
   * What a flow reads it as. An output: `output`, an agent's `new_messages`, or, for a START or END, one field of the
   * record it received or returned. An input, relative to the node's flow: `input` for its START's record,
   * `<node>.output`, `<node>.new_messages`, `system.<name>`, or a pool name from outside its flow as it is.
   */
  name: z.string().min(1),
  /** The seq of the pool_commit that holds it. */
  seq: z.int().min(0),
  /** Its kind, such as str, object or list[object]; null when not known, as for a field of a record. */
  type: z.string().nullable().default(null),
  /** The value; null too when `missing` says why it isn't here. */
  value: z.unknown().default(null),
  /**
   * Why the value isn't here: too_large, too large to show (see `size`; download the log); not_rebuilt, a derived
   * value this office couldn't rebuild from the log.
   */
  missing: z.enum(["too_large", "not_rebuilt"]).nullable().default(null),
  /** With too_large: the size in bytes. */
  size: z.int().min(0).nullable().default(null),
  /** JSON pointers (into `value`) of strings cut at 4K characters, as a detail too large to show whole is cut. */
  cut: z.array(z.string()).default(() => []),
})
export type RunNodeValue = z.input<typeof RunNodeValue>

/** A failed node attempt's error. */
export const RunNodeFailure = z.strictObject({
  message: z.string(),
  traceback: z.string().nullable().default(null),
  /** JSON pointers (`/message`, `/traceback`) of strings cut at 4K characters, the record being too large to show. */
  cut: z.array(z.string()).default(() => []),
  /** The size of its record when too large to show: `message` is then the error as the Timeline shows it. */
  size: z.int().min(0).nullable().default(null),
})
export type RunNodeFailure = z.input<typeof RunNodeFailure>

/**
 * GET /runs/{id}/nodes/{seq}: one node attempt by its start record's seq, read from the log: its row of the node page
 * (its route's handle whole), its model, when its start and end records were written, the values its success
 * accepted and its binding read, and its error.
 */
export const RunNodeDetail = z.strictObject({
  node: RunNode,
  /** An agent's model, from the run start by static path; null for any other node. */
  model: z.string().nullable().default(null),
  /** When its start record was written. */
  started_at: Timestamp.nullable().default(null),
  /** When the record that ended it was written; null while open and once restarted. */
  ended_at: Timestamp.nullable().default(null),
  /** The values its success accepted, one row each; none until it succeeds. */
  outputs: z.array(RunNodeValue).default(() => []),
  /**
   * The values a derived node's binding read (an END's gathered values, a loop's or a call's result), one row each:
   * the log names them only for those. A START's are its outputs.
   */
  inputs: z.array(RunNodeValue).default(() => []),
  failure: RunNodeFailure.nullable().default(null),
})
export type RunNodeDetail = z.input<typeof RunNodeDetail>

/** One run-log record as written. */
export const RunEvent = z.strictObject({
  seq: z.int().min(0),
  kind: z.string().min(1),
  node_id: z.string().nullable().default(null),
  /** The record's payload; null when too large to preview. */
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  /** JSON pointers (into payload) of strings cut at 4 KiB; fetch the event by seq for the whole. */
  cut: z.array(z.string()).default(() => []),
  /** Always null: the office no longer withholds payloads. Kept for compatibility; clients ignore it. */
  withheld: z.string().nullable().default(null),
  /** The record's size in bytes, when it was too large to preview. */
  size: z.int().min(0).nullable().default(null),
})
export type RunEvent = z.input<typeof RunEvent>

/** GET /runs/{id}/events: records in seq order, at most 500 or 256 KiB of JSON. */
export const RunEventPage = z.strictObject({
  events: z.array(RunEvent),
  /** The `after` of the next page; null at the end of the log so far. */
  next_after: z.int().min(0).nullable().default(null),
  /** True when the page stopped at its byte cap. */
  cut: z.boolean().default(false),
})
export type RunEventPage = z.input<typeof RunEventPage>

/** A `record` frame of GET /runs/{id}/live: one run-log record, as GET /runs/{id}/events pages show it. */
export const RunLiveRecord = z.strictObject({
  seq: z.int().min(0),
  record: RunEvent,
})
export type RunLiveRecord = z.input<typeof RunLiveRecord>

/** A `call` frame of GET /runs/{id}/live: a model call in flight when the stream joined, with its text so far. */
export const RunLiveCall = z.strictObject({
  /** The agent node making the call. */
  node: z.string(),
  /** The call's number within the node's attempt. */
  n: z.int().min(0),
  text: z.string(),
  /** The `index` of the call's next chunk. */
  next_index: z.int().min(0),
})
export type RunLiveCall = z.input<typeof RunLiveCall>

/** A `start` frame of GET /runs/{id}/live: a model call started. */
export const RunLiveStart = z.strictObject({
  node: z.string(),
  n: z.int().min(0),
  /** The model it calls; null when not known. */
  model: z.string().nullable(),
  /** What the call is for. */
  purpose: z.string(),
  started_at: z.string(),
})
export type RunLiveStart = z.input<typeof RunLiveStart>

/**
 * A `chunk` frame of GET /runs/{id}/live: text a model call streamed. Merged chunks carry the last one's `index`:
 * append the text; the next chunk's index is `index + 1`.
 */
export const RunLiveChunk = z.strictObject({
  node: z.string(),
  n: z.int().min(0),
  index: z.int().min(0),
  text: z.string(),
})
export type RunLiveChunk = z.input<typeof RunLiveChunk>

/** An `end` frame of GET /runs/{id}/live: a model call ended. */
export const RunLiveEnd = z.strictObject({
  node: z.string(),
  n: z.int().min(0),
  /** Why the call failed; null when it succeeded. */
  error: z.string().nullable(),
})
export type RunLiveEnd = z.input<typeof RunLiveEnd>

/** The data of a run.updated event: from the store and memory, node ids only. */
export const RunUpdated = z.strictObject({
  run_id: Ulid,
  session_id: Ulid,
  parent_run_id: Ulid.nullable().default(null),
  status: z.enum(["running", "waiting", "idle", "finished", "failed", "interrupted"]),
  current_nodes: z.array(z.string()).default(() => []),
})
export type RunUpdated = z.input<typeof RunUpdated>

/** One AGENT model call of a run, as GET /runs/{id}/calls lists it (yian's `agentCalls`). */
export const RunCallEntry = z.strictObject({
  /** The agent node that made it. */
  node_id: z.string().min(1),
  /** Its last attempt's step number in the node: the `n` GET /runs/{id}/calls/{node}/{n} takes. */
  n: z.int().min(1),
  /** chat, structured_native or structured_fallback. */
  purpose: z.string(),
  /** The model it reached. */
  model: z.string(),
  /** When its first attempt started. */
  started_at: z.string(),
  /** 1, plus one per retry. */
  attempts: z.int().min(1),
  /** The last attempt's finish reason (`interrupted` for a reply an interrupt cut); null when it failed. */
  finish: z.string().nullable().default(null),
})
export type RunCallEntry = z.input<typeof RunCallEntry>

/** GET /runs/{id}/calls?node=<node id>: the node's model calls, oldest first. */
export const RunCallList = z.strictObject({
  calls: z.array(RunCallEntry),
})
export type RunCallList = z.input<typeof RunCallList>

/** The tokens a model call's attempt used, each null when the provider didn't report it. */
export const RunCallUsage = z.strictObject({
  input_tokens: z.int().min(0).nullable(),
  output_tokens: z.int().min(0).nullable(),
  cache_read_tokens: z.int().min(0).nullable(),
  cache_creation_tokens: z.int().min(0).nullable(),
  reasoning_tokens: z.int().min(0).nullable(),
})
export type RunCallUsage = z.input<typeof RunCallUsage>

/** One attempt of a model call. */
export const RunCallAttempt = z.strictObject({
  n: z.int().min(1),
  started_at: z.string(),
  /** When its first event arrived; null when none did. */
  first_token_at: z.string().nullable().default(null),
  /** When its step was written, right after it returned or failed. */
  finished_at: z.string(),
  /** A failed attempt's error, its message scrubbed of credentials by yian; null for a reply. */
  error: z.strictObject({ kind: z.string(), message: z.string() }).nullable().default(null),
  /** Seconds a failed attempt waited before its retry; null when it wasn't retried, or replied. */
  retry_in: z.number().min(0).nullable().default(null),
  usage: RunCallUsage.nullable().default(null),
})
export type RunCallAttempt = z.input<typeof RunCallAttempt>

/** One part of a model call's message. Provider data the log keeps beside a part isn't shown. */
export const RunCallPart = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(["text", "reasoning", "refusal"]), text: z.string() }),
  z.strictObject({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    /** The parsed arguments; null when they didn't parse (see `raw_arguments`). */
    arguments: z.record(z.string(), z.unknown()).nullable().default(null),
    raw_arguments: z.string().nullable().default(null),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    call_id: z.string(),
    name: z.string(),
    content: z.string(),
    is_error: z.boolean().nullable().default(null),
  }),
  /** A file the message carried, by its type and name. */
  z.strictObject({ type: z.literal("media"), mime: z.string(), name: z.string().nullable().default(null) }),
])
export type RunCallPart = z.input<typeof RunCallPart>

/** A message a model call sent or got back. */
export const RunCallMessage = z.strictObject({
  /** user, assistant or tool. */
  role: z.string(),
  /** Who said it, when the run recorded a speaker. */
  author: z.string().nullable().default(null),
  parts: z.array(RunCallPart),
})
export type RunCallMessage = z.input<typeof RunCallMessage>

/** A tool the model could call. */
export const RunCallTool = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** Its arguments' JSON Schema. */
  parameters: z.record(z.string(), z.unknown()),
  strict: z.boolean().nullable().default(null),
})
export type RunCallTool = z.input<typeof RunCallTool>

/** The request a model call sent, rebuilt from the run log. */
export const RunCallRequest = z.strictObject({
  model: z.string(),
  /** The model config the call used, without the key, headers or connection. */
  params: z.record(z.string(), z.unknown()),
  /** The system prompt; null without one. */
  system: z.string().nullable().default(null),
  /** The other messages in order: the prompt, the history, steers and tool results. */
  messages: z.array(RunCallMessage),
  tools: z.array(RunCallTool).default(() => []),
  /** auto, required, none, a named tool, or null for the provider's default. */
  tool_choice: z.union([z.enum(["auto", "required", "none"]), z.strictObject({ name: z.string() })]).nullable().default(null),
  parallel_tool_calls: z.boolean().nullable().default(null),
  /** The schema a structured reply had to match. */
  output_format: z
    .strictObject({ name: z.string(), schema: z.record(z.string(), z.unknown()), strict: z.boolean().nullable() })
    .nullable()
    .default(null),
})
export type RunCallRequest = z.input<typeof RunCallRequest>

/** One tool call of a model call's reply, with its recorded result and what the office's gate said of it. */
export const RunCallToolResult = z.strictObject({
  call_id: z.string(),
  name: z.string(),
  /** The parsed arguments; null when they didn't parse (the call never reached its tool). */
  arguments: z.record(z.string(), z.unknown()).nullable().default(null),
  /** The text the model read; null while no result is recorded. */
  output: z.string().nullable().default(null),
  is_error: z.boolean().nullable().default(null),
  /** skipped, interrupted, timed_out, crashed or failed for a result yian wrote in place of running it, refused for
   *  a call the gate refused; null for a call that ran. */
  closed: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  /** The note the gate ran the call with, such as why it was allowed. */
  note: z.string().nullable().default(null),
  /** Whether the gate held it for an answer. */
  held: z.boolean(),
  /** The note a held call was released with, such as who approved it. */
  release_note: z.string().nullable().default(null),
})
export type RunCallToolResult = z.input<typeof RunCallToolResult>

/**
 * GET /runs/{id}/calls/{node}/{n}: one AGENT model call, rebuilt from the run log by yian's `agentCall`: the request
 * it sent, its attempts, the reply and each tool call's result. Strings longer than 64K characters (UTF-16 code
 * units) are cut with "…", each named in `cut`; the log holds them whole.
 */
export const RunCall = z.strictObject({
  node_id: z.string().min(1),
  /** The call's last attempt. */
  n: z.int().min(1),
  purpose: z.string(),
  /** Null when it couldn't be rebuilt from the log. */
  request: RunCallRequest.nullable(),
  /** The rebuilt request differs from what an attempt recorded sending. */
  digest_mismatch: z.boolean().default(false),
  /** Every attempt, oldest first. */
  attempts: z.array(RunCallAttempt),
  /** What the last attempt got back, what arrived before a failure included; null when nothing did. */
  reply: RunCallMessage.nullable(),
  /** Each tool call of the reply, in call order. */
  tool_results: z.array(RunCallToolResult).default(() => []),
  /** The last attempt's usage. */
  usage: RunCallUsage.nullable().default(null),
  /** The last attempt's finish reason; null when it failed. */
  finish: z.string().nullable().default(null),
  /** An interrupt cut the reply, or the agent stopped before acting on all of it. */
  interrupted: z.boolean().default(false),
  /** JSON pointers of the strings cut at 64K characters. */
  cut: z.array(z.string()).default(() => []),
})
export type RunCall = z.input<typeof RunCall>
