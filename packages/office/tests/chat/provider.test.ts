/** The provider file: defaults, checked fields, refused env names and values, and errors that never echo it; and a
 *  key in llm config that reaches the model and nothing else. */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { z } from "zod"
import type { LiveEvent, Part } from "@opencorp/protocol"
import { checked, loadProvider, Provider, ProviderError, providerSchema } from "../../src/chat/provider.ts"
import { Transcript } from "../../src/chat/transcript.ts"
import { LiveRelay } from "../../src/daemon/live.ts"
import { writePrivate } from "../../src/secrets.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { decode, encode } from "../../src/worker/codec.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import type { SpawnLog, Worker } from "../../src/worker/spawn.ts"
import { envText, tempDir } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { base, makeJob, makeRegistry, Recorder, recordFrames, runWorker } from "../worker/helpers.ts"
import { fakeLlm, send, TemplateOffice, templateJob } from "./helpers.ts"

setDefaultTimeout(60_000)

const SENTINEL = "sk-sentinel-4b1d9e"

/** Writes `data` (text or bytes as is, JSON for anything else) to `file` with `mode`, and returns `file`. */
function write(file: string, data: unknown, mode = 0o600): string {
  fs.writeFileSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data))
  fs.chmodSync(file, mode)
  return file
}

/** The error `loadProvider` rejects with for `file`; fails unless it is a `ProviderError` with no cause. */
async function refusal(file: string): Promise<ProviderError> {
  const error = await loadProvider(file, Provider.parse).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).cause).toBeUndefined()
  return error as ProviderError
}

/** Fails if `error`'s message or its inspected form holds any of `texts`. */
function expectNoneOf(error: Error, ...texts: string[]): void {
  for (const text of texts) {
    expect(error.message).not.toContain(text)
    expect(inspect(error)).not.toContain(text)
  }
}

test("no file means composer defaults", async () => {
  const provider = await loadProvider(path.join(tempDir(), "provider.json"), Provider.parse)
  expect(provider).toEqual(Provider.parse({}))
})

class Extra extends Provider {
  readonly method: string

  protected constructor(fields: z.output<typeof providerSchema>, method: string) {
    super(fields)
    this.method = method
  }

  static override parse(data: unknown = {}): Extra {
    const { method = "api_key", ...rest } = data as { method?: string }
    return new Extra(checked(providerSchema, rest), method)
  }
}

test("load provider validates as the given model", async () => {
  const tmp = tempDir()
  const file = path.join(tmp, "c.json")
  await writePrivate(file, '{"method": "subscription"}')
  expect((await loadProvider(file, Extra.parse)).method).toBe("subscription")
  const missing = await loadProvider(path.join(tmp, "missing.json"), Extra.parse)
  expect(missing).toEqual(Extra.parse({}))
  expect(missing).toBeInstanceOf(Extra)
  const error = await loadProvider(path.join(tmp, "missing.json"), Extra.parse, { missingOk: false }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
})

test("reads config env and prices", async () => {
  const file = write(path.join(tempDir(), "provider.json"), {
    llm_config: { provider: "anthropic", model: "claude-x", api_key: SENTINEL },
    env: { ANTHROPIC_BASE_URL: "https://llm.example" },
    prices: { "claude-x": { input: 3, output: 15 } },
  })
  const provider = await loadProvider(file, Provider.parse)
  expect(provider.llm_config).toEqual({ provider: "anthropic", model: "claude-x", api_key: SENTINEL })
  expect(provider.env).toEqual({ ANTHROPIC_BASE_URL: "https://llm.example" })
  expect(provider.prices).toEqual({ "claude-x": { input: 3, output: 15 } })
  expect(inspect(provider)).not.toContain(SENTINEL)
  expect(JSON.stringify(provider)).not.toContain(SENTINEL)
})

test.each([
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "CLIENT_SECRET",
  "DB_PASSWORD",
  "PASSWORD_FILE",
  "openai_api_key",
  "OPENAI_APIKEY",
  "DB_PASS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_CREDENTIALS",
])("a credential in env is refused [%s]", async (name) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { [name]: SENTINEL } }))
  expect(error.message).toMatch(/llm_config\.api_key/)
  expectNoneOf(error, SENTINEL)
})

