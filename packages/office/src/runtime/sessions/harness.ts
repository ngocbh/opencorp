/** What every session harness offers: the card actions (`CardActor`) and what the session routes call
 *  (`SessionHarness`). The chat harness and the Codex sessions implement it; the routes and the cards call it. */
import type { Message } from "@opencorp/protocol"
import type { Hooks } from "./hooks.ts"
import type { Live } from "../runs/records.ts"
import type { QuestionRecord, SessionRecord } from "../store/store.ts"

/** The four ways a question is answered (`option`, `text`, `sent_back`, `interrupted`): the store's `answer_kind`. */
export type AnswerKind = NonNullable<QuestionRecord["answer_kind"]>

/** What the cards ask of the session actor: the chat harness or the Codex sessions. */
export interface CardActor {
  /** The hooks the questions extension adds the cards' checks and notifications to. */
  readonly hooks: Hooks
  /** Answer an open question as `by` after the `answerCheck` hooks and deliver it to its run; throws
   *  `HarnessError` (404 not_found, 409 not_open, 422 invalid_answer, ...). */
  answer(
    questionId: string,
    value: unknown,
    kind: AnswerKind,
    options?: { by?: string | null },
  ): Promise<QuestionRecord>
  /** Esc on a live session: its model questions are answered interrupted and the reply stops; throws
   *  `HarnessError` when the session has no run to stop. A card's stop names its `question`: refused 409
   *  `not_open` unless it is open with no other interrupt under way, and 409 `ending` while the session ends. */
  interrupt(sessionId: string, options?: { question?: string | null }): Promise<void>
}

/** The office's harness for the session routes: the card actions, plus what the session routes call. Each call
 *  throws `HarnessError` for an API error (404 not_found, 409 not_live, 422 refused, 501 not_implemented, ...). */
export interface SessionHarness extends CardActor {
  /** Starts `handle`'s main chat in `cwd` on `harness`, opened by `openedBy`; `connection` and `model` are their
   *  pick, which the harness may pass over. */
  startSession(
    handle: string,
    cwd: string,
    options: {
      harness: SessionRecord["harness"]
      openedBy: string | null
      connection: string | null
      model: string | null
    },
  ): Promise<SessionRecord>
  /** Opens a profile-manager session over `handle`'s profile, opened by `by`, with `text` as its first message.
   *  Only the chat harness runs one; Codex sessions don't. */
  startManager?(handle: string, text: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** A message from `by` (the opener when null): a turn, a steer, an answer or queued. */
  prompt(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Steers the running reply as `by`; with no reply running it is a `prompt`. */
  steer(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Ends the session, interrupting a busy reply first; ending one already ending is a no-op. */
  end(sessionId: string): Promise<void>
  /** Continues an ended session as a new one opened by `by`. */
  continueSession(sessionId: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** Sets the session's cost cap. */
  setCostCap(sessionId: string, usd: number): Promise<SessionRecord>
  /** Switches the session's connection and model for its next turn. */
  setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord>
  /** What a client reads of the session before following its live events. */
  messages(sessionId: string): Message[] | Promise<Message[]>
  /** What memory says about its runs, for Run Logs; the chat harness implements it. */
  live?(): Live
  /** Closes each parked worker whose connection changed; the chat harness implements it. Never rejects. */
  connectionsChanged?(): Promise<void>
}
