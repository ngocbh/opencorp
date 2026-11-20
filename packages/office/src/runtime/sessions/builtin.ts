/** A built-in agent's session on a host with no office: what a feature gives the host (`BuiltinSession`), what the
 *  host gives the feature's tools (`SessionBinding`), and the chat that runs it with the TUI on it (`BuiltinChat`),
 *  which the CLI gives the feature. The host runs the session's flow in a kept worker and serves it
 *  as the office serves its sessions: its cards, its four modes, Auto's check and its instruments. */
import type { ApprovalCard, Permissions, Where } from "../permissions/policy.ts"
import type { OfficeTool } from "../worker/rpc.ts"
import type { LiveInstrument } from "./instruments.ts"

/** The built-in agent the session talks with: its handle and its name. */
export interface BuiltinAgent {
  readonly handle: string
  readonly name: string
}

/** The model the session's flow and Auto's check run on, as `llm_config` and its env; the key stays in these. */
export interface BuiltinModel {
  readonly llm_config: Readonly<Record<string, unknown>>
  readonly env: Readonly<Record<string, string>>
}

/** What the host uses of the terminal the session's tools drive: where a new shell starts, a held call run once its
 *  card says Yes, Esc, and the session's end. `Terminal` fits. */
export interface BuiltinTerminal {
  where(): Where
  runApproved(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
  interruptWaits(): void
  close(): Promise<void>
}

/** The session's tools: its tool groups as the model calls them, and the terminal they drive, if any. */
export interface BuiltinTools<T extends BuiltinTerminal = BuiltinTerminal> {
  readonly groups: Readonly<Record<string, Readonly<Record<string, OfficeTool>>>>
  readonly terminal?: T
}

/** One session of a built-in agent, as a feature gives it to the host. */
export interface BuiltinSession<T extends BuiltinTerminal = BuiltinTerminal> {
  readonly agent: BuiltinAgent
  /** The flow, as embedded text and its name. It has the chat flow's shape: inbox `messages`, turn `chat/heard`,
   *  reply `chat/reply`. */
  readonly flow: { readonly name: string; readonly text: string }
  readonly inputs: Readonly<Record<string, unknown>>
  /** The owner's first message, sent from them as the session opens: the choice that started it. */
  readonly first?: string
  readonly model: BuiltinModel
  /** The session's own folder: its flow's pin, its run log, Auto's checks and its worker's log. Its parent holds the
   *  folders of earlier sessions, whose shells' records (`<folder>/terminal/`) an earlier host may have left running. */
  readonly folder: string
  /** The session's tools, given what the host binds for them. */
  tools(binding: SessionBinding): BuiltinTools<T> | Promise<BuiltinTools<T>>
}

/** Runs `session` on the no-office host with the TUI on it, in this process, so what the session's tools leave open
 *  stays the caller's. Resolves once the session is over, the host stopped and the TUI closed, to how it ended. */
export type BuiltinChat<T extends BuiltinTerminal = BuiltinTerminal> = (session: BuiltinSession<T>) => Promise<ChatEnd>

/** How a built-in agent's session ended: as asked (`ended`), its run failed (`failed`, `error` saying why, as the run
 *  said it), or the owner left the TUI before it ended (`left`, which ends it). */
export interface ChatEnd {
  readonly status: "ended" | "failed" | "left"
  readonly error: string | null
}

/** What a card's Yes runs: the held call's output, stopped by `signal` (Esc, End). */
export type CardAct = (signal: AbortSignal) => Promise<unknown>

/** A question card a feature's call holds for the owner: its title, the text they read whole before the choices, and
 *  the choices; they may type an answer instead. `reason` says why it asks, which `dontAsk`'s refusal names. */
export interface QuestionCard {
  readonly title: string
  readonly question: string
  readonly options: readonly string[]
  readonly reason: string
}

/** The owner's answer to a question card: one of its options, or the words they typed. */
export interface CardAnswer {
  readonly value: string
  readonly typed: boolean
}

/** What a question card's answer runs: the held call's output, stopped by `signal` (Esc, End). */
export type QuestionAct = (answer: CardAnswer, signal: AbortSignal) => Promise<unknown>

/** Where one shell's state changes and live output go. */
export interface ShellListener {
  changed(state: unknown): void
  output(chunk: Uint8Array): void
}

/** What the host binds for a session's tools; the model sets none of it. */
export interface SessionBinding {
  readonly sessionId: string
  /** The session's mode, its session rules, Auto's check and its cards. Where a shell runs is its terminal's to say:
   *  this `where` is only the start of shells with no sandbox, a folder it doesn't know. */
  readonly permissions: Permissions
  /** Holds yian call `callId` on approval card `card` for the session's owner and returns what the call returns now:
   *  yian's `pending()`, or, in `dontAsk`, the refusal. On Yes `act` makes the call's output; a No's is the owner's
   *  words. */
  hold(card: ApprovalCard, callId: string, act: CardAct): unknown
  /** Holds yian call `callId` on question card `card` for the session's owner and returns what the call returns now:
   *  yian's `pending()`, or, in `dontAsk`, the refusal. It asks in every other mode: no rule or check answers it. The
   *  owner's answer goes to `act`, whose output completes the call; Esc answers it interrupted. */
  ask(card: QuestionCard, callId: string, act: QuestionAct): unknown
  /** Where new shell `id`, named `name`, reports: the host lists it as the session's instrument. */
  onShell(id: string, name: string): ShellListener
  /** The instruments the feature owns, listed in the session: the host removes their listing at the session's end and
   *  never closes them. */
  readonly instruments: {
    add(instrument: LiveInstrument): void
    updated(id: string): void
    output(id: string, chunk: Uint8Array): void
    remove(id: string): void
  }
}