test.each([
  `https://user:${SENTINEL}@proxy.example:3128`,
  `http://${SENTINEL}@llm.example`,
  `socks5://u:${SENTINEL}@h`,
  `  https://u:${SENTINEL}@h`,
  `\thttp://${SENTINEL}@h`,
])("a url with credentials in env is refused [%s]", async (url) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { HTTPS_PROXY: url } }))
  expect(error.message).toMatch(/HTTPS_PROXY/)
  expectNoneOf(error, SENTINEL)
})

test.each(["https://proxy.example:3128", "http://llm.example/v1?user=a@b", "/etc/ssl/ca.pem", "a@b.example"])(
  "settings that arent credentials are kept [%s]",
  async (value) => {
    const file = write(path.join(tempDir(), "provider.json"), { env: { HTTPS_PROXY: value } })
    expect((await loadProvider(file, Provider.parse)).env).toEqual({ HTTPS_PROXY: value })
  },
)

test.each(
  [{ [`${SENTINEL}_KEY`]: "v" }, { [SENTINEL]: 5 }, { [SENTINEL]: "https://u:p@h" }].map(
    (env) => [JSON.stringify(env), env] as const,
  ),
)("an env name that isnt a variable name is never echoed [%s]", async (_label, env) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env }))
  expectNoneOf(error, SENTINEL)
})

test.each(
  [{ [SENTINEL]: "v" }, { api_key: SENTINEL }, { prices: { m: { input: 1, output: 1, [SENTINEL]: 1 } } }].map(
    (data) => [JSON.stringify(data), data] as const,
  ),
)("an extra field is never named [%s]", async (_label, data) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), data))
  expect(error.message).toMatch(/an extra field/)
  expect(error.message).toMatch(/is not allowed/)
  expectNoneOf(error, SENTINEL, "api_key")
})

test.each(
  [{ [SENTINEL]: { input: "x", output: 1 } }, { [SENTINEL]: { input: -1, output: 1 } }, { [SENTINEL]: 5 }].map(
    (prices) => [JSON.stringify(prices), prices] as const,
  ),
)("a model name in prices is never echoed [%s]", async (_label, prices) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { prices }))
  expect(error.message).toMatch(/prices/)
  expectNoneOf(error, SENTINEL)
})

test("a file others can read is refused", async () => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), {}, 0o644))
  expect(error.message).toMatch(/mode 0600/)
})

test("a symlink is refused", async () => {
  const tmp = tempDir()
  const target = write(path.join(tmp, "real.json"), {})
  fs.symlinkSync(target, path.join(tmp, "provider.json"))
  const error = await refusal(path.join(tmp, "provider.json"))
  expect(error.message).toMatch(/is a symlink, not a regular file/)
})

test.each(['{"env": {"KEY": 12345678}, "llm_config": "sk-secret-value"}', "sk-secret-value"])(
  "errors never echo the file [%s]",
  async (text) => {
    const error = await refusal(write(path.join(tempDir(), "provider.json"), text))
    expectNoneOf(error, "sk-secret-value", "12345678")
  },
)

test.each(
  [
    ["a bom", "\ufeff{}"],
    ["bad utf 8", Buffer.from('{"env": {"A": "\xff"}}', "latin1")],
  ] as const,
)("a bom or bad utf 8 is not valid json [%s]", async (_label, data) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), data))
  expect(error.message).toMatch(/not valid JSON/)
})

test.each([
  "BUN_OPTIONS",
  "BUN_INSTALL",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_PATH",
])("a runtime or loader variable in env is refused [%s]", async (name) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { [name]: "x" } }))
  expect(error.message).toContain(name)
})

