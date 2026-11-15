/** The model check: why a provider's model doesn't answer a one-word request, made in this process, and as a worker
 *  job of kind `check` for a connection whose provider can't list its models. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ComposedFlow, loadFlow, runFlow } from "@ngocbh/yian"
import { callCredentials } from "@ngocbh/yian/llm_clients"
import { withWarnings } from "@ngocbh/yian/platform"
import type { RunFlowOptions, RunResult } from "@ngocbh/yian/run"
import checkModelYaml from "./flows/check_model.yaml" with { type: "file" }
import { redact as redactSecrets, redactUrls } from "../util/redact.ts"
import { embedded } from "../platform.ts"
import type { Frame } from "../runtime/worker/channel.ts"
import { type Job, parseJob, type WorkerEnv } from "../runtime/worker/job.ts"
import { BaseHandlers } from "../runtime/worker/rpc.ts"
import { RegistryClosed, type WorkerRegistry, workerEnv } from "../runtime/worker/spawn.ts"
import * as models from "./models.ts"
import { Provider } from "./provider.ts"

/** How long, in ms, the check may take: one short reply from the model. */
export const TIMEOUT_MS = 90_000
/** The problem when the check ended without a usable result frame. */
export const NO_RESULT = "the check didn't give a result"
/** The problem when the check outlived its timeout. */
export const NOT_FINISHED = "the check didn't finish"
/** How long, in ms, a hung check gets to stop before its group is killed. */
export const CLOSE_MS = 1000

/** What the check needs of the worker registry. */
export type CheckWorkers = Pick<WorkerRegistry, "spawn" | "close" | "closed">

/** Handlers that keep the worker's last `result` or `error` frame, and refuse every request as `BaseHandlers` does
 *  (a check job has no groups or stores, and nobody answers its questions). */
class CheckHandlers extends BaseHandlers {
  last: Frame | undefined

  override result(_worker: unknown, frame: Frame): void {
    this.last = frame
  }

  override error(_worker: unknown, frame: Frame): void {
    this.last = frame
  }
}

/**
 * Why `provider`'s model doesn't answer a one-word request made as an office run makes it, or null when it answers.
 *
 * Runs a `check` job through `workers` in a fresh folder of its own (removed afterwards, with the worker's log: its
 * stderr is dropped, since yian's errors there could quote the request); the key goes only in the job's
 * `llm_config`. `log` gets the "no result" line, with the exit code only. Rejects as `workers.spawn` does
 * (`RegistryClosed` once the office is stopping), and with `RegistryClosed` when the office stop ended the check
 * before it gave a result.
 */
