/** The model check, made in this process and, for a new connection, as a worker job. */
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { loadFlow, runFlow } from "@ngocbh/yian"
import { ApiKeyCredentials, AuthStore, OAuthCredentials } from "@ngocbh/yian/llm_clients"
import {
  CHECK_DEADLINE_MS,
  type CheckWorkers,
  CLOSE_MS,
  modelProblem,
  NO_RESULT,
  NOT_FINISHED,
  oneReplyProblem,
  providerSecrets,
  runSetup,
  TIMEOUT_MS,
} from "../../src/models/check.ts"
import { ConnectionFile } from "../../src/models/connections.ts"
import { Provider } from "../../src/models/provider.ts"
import { readFlow } from "../../src/company/flow_yaml.ts"
import { loadConfined } from "../../src/company/flows.ts"
import { checkProvider, withSignIn } from "../../src/features/setup/onboard.ts"
import { args, startTime } from "../../src/util/proc.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/runtime/worker/channel.ts"
import { decode } from "../../src/runtime/worker/codec.ts"
import { type Job, STOP_REASON } from "../../src/runtime/worker/job.ts"
import type { WorkerHandlers } from "../../src/runtime/worker/rpc.ts"
import { EXIT_GRACE_MS, RegistryClosed, type SpawnLog, type Worker } from "../../src/runtime/worker/spawn.ts"
import { cwdOf, envText, isGone, ps, tempDir } from "../helpers.ts"
import { openStore } from "../runtime/store/helpers.ts"
import { makeRegistry, recordFrames } from "../runtime/worker/helpers.ts"
import { fakeLlm, keyCopies, MIXED_KEY, refusingLlm } from "../features/chat/helpers.ts"

setDefaultTimeout(60_000)

const SENTINEL = "sk-ant-sentinel-61f0d2c9a8b3"
const PROVIDER = checkProvider({ llm_config: { provider: "anthropic", api_key: SENTINEL, model: "claude-x" } })
const KEY = "sk-test-0000000000000000"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const CHECK_MODULE = fileURLToPath(new URL("../../src/models/check.ts", import.meta.url))
const PROVIDER_MODULE = fileURLToPath(new URL("../../src/models/provider.ts", import.meta.url))
const FAKE_LLM = fileURLToPath(new URL("../../src/testing/fake_llm.ts", import.meta.url))
const CHECK_MODEL = fileURLToPath(new URL("../../src/models/flows/check_model.yaml", import.meta.url))

test("the worker gives up on a silent model before the daemon stops waiting for it", () => {
  // The worker's "timed out" reaches the daemon, rather than the daemon's "didn't finish".
  expect(CHECK_DEADLINE_MS + 5_000).toBeLessThanOrEqual(TIMEOUT_MS)
})

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
  // The check's time starts once the test has looked at its held worker, so a short time never ends it first.
  let looked!: () => void
  const inspected = new Promise<void>((resolve) => (looked = resolve))
  const spawn = registry.spawn.bind(registry)
  const spawning = spyOn(registry, "spawn").mockImplementation(async (...given) => {
    const spawned = await spawn(...given)
    const wait = spawned.wait.bind(spawned)
    spawned.wait = async (ms) => {
      await inspected
      return wait(ms)
    }
    return spawned
  })
  const provider = Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: SENTINEL }, env: fake.env() })
  fake.script({ hold: true })
  const checking = oneReplyProblem(registry, provider, { timeoutMs: 1000 })
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

  looked()
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

test("a copy of the key in another case or base64 never reaches the problem", async () => {
  const probe = `probe-${crypto.randomUUID()}`
  const url = await refusingLlm(`${probe} rejected ${keyCopies(MIXED_KEY).join(" ")}`)
  const lines: string[] = []
  const store = openStore()
  const registry = makeRegistry(store, { log: (level, line) => void lines.push(`${level} ${line}`) })
  const provider = Provider.parse({
    llm_config: { provider: "vllm", model: "stub", api_key: MIXED_KEY },
    env: { VLLM_BASE_URL: `${url}/v1` },
  })

  const problem = await oneReplyProblem(registry, provider, { log: (line) => void lines.push(line) })

  // yian scrubs the copies before the office sees them, a base64 copy whole.
  expect(problem).toEndWith(`${probe} rejected [REDACTED] [REDACTED] [REDACTED]`)
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) {
    expect(problem).not.toContain(copy)
    expect(lines.filter((line) => line.includes(copy))).toEqual([])
  }
})

