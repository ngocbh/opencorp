/** The one-reply check of a new connection, run as a worker job. */
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { type CheckWorkers, CLOSE_MS, NO_RESULT, NOT_FINISHED, oneReplyProblem } from "../../src/chat/check.ts"
import { Provider } from "../../src/chat/provider.ts"
import { checkProvider } from "../../src/install/onboard.ts"
import { args, startTime } from "../../src/install/proc.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { decode } from "../../src/worker/codec.ts"
import { type Job, STOP_REASON } from "../../src/worker/job.ts"
import type { WorkerHandlers } from "../../src/worker/rpc.ts"
import { EXIT_GRACE_MS, RegistryClosed, type SpawnLog, type Worker } from "../../src/worker/spawn.ts"
import { cwdOf, envText, isGone, ps } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { makeRegistry, recordFrames } from "../worker/helpers.ts"
import { fakeLlm } from "./helpers.ts"

setDefaultTimeout(60_000)

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
 *  `spawn` rejects with `rejects`; `closed` once the office is stopping. It records spawns, waits and closes. */
function fakeWorkers({
  frames = [],
  code = 0,
  rejects,
  closed = false,
}: { frames?: Frame[]; code?: number | null; rejects?: Error; closed?: boolean } = {}) {
  const spawned: Spawned[] = []
  const waits: number[] = []
  const closes: [string, number | undefined][] = []
  const workers: CheckWorkers = {
    closed,
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
  expect(call!.existed).toBe(true)
  expect(call!.files).toEqual([])
  expect(fs.existsSync(call!.dir)).toBe(false)
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

test("a check the office stop cut rejects as the registry does", async () => {
  const stopped = { type: "error", message: `Error: ${STOP_REASON}` }
  const fake = fakeWorkers({ frames: [stopped], code: 1, closed: true })
  await expect(oneReplyProblem(fake.workers, PROVIDER)).rejects.toBeInstanceOf(RegistryClosed)
  expect(fs.existsSync(fake.spawned[0]!.dir)).toBe(false)
  // A worker killed at the stop's grace sends nothing.
  await expect(oneReplyProblem(fakeWorkers({ code: -9, closed: true }).workers, PROVIDER)).rejects.toBeInstanceOf(
    RegistryClosed,
  )
  // A check that answered before the stop still gives its answer.
  const answered = fakeWorkers({ frames: [{ type: "result", problem: "HTTP 404" }], closed: true })
  expect(await oneReplyProblem(answered.workers, PROVIDER)).toBe("HTTP 404")
})

test("the child prints only its result on stdout", async () => {
  const fake = await fakeLlm()
  const registry = makeRegistry()
  const frames = recordFrames()
  // The fake is reached only through the provider env, so the run inside the worker had it.
  const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: SENTINEL }, env: fake.env() })
  fake.script({ content: "OK" })
  expect(await oneReplyProblem(registry, provider)).toBeNull()
  const sent = frames.map((frame) => decode(frame) as Frame)
  expect(sent.map((frame) => frame.type)).toEqual(["start", "result"])
  expect(sent[1]).toEqual({ type: "result", problem: null })
  expect(fake.authorizations()).toEqual([`Bearer ${SENTINEL}`])

  fake.script({ error: 429 })
  expect(await oneReplyProblem(registry, provider)).toContain("429")
})

test("a hung check in a worker is killed and its folder removed", async () => {
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const spawning = spyOn(registry, "spawn")
  const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: SENTINEL }, env: fake.env() })
  fake.script({ hold: true })
  const checking = oneReplyProblem(registry, provider, { timeoutMs: 30_000 })
  await fake.waitForRequests(1, 25_000)
  const worker = (await spawning.mock.results[0]!.value) as Worker
  const dir = spawning.mock.calls[0]![1]
  const started = startTime(worker.pid)
  expect(cwdOf(worker.pid)).toBe(fs.realpathSync(dir))
  const argv = args(worker.pid, ps())
  expect(argv).toContain("__worker")
  expect(argv).not.toContain(SENTINEL)
  const env = envText(worker.pid)
  expect(env).toContain("VLLM_BASE_URL")
  expect(env).not.toContain(SENTINEL)

  expect(await checking).toBe(NOT_FINISHED)
  expect(isGone(worker.pid, started)).toBe(true)
  expect(registry.get(worker.sessionId)).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  expect(fs.existsSync(dir)).toBe(false)
  fake.release()
}, 90_000)

test("a held check in a worker stops with the office without its grace", async () => {
  const fake = await fakeLlm()
  const registry = makeRegistry()
  const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: SENTINEL }, env: fake.env() })
  fake.script({ hold: true })
  const frames = recordFrames()
  const checking = oneReplyProblem(registry, provider, { timeoutMs: 30_000 })
  await fake.waitForRequests(1, 25_000)
  const start = performance.now()
  await registry.closeAll(EXIT_GRACE_MS)
  expect(performance.now() - start).toBeLessThan(EXIT_GRACE_MS)
  await expect(checking).rejects.toBeInstanceOf(RegistryClosed)
  const last = decode(frames.at(-1)!) as Frame
  expect([last.type, last.message]).toEqual(["error", `Error: ${STOP_REASON}`])
  fake.release()
}, 90_000)

test("the key reaches the model and the start frame only", async () => {
  // A provider that quotes the key it refuses, as some do.
  const probe = `probe-${crypto.randomUUID()}`
  const seen: (string | null)[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method !== "POST") {
      res.writeHead(404)
      res.end()
      return
    }
    seen.push(req.headers.authorization ?? null)
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `${probe} rejected ${req.headers.authorization}` } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const lines: string[] = []
  const log: SpawnLog = (level, line) => void lines.push(`${level} ${line}`)
  const store = openStore()
  const registry = makeRegistry(store, { log })
  const spawning = spyOn(registry, "spawn")
  // A store failure quoting the key, so the log scan meets a real registry line on an error path.
  spyOn(store, "removeWorker").mockImplementationOnce(() => {
    throw new Error(`store failed for ${SENTINEL}`)
  })
  const frames = recordFrames()
  const provider = Provider.parse({
    llm_config: { provider: "vllm", model: "stub", api_key: SENTINEL },
    env: { VLLM_BASE_URL: `${url}/v1` },
  })

  const problem = await oneReplyProblem(registry, provider, { log: (line) => void lines.push(line) })

  expect(seen).toContain(`Bearer ${SENTINEL}`)
  expect(problem).toContain(probe)
  expect(problem).toContain("[REDACTED]")
  expect(problem).not.toContain(SENTINEL)
  const holding = frames.filter((frame) => frame.includes(SENTINEL))
  expect(holding).toHaveLength(1)
  expect((decode(holding[0]!) as Frame).type).toBe("start")
  expect(lines.filter((line) => line.includes(SENTINEL))).toEqual([])
  const [job, dir] = spawning.mock.calls[0]!
  expect(lines).toContain(`ERROR could not remove the record of worker ${job.session_id} (Error)`)
  expect(fs.existsSync(path.join(dir, "worker.log"))).toBe(false)
  expect(fs.existsSync(dir)).toBe(false)
})
