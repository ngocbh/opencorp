/** The shape every external agent harness adapter takes, and the types it passes. Types only. */
import type { AnswerField, HarnessPolicy, HarnessUsage, Message, Part, QuestionPage } from "@opencorp/protocol"

/** Environment variables by name. */
export type Env = Record<string, string>

/** One of doctor's check lines. */
export type HarnessCheck = { status: "ok" | "warn" | "fail"; detail: string }

/** What a harness Question shows. Secret pages are those with `QuestionPage.secret`. */
export type Card = {
  kind: "command" | "file_change" | "permissions" | "mcp_tool" | "question" | "elicitation"
  title: string | null
  question: string
  options: string[]
  questions: QuestionPage[] | null
  answer_schema: AnswerField[]
}

/** An answer to a harness card: one of its offered labels, or its pages' values. */
export type CardAnswer = { kind: "option" | "text"; answer: unknown }

/** One external agent harness: Codex now; Claude Code and other coding harnesses later.
 *
 *  No option an adapter offers may persist a permission past the session (Codex's exec-policy amendments and MCP
 *  "don't ask again", Claude Code's "always allow" and other harnesses' equivalents are never offered), and an answer that
 *  isn't one of the card's offered labels is refused. */
export interface HarnessAdapter {
  /** The harness's name, as `Session.harness`. */
  readonly name: "codex"
  /** Doctor's check: the binary, its version, and whether an account is signed in. */
  check(env: Env): Promise<HarnessCheck>
  /** Starts the harness for one session, loading or resuming its thread. */
  open(spec: HarnessOpen): Promise<HarnessProcess>
}

/** What a harness session opens with. */
export interface HarnessOpen {
  /** The office session's id. */
  sessionId: string
  /** The checked workspace the harness works in. */
  cwd: string
  /** The person's profile.md text. */
  profile: string
  /** The person's sandbox and network; null takes the defaults (read-only, no network). */
  policy: HarnessPolicy | null
  /** The model to use; null keeps the harness's own choice. */
  model: string | null
  /** The harness session id to resume; null starts a new one. */
  resume: string | null
  /** The file the harness's stderr goes to. */
  log: string
  /** The allowlisted environment the harness runs with. */
  env: Env
  /** Called with each event, in order. */
  onEvent(event: HarnessEvent): void
}

/** One running harness session. */
export interface HarnessProcess {
  /** The harness's own id for the session, which `HarnessOpen.resume` takes. */
  readonly harnessSessionId: string
  /** The harness process's pid. */
  readonly pid: number
  /** Starts a turn with the message `text`; `author` is the human who sent it (the opener when the caller named
   *  nobody). */
  turn(text: string, author: string | null): Promise<void>
  /** Adds `text` to the running turn; "queued" where the harness has no mid-turn input. `author` is the human who
   *  sent it (the opener when the caller named nobody). */
  steer(text: string, author: string | null): Promise<"steered" | "queued">
  /** Stops the running turn. */
  interrupt(): Promise<void>
  /** Answers the card issued as `key`; the adapter maps the answer through the card it stored and builds the
   *  harness's reply itself. */
  answer(key: string, answer: CardAnswer): Promise<void>
  /** Closes stdin, waits 5 s, then kills the process group. */
  close(): Promise<void>
}

/** What a harness session reports, in order. */
export type HarnessEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage: HarnessUsage | null }
  /** Live only, never stored, in order: a new user, assistant or error message, with its parts
   *  (`message.updated`). The message is a copy the receiver may keep. */
  | { type: "message"; message: Message }
  /** Live only, never stored, in order: a part added to message `messageId`, or replacing the one with its `id`
   *  (`part.updated`). The part is a copy the receiver may keep. */
  | { type: "part"; messageId: string; part: Part }
  /** Live only, never stored, in order: `text` appended to part `partId` of message `messageId` (`part.delta`). */
  | { type: "delta"; messageId: string; partId: string; text: string }
  /** Becomes a Question with source "harness" on run `runId`, node `nodeId`. */
  | { type: "request"; key: string; card: Card; runId: string; nodeId: string }
  /** The card went stale. */
  | { type: "request_resolved"; key: string }
  | { type: "model"; model: string }
  | { type: "exited"; code: number | null; signal: string | null }