/** What `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

test("a model that answers has no problem", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  expect(await modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }))).toBeNull()
  expect(fake.requests()).toHaveLength(1)
})

test("a model check given an env runs in that env", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  // The fake listens on a random port that only the given env names, so an answer means that env was used.
  expect(await modelProblem(Provider.parse({ llm_config: LLM_CONFIG }), { env: fake.env() })).toBeNull()
  expect(fake.requests()).toHaveLength(1)
})

test("a model that fails says why without the key", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 401 })
  const problem = await modelProblem(Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY }, env: fake.env() }))
  expect(problem).toBeTruthy()
  expect(problem).not.toContain(KEY)
})

test("a model that quotes the key in another case or base64 says why without any copy", async () => {
  const url = await refusingLlm(`bad key: ${keyCopies(MIXED_KEY).join(" and ")}`)
  const problem = await modelProblem(
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: MIXED_KEY }, env: { VLLM_BASE_URL: `${url}/v1` } }),
  )
  expect(problem).toEndWith("bad key: [REDACTED] and [REDACTED] and [REDACTED]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) expect(problem).not.toContain(copy)
})

test("providerSecrets reads a subscription's tokens as they are now, and the login yian's own store holds", async () => {
  const dir = tempDir()
  const auth = path.join(dir, "auth.json")
  const tokens = (n: number) =>
    new OAuthCredentials({
      accessToken: `access-${n}-0123456789`,
      refreshToken: `refresh-${n}-0123456789`,
      expiresAt: Date.now() / 1000 + 3600,
      accountId: "account-0123456789",
    })
  await new AuthStore(auth).save("openai", tokens(1), "gpt-5.5")
  const subscription = withSignIn(
    ConnectionFile.parse({ method: "subscription", llm_config: { provider: "openai", model: "gpt-5.5" } }),
    auth,
  )
  const base = { HOME: dir }
  expect(providerSecrets(subscription, base)).toEqual(["access-1-0123456789", "refresh-1-0123456789", "account-0123456789"])
  await new AuthStore(auth).save("openai", tokens(2), "gpt-5.5")
  expect(providerSecrets(subscription, base)).toEqual(["access-2-0123456789", "refresh-2-0123456789", "account-0123456789"])
  // openai with no key runs on the login in the run's HOME, which yian's own store holds.
  const keyless = Provider.parse({ llm_config: { provider: "openai", model: "gpt-5.5" } })
  expect(providerSecrets(keyless, base)).toEqual([])
  await new AuthStore(path.join(dir, ".config", "yian", "auth.json")).save("openai", new ApiKeyCredentials(KEY), "gpt-5.5")
  expect(providerSecrets(keyless, base)).toEqual([KEY])
  expect(providerSecrets(Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY } }), base)).toEqual([KEY])
})

test("a model check on the sign-in YIAN_AUTH_FILE names says why without any copy of what that sign-in sends", async () => {
  const dir = tempDir()
  const auth = path.join(dir, "auth.json")
  const url = await refusingLlm(`bad key: ${keyCopies(MIXED_KEY).join(" and ")}`)
  // A key login, not a subscription: yian sends a subscription only to OpenAI's own host, and this test reaches none.
  // yian sends a saved key only to the endpoint it was saved for.
  await new AuthStore(auth).save("openai", new ApiKeyCredentials(MIXED_KEY), "gpt-5.5", { endpoint: `${url}/v1` })
  const provider = Provider.parse({
    llm_config: { provider: "openai", model: "gpt-5.5" },
    env: { YIAN_AUTH_FILE: auth, OPENAI_BASE_URL: `${url}/v1` },
  })
  const problem = await modelProblem(provider, { env: { HOME: dir } })
  expect(problem).toEndWith("bad key: [REDACTED] and [REDACTED] and [REDACTED]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) expect(problem).not.toContain(copy)
})

test("a model that never answers times out", async () => {
  const fake = await fakeLlm()
  fake.script({ hold: true })
  const started = performance.now()
  const problem = await modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }), { timeoutMs: 300 })
  expect(problem).toBe("timed out")
  expect(performance.now() - started).toBeLessThan(5_000)
})

test("the model checks own retry limit wins over the providers env", async () => {
  let posts = 0
  // Not the fake LLM: its errors say not to retry, so yian would never try again against it.
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++
    req.resume()
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "overloaded" } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const provider = Provider.parse({ llm_config: LLM_CONFIG, env: { VLLM_BASE_URL: url, YIAN_MODEL_RETRIES: "6" } })
  expect(await modelProblem(provider)).toBeTruthy()
  expect(posts).toBe(2)
}, 30_000)

test("a stop during the model check rejects with its reason", async () => {
  const fake = await fakeLlm()
  fake.script({ hold: true })
  const controller = new AbortController()
  const checking = modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }), {
    signal: controller.signal,
    timeoutMs: 10_000,
  })
  await fake.waitForRequests(1)
  const reason = new Error("stopped")
  controller.abort(reason)
  expect(await rejection(checking)).toBe(reason)
})

test("a setup run failure never shows the key or url credentials", async () => {
  const flow = await loadFlow(
    "id: fail\nname: fail\ninput:\n  text: !str\noutput: !str\nkind: code\ncode: |\n  throw new Error(inputs.text)\n",
    { sourceLabel: "fail" },
  )
  const text = `bad key ${KEY} for https://user:hunter2@example.com/v1.`
  const { message } = await runSetup(
    flow,
    { text },
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY } }),
    { tools: {} },
  )
  expect(message).toContain("bad key [redacted] for https://***@example.com/v1")
  expect(message).not.toContain(KEY)
  expect(message).not.toContain("hunter2")
  expect(message!.endsWith(".")).toBe(false)
})

test("a setup run failure never shows the key in another case or base64", async () => {
  const flow = await loadFlow(
    "id: fail\nname: fail\ninput:\n  text: !str\noutput: !str\nkind: code\ncode: |\n  throw new Error(inputs.text)\n",
    { sourceLabel: "fail" },
  )
  const { message } = await runSetup(
    flow,
    { text: `bad keys ${keyCopies(MIXED_KEY).join(", ")}` },
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: MIXED_KEY } }),
    { tools: {} },
  )
  expect(message).toContain("bad keys [redacted], [redacted], [redacted]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) expect(message).not.toContain(copy)
})

test("the unknown model warning stays off the terminal", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const seen: string[] = []
  const listener = (warning: Error) => seen.push(warning.message)
  process.on("warning", listener)
  try {
    const provider = Provider.parse({
      llm_config: {
        // A Chat Completions vendor with a model list (openai's key route goes to /v1/responses, which the fake
        // doesn't serve).
        provider: "deepseek",
        base_url: `${fake.baseUrl}/v1`,
        api_key: KEY,
        // Unique: yian warns once per text in a process, and test files share one.
        model: `unlisted-${crypto.randomUUID()}`,
      },
    })
    expect(await modelProblem(provider)).toBeNull()
    // A warning is emitted on the next tick.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off("warning", listener)
  }
  expect(seen.filter((message) => message.includes("known model list"))).toEqual([])
})

// No test changes process.env, so the variable sits in a child's environment.
test("a setup run sees only the office workers env and the providers", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const code = [
    `import { Provider } from ${JSON.stringify(PROVIDER_MODULE)}`,
    `import { modelProblem } from ${JSON.stringify(CHECK_MODULE)}`,
    `import { LLM_CONFIG } from ${JSON.stringify(FAKE_LLM)}`,
    // The check's own limits allow one retry, so the refused connection fails well within the wait.
    "const provider = Provider.parse({ llm_config: LLM_CONFIG })",
    "console.log(JSON.stringify(await modelProblem(provider)))",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH, VLLM_BASE_URL: `${fake.baseUrl}/v1` },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 20_000)))
    const status = await Promise.race([child.exited, timeout])
    clearTimeout(timer)
    // Killed before the output is read: a child that timed out would keep its pipes open.
    child.kill("SIGKILL")
    const stderr = await new Response(child.stderr).text()
    expect(status, stderr).toBe(0)
    const problem: unknown = JSON.parse(await new Response(child.stdout).text())
    expect(typeof problem === "string" && problem.length > 0, stderr).toBe(true)
    expect(fake.requests()).toEqual([])
  } finally {
    child.kill("SIGKILL")
  }
}, 30_000)

/** check_model.yaml as the office loads its embedded text. */
function loadCheckModel() {
  return loadFlow(fs.readFileSync(CHECK_MODEL, "utf8"), { sourceLabel: "check_model.yaml" })
}

test("check_model.yaml loads on ts yian and uses only agent nodes", async () => {
  expect((await loadConfined(path.dirname(CHECK_MODEL), CHECK_MODEL)).name).toBe("check_model")
  expect((await loadCheckModel()).name).toBe("check_model")
  const flow = readFlow(fs.readFileSync(CHECK_MODEL, "utf8")) as Record<string, any>
  // A single-node flow is its own node.
  const nodes: Record<string, any>[] = flow.nodes ? Object.values(flow.nodes) : [flow]
  for (const node of nodes) {
    expect(node.kind).toBe("agent")
    expect(node).not.toHaveProperty("steerable")
  }
})

test("check model asks for one word and returns it", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const result = await runFlow(await loadCheckModel(), {}, { llmConfig: LLM_CONFIG, env: (n) => fake.env()[n] })
  expect([result.status, result.output]).toEqual(["succeeded", "OK"])
})
