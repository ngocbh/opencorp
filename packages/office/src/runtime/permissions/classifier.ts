/** Auto's check: runs `flows/classify_command.yaml` on one command and reads its typed verdict. Every failure, a
 *  timeout and an answer that doesn't fit come back as an `ask` that says so; every check is recorded with what it
 *  spent. */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadFlow, runFlow } from "@ngocbh/yian"
import { withWarnings } from "@ngocbh/yian/platform"
import type { EventHook } from "@ngocbh/yian/run"
import flowYaml from "./flows/classify_command.yaml" with { type: "file" }
import { embedded } from "../../platform.ts"
import { makePrivateFolder } from "../../util/private_files.ts"
import type { Frame } from "../worker/channel.ts"
import { type Job, parseJob, type WorkerEnv } from "../worker/job.ts"
import { BaseHandlers } from "../worker/rpc.ts"
import { type WorkerRegistry, workerEnv } from "../worker/spawn.ts"
import type { CheckInput, Verdict } from "./policy.ts"

/** The model connection the host chose (the office's), as `llm_config` and its env; the key stays in these. */
export interface CheckModel {
  readonly llm_config: Readonly<Record<string, unknown>>
  readonly env: Readonly<Record<string, string>>
}
/** One check's model usage, raw, for the host to price: the sum over its calls. */
export interface CheckUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}
/** What a check spent: the model that answered, and its calls' usage (null when none reported any). */
export interface Spent {
  readonly model: string | null
  readonly usage: CheckUsage | null
}
/** One check as recorded: its verdict, or the `ask` it fell back to, and what it spent. */
export interface CheckRecord extends Spent {
  readonly input: CheckInput
  readonly verdict: "run" | "ask"
  readonly reason: string
  readonly failed: boolean
  readonly cached: boolean
  readonly runId: string | null
}

/** How long, in ms, a check may take before it asks: the office's backstop, which closes a worker that never
 *  answers. */
export const CHECK_TIMEOUT_MS = 30_000
/** The worker's own deadline for one check, under `CHECK_TIMEOUT_MS`, so a slow model reports a timeout rather than
 *  being killed. */
export const CLASSIFY_DEADLINE_MS = 25_000
/** How many inputs a session's check keeps verdicts for; past it, the oldest goes first. */
export const CACHE_SIZE = 500

/** The fixed reasons of an `ask` the check couldn't judge: no text from a failure, which could quote the request. */
export const COULD_NOT_RUN = "it couldn't run"
export const TIMED_OUT = `it didn't finish in ${CHECK_TIMEOUT_MS / 1000} s`
export const NO_VERDICT = "it gave no verdict"
/** The reason a stopped check is recorded with. */
export const STOPPED = "it was stopped"
const REASONS: readonly string[] = [COULD_NOT_RUN, TIMED_OUT, NO_VERDICT, STOPPED]

/** The yian settings a check runs with, after the connection's env so it can't lift them: a short wait for the
 *  first response and one retry; the deadline decides the rest. */
const CLASSIFY_LIMITS: Readonly<Record<string, string>> = Object.freeze({
  YIAN_MODEL_FIRST_RESPONSE_TIMEOUT_SECONDS: "20",
  YIAN_MODEL_IDLE_TIMEOUT_SECONDS: "20",
  YIAN_MODEL_RETRIES: "1",
})

/** How long, in ms, a stopped check's worker gets to end before its group is killed. */
const CLOSE_MS = 1000
/** How long, in ms, the office waits for a check's worker: past `CHECK_TIMEOUT_MS`, whose stop closes it first. */
const WAIT_MS = CHECK_TIMEOUT_MS + 2 * CLOSE_MS
/** How long, in ms, a stopped or late check's runner gets to settle (closing its worker, which a kill ends within
 *  twice `CLOSE_MS`, and reporting what it spent) before `judge` lets it go. */
const SETTLE_MS = 3 * CLOSE_MS

