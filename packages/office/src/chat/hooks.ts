/** Callback lists that extensions append to when they register; the harness calls them in order. */
import type { QuestionRecord, SessionRecord } from "../store/store.ts"
import type { Frame } from "../worker/channel.ts"

type Status = SessionRecord["status"]

/** Every hook's signature. Notifications return `unknown`: a returned promise is awaited, any other value ignored. */
export interface HookFns {
  /** A question was stored (turn questions included). */
  questionStored: (question: QuestionRecord) => unknown
  /** Return a message to refuse an answer (`422 invalid_answer`); nothing accepts it. */
  answerCheck: (question: QuestionRecord, answer: unknown, kind: "option" | "text") => string | null | undefined
  /** Return a message to refuse a person's message to the session (prompt, steer or turn answer; `422 refused`);
   *  `session` is undefined for a session being opened. */
  promptCheck: (session: SessionRecord | undefined, text: string) => string | null | undefined
  /** Text for the turn input's `context`, which the flow puts before the person's messages; the transcript shows only
   *  the messages. The first string wins; other results are ignored. The exit command skips it. */
  turnContext: (session: SessionRecord, question: QuestionRecord, text: string) => string | null | undefined
  /** A worker started a run or a resume of one. */
  runStarted: (session: SessionRecord, runId: string) => unknown
  /** A run ended; `result` is the worker's result frame (`status`, `output`, `failure`) with the model key redacted,
   *  or null after an error frame. */
  runFinished: (session: SessionRecord, runId: string, result: Frame | null) => unknown
  /** The session's worker is gone. */
  workerExited: (session: SessionRecord, code: number | null) => unknown
  /** The session's run ended normally; the first status returned (say `debriefing`) is stored instead of `ended`. */
  endStatus: (session: SessionRecord) => Status | null | undefined
  /** The session reached ended, the endStatus one, or failed; fires once, also for a session that failed before its
   *  worker started. */
  sessionEnded: (session: SessionRecord) => unknown
}

export type CheckName = "answerCheck" | "promptCheck" | "turnContext" | "endStatus"
export type NotificationName = "questionStored" | "runStarted" | "runFinished" | "workerExited" | "sessionEnded"

const CHECKS = new Set<string>(["answerCheck", "promptCheck", "turnContext", "endStatus"])
const NOTIFICATIONS = new Set<string>(["questionStored", "runStarted", "runFinished", "workerExited", "sessionEnded"])

type AnyFn = (...args: unknown[]) => unknown

/**
 * The harness's extension points: one list of callbacks per hook, which extensions append to when they register
 * (the explicit extension list). A callback that throws is logged by its error's type and skipped; the rest still run.
 *
 * Checks run inline in the session actor, so they must be quick and synchronous (an async check's promise would read
 * as a refusal) and must never call back into it. Notifications may be async; they are awaited one by one, in order.
 */
export class Hooks {
  readonly questionStored: HookFns["questionStored"][] = []
  readonly answerCheck: HookFns["answerCheck"][] = []
  readonly promptCheck: HookFns["promptCheck"][] = []
  readonly turnContext: HookFns["turnContext"][] = []
  readonly runStarted: HookFns["runStarted"][] = []
  readonly runFinished: HookFns["runFinished"][] = []
  readonly workerExited: HookFns["workerExited"][] = []
  readonly endStatus: HookFns["endStatus"][] = []
  readonly sessionEnded: HookFns["sessionEnded"][] = []
  readonly #log: (line: string) => void

  /** `log` takes the failure lines (default `console.error`). */
  constructor(options?: { log?: (line: string) => void }) {
    this.#log = options?.log ?? ((line) => console.error(line))
  }

  /** Calls every `name` check with `args`, in order, synchronously; returns the results of those that didn't throw. */
  fire<K extends CheckName>(name: K, ...args: Parameters<HookFns[K]>): ReturnType<HookFns[K]>[] {
    checkName(name, CHECKS, "check")
    const results: ReturnType<HookFns[K]>[] = []
    // A copy, so a callback added during the call runs next time.
    for (const fn of [...this[name]] as AnyFn[]) {
      try {
        results.push(fn(...args) as ReturnType<HookFns[K]>)
      } catch (error) {
        this.#failed(name, fn, error)
      }
    }
    return results
  }

  /** Calls every `name` notification with `args`, in order, awaiting each; one that throws or rejects is logged
   *  and skipped. Never rejects (a bad name throws synchronously, before anything runs). */
  notify<K extends NotificationName>(name: K, ...args: Parameters<HookFns[K]>): Promise<void> {
    checkName(name, NOTIFICATIONS, "notification")
    return this.#notify(name, [...this[name]] as AnyFn[], args)
  }

  async #notify(name: string, fns: AnyFn[], args: unknown[]): Promise<void> {
    for (const fn of fns) {
      try {
        await fn(...args)
      } catch (error) {
        this.#failed(name, fn, error)
      }
    }
  }

  #failed(name: string, fn: AnyFn, error: unknown): void {
    // A `name` getter can throw, and a non-string name must not become log text.
    let label = "anonymous"
    try {
      const fnName: unknown = fn.name
      if (typeof fnName === "string" && fnName !== "") label = fnName
    } catch {}
    // The type only: an error's message or stack could quote a secret.
    try {
      this.#log(`${name} callback ${label} failed: ${errorName(error)}`)
    } catch {}
  }
}

/** Throws unless `name` is a hook in `kind`'s set. */
function checkName(name: string, names: Set<string>, kind: string): void {
  if (names.has(name)) return
  if (!CHECKS.has(name) && !NOTIFICATIONS.has(name)) throw new Error(`no hook named '${name}'`)
  throw new Error(`'${name}' is not a ${kind}`)
}

const NAME = /^[A-Za-z_$][\w$]{0,63}$/

/** A thrown value's name for a log line; never throws (a getter or a revoked `Proxy` can). */
function errorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    const name: unknown = error.name
    return typeof name === "string" && NAME.test(name) ? name : "Error"
  } catch {
    return "Error"
  }
}
