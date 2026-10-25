/** One Codex session's app-server, thread, transcript and turns. */
import type { SessionRecord } from "../store/store.ts"
import type { CodexProcess } from "./codex.ts"
import type { CodexSessions } from "./sessions.ts"

/** Milliseconds office stop waits for the session to finish the job it is in. */
export const STOP_WAIT_MS = 10_000
/** Milliseconds an ending session waits for its interrupted turn to complete before it closes the app-server anyway. */
export const END_WAIT_MS = 10_000
/** Milliseconds an answer waits for the session to write its reply. */
export const REPLY_WAIT_MS = 30_000

/** One Codex session: its app-server and the thread it has loaded. */
export class CodexSession {
  readonly owner: CodexSessions
  readonly sessionId: string
  readonly cwd: string
  /** Who a message with no named sender is from. */
  readonly author: string | null
  /** The app-server being started, which office stop kills too. */
  launching: CodexProcess | null = null
  /** Set by office stop: no app-server starts after it. */
  stopped = false

  constructor(owner: CodexSessions, session: SessionRecord, { author }: { author: string | null }) {
    this.owner = owner
    this.sessionId = session.id
    this.cwd = session.cwd
    this.author = author
  }

  /** Records `proc` as the app-server being started, so office stop kills it; false once stopped. */
  launchingAs(proc: CodexProcess): boolean {
    if (this.stopped) return false
    this.launching = proc
    return true
  }

  /** A notification from `proc`. */
  notified(_proc: CodexProcess, _method: string, _params: unknown): void {}

  /** A server request from `proc`, which waits for the reply to `id`. */
  requested(_proc: CodexProcess, _id: unknown, _method: string, _params: unknown): void {}

  /** `proc` exited. */
  exited(_proc: CodexProcess): void {}
}