test.each([
  ["a name setting NODE_OPTIONS", "NODE_OPTIONS=--require=/tmp/x.js", ""],
  ["a name holding a key", `OPENAI_API_KEY=${SENTINEL}`, ""],
  ["an empty name", "", "x"],
  ["a NUL in a name", "A\0B", "x"],
  ["a NUL in a value", "HTTPS_PROXY", `http://p\0${SENTINEL}`],
])("an env name or value a spawn cant pass is refused [%s]", async (_label, name, value) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { [name]: value } }))
  expectNoneOf(error, SENTINEL, "--require")
})

test("runtime settings that arent loader variables are kept", async () => {
  // BUNDLE_PATH sits just outside the BUN_ prefix.
  const kept = { NODE_ENV: "production", BUNDLE_PATH: "/b", NODE_EXTRA_CA_CERTS: "/etc/ssl/ca.pem" }
  const file = write(path.join(tempDir(), "provider.json"), { env: kept })
  expect((await loadProvider(file, Provider.parse)).env).toEqual(kept)
})

/** The regular files under `root` (symlinks not followed), relative to it, whose bytes hold `text`. */
function filesHolding(root: string, text: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && fs.readFileSync(path.join(d.parentPath, d.name)).includes(text))
    .map((d) => path.relative(root, path.join(d.parentPath, d.name)))
}

/** Handlers whose `event` records the frame, then throws an error whose message is the key. */
class LeakyRecorder extends Recorder {
  override event(worker: unknown, frame: Frame): void {
    super.event(worker, frame)
    throw new Error(SENTINEL)
  }
}

/** `Base`'s handlers that also hand each stream frame to `relay`, and detach the worker from it at its exit, as the
 *  office's do. */
function relaying<B extends new (...args: any[]) => Recorder>(Base: B, relay: LiveRelay) {
  return class extends Base {
    override stream(worker: unknown, frame: Frame): void {
      super.stream(worker, frame)
      relay.frame(worker as Worker, frame.frame)
    }

    override exited(worker: unknown, returncode: number | null): void {
      super.exited(worker, returncode)
      relay.detach(worker as Worker)
    }
  }
}

