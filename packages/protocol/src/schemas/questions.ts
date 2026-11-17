import { z } from "zod"
import { Handle, Timestamp, Ulid } from "./common"

export const QuestionOption = z.strictObject({
  label: z.string(),
  description: z.string().default(""),
})
export type QuestionOption = z.input<typeof QuestionOption>

export const QuestionPage = z.strictObject({
  question: z.string(),
  header: z.string(),
  options: z.array(QuestionOption),
  multi_select: z.boolean().default(false),
  /** The answer is a secret: clients mask it, and the office stores `[secret]` in its place. */
  secret: z.boolean().default(false),
})
export type QuestionPage = z.input<typeof QuestionPage>

export const AnswerField = z.strictObject({
  name: z.string(),
  type: z.enum([
    "None", "str", "int", "float", "date", "datetime", "bool", "object", "file",
    "list[Any]", "list[str]", "list[int]", "list[float]", "list[bool]", "list[object]",
  ]),
  required: z.boolean(),
  enum: z.array(z.string()).nullable().default(null),
  // A getter lets the schema refer to itself; tsc needs the return type to type the cycle.
  get fields(): z.ZodDefault<z.ZodNullable<z.ZodArray<typeof AnswerField>>> {
    return z.array(AnswerField).nullable().default(null)
  },
})
export type AnswerField = z.input<typeof AnswerField>

export const DiscussionEntry = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
})
export type DiscussionEntry = z.input<typeof DiscussionEntry>

/** What an approval card asks its approver to allow: the action exactly as it would run, the tool and arguments
 *  that run it, the agent's own reason (untrusted), why policy asks, and the allow rules "don't ask again" adds
 *  (empty: it may add none). The card's `call_id` is the yian call it holds. */
export const Approval = z.strictObject({
  /** `command`: a command to run; `input`: a line to type into a running command. */
  kind: z.enum(["command", "input"]),
  /** The tool that would act: `shell`, `terminal_run`, `terminal_type`. */
  tool: z.string(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()).default(() => ({})),
  why: z.string().default(""),
  reason: z.string(),
  rules: z.array(z.string()).default(() => []),
  /** Typed text without Enter (`input` only). */
  partial: z.boolean().default(false),
  /** For typed text: the command it is typed into, whose ssh destination is its host. */
  into: z.string().nullable().default(null),
})
export type Approval = z.input<typeof Approval>

export const Question = z.strictObject({
  id: Ulid,
  session_id: Ulid,
  run_id: z.string(),
  /** Null for a model ask_user call. */
  node_id: z.string().nullable(),
  /**
   * The yian call it answers (`<run>/<node>` for a TOOL `ask`, `<run>/<node>/<n>/<index>` for an agent's call); null
   * for a question no yian call asked (a Codex request).
   */
  call_id: z.string().nullable().default(null),
  /**
   * Where the question comes from. `ask`: a flow's TOOL `ask` node. `harness`: a request from the session's
   * harness (a Codex approval or question). It takes only an `option` or `text` answer; no side chat, send back
   * or stop. It goes `stale` when the harness stops waiting. `approval`: an agent's call held for the session's
   * approver: one of its options, or text, which is No and what to do instead; its stop interrupts the agent; no
   * side chat or send back.
   */
  source: z.enum(["ask_user", "ask", "ask_manager", "harness", "approval"]),
  asker: Handle,
  work_item_id: Ulid.nullable().default(null),
  title: z.string().nullable().default(null),
  question: z.string(),
  options: z.array(z.string()).default(() => []),
  questions: z.array(QuestionPage).min(1).max(4).nullable().default(null),
  answer_schema: z.array(AnswerField).default(() => []),
  approval: Approval.nullable().default(null),
  discussion: z.array(DiscussionEntry).default(() => []),
  gate: z.boolean().default(false),
  status: z.enum(["open", "answered", "consumed", "stale"]),
  /** Null until answered, and may be null once answered too. Read status to tell whether it is answered. */
  answer: z.unknown().default(null),
  answer_kind: z.enum(["option", "text", "sent_back", "interrupted"]).nullable().default(null),
  answered_by: Handle.nullable().default(null),
  side_session_id: Ulid.nullable().default(null),
  carried_from: Ulid.nullable().default(null),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Question = z.input<typeof Question>

export const AnswerRequest = z.strictObject({
  /** Any JSON value, including null. */
  answer: z.unknown(),
  /** `sent_back` and `interrupted` are set only by the office. */
  answer_kind: z.enum(["option", "text"]),
})
export type AnswerRequest = z.input<typeof AnswerRequest>

export const SendBackRequest = z.strictObject({
  note: z.string(),
})
export type SendBackRequest = z.input<typeof SendBackRequest>