/** What `escapeData` replaces: `&`, and `<` and `>` in every width (full-width U+FF1C and U+FF1E, small U+FE64 and
 *  U+FE65). */
const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "＜": "&lt;",
  "＞": "&gt;",
  "﹤": "&lt;",
  "﹥": "&gt;",
}

/** The check couldn't judge; its message is one of the fixed reasons, and `model` and `usage` say what it spent. */
export class CheckFailed extends Error {
  override name = "CheckFailed"
  readonly model: string | null
  readonly usage: CheckUsage | null

  constructor(reason: string, spent: Spent = { model: null, usage: null }) {
    super(REASONS.includes(reason) ? reason : COULD_NOT_RUN)
    this.model = spent.model
    this.usage = spent.usage
  }
}

/** `text` with `&`, and `<` and `>` in any width, escaped as `&amp;`, `&lt;` and `&gt;`, so it can't close an
 *  element of the prompt's `<input>` block, or look as if it did. */
export function escapeData(text: string): string {
  return text.replace(/[&<>＜＞﹤﹥]/g, (char) => ESCAPES[char]!)
}

/** Runs the flow once on `input`: its raw output. `spend` hears what it spends as it learns it, on every path.
 *  Rejects on any failure, and with `signal`'s reason as soon as it aborts. */
export type CheckRunner = (
  input: CheckInput,
  o: { runId: string; signal: AbortSignal; spend(spent: Spent): void },
) => Promise<{ output: unknown }>

/** What a check needs of the worker registry. */
export type CheckWorkers = Pick<WorkerRegistry, "spawn" | "close" | "closed">

/** Handlers that keep the worker's last `result` or `error` frame, and refuse every request as `BaseHandlers` does
 *  (a classify job has no groups or stores, and nobody answers its questions). */
class ClassifyHandlers extends BaseHandlers {
  last: Frame | undefined

  override result(_worker: unknown, frame: Frame): void {
    this.last = frame
  }

  override error(_worker: unknown, frame: Frame): void {
    this.last = frame
  }
}

/** The office's runner: a `classify` worker job through `workers`, in a temp folder of its own, its log in `logDir`.
 *  The key is only in the job's `llm_config` and the connection's env, which the worker's env gets (as
 *  `oneReplyProblem` runs the model check). What the worker spent comes from its last frame. */
