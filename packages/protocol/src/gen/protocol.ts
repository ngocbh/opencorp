// Generated from schema/protocol.schema.json. Do not edit.

/**
 * A group or asset id: a ULID or a lowercase slug (ids name files, and macOS is case-insensitive). No '_', '/', '.', or '--'.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * A person's unique, permanent name: shown as @handle, and the name of their people/<handle>/ directory.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Handle".
 */
export type Handle = string;
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Ulid".
 */
export type Ulid = string;
/**
 * A git commit or blob id.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "GitId".
 */
export type GitId = string;
/**
 * A device's name within one person, such as 'macbook'.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "DeviceName".
 */
export type DeviceName = string;
/**
 * The lowercase hex sha256 of a device token. Tokens are long random secrets, so the hash is safe to publish.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "TokenHash".
 */
export type TokenHash = string;
/**
 * A password's salted hash as a PHC string, such as $scrypt$ln=15,r=8,p=1$<salt>$<hash>; never the password itself.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PasswordHash".
 */
export type PasswordHash = string;
/**
 * A connection's name on its office; `office` is office/provider.json. A removed name is never reused.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ConnectionName".
 */
export type ConnectionName = string;
/**
 * UTC, ISO-8601 in milliseconds with a Z suffix. Fixed width, so string order is time order; a plain string, so it round-trips unchanged.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Part".
 */
export type Part = TextPart | FilePart | ToolPart | ErrorPart;
/**
 * One line `python -m opencorp.install init|onboard --json-prompts` writes on stdout: a question for `opencorp`'s setup screen, or something to show.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupPrompt".
 */
export type SetupPrompt = SetupAsk | SetupChoose | SetupSecret | SetupSay | SetupStep;

/**
 * A device a human uses opencorp from: requests carrying the token whose hash this is act as that person.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Device".
 */
