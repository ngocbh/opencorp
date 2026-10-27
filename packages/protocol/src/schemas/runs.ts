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
  /** Whether the log keeps evidence (prompts, model turns, tool calls); null until the log is read. */
  learnable: z.boolean().nullable().default(null),
  /** The model of each agent node, by static path, from the log's first record. */
  models: z.record(z.string(), z.string()).default(() => ({})),
  /** Null when not recorded: the office records usage only for runs the chat harness runs, not debriefs. */
  usage: RunUsage.nullable().default(null),
  log_state: z.enum(["ok", "indexing", "missing", "not_started", "unsupported_schema"]),
  /** What to show for any log_state but ok. */
  log_message: z.string().nullable().default(null),
  /** While indexing: bytes of the log read so far. */
  bytes_done: z.int().min(0).nullable().default(null),
  /** While indexing: the log's size in bytes. */
  bytes_total: z.int().min(0).nullable().default(null),
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
   * The node's kind by static path, such as agent, case, loop, map or call. Always null until Yian lists a
   * flow's nodes publicly (yian#943); clients show nothing for null.
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
  /** True when the log is still being read for the first time: nodes is empty; ask again. */
  indexing: z.boolean().default(false),
  /** While indexing: bytes of the log read so far. */
  bytes_done: z.int().min(0).nullable().default(null),
  /** While indexing: the log's size in bytes. */
  bytes_total: z.int().min(0).nullable().default(null),
})
export type RunNodePage = z.input<typeof RunNodePage>

/** One run-log record as written. */
export const RunEvent = z.strictObject({
  seq: z.int().min(0),
  kind: z.string().min(1),
  node_id: z.string().nullable().default(null),
  /** The record's payload; null when too large to preview. */
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  /** JSON pointers (into payload) of strings cut at 4 KiB; fetch the event by seq for the whole. */
  cut: z.array(z.string()).default(() => []),
  /** True when evidence was left out of a page; fetch the event by seq for it. */
  evidence_left_out: z.boolean().default(false),
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
  /** True when the log is still being read for the first time: events is empty; ask again. */
  indexing: z.boolean().default(false),
  /** While indexing: bytes of the log read so far. */
  bytes_done: z.int().min(0).nullable().default(null),
  /** While indexing: the log's size in bytes. */
  bytes_total: z.int().min(0).nullable().default(null),
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
