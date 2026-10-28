/** The one-reply check of a connection whose provider can't list its models, run as a worker job of kind `check`. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { modelProblem } from "../install/onboard.ts"
import type { Frame } from "../worker/channel.ts"
import { type Job, parseJob } from "../worker/job.ts"
import type { WorkerEnv } from "../worker/main.ts"
import { BaseHandlers } from "../worker/rpc.ts"
import { RegistryClosed, type WorkerRegistry } from "../worker/spawn.ts"
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