export interface Device {
  name: DeviceName;
  token_sha256: TokenHash;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Company".
 */
export interface Company {
  name: string;
  ceo: Handle;
  hq?: string | null;
  defaults?: CompanyDefaults | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "HarnessPolicy".
 */
export interface HarnessPolicy {
  sandbox?: "read-only" | "workspace-write";
  network?: boolean;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Sop".
 */
export interface Sop {
  flow: string;
  gate?: boolean;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
  /**
   * The devices this human uses opencorp from, each with a unique name.
   */
  devices?: Device[];
  /**
   * The hash of the password this human logs in a new device with; null for none.
   */
  password_hash?: PasswordHash | null;
  /**
   * A model id as a connection lists it, e.g. `gpt-5.5`, or `openai/gpt-4o` on OpenRouter. Each office starts the agent's chats on the first of its connections that offers it (the default first, then the others by name). If none does, it uses its default and says so in the chat.
   */
  model?: string | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Group".
 */
export interface Group {
  id: Id;
  name: string;
  parent?: Id | null;
  head?: Handle | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "AssetTool".
 */
export interface AssetTool {
  risk?: "normal" | "gated";
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
  /**
   * The human who opened the session; null for sessions from before this field or opened by the office itself.
   */
  opened_by?: Handle | null;
  /**
   * The chat's connection on its office. Null: `office`, for sessions from before this field; every new session sets it.
   */
  connection?: ConnectionName | null;
  /**
   * Null: the connection's own model. For Azure, a deployment name.
   */
  model?: string | null;
  /**
   * Why the chat isn't on the model it was asked to start on, or why it moved.
   */
  model_note?: string | null;
  /**
   * The model the harness runs, as it reports it (a Codex session: Codex's load response); null until the harness reports it, and for composer sessions.
   */
  harness_model?: string | null;
  /**
   * This session's own token counts so far, as the harness reports them. A continued session counts only its own stretch: add its parent chain's counts for the thread's total. Null until the harness reports any; always null for composer sessions.
   */
  harness_usage?: HarnessUsage | null;
  /**
   * The session this one directly continues, on the same harness thread; follow its parent_session_id for earlier stretches. Null for a first stretch.
   */
  parent_session_id?: Ulid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
/**
 * A harness session's token counts as the harness reports them, on the harness's own login; the office doesn't price them.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "HarnessUsage".
 */
export interface HarnessUsage {
  input_tokens: number;
  /**
   * The part of input_tokens served from the cache.
   */
  cached_input_tokens: number;
  output_tokens: number;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message {
  id: Ulid;
  session_id: Ulid;
  role: "user" | "assistant";
  /**
   * The human who sent a user message. A harness session names every sender; null for assistant messages, for composer sessions, and for rows from before this field.
   */
  author?: Handle | null;
  parts: Part[];
  created_at: Timestamp;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "TextPart".
 */
export interface TextPart {
  id: Ulid;
  type: "text";
  text: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "FilePart".
 */
export interface FilePart {
  id: Ulid;
  type: "file";
  path: string;
  mime: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ErrorPart".
 */
export interface ErrorPart {
  id: Ulid;
  type: "error";
  message: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "QuestionOption".
 */
export interface QuestionOption {
  label: string;
  description?: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "QuestionPage".
 */
export interface QuestionPage {
  question: string;
  header: string;
  options: QuestionOption[];
  multi_select?: boolean;
  /**
   * The answer is a secret: clients mask it, and the office stores `[secret]` in its place.
   */
  secret?: boolean;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "DiscussionEntry".
 */
export interface DiscussionEntry {
  role: "user" | "assistant";
  text: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
  /**
   * harness: a request from the session's harness (a Codex approval or question). It takes only an `option` or `text` answer; no side chat, send back or stop. It goes `stale` when the harness stops waiting.
   */
  source: "ask_user" | "human_input" | "ask_manager" | "harness";
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Profile".
 */
export interface Profile {
  person: Handle;
  text: string;
  version: GitId;
  over_budget?: boolean;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "FollowUp".
 */
export interface FollowUp {
  text: string;
  confirmed?: boolean;
  work_item_id?: Ulid | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
  /**
   * Why learning from it failed, when the office knows.
   */
  failure?: string | null;
  created_at: Timestamp;
}
/**
 * A metadata change, written to the outbox.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
    | "profile_proposal.updated"
    | "company.updated";
  at: Timestamp;
  subject_id: string;
  /**
   * The entity after the change; for company.updated, `{sha}` of the new company commit.
   */
  data: {
    [k: string]: unknown;
  };
}
/**
 * Streamed content that is never stored as metadata. For part.delta, data is {message_id, part_id, text} and the text is appended.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "CreateSessionRequest".
 */
export interface CreateSessionRequest {
  person: Handle;
  cwd: string;
  harness?: "composer" | "codex" | "claude";
  /**
   * The human's pick of connection for the new chat, which falls back as the office decides; null leaves it to the office.
   */
  connection?: ConnectionName | null;
  /**
   * The human's pick of model for the new chat, which falls back as the office decides; null leaves it to the office.
   */
  model?: string | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PromptRequest".
 */
export interface PromptRequest {
  text: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Ack".
 */
export interface Ack {
  ok: true;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "CostCapRequest".
 */
export interface CostCapRequest {
  cost_cap_usd: number;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "RepoIssue".
 */
export interface RepoIssue {
  path: string;
  code: string;
  message: string;
  severity?: "error" | "warning";
}
/**
 * The company at one commit of the office's clone, as GET /api/company serves it. People come without devices or password hashes.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "CompanyView".
 */
export interface CompanyView {
  sha: GitId;
  /**
   * Null when company.yaml is missing or doesn't parse at this commit.
   */
  company: Company | null;
  people: Person[];
  groups: Group[];
  /**
   * The files at this commit that don't parse.
   */
  issues: RepoIssue[];
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PersonCost".
 */
export interface PersonCost {
  /**
   * The price of the person's model calls since the report's start; only composer sessions are priced.
   */
  usd: number;
  /**
   * The person's harness sessions (Codex, Claude) updated since then, whose tokens the office doesn't price.
   */
  unpriced_sessions: number;
}
/**
 * Spend per person since a time, as GET /costs and GET /api/costs serve it.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "CostReport".
 */
export interface CostReport {
  since: Timestamp;
  /**
   * By handle; people with no spend are left out.
   */
  people: {
    [k: string]: PersonCost;
  };
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ApiVersion".
 */
export interface ApiVersion {
  /**
   * The compatibility key: `<version>+<first 12 hex of sha256(protocol.schema.json)>`, or just the version for an install without the schema.
   */
  api: string;
}
/**
 * The built web app's build.json.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "AppBuild".
 */
export interface AppBuild {
  /**
   * A random nonce per build.
   */
  build: string;
  /**
   * The compatibility key the app was built for.
   */
  api: string;
}
/**
 * GET /api/health: the office's compatibility key and the built app's, if there is one.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Health".
 */
export interface Health {
  ok: true;
  office: ApiVersion;
  /**
   * Null when the web app isn't built.
   */
  app: AppBuild | null;
}
/**
 * HQ's TCP listener on 127.0.0.1.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "HqTcp".
 */
export interface HqTcp {
  enabled: boolean;
  /**
   * The bound port while listening, else the configured one.
   */
  port: number;
  listening: boolean;
  /**
   * Why the last bind failed.
   */
  error?: string | null;
  next_retry_at?: Timestamp | null;
}
/**
 * GET /hq on the office socket: where HQ listens, for `opencorp pair` and `opencorp doctor`.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "HqStatus".
 */
export interface HqStatus {
  /**
   * The path of hq.sock.
   */
  socket: string;
  tcp: HqTcp;
  /**
   * http://127.0.0.1:<port>/ while TCP is listening, else null.
   */
  url: string | null;
  health: Health;
  /**
   * Why hq.sock isn't listening, or null when it is.
   */
  socket_error?: string | null;
  warnings?: string[];
}
/**
 * The body of POST /hq/pair on the office socket.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PairCodeRequest".
 */
export interface PairCodeRequest {
  /**
   * The human the browser will act as; null: the asking person.
   */
  handle?: Handle | null;
  /**
   * Also write a 0600 redirect file to open, so the code never appears in a process's arguments.
   */
  open_file?: boolean;
}
/**
 * A one-time pairing link: single use, valid for 5 minutes. `path` and `url` carry the secret code: served only on the office socket, never under `/api`, and never logged.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PairCode".
 */
export interface PairCode {
  /**
   * /pair#<code>.
   */
  path: string;
  /**
   * http://127.0.0.1:<port>/pair#<code> while TCP is listening, else null.
   */
  url: string | null;
  /**
   * The path of hq.sock, for an SSH forward.
   */
  socket: string;
  port: number;
  expires_at: Timestamp;
  /**
   * The redirect file's path, when one was asked for and TCP is listening.
   */
  open_file: string | null;
}
/**
 * The body of POST /api/pair: the code from the link's fragment.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "PairRequest".
 */
export interface PairRequest {
  code: string;
  /**
   * Free text naming the browser, such as 'Safari on Mac'.
   */
  label?: string | null;
}
/**
 * A browser signed in to this office's HQ. Local to the office; never the cookie's secret.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "BrowserSession".
 */
export interface BrowserSession {
  id: Ulid;
  person: Handle;
  /**
   * web-<6 characters>, made by the office.
   */
  name: string;
  label: string | null;
  via: "pair" | "login";
  /**
   * A person's unique, permanent name: shown as @handle, and the name of their people/<handle>/ directory.
   */
  issued_by: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  last_used_at: Timestamp | null;
}
/**
 * The body of POST /api/login: a human's handle and password; the office answers with a browser session cookie.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "HqLoginRequest".
 */
export interface HqLoginRequest {
  handle: Handle;
  password: string;
  /**
   * Free text naming the browser, such as 'Safari on Mac'.
   */
  label?: string | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SideChatRequest".
 */
export interface SideChatRequest {
  text: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SendBackRequest".
 */
export interface SendBackRequest {
  note: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ProfileWriteRequest".
 */
export interface ProfileWriteRequest {
  text: string;
  base_version: GitId;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "VersionConflict".
 */
export interface VersionConflict {
  expected: GitId;
  current: GitId;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ProfileManagerRequest".
 */
export interface ProfileManagerRequest {
  /**
   * The first message.
   */
  text: string;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
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
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ConfirmFollowUpsRequest".
 */
export interface ConfirmFollowUpsRequest {
  indices: number[];
}
/**
 * The body of POST /people/{handle}/devices.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "AddDeviceRequest".
 */
export interface AddDeviceRequest {
  name: DeviceName;
  token_sha256: TokenHash;
}
/**
 * The body of POST /login: a human's handle and password, and the device to add to their devices once they check out.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "LoginRequest".
 */
export interface LoginRequest {
  handle: Handle;
  password: string;
  device: DeviceName;
  token_sha256: TokenHash;
}
/**
 * The body of PUT /people/{handle}/password: the new password, which the office stores only as a hash.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetPasswordRequest".
 */
export interface SetPasswordRequest {
  password: string;
}
/**
 * A model connection on this office. Never holds a key.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "Connection".
 */
export interface Connection {
  name: ConnectionName;
  provider: string;
  method: "api_key" | "subscription" | "none";
  model?: string | null;
  default?: boolean;
}
/**
 * The connections on this office.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ConnectionList".
 */
export interface ConnectionList {
  connections: Connection[];
  default: ConnectionName;
  /**
   * Whether the asking person may add, remove or set the default.
   */
  can_manage: boolean;
}
/**
 * A model a connection offers; `name` is its display name when the provider gives one.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ModelOption".
 */
export interface ModelOption {
  id: string;
  name?: string | null;
}
/**
 * `listed` false: the provider can't list models, so a model name is typed.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ModelList".
 */
export interface ModelList {
  connection: ConnectionName;
  models: ModelOption[];
  listed: boolean;
  error?: string | null;
}
/**
 * A model equal to the connection's own is stored as null, so it follows that connection's changes.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetModelRequest".
 */
export interface SetModelRequest {
  connection: ConnectionName;
  model: string;
}
/**
 * A new API-key connection. The office never echoes it: a 422 names fields only.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "AddConnectionRequest".
 */
export interface AddConnectionRequest {
  provider: string;
  api_key: string;
  /**
   * Azure: the resource name or URL. provider openai: an OpenAI-compatible base URL.
   */
  endpoint?: string | null;
  model?: string | null;
}
/**
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetDefaultConnectionRequest".
 */
export interface SetDefaultConnectionRequest {
  connection: ConnectionName;
}
/**
 * Starts a subscription sign-in that adds a connection.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "StartLoginRequest".
 */
export interface StartLoginRequest {
  provider: "openai";
}
/**
 * A subscription sign-in. While `waiting`, the human opens `url` and enters `user_code`; `connection` names the new connection once `signed_in`; `message` says why it failed.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "ConnectionLogin".
 */
export interface ConnectionLogin {
  id: string;
  state: "waiting" | "signed_in" | "failed" | "cancelled";
  url?: string | null;
  user_code?: string | null;
  message?: string | null;
  connection?: ConnectionName | null;
}
/**
 * A typed answer; an empty one means `default`.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupAsk".
 */
export interface SetupAsk {
  type: "ask";
  question: string;
  default?: string;
}
/**
 * Pick one of `options`, or with `typed` type an answer.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupChoose".
 */
export interface SetupChoose {
  type: "choose";
  question: string;
  /**
   * @minItems 1
   */
  options: string[];
  default?: string;
  /**
   * Whether the owner may type an answer of their own instead of picking one of `options`.
   */
  typed?: boolean;
}
/**
 * An answer typed without being shown.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupSecret".
 */
export interface SetupSecret {
  type: "secret";
  question: string;
}
/**
 * A line to show.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupSay".
 */
export interface SetupSay {
  type: "say";
  text: string;
}
/**
 * The start of step `number` of `total`.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupStep".
 */
export interface SetupStep {
  type: "step";
  number: number;
  total: number;
  title: string;
  why: string;
}
/**
 * One line `opencorp`'s setup screen writes to the install's stdin: the answer to the last ask, choose or secret.
 *
 * This interface was referenced by `OpenCorpProtocol`'s JSON-Schema
 * via the `definition` "SetupAnswer".
 */
export interface SetupAnswer {
  answer: string;
}
