// Generated from schema/protocol.schema.json. Do not edit.

/**
 * A group or asset id: a ULID or a lowercase slug (ids name files, and macOS is case-insensitive). No '_', '/', '.', or '--'.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * A person's unique, permanent name: shown as @handle, and the name of their people/<handle>/ directory.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Handle".
 */
export type Handle = string;
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Ulid".
 */
export type Ulid = string;
/**
 * A git commit or blob id.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "GitId".
 */
export type GitId = string;
/**
 * UTC, ISO-8601 in milliseconds with a Z suffix. Fixed width, so string order is time order; a plain string, so it round-trips unchanged.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Part".
 */
export type Part = TextPart | FilePart | ToolPart | ErrorPart;

/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "CompanyDefaults".
 */
export interface CompanyDefaults {
  provider_policy?: string;
  cost_cap_usd?: number;
  idle_end?: string;
  max_turns?: number;
  profile_max_chars?: number;
  side_chat_cost_cap_usd?: number;
  side_seed_max_chars?: number;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Company".
 */
export interface Company {
  name: string;
  ceo: Handle;
  hq?: string | null;
  defaults?: CompanyDefaults | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "HarnessPolicy".
 */
export interface HarnessPolicy {
  sandbox?: "read-only" | "workspace-write";
  network?: boolean;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Sop".
 */
export interface Sop {
  flow: string;
  gate?: boolean;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Routine".
 */
export interface Routine {
  name: string;
  flow: string;
  trigger?: {
    [k: string]: unknown;
  } | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Person".
 */
export interface Person {
  handle: Handle;
  name: string;
  kind: "human" | "agent";
  title: string;
  manager: Handle | null;
  groups?: Id[];
  home_office?: string | null;
  main?: string | null;
  sops?: Sop[];
  skills?: string[];
  harnesses?: ("composer" | "codex" | "claude")[];
  harness_policy?: HarnessPolicy | null;
  routines?: Routine[];
  provider_policy?: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Group".
 */
export interface Group {
  id: Id;
  name: string;
  parent?: Id | null;
  head?: Handle | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "AssetTool".
 */
export interface AssetTool {
  risk?: "normal" | "gated";
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Grant".
 */
export interface Grant {
  /**
   * A person's handle, or group:<group id>.
   */
  who: string;
  /**
   * @minItems 1
   */
  can: string[];
  where?: {
    [k: string]: unknown[];
  } | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Asset".
 */
export interface Asset {
  id: Id;
  kind: string;
  tools?: {
    [k: string]: AssetTool;
  };
  grants?: Grant[];
  secrets?: string[];
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "WorkItem".
 */
export interface WorkItem {
  id: Ulid;
  title: string;
  kind: "task" | "question";
  status: "open" | "in_progress" | "done" | "cancelled";
  requester: Handle;
  assignee?: Handle | null;
  parent_id?: Ulid | null;
  groups?: Id[];
  gate?: boolean;
  resolved_by?: Handle | null;
  on_behalf_of?: Handle | null;
  summary?: string | null;
  cost?: number;
  version?: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Comment".
 */
export interface Comment {
  id: Ulid;
  work_item_id: Ulid;
  author: Handle;
  body: string;
  on_behalf_of?: Handle | null;
  created_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Session".
 */
export interface Session {
  id: Ulid;
  person: Handle;
  harness: "composer" | "codex" | "claude";
  office: string;
  cwd: string;
  repo_commit: GitId;
  status: "starting" | "idle" | "busy" | "ending" | "debriefing" | "ended" | "failed" | "interrupted";
  kind: "main" | "side" | "profile_manager";
  harness_session_id?: string | null;
  work_item_id?: Ulid | null;
  run_ids?: string[];
  question_id?: Ulid | null;
  seed?: string | null;
  cost?: number;
  /**
   * null means company.defaults.cost_cap_usd.
   */
  cost_cap_usd?: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message {
  id: Ulid;
  session_id: Ulid;
  role: "user" | "assistant";
  parts: Part[];
  created_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "TextPart".
 */
export interface TextPart {
  id: Ulid;
  type: "text";
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "FilePart".
 */
export interface FilePart {
  id: Ulid;
  type: "file";
  path: string;
  mime: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ToolPart".
 */
export interface ToolPart {
  id: Ulid;
  type: "tool";
  call_id: string;
  tool: string;
  state: "pending" | "running" | "completed" | "error" | "interrupted";
  input: {
    [k: string]: unknown;
  };
  output?: unknown;
  error?: string | null;
}
/**
 * A turn that failed: why, in words the owner can act on. Never holds a secret.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ErrorPart".
 */
export interface ErrorPart {
  id: Ulid;
  type: "error";
  message: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Permission".
 */
export interface Permission {
  id: Ulid;
  session_id: Ulid;
  tool: string;
  input: {
    [k: string]: unknown;
  };
  status: "pending" | "allowed" | "denied";
  answered_by?: Handle | null;
  created_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "QuestionOption".
 */
export interface QuestionOption {
  label: string;
  description?: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "QuestionPage".
 */
export interface QuestionPage {
  question: string;
  header: string;
  options: QuestionOption[];
  multi_select?: boolean;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "AnswerField".
 */
export interface AnswerField {
  name: string;
  type:
    | "None"
    | "str"
    | "int"
    | "float"
    | "date"
    | "datetime"
    | "bool"
    | "object"
    | "file"
    | "list[Any]"
    | "list[str]"
    | "list[int]"
    | "list[float]"
    | "list[bool]"
    | "list[object]";
  required: boolean;
  enum?: string[] | null;
  fields?: AnswerField[] | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "DiscussionEntry".
 */
export interface DiscussionEntry {
  role: "user" | "assistant";
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Question".
 */
export interface Question {
  id: Ulid;
  session_id: Ulid;
  run_id: string;
  /**
   * null for a model ask_user call.
   */
  node_id: string | null;
  source: "ask_user" | "human_input" | "ask_manager";
  asker: Handle;
  work_item_id?: Ulid | null;
  title?: string | null;
  question: string;
  options?: string[];
  questions?: QuestionPage[] | null;
  answer_schema?: AnswerField[];
  discussion?: DiscussionEntry[];
  gate?: boolean;
  status: "open" | "answered" | "consumed" | "stale";
  /**
   * null until answered, and may be null once answered too. Read status to tell whether it is answered.
   */
  answer?: unknown;
  answer_kind?: ("option" | "text" | "sent_back" | "interrupted") | null;
  answered_by?: Handle | null;
  side_session_id?: Ulid | null;
  carried_from?: Ulid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Profile".
 */
export interface Profile {
  person: Handle;
  text: string;
  version: GitId;
  over_budget?: boolean;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ProfileProposal".
 */
export interface ProfileProposal {
  id: Ulid;
  session_id: Ulid;
  person: Handle;
  base_version: GitId;
  text: string;
  diff: string;
  status: "open" | "applied" | "discarded" | "stale";
  commit?: GitId | null;
  created_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "FollowUp".
 */
export interface FollowUp {
  text: string;
  confirmed?: boolean;
  work_item_id?: Ulid | null;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Debrief".
 */
export interface Debrief {
  session_id: Ulid;
  state: "pending" | "ready";
  summary?: string | null;
  /**
   * The debrief flow's own status.
   */
  status?: string | null;
  artifacts?: string[];
  decisions?: string[];
  follow_ups?: FollowUp[];
  open_questions?: string[];
  cost?: number;
  updated_at: Timestamp;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Feedback".
 */
export interface Feedback {
  id: Ulid;
  session_id: Ulid;
  run_id: string;
  author: Handle;
  text: string;
  status: "queued" | "learning" | "applied" | "learning_failed";
  attempts?: number;
  /**
   * The profile commit once applied.
   */
  commit?: GitId | null;
  created_at: Timestamp;
}
/**
 * A metadata change, written to the outbox.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Event".
 */
export interface Event {
  id: Ulid;
  type:
    | "work_item.created"
    | "work_item.updated"
    | "comment.created"
    | "session.created"
    | "session.updated"
    | "question.created"
    | "question.updated"
    | "feedback.created"
    | "feedback.updated"
    | "debrief.created"
    | "debrief.updated"
    | "profile.updated"
    | "profile_proposal.created"
    | "profile_proposal.updated";
  at: Timestamp;
  subject_id: string;
  /**
   * The entity after the change.
   */
  data: {
    [k: string]: unknown;
  };
}
/**
 * Streamed content that is never stored as metadata. For part.delta, data is {message_id, part_id, text} and the text is appended.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "LiveEvent".
 */
export interface LiveEvent {
  type: "message.updated" | "part.updated" | "part.delta";
  session_id: Ulid;
  data: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "CreateSessionRequest".
 */
export interface CreateSessionRequest {
  person: Handle;
  cwd: string;
  harness?: "composer" | "codex" | "claude";
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "PromptRequest".
 */
export interface PromptRequest {
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "Ack".
 */
export interface Ack {
  ok: true;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "CostCapRequest".
 */
export interface CostCapRequest {
  cost_cap_usd: number;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "RepoIssue".
 */
export interface RepoIssue {
  path: string;
  code: string;
  message: string;
  severity?: "error" | "warning";
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "HireRequest".
 */
export interface HireRequest {
  name: string;
  handle: Handle;
  title: string;
  manager: Handle;
  confirm?: boolean;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "HireResponse".
 */
export interface HireResponse {
  person: Person;
  diff: string;
  issues: RepoIssue[];
  commit: GitId | null;
}
/**
 * The body of every error response, sent with its HTTP status.
 *
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  /**
   * A short code, such as not_implemented or not_found.
   */
  error: string;
  message: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "AnswerRequest".
 */
export interface AnswerRequest {
  /**
   * Any JSON value, including null.
   */
  answer: unknown;
  /**
   * sent_back and interrupted are set only by the office.
   */
  answer_kind: "option" | "text";
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "SideChatRequest".
 */
export interface SideChatRequest {
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "SendBackRequest".
 */
export interface SendBackRequest {
  note: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ProfileWriteRequest".
 */
export interface ProfileWriteRequest {
  text: string;
  base_version: GitId;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "VersionConflict".
 */
export interface VersionConflict {
  expected: GitId;
  current: GitId;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ProfileManagerRequest".
 */
export interface ProfileManagerRequest {
  /**
   * The first message.
   */
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "FeedbackRequest".
 */
export interface FeedbackRequest {
  session_id: Ulid;
  /**
   * null means the session's latest run.
   */
  run_id?: string | null;
  text: string;
}
/**
 * This interface was referenced by `AgentCorpProtocol`'s JSON-Schema
 * via the `definition` "ConfirmFollowUpsRequest".
 */
export interface ConfirmFollowUpsRequest {
  indices: number[];
}
