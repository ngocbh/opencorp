/** The one-reply check of a new connection, run as a worker job. */
import fs from "node:fs"
import os from "node:os"
import { expect, test } from "bun:test"
import { type CheckWorkers, CLOSE_MS, NO_RESULT, NOT_FINISHED, oneReplyProblem } from "../../src/chat/check.ts"
import { checkProvider } from "../../src/install/onboard.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { Job } from "../../src/worker/job.ts"
import type { WorkerHandlers } from "../../src/worker/rpc.ts"
import { RegistryClosed, type Worker } from "../../src/worker/spawn.ts"

const SENTINEL = "sk-ant-sentinel-61f0d2c9a8b3"
const PROVIDER = checkProvider({ llm_config: { provider: "anthropic", api_key: SENTINEL, model: "claude-x" } })

interface Spawned {
  job: Job
  dir: string
  real: string
  existed: boolean
  files: string[]
  env: Record<string, string> | undefined
}

/** A registry whose worker sends `frames` and exits with `code` (`wait` gives null when `code` is null), or whose
 *  `spawn` rejects with `rejects`; it records spawns, waits and closes. */
function fakeWorkers({
  frames = [],
  code = 0,
  rejects,
}: { frames?: Frame[]; code?: number | null; rejects?: Error } = {}) {
  const spawned: Spawned[] = []
  const waits: number[] = []
  const closes: [string, number | undefined][] = []
  const workers: CheckWorkers = {
    async spawn(job, dir, handlers, { env } = {}) {
      const existed = fs.existsSync(dir)
      spawned.push({
        job,
        dir,
        real: existed ? fs.realpathSync(dir) : dir,
        existed,
        files: existed ? fs.readdirSync(dir) : [],
        env,
      })
      if (rejects) throw rejects
      const worker = {
        job,
        returncode: code,
        wait: async (ms: number) => {
          waits.push(ms)
          return code
        },
      } as unknown as Worker
      const notify = handlers as unknown as Record<string, (worker: Worker, frame: Frame) => void>
      for (const frame of frames) notify[String(frame.type)]!(worker, frame)
      if (code !== null) (handlers as WorkerHandlers<Worker>).exited(worker, code)
      return worker
    },
    async close(sessionId, ms) {
      closes.push([sessionId, ms])
      return null
    },
  }
  return { workers, spawned, waits, closes }
}

test("one reply check runs isolated in a temp cwd", async () => {
  const fake = fakeWorkers({ frames: [{ type: "result", problem: null }] })
  expect(await oneReplyProblem(fake.workers, PROVIDER)).toBeNull()
  expect(fake.spawned).toHaveLength(1)
  const [call] = fake.spawned
  expect(call!.job.kind).toBe("check")
  expect(call!.job.llm_config).toEqual(PROVIDER.llm_config)
  expect(call!.existed && call!.files.length === 0 && !fs.existsSync(call!.dir)).toBe(true)
  expect(call!.real).not.toBe(fs.realpathSync(process.cwd()))
  expect(call!.real.startsWith(fs.realpathSync(os.tmpdir()) + "/")).toBe(true)
  expect(call!.env).toEqual({})
  expect(fake.waits).toEqual([90_000])
  expect(JSON.stringify([call!.job.session_id, call!.dir, call!.env])).not.toContain(SENTINEL)
})

test.each([
  [
    "an event then a result",
    [
      { type: "event", name: "x", data: {} },
      { type: "result", problem: "HTTP 404" },
    ],
    "HTTP 404",
  ],
  ["a result alone", [{ type: "result", problem: "HTTP 404" }], "HTTP 404"],
  ["a result then an error", [{ type: "result", problem: null }, { type: "error", message: "boom" }], NO_RESULT],
  ["no frame", [], NO_RESULT],
  ["a result without problem", [{ type: "result" }], NO_RESULT],
  ["a problem that is a number", [{ type: "result", problem: 3 }], NO_RESULT],
  ["an extra key", [{ type: "result", problem: null, extra: 1 }], NO_RESULT],
  ["a chat result", [{ type: "result", status: "succeeded", run_id: "r", output: {}, failure: null }], NO_RESULT],
] as [string, Frame[], string][])("only the result line is read [%s]", async (_case, frames, problem) => {
  expect(await oneReplyProblem(fakeWorkers({ frames }).workers, PROVIDER)).toBe(problem)
})

test("a check without a result logs its exit code never its output", async () => {
  const lines: string[] = []
  const fake = fakeWorkers({ frames: [{ type: "error", message: `Traceback: ${SENTINEL}` }], code: 3 })
  expect(await oneReplyProblem(fake.workers, PROVIDER, { log: (line) => lines.push(line) })).toBe(NO_RESULT)
  const text = lines.join("\n")
  expect(text).toContain("exit code 3")
  expect(text).not.toContain(SENTINEL)
  expect(text).not.toContain("Traceback")
})

test("a hung check says it didnt finish", async () => {
  const fake = fakeWorkers({ code: null })
  expect(await oneReplyProblem(fake.workers, PROVIDER, { timeoutMs: 5 })).toBe(NOT_FINISHED)
  expect(fake.waits).toEqual([5])
  expect(fake.closes).toEqual([[fake.spawned[0]!.job.session_id, CLOSE_MS]])
  expect(fs.existsSync(fake.spawned[0]!.dir)).toBe(false)
})

test("a check the registry refuses leaves no folder", async () => {
  const fake = fakeWorkers({ rejects: new RegistryClosed() })
  await expect(oneReplyProblem(fake.workers, PROVIDER)).rejects.toBeInstanceOf(RegistryClosed)
  expect(fake.spawned).toHaveLength(1)
  expect(fake.spawned[0]!.existed).toBe(true)
  expect(fs.existsSync(fake.spawned[0]!.dir)).toBe(false)
})
