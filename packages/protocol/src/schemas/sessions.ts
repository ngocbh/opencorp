import { z } from "zod"
import { ConnectionName, GitId, Handle, MessageText, ModelName, Timestamp, Ulid } from "./common"

/**
 * A harness session's token counts as the harness reports them, on the harness's own login; the office
 * doesn't price them.
 */
export const HarnessUsage = z.strictObject({
  input_tokens: z.int().min(0),
  /** The part of input_tokens served from the cache. */
  cached_input_tokens: z.int().min(0),
  output_tokens: z.int().min(0),
})
export type HarnessUsage = z.input<typeof HarnessUsage>

/** What a session's agent may do without its approver, in Shift+Tab's order. `auto` (the start mode): rules,
 *  read-only forms, file operations inside the workspace sandbox, then Auto's check; the rest asks. `default`:
 *  rules and read-only forms; the rest asks. `ask`: only what a rule allows; the rest asks. `dontAsk`: as `auto`,
 *  but what would ask is refused. The sandbox applies in every mode. */
export const SessionMode = z.enum(["auto", "default", "ask", "dontAsk"])
export type SessionMode = z.input<typeof SessionMode>

export const Session = z.strictObject({
  id: Ulid,
  person: Handle,
  harness: z.enum(["yian", "codex", "claude"]),
  office: z.string(),
  cwd: z.string(),
  repo_commit: GitId,
  status: z.enum([
    "starting", "idle", "busy", "waiting", "ending", "debriefing", "ended", "failed", "interrupted",
  ]),
  /** `instrument`: a harness session an employee's chat drives as its instrument, a child session of that chat
   *  (`instrument_of`): an employee's Codex thread. */
  kind: z.enum(["main", "side", "profile_manager", "instrument"]),
  /**
   * While status is waiting: who must act (answer an open question, or raise the cost cap), in the order
   * those opened. Empty otherwise.
   */
  waiting_on: z.array(Handle).default(() => []),
  /**
   * True while the session's cost is at or over its cost cap: its turns wait until someone raises the cap,
   * and its status is waiting.
   */
  capped: z.boolean().default(false),
  harness_session_id: z.string().nullable().default(null),
  work_item_id: Ulid.nullable().default(null),
  run_ids: z.array(z.string()).default(() => []),
  question_id: Ulid.nullable().default(null),
  seed: z.string().nullable().default(null),
  cost: z.number().min(0).default(0),
  /**
   * The part of `cost` its subscription's model calls make up: what the API would charge for their tokens, which the
   * cost cap counts and the subscription doesn't pay. Clients show `cost` as at API prices when it is above 0.
   */
  subscription_cost: z.number().min(0).default(0),
  /** Null means company.defaults.cost_cap_usd. */
  cost_cap_usd: z.number().min(0).nullable().default(null),
  /**
   * The human who opened the session; null for sessions from before this field or opened by the office
   * itself.
   */
  opened_by: Handle.nullable().default(null),
  /**
   * The chat's connection on its office. Null: `office`, for sessions from before this field; every new
   * session sets it.
   */
  connection: ConnectionName.nullable().default(null),
  /** Null: the connection's own model. For Azure, a deployment name. */
  model: z.string().nullable().default(null),
  /** Why the chat isn't on the model it was asked to start on, or why it moved. */
  model_note: z.string().nullable().default(null),
  /**
   * The model the harness runs, as it reports it (a Codex session: Codex's load response); null until the
   * harness reports it, and for yian sessions.
   */
  harness_model: z.string().nullable().default(null),
  /**
   * The harness turn running now (a Codex session's turn id); null outside a turn and for yian sessions.
   * Restore reads it to mark a turn that an office stop cut off as interrupted.
   */
  harness_turn_id: z.string().nullable().default(null),
  /**
   * This session's own token counts so far, as the harness reports them. A continued session counts only its
   * own stretch: add its parent chain's counts for the thread's total. Null until the harness reports any;
   * always null for yian sessions.
   */
  harness_usage: HarnessUsage.nullable().default(null),
  /**
   * The session this one directly continues, on the same harness thread; follow its parent_session_id for
   * earlier stretches. Null for a first stretch.
   */
  parent_session_id: Ulid.nullable().default(null),
  /**
   * The chat whose employee drives this session as an instrument: it is that chat's child session, and the
   * instrument's id in the chat's list is this session's id. Null for every session a person opened.
   */
  instrument_of: Ulid.nullable().default(null),
  /** Finished replies: the next fresh run's `turns` input; `0` means no reply has finished yet. */
  turns: z.int().min(0).default(0),
  /** What the agent may do without its approver; new and older sessions are in auto. Only the approver (the
   *  opener, else the CEO) switches it, and a Codex session's stays auto: Codex runs under its employee's permission
   *  and asks nothing. */
  mode: SessionMode.default("auto"),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Session = z.input<typeof Session>

/** A transcript item's id: a ULID, or one derived from the run log record it comes from. */
const ItemId = z.string().min(1)

export const TextPart = z.strictObject({
  id: ItemId,
  type: z.literal("text"),
  text: z.string(),
})
export type TextPart = z.input<typeof TextPart>

export const FilePart = z.strictObject({
  id: ItemId,
  type: z.literal("file"),
  path: z.string(),
  mime: z.string(),
})
export type FilePart = z.input<typeof FilePart>

export const ToolPart = z.strictObject({
  id: ItemId,
  type: z.literal("tool"),
  /** The model's id for the call. */
  call_id: z.string(),
  tool: z.string(),
  state: z.enum(["pending", "running", "completed", "error", "interrupted"]),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().default(() => ({})),
  error: z.string().nullable().default(null),
  /** Yian's id for the call (`<run>/<node>/<n>/<index>`) once it waited on the office: the `call_id` of the card
   *  it waits on, if any. Null for a call that never waited. */
  yian_call_id: z.string().nullable().default(null),
})
export type ToolPart = z.input<typeof ToolPart>

/** A turn that failed: why, in words the owner can act on. Never holds a secret. */
export const ErrorPart = z.strictObject({
  id: ItemId,
  type: z.literal("error"),
  message: z.string(),
})
export type ErrorPart = z.input<typeof ErrorPart>

export const Part = z.discriminatedUnion("type", [TextPart, FilePart, ToolPart, ErrorPart])
export type Part = z.input<typeof Part>

export const Message = z.strictObject({
  id: ItemId,
  session_id: Ulid,
  role: z.enum(["user", "assistant"]),
  /**
   * The human who sent a user message: harness and yian sessions both name the sender. Null for assistant
   * messages, an instrument's note, and a user message whose sender wasn't recorded.
   */
  author: Handle.nullable().default(null),
  /**
   * The instrument whose note this user message is (`isInstrumentNote`): one the office wrote to the agent about its
   * own work, such as a shell's command that ended, signed by that instrument (its id in the chat's instruments and its
   * name there, `shell 1`). Only the office sets it. Null for every other message.
   */
  instrument: z.strictObject({ id: Ulid, name: z.string().min(1) }).nullable().default(null),
  /**
   * A user message of a yian chat that waits in its run's inbox: no turn has taken it and the running reply hasn't
   * read it as a steer. Once the run reads it, `message.updated` sends it again with this false, under the same id.
   * False for every other message.
   */
  unread: z.boolean().default(false),
  /**
   * A user message of a yian chat that waits unread in its run's queue: the next turn takes it, and the running reply
   * never reads it as a steer; `unread` is true too. Once a turn takes it, `message.updated` sends it again with both
   * false, under the same id. False for every other message.
   */
  queued: z.boolean().default(false),
  parts: z.array(Part),
  created_at: Timestamp,
})
export type Message = z.input<typeof Message>

/** A page of a session's transcript (`GET /sessions/{id}/messages?limit=N&before=…`): its newest messages before the
 *  cursor `before`, or the newest of all, oldest first. */
export const MessagePage = z.strictObject({
  messages: z.array(Message),
  /** The `before` of the next, older page; null once the page holds the transcript's first message. A cursor is
   *  opaque, and stays good while newer messages arrive. */
  next: z.string().min(1).nullable().default(null),
})
export type MessagePage = z.input<typeof MessagePage>

/** `message.removed` data: a queued message the run took back before anything read it, such as one Esc held or sent
 *  again, which then shows under its new id. */
export const MessageRemoved = z.strictObject({ id: ItemId, session_id: Ulid })
export type MessageRemoved = z.input<typeof MessageRemoved>

export const Permission = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "allowed", "denied"]),
  answered_by: Handle.nullable().default(null),
  created_at: Timestamp,
})
export type Permission = z.input<typeof Permission>

export const CreateSessionRequest = z.strictObject({
  person: Handle,
  cwd: z.string(),
  harness: z.enum(["yian", "codex", "claude"]).default("yian"),
  /**
   * The human's pick of connection for the new chat, which falls back as the office decides; null leaves it
   * to the office.
   */
  connection: ConnectionName.nullable().default(null),
  /**
   * The human's pick of model for the new chat, which falls back as the office decides; null leaves it to the
   * office.
   */
  model: ModelName.nullable().default(null),
})
export type CreateSessionRequest = z.input<typeof CreateSessionRequest>

export const PromptRequest = z.strictObject({
  text: MessageText,
})
export type PromptRequest = z.input<typeof PromptRequest>

export const SetModeRequest = z.strictObject({
  mode: SessionMode,
})
export type SetModeRequest = z.input<typeof SetModeRequest>

export const CostCapRequest = z.strictObject({
  cost_cap_usd: z.number().min(0),
})
export type CostCapRequest = z.input<typeof CostCapRequest>

export const SideChatRequest = z.strictObject({
  text: MessageText,
})
export type SideChatRequest = z.input<typeof SideChatRequest>