export async function oneReplyProblem(
  workers: CheckWorkers,
  provider: Provider,
  { timeoutMs = TIMEOUT_MS, log = () => {} }: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-check-"))
  try {
    const sessionId = `check-${path.basename(dir)}`
    const job = parseJob({
      kind: "check",
      session_id: sessionId,
      run_id: sessionId,
      person: "",
      pin: dir,
      flow: "check_model.yaml",
      log: path.join(dir, "log.jsonl"),
      llm_config: provider.llm_config,
    })
    const handlers = new CheckHandlers()
    const worker = await workers.spawn(job, dir, handlers, { env: { ...provider.env } })
    const code = await worker.wait(timeoutMs)
    if (code === null) {
      await workers.close(sessionId, CLOSE_MS)
      return NOT_FINISHED
    }
    const problem = resultOf(handlers.last)
    // The stop asked the worker to end, or killed it: the model never had its say.
    if (problem === NO_RESULT && workers.closed) throw new RegistryClosed()
    if (problem === NO_RESULT) log(`the one-reply check gave no result (exit code ${code})`)
    return problem
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The problem in the worker's last frame; `NO_RESULT` unless it is a result holding just a null or string
 *  `problem`. */
function resultOf(frame: Frame | undefined): string | null {
  if (frame?.type !== "result") return NO_RESULT
  const keys = Object.keys(frame)
  if (keys.length !== 2 || !Object.hasOwn(frame, "problem")) return NO_RESULT
  const problem = frame.problem
  return problem === null || typeof problem === "string" ? problem : NO_RESULT
}

/** The worker's side of a `check` job: why the model in `job.llm_config` doesn't answer, or null when it does. The
 *  run's environment is `env`, the worker's own, which holds the provider env. Rejects with `signal`'s reason once
 *  it aborts. */
export async function runCheck(job: Job, env: WorkerEnv, signal: AbortSignal): Promise<string | null> {
  return modelProblem(Provider.parse({ llm_config: job.llm_config }), { env, signal })
}

/** Why a provider's model doesn't answer, or null when it does. */
export type ModelCheck = (provider: Provider) => Promise<string | null>

/** How long, in ms, the model check waits for an answer: under the daemon's 90 s wait for its worker, so the
 *  worker's "timed out" reaches the daemon first. */
export const CHECK_DEADLINE_MS = 80_000

/** The yian settings the model check runs with: one slow request and one retry, then the deadline decides. */
export const CHECK_LIMITS: Readonly<Record<string, string>> = Object.freeze({
  YIAN_MODEL_FIRST_RESPONSE_TIMEOUT_SECONDS: "60",
  YIAN_MODEL_IDLE_TIMEOUT_SECONDS: "60",
  YIAN_MODEL_RETRIES: "1",
})

/** The secrets a run on `provider` in `base` (a worker's env from this process's by default) with `provider.env` on
 *  top may send, as yian lists them now: its key, or the login it would use (the sign-in `YIAN_AUTH_FILE` names, or
 *  yian's own store in the run's `HOME`) read again, so tokens refreshed since are in it. */
export function providerSecrets(provider: Provider, base?: WorkerEnv): string[] {
  const vars: Record<string, string | undefined> = { ...(base ?? workerEnv(process.env)), ...provider.env }
  const env = (name: string) => (Object.hasOwn(vars, name) ? vars[name] : undefined)
  return [...callCredentials(provider.llm_config, { env })]
}

/**
 * Runs `flow` with `provider`'s model as an office run would; resolves its result (null when the run threw), and
 * why it failed (null when it didn't), without the key, the sign-in's tokens or URL credentials. The run's
 * environment is `env` (by default a worker's, from this process's) with `provider.env` on top, then `limits`;
 * `onEvent` sees the run's events as `runFlow`'s does. Rejects with `signal`'s reason once it aborts.
 */
export async function runSetup(
  flow: ComposedFlow,
  inputs: Readonly<Record<string, unknown>>,
  provider: Provider,
  {
    tools,
    context,
    env: base,
    signal,
    limits,
    onEvent,
  }: {
    tools: NonNullable<RunFlowOptions["tools"]>
    context?: unknown
    env?: WorkerEnv
    signal?: AbortSignal
    limits?: Readonly<Record<string, string>>
    onEvent?: RunFlowOptions["onEvent"]
  },
): Promise<{ result: RunResult | null; message: string | null }> {
  // The run gets the environment office runs get, so it authenticates the way they will: a shell variable the
  // office never sees can't make it work.
  // The limits go after the provider's env, so it can't lift them.
  const vars: Record<string, string | undefined> = { ...(base ?? workerEnv(process.env)), ...provider.env, ...limits }
  const env = (name: string) => (Object.hasOwn(vars, name) ? vars[name] : undefined)
  // An Azure deployment or a gateway's model is never in yian's list; the owner chose it on purpose.
  const handler = (message: string, type: string | undefined) => {
    if (!/^Model .* is not in the known model list/s.test(message)) process.emitWarning(message, type)
  }
  let result: RunResult | null = null
  let message: string | null = null
  try {
    // No workers: the code nodes, and so the terminal, stay in this process.
    result = await withWarnings(handler, () =>
      runFlow(flow, inputs, { llmConfig: provider.llm_config, tools, numWorkers: 0, context, env, signal, onEvent }),
    )
    if (result.status === "failed") message = result.failure?.message ?? "the run failed"
  } catch (error) {
    // A stopped run says nothing about the model.
    signal?.throwIfAborted()
    message = error instanceof Error ? error.message : String(error)
  }
  if (message !== null) {
    const secrets = providerSecrets(provider, base)
    // Every form of the key or sign-in tokens, as chat runs scrub theirs: yian scrubs a key only as written and
    // escaped, and a provider may quote it in another letter case or base64-encoded.
    if (secrets.length > 0) message = redactSecrets(message, [], secrets)
    message = redactUrls(message).replace(/\.+$/, "")
  }
  return { result, message }
}

/** Why `provider`'s model doesn't answer a one-word request made as an office run makes it, or null when it
 *  answers; `timed out` once `timeoutMs` passes. The run's environment is as `runSetup`'s, `env` replacing the
 *  default base, with `CHECK_LIMITS` on top. Rejects with `signal`'s reason once it aborts. */
export async function modelProblem(
  provider: Provider,
  { env, signal, timeoutMs = CHECK_DEADLINE_MS }: { env?: WorkerEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const flow = await loadFlow(embedded(checkModelYaml).toString("utf8"), {
    sourceLabel: "models/flows/check_model.yaml",
  })
  // Apart from the caller's signal: running out of time is a problem with the model, a caller's stop is not.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const both = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  try {
    const { message } = await runSetup(flow, {}, provider, { tools: {}, env, signal: both, limits: CHECK_LIMITS })
    // The run may end as failed, rather than throw, once its signal aborts.
    signal?.throwIfAborted()
    if (message !== null && deadline.signal.aborted) return models.TIMED_OUT
    return message
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.signal.aborted) return models.TIMED_OUT
    throw error
  } finally {
    clearTimeout(timer)
  }
}