export function inWorker(workers: CheckWorkers, model: () => Promise<CheckModel>, o: { logDir: string }): CheckRunner {
  return async (input, { runId, signal, spend }) => {
    const connection = await untilAborted(model(), signal)
    makePrivateFolder(o.logDir)
    // The worker's own log (its stderr, where yian's errors could quote the request) goes with this folder.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-classify-"))
    const sessionId = `classify-${runId}`
    const stop = () => void workers.close(sessionId, CLOSE_MS).catch(() => {})
    try {
      const job = parseJob({
        kind: "classify",
        session_id: sessionId,
        run_id: runId,
        person: "",
        pin: dir,
        flow: "classify_command.yaml",
        log: path.join(o.logDir, `${runId}.jsonl`),
        llm_config: connection.llm_config,
        inputs: fieldsOf(input),
      })
      const handlers = new ClassifyHandlers()
      const spawning = workers.spawn(job, dir, handlers, { env: { ...connection.env } })
      const worker = await untilAborted(spawning, signal).catch((error: unknown) => {
        // A worker that starts after the stop is closed once it has.
        if (signal.aborted) void spawning.then(stop, () => {})
        throw error
      })
      signal.addEventListener("abort", stop, { once: true })
      if (signal.aborted) stop()
      const code = await worker.wait(WAIT_MS)
      if (code === null) await workers.close(sessionId, CLOSE_MS)
      spend(spentOf(handlers.last))
      signal.throwIfAborted()
      if (code === null) throw new CheckFailed(TIMED_OUT)
      return resultOf(handlers.last)
    } finally {
      signal.removeEventListener("abort", stop)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A runner in this process, running the flow as a `classify` worker does: the no-office host's. The run's
 *  environment is `env` (by default a worker's, from this process's) with the connection's env on top. */
export function here(model: () => Promise<CheckModel>, o: { logDir: string; env?: WorkerEnv }): CheckRunner {
  return async (input, { runId, signal, spend }) => {
    const connection = await untilAborted(model(), signal)
    makePrivateFolder(o.logDir)
    return classify(input, connection.llm_config, {
      env: { ...(o.env ?? workerEnv(process.env)), ...connection.env },
      log: path.join(o.logDir, `${runId}.jsonl`),
      runId,
      signal,
      deadlineMs: CLASSIFY_DEADLINE_MS,
      spend,
    })
  }
}

/** The worker's side of a `classify` job: the flow on the command in `job.inputs`, with `job.llm_config`, in `env`
 *  (the worker's own, which holds the connection's env), its run log at `job.log`; its output and what it spent.
 *  Rejects with a `CheckFailed` that carries what it spent: when it couldn't judge, passed `deadlineMs`, or `signal`
 *  aborted (`STOPPED`). */
export async function runClassify(
  job: Job,
  env: WorkerEnv,
  signal: AbortSignal,
  { deadlineMs = CLASSIFY_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<{ output: unknown } & Spent> {
  const tally = new Tally()
  try {
    const { kind, command, profile, cwd, host } = job.inputs
    if (![kind, command, profile, cwd, host].every((field) => typeof field === "string")) {
      throw new CheckFailed(COULD_NOT_RUN)
    }
    const input = { kind, command, profile, cwd, host } as CheckInput
    const options = { env, log: job.log, runId: job.run_id, signal, deadlineMs, spend: tally.add }
    const { output } = await classify(input, job.llm_config ?? {}, options)
    return { output, ...tally.spent }
  } catch (error) {
    const reason = signal.aborted ? STOPPED : error instanceof CheckFailed ? error.message : COULD_NOT_RUN
    throw new CheckFailed(reason, tally.spent)
  }
}

/** One session's check, which its host binds as `Permissions.check`. */
export class Check {
  readonly #run: CheckRunner
  readonly #record: (entry: CheckRecord) => Promise<void>
  readonly #timeoutMs: number
  readonly #cacheSize: number
  /** The session's verdicts by their exact input, oldest first. */
  readonly #cache = new Map<string, { verdict: "run" | "ask"; reason: string }>()

  constructor(o: {
    run: CheckRunner
    record(entry: CheckRecord): Promise<void>
    timeoutMs?: number
    cacheSize?: number
  }) {
    this.#run = o.run
    this.#record = (entry) => o.record(entry)
    this.#timeoutMs = o.timeoutMs ?? CHECK_TIMEOUT_MS
    this.#cacheSize = o.cacheSize ?? CACHE_SIZE
  }

  /**
   * The verdict on `input`: the session's cached one, else the flow's; `ask` with `failed` on any failure or past
   * `timeoutMs`. Each check is recorded, with what it spent, before it returns; a stopped one too. Rejects when
   * `signal` aborts, and when `record` rejects, so nothing runs unrecorded. Past a stop or `timeoutMs`, it waits for
   * the runner at most `SETTLE_MS`.
   */
  async judge(input: CheckInput, signal: AbortSignal): Promise<Verdict> {
    signal.throwIfAborted()
    const asked = fieldsOf(input)
    const key = JSON.stringify([asked.kind, asked.command, asked.profile, asked.cwd, asked.host])
    const kept = this.#cache.get(key)
    if (kept) {
      await this.#record({ input: asked, ...kept, failed: false, cached: true, runId: null, model: null, usage: null })
      return { ...kept }
    }
    const runId = randomUUID()
    const tally = new Tally()
    const run = new AbortController()
    const stop = () => run.abort(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    let late = false
    const timer = setTimeout(() => {
      late = true
      run.abort(new CheckFailed(TIMED_OUT))
    }, this.#timeoutMs)
    let outcome: Outcome<{ output: unknown }> | null
    try {
      outcome = await settled(this.#run(asked, { runId, signal: run.signal, spend: tally.add }), run.signal)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
    }
    const ran = { input: asked, cached: false, runId, ...tally.spent }
    if (signal.aborted) {
      await this.#record({ ...ran, verdict: "ask", reason: STOPPED, failed: true })
      throw signal.reason
    }
    const verdict = !late && outcome !== null && "ok" in outcome ? verdictOf(outcome.ok.output) : null
    if (verdict !== null) {
      await this.#record({ ...ran, ...verdict, failed: false })
      this.#keep(key, verdict)
      return { ...verdict }
    }
    const reason =
      late || outcome === null
        ? TIMED_OUT
        : "ok" in outcome
          ? NO_VERDICT
          : outcome.error instanceof CheckFailed
            ? outcome.error.message
            : COULD_NOT_RUN
    await this.#record({ ...ran, verdict: "ask", reason, failed: true })
    return { verdict: "ask", reason, failed: true }
  }

  #keep(key: string, verdict: { verdict: "run" | "ask"; reason: string }): void {
    if (this.#cacheSize <= 0) return
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size < this.#cacheSize) break
      this.#cache.delete(oldest)
    }
    this.#cache.set(key, verdict)
  }
}

/** A running sum of what one check spent: the latest model named, and the usage added up. */
class Tally {
  #model: string | null = null
  #usage: CheckUsage | null = null

  readonly add = (spent: Spent): void => {
    this.#model = spent.model ?? this.#model
    if (spent.usage === null) return
    this.#usage = {
      input_tokens: (this.#usage?.input_tokens ?? 0) + spent.usage.input_tokens,
      output_tokens: (this.#usage?.output_tokens ?? 0) + spent.usage.output_tokens,
    }
  }

  get spent(): Spent {
    return { model: this.#model, usage: this.#usage }
  }
}

/** How a promise settled. */
type Outcome<T> = { ok: T } | { error: unknown }

/** How `promise` settles, or null when it hasn't `SETTLE_MS` after `signal` aborts. */
async function settled<T>(promise: Promise<T>, signal: AbortSignal): Promise<Outcome<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let letGo!: (outcome: null) => void
  const given = new Promise<null>((resolve) => (letGo = resolve))
  const wait = () => void (timer = setTimeout(() => letGo(null), SETTLE_MS))
  if (signal.aborted) wait()
  else signal.addEventListener("abort", wait, { once: true })
  try {
    return await Promise.race([promise.then((ok) => ({ ok }), (error: unknown) => ({ error })), given])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", wait)
  }
}

/** `promise`, or a rejection with `signal`'s reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
}

/** `input`'s five fields alone, whatever else the caller's object holds. */
function fieldsOf(input: CheckInput): CheckInput {
  return { kind: input.kind, command: input.command, profile: input.profile, cwd: input.cwd, host: input.host }
}

/** The flow's output as a verdict, its other fields dropped; null when it isn't one. */
function verdictOf(output: unknown): { verdict: "run" | "ask"; reason: string } | null {
  if (typeof output !== "object" || output === null) return null
  const { verdict, reason } = output as { verdict?: unknown; reason?: unknown }
  if ((verdict !== "run" && verdict !== "ask") || typeof reason !== "string") return null
  return { verdict, reason }
}

/** What a classify worker's last frame, a result or an error, says it spent. */
function spentOf(frame: Frame | undefined): Spent {
  const usage = isUsage(frame?.usage) ? (frame!.usage as CheckUsage) : null
  return {
    model: typeof frame?.model === "string" ? frame.model : null,
    usage: usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  }
}

/** What a classify worker's last frame says: its result's output, or the `CheckFailed` its error names
 *  (`COULD_NOT_RUN` for any other end). */
function resultOf(frame: Frame | undefined): { output: unknown } {
  if (frame?.type === "error") {
    const reason = REASONS.find((known) => frame.message === `CheckFailed: ${known}`)
    throw new CheckFailed(reason ?? COULD_NOT_RUN)
  }
  if (frame?.type !== "result") throw new CheckFailed(COULD_NOT_RUN)
  const { type: _, output, model, usage, ...rest } = frame
  const fits =
    Object.keys(rest).length === 0 &&
    Object.hasOwn(frame, "output") &&
    (model === null || typeof model === "string") &&
    (usage === null || isUsage(usage))
  if (!fits) throw new CheckFailed(COULD_NOT_RUN)
  return { output }
}

/** Whether `usage` holds finite `input_tokens` and `output_tokens`, as a check's usage does. */
function isUsage(usage: unknown): boolean {
  const counts = usage as { input_tokens?: unknown; output_tokens?: unknown } | null
  return (
    typeof counts === "object" &&
    counts !== null &&
    Number.isFinite(counts.input_tokens) &&
    Number.isFinite(counts.output_tokens)
  )
}

/**
 * Runs the flow once on `input` with `llmConfig`, in `env` with `CLASSIFY_LIMITS` on top, its run log at `log`
 * under `runId`; `spend` hears each model call's model and usage as it finishes. `cwd`, `host` and `command` reach
 * the prompt escaped. Rejects with `CheckFailed` on any failure or past `deadlineMs`, and with `signal`'s reason once
 * it aborts.
 */
async function classify(
  input: CheckInput,
  llmConfig: Readonly<Record<string, unknown>>,
  o: {
    env: WorkerEnv
    log: string
    runId: string
    signal: AbortSignal
    deadlineMs: number
    spend(spent: Spent): void
  },
): Promise<{ output: unknown }> {
  o.signal.throwIfAborted()
  const vars: Record<string, string | undefined> = { ...o.env, ...CLASSIFY_LIMITS }
  const env = (name: string) => (Object.hasOwn(vars, name) ? vars[name] : undefined)
  // Apart from the caller's signal: running out of time is a timeout, a caller's stop is not.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), o.deadlineMs)
  const onEvent: EventHook = (event) => {
    if (event.type !== "ModelCallFinished") return
    const usage = event.usage && { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens }
    o.spend({ model: event.model, usage })
  }
  // An Azure deployment or a gateway's model is never in yian's list; the owner chose it on purpose.
  const warned = (message: string, type: string | undefined) => {
    if (!/^Model .* is not in the known model list/s.test(message)) process.emitWarning(message, type)
  }
  const data = {
    kind: input.kind,
    command: escapeData(input.command),
    profile: input.profile,
    cwd: escapeData(input.cwd),
    host: escapeData(input.host),
  }
  try {
    const flow = await loadFlow(embedded(flowYaml).toString("utf8"), {
      sourceLabel: "runtime/permissions/flows/classify_command.yaml",
    })
    const result = await withWarnings(warned, () =>
      runFlow(flow, data, {
        llmConfig,
        tools: {},
        numWorkers: 0,
        env,
        log: o.log,
        runId: o.runId,
        signal: AbortSignal.any([o.signal, deadline.signal]),
        onEvent,
      }),
    )
    o.signal.throwIfAborted()
    if (result.status === "succeeded") return { output: result.output }
    if (deadline.signal.aborted) throw new CheckFailed(TIMED_OUT)
    throw new CheckFailed(result.failure?.code === "agent.output_invalid" ? NO_VERDICT : COULD_NOT_RUN)
  } catch (error) {
    o.signal.throwIfAborted()
    if (error instanceof CheckFailed) throw error
    throw new CheckFailed(deadline.signal.aborted ? TIMED_OUT : COULD_NOT_RUN)
  } finally {
    clearTimeout(timer)
  }
}
