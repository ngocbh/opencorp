// Protocol schemas: sessions.
import { z } from "zod"
import { ConnectionName, GitId, Handle, Timestamp, Ulid } from "./common"

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

export const Session = z.strictObject({
  id: Ulid,
  person: Handle,
  harness: z.enum(["composer", "codex", "claude"]),
  office: z.string(),
  cwd: z.string(),
  repo_commit: GitId,
  status: z.enum([
    "starting", "idle", "busy", "waiting", "ending", "debriefing", "ended", "failed", "interrupted",
  ]),
  kind: z.enum(["main", "side", "profile_manager"]),
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
   * harness reports it, and for composer sessions.
   */
  harness_model: z.string().nullable().default(null),
  /**
   * This session's own token counts so far, as the harness reports them. A continued session counts only its
   * own stretch: add its parent chain's counts for the thread's total. Null until the harness reports any;
   * always null for composer sessions.
   */
  harness_usage: HarnessUsage.nullable().default(null),
  /**
   * The session this one directly continues, on the same harness thread; follow its parent_session_id for
   * earlier stretches. Null for a first stretch.
   */
  parent_session_id: Ulid.nullable().default(null),
  /** Finished replies: the next fresh run's `turns` input; `0` means no reply has finished yet. */
  turns: z.int().min(0).default(0),
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
  call_id: z.string(),
  tool: z.string(),
  state: z.enum(["pending", "running", "completed", "error", "interrupted"]),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().default(() => ({})),
  error: z.string().nullable().default(null),
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
   * The human who sent a user message. A harness session names every sender; null for assistant messages, for
   * composer sessions, and for rows from before this field.
   */
  author: Handle.nullable().default(null),
  parts: z.array(Part),
  created_at: Timestamp,
})
export type Message = z.input<typeof Message>

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
  harness: z.enum(["composer", "codex", "claude"]).default("composer"),
  /**
   * The human's pick of connection for the new chat, which falls back as the office decides; null leaves it
   * to the office.
   */
  connection: ConnectionName.nullable().default(null),
  /**
   * The human's pick of model for the new chat, which falls back as the office decides; null leaves it to the
   * office.
   */
  model: z.string().nullable().default(null),
})
export type CreateSessionRequest = z.input<typeof CreateSessionRequest>

export const PromptRequest = z.strictObject({
  text: z.string().min(1),
})
export type PromptRequest = z.input<typeof PromptRequest>

export const CostCapRequest = z.strictObject({
  cost_cap_usd: z.number().min(0),
})
export type CostCapRequest = z.input<typeof CostCapRequest>

export const SideChatRequest = z.strictObject({
  text: z.string().min(1),
})
export type SideChatRequest = z.input<typeof SideChatRequest>