test("a key in llm config reaches the model and nothing else", async () => {
  // The key travels only in the start frame, never in another frame, a file the run leaves, a log line
  // (the registry's log stands in for office.log), the worker's env, or the live relay's bus events and log lines; on a
  // failed turn too.
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const lines: string[] = []
  const log: SpawnLog = (level, line) => void lines.push(`${level} ${line}`)
  const registry = makeRegistry(store, { log })
  const frames = recordFrames()
  const sessionDir = path.join(where.root, "sessions", "s1")
  const events: LiveEvent[] = []
  const relayLines: string[] = []
  const relay = new LiveRelay({
    bus: { publishLive: (event) => void events.push(event) },
    transcript: new Transcript(where.runs),
    log: (line) => void relayLines.push(line),
  })
  const envs: string[] = []
  const inFlight: unknown[] = []
  const echo: OfficeTool = {
    description: "Return text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    call: (args) => {
      // The worker is blocked on this reply, so it is still running.
      envs.push(envText(registry.get("s1")!.pid))
      inFlight.push(relay.calls("r1"))
      return String(args.text)
    },
  }
  const llmConfig = { ...LLM_CONFIG, api_key: SENTINEL }

  fake.script({ tool_calls: [{ name: "echo", arguments: { text: "ping" } }] }, { content: "done" })
  const ok = new (relaying(Recorder, relay))({ tools: { toolbox: { echo } } })
  await runWorker(registry, makeJob(where, "flows/tools.yaml", { llm_config: llmConfig }, ok), ok, sessionDir, {
    env: fake.env(),
  })
  fake.script({ error: 401 })
  // Its handler throws the key, so the log scan meets a real line on an error path.
  const refused = new (relaying(LeakyRecorder, relay))({ tools: { toolbox: { echo } } })
  const job = makeJob(where, "flows/tools.yaml", { run_id: "r2", llm_config: llmConfig }, refused)
  await runWorker(registry, job, refused, sessionDir, { env: fake.env() })
  // A template chat turn: the relay shows only a chat's replies, so this run is the one that puts events on the bus.
  fake.script({ content: "Hello from the chat." })
  const chatting = new (relaying(TemplateOffice, relay))()
  const chat = templateJob("chat", chatting, {}, {
    runs: where.runs,
    runId: "r3",
    llm_config: llmConfig,
    deliver: [send("s1", "hi")],
  })
  await runWorker(registry, chat, chatting, sessionDir, { env: fake.env() })

  const leaks = [
    ...frames.filter((f) => f.includes(SENTINEL) && !f.startsWith('{"type":"start"')).map((f) => `frame ${f}`),
    ...fake.requests().filter((r) => encode(r).includes(SENTINEL)).map(() => "a model request"),
    ...[sessionDir, where.runs, path.dirname(store.path)].flatMap((root) =>
      filesHolding(root, SENTINEL).map((rel) => `file ${path.join(root, rel)}`),
    ),
    ...lines.filter((line) => line.includes(SENTINEL)).map((line) => `log line ${line}`),
    ...envs.filter((text) => text.includes(SENTINEL)).map(() => "the worker env"),
    ...(encode(refused.outcome?.failure ?? null).includes(SENTINEL) ? ["the failure"] : []),
    ...events.filter((event) => encode(event).includes(SENTINEL)).map((event) => `bus event ${encode(event)}`),
    ...relayLines.filter((line) => line.includes(SENTINEL)).map((line) => `relay log line ${line}`),
  ]
  expect(leaks).toEqual([])
  // The key did travel: in the office's three start frames, and to the model.
  expect(frames.filter((f) => f.includes(SENTINEL))).toHaveLength(3)
  // The scan reads both directions: the worker's tool call came in through the office's channel.
  expect(frames.some((f) => (decode(f) as Frame).type === "tool_call")).toBe(true)
  // ...and its live frames: a snapshot and the records after it.
  const live = frames.map((f) => decode(f) as Frame).filter((f) => f.type === "stream")
  const liveTypes = new Set(live.map((f) => (f.frame as Frame).type))
  expect(liveTypes).toContain("snapshot")
  expect(liveTypes).toContain("record")
  // The relay ran on those frames: it followed r1 while its tool ran, and published r3's reply.
  expect(inFlight).toHaveLength(1)
  expect(inFlight[0]).not.toBeNull()
  expect(events.length).toBeGreaterThan(0)
  // The reply streams as deltas, so no one event holds it whole; a follower that meets the part already
  // finished publishes it whole in the part's update instead.
  const deltas = events.flatMap((event) => (event.type === "part.delta" ? [event.data.text as string] : []))
  const written = events.flatMap((event) => (event.type === "part.updated" ? [event.data.part as Part] : []))
  const reply = deltas.length > 0 ? deltas.join("") : written.filter((part) => part.type === "text").at(-1)?.text
  expect(reply).toBe("Hello from the chat.")
  expect(relayLines).toEqual([])
  // ...and real log lines: the failing handler's, with the error's type only.
  expect(lines).toContain(`ERROR worker s1 handler event failed (Error)`)
  expect(envs).toHaveLength(1)
  expect(envs[0]).toContain("VLLM_BASE_URL")
  // The scan reads every run log, run_started included.
  expect(filesHolding(where.runs, '"kind":"run_started"').sort()).toEqual([
    "r1/log.jsonl",
    "r2/log.jsonl",
    "r3/log.jsonl",
  ])
  expect(new Set(fake.authorizations())).toEqual(new Set([`Bearer ${SENTINEL}`]))
  expect(encode(ok.frames)).toContain("ToolCallFinished")
  expect(ok.outcome?.status).toBe("succeeded")
  expect(ok.returncode).toBe(0)
  expect(refused.outcome?.status).toBe("failed")
  expect(refused.outcome?.failure).toBeTruthy()
  expect(chatting.outcome?.status).toBe("waiting")
  expect(fs.existsSync(path.join(sessionDir, "worker.log"))).toBe(true)
})
