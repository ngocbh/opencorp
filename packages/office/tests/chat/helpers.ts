/** Chat test helpers (Python's `tests/chat/conftest.py`): the fake LLM, the chat flow and OpenAI's
 *  sign-in, faked. */
import { expect, onTestFinished } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HttpResponse } from "@ngocbh/yian/llm_clients"
import { realScheduler, type Scheduler } from "@ngocbh/yian/platform"
import { iterRunRecords, type RunLogEntry } from "@ngocbh/yian/run"
import { type LiveEvent, now, OFFICE, Session, WorkItem } from "@opencorp/protocol"
import { ConnectionFile } from "../../src/chat/connections.ts"
import { ChatHarness } from "../../src/chat/harness.ts"
import { Hooks } from "../../src/chat/hooks.ts"
import { type Lister, ModelCache, ownModels } from "../../src/chat/models.ts"
import { mainSpec } from "../../src/chat/run_spec.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { type ActorContext, type ActorWorker, SessionActor, type Wait } from "../../src/chat/session_actor.ts"
import { Transcript } from "../../src/chat/transcript.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { LiveRelay } from "../../src/daemon/live.ts"
import { register as registerQuestions } from "../../src/extensions/questions.ts"
import type { Office } from "../../src/daemon/office.ts"
import { sameProcess, startTime } from "../../src/install/proc.ts"
import { Monitor } from "../../src/perm/monitor.ts"
import { Answers } from "../../src/questions/ask.ts"
import { SecretStore, writePrivate } from "../../src/secrets.ts"
import { newId, type QuestionRecord, type SessionRecord, type WorkItemRecord } from "../../src/store/store.ts"
import { FakeLLM, LLM_CONFIG, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { type Delivery, Job, type JobInput } from "../../src/worker/job.ts"
import { MemoryHost, type MemoryRequest } from "../../src/worker/memory_host.ts"
import type { JobWorker, OfficeTool, WorkerHandlers } from "../../src/worker/rpc.ts"
import type { Worker, WorkerRegistry } from "../../src/worker/spawn.ts"
import { baseFiles, person } from "../company/helpers.ts"
import { CEO, makeOffice } from "../daemon/helpers.ts"
import { type Codex, makeCodex } from "../harness/helpers.ts"
import { NO_GROUP, tempDir, waitFor } from "../helpers.ts"
import {
  advanceJob,
  inProcessWorker,
  makeJob,
  makeRegistry,
  profileMemory,
  Recorder,
  run,
  waitsOf,
} from "../worker/helpers.ts"

/** The template's chat flow, as a hire's main points at it. */
export const CHAT_FLOW = fs.readFileSync(
  new URL("../../src/company_template/template/shared/flows/chat.yaml", import.meta.url),
  "utf8",
)

/** The template's `compact_history.yaml`, which the chat flow uses. */
export const COMPACT_HISTORY = fs.readFileSync(
  new URL("../../src/company_template/template/shared/flows/compact_history.yaml", import.meta.url),
  "utf8",
)

/** The chat flow and the flow it uses, by repo path. */
export const CHAT_FILES = {
  "shared/flows/chat.yaml": CHAT_FLOW,
  "shared/flows/compact_history.yaml": COMPACT_HISTORY,
}

/** A started fake LLM, closed when the current test finishes. Call inside a test. */
export async function fakeLlm(): Promise<FakeLLM> {
  const fake = await FakeLLM.start()
  onTestFinished(() => fake.close())
  return fake
}

/** A started model server that refuses every POST with a 401 whose message is `message`, as a provider that quotes
 *  the key it refuses does; its URL is `http://127.0.0.1:<port>`. Closed when the current test finishes. */
export async function refusingLlm(message: string): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(req.method === "POST" ? 401 : 404, { "content-type": "application/json" })
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A mixed-case key, so its lowercase and uppercase copies differ from it. */
export const MIXED_KEY = "sk-MiXeD-7Qd93C10e5B2aZ"

/** Copies of `key` that a provider may quote: in lowercase, in uppercase and base64-encoded. */
export function keyCopies(key: string): string[] {
  return [key.toLowerCase(), key.toUpperCase(), Buffer.from(key).toString("base64")]
}

// OpenAI's device sign-in, faked: its replies and a token whose signature and refresh are fake secrets.

export const SIGNATURE = "fake-signature-6e2a90d4"
export const REFRESH = "fake-refresh-b81c5f37"

/** A token shaped like OpenAI's, naming `account`; its signature part is a fake secret. */
function jwt(account = "account-test"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SIGNATURE}`
}

export const ACCESS = jwt()

export const USERCODE = new HttpResponse(200, { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1n })
export const PENDING = new HttpResponse(403, { error: "pending" })
export const APPROVED = new HttpResponse(200, { authorization_code: "auth-code", code_verifier: "verifier" })
export const TOKENS = new HttpResponse(200, {
  access_token: ACCESS,
  refresh_token: REFRESH,
  id_token: ACCESS,
  expires_in: 3600n,
})
export const CATALOG = new HttpResponse(200, {
  models: [
    { slug: "gpt-5.5-codex", visibility: "list", priority: 2n },
    { slug: "gpt-5.5", visibility: "list", priority: 1n },
  ],
})

/** A scheduler that moves its clock by each sleep, giving way for ~5 real ms; `now` starts at real time, so a token's
 *  expiry stays real. A sleep of a minute or more (the login's deadline) only ends by its abort, so it never fires
 *  while a test holds a request. */
export function testScheduler(): Scheduler {
  let slept = 0
  return {
    now: () => Date.now() + slept,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = () => {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (ms < 60_000) {
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort)
            slept += ms
            resolve()
          }, 5)
        }
      }),
  }
}

// The template's chat flows, run in an in-process worker.

/** The company template's root. */
export const ROOT = fileURLToPath(new URL("../../src/company_template/template/", import.meta.url))

/** The person a template run plays. */
export const PERSON = { name: "Minh", handle: "minh", title: "Engineer", company: "Acme", reports_to: "" }

/** The groups each template flow names; `ask_user` is the worker's own tool. */
export const GROUPS: Record<string, string[]> = {
  chat: ["toolbox", "workspace", "company"],
  side_chat: ["workspace", "work_items"],
  profile_manager: ["profile"],
}

/** A tool's schema that takes no arguments. */
export const EMPTY = { type: "object", properties: {} }

/** A user message saying `text`, from `author` when given. */
export function message(text: string, author?: string): Record<string, unknown> {
  return { role: "user", parts: [{ type: "text", text }], ...(author === undefined ? {} : { author }) }
}

/** A send of `text` to the messages inbox. */
export function send(id: string, text: string, author?: string): Delivery {
  return { id, op: "send", inbox: "messages", event: message(text, author) }
}

/** A close of the messages inbox. */
export const CLOSE: Delivery = { id: "close", op: "close", inbox: "messages" }

/** The memories each template flow declares, which the office binds. */
export const MEMORIES: Record<string, string[]> = { chat: ["profile"], side_chat: ["profile"], profile_manager: [] }

/** minh's profile for the template runs of `pin`: a FileMemory in `profile/` beside the pin, which every run of
 *  that pin binds, and a test may write `profile.md` in before the first. */
export function templateProfile(pin: string): ReturnType<typeof profileMemory> {
  return profileMemory(path.join(path.dirname(pin), "profile"))
}

/** A `Recorder` serving one no-op tool, `stub` (which a model calls `<group>_stub`), for each group `name`'s flow
 *  names, and the tools of `extra`, by group, merged in; and the `profile` memory, `templateProfile` of the job's
 *  pin. */
export class TemplateOffice extends Recorder {
  #profile: MemoryHost | null = null

  constructor(name = "chat", extra: Record<string, Record<string, OfficeTool>> = {}) {
    const tools: Record<string, Record<string, OfficeTool>> = Object.fromEntries(
      GROUPS[name]!.map((group) => [
        group,
        { stub: { description: "Does nothing.", parameters: EMPTY, call: () => "ok" } },
      ]),
    )
    for (const [group, named] of Object.entries(extra)) tools[group] = { ...tools[group], ...named }
    super({ tools })
  }

  override memory(worker: unknown, request: MemoryRequest): Promise<Frame> {
    this.#profile ??= new MemoryHost({ profile: templateProfile((worker as JobWorker).job.pin) })
    return this.#profile.answer(request)
  }

  override released(worker: unknown): void {
    super.released(worker)
    void this.#profile?.close()
  }

  override exited(worker: unknown, returncode: number | null): void {
    super.exited(worker, returncode)
    void this.#profile?.close()
  }
}

/** A chat job running the template flow `name` from a temp copy of the template, or, with `base`, from `base.pin`
 *  (which holds the flow at `shared/flows/<name>.yaml`) logging under `base.runs`; `inputs` replace the defaults.
 *  Without `base` it logs under `runs` (a temp folder by default); it runs as `runId` (`r1` by default); `over`
 *  replaces the job's fields. */
export function templateJob(
  name: string,
  handlers: Recorder,
  inputs: Record<string, unknown> = {},
  {
    runs,
    runId,
    base,
    ...over
  }: { runs?: string; runId?: string; base?: { pin: string; runs: string } } & Partial<JobInput> = {},
): Job {
  let where = base
  if (where === undefined) {
    const root = tempDir()
    where = { pin: path.join(root, "pin"), runs: runs ?? path.join(root, "runs") }
    fs.cpSync(ROOT, where.pin, { recursive: true })
  }
  const who = name === "profile_manager" ? {} : { person: PERSON, talking_to: "" }
  const fields: Partial<JobInput> = {
    inputs: { ...who, summary: "", history: [], turns: 0, max_turns: 500, ...inputs },
    memory: MEMORIES[name],
    ...(runId === undefined ? {} : { run_id: runId }),
    ...over,
  }
  return makeJob(where, `shared/flows/${name}.yaml`, fields, handlers)
}

/** A fresh chat job after `job`: run `r2` in the same runs folder, same pin, flow, inputs and grants, with no
 *  deliveries and no seed; `over` replaces fields. */
export function nextRun(job: Job, over: Partial<JobInput> = {}): Job {
  const runs = path.dirname(path.dirname(job.log))
  return Job.parse({
    ...job,
    kind: "chat",
    run_id: "r2",
    log: path.join(runs, "r2", "log.jsonl"),
    deliver: [],
    seed: null,
    ...over,
  })
}

/** Advances the run `chat` started, applying `deliver` first; returns its recorder. */
export function advance(chat: Job, fake: FakeLLM, deliver: Delivery[], name = "chat"): Promise<Recorder> {
  return run(advanceJob(chat, { deliver }), new TemplateOffice(name), { env: fake.env() })
}

/** The nodes a waiting result waits at. */
export function waitingAt(rec: Recorder): unknown[] {
  expect(rec.outcome?.status).toBe("waiting")
  return waitsOf(rec).map((wait) => wait.node)
}

/** The data of each NodeSucceeded event `rec` recorded for `node`. */
export function succeeded(rec: Recorder, node: string): Record<string, any>[] {
  return rec.frames
    .filter((frame) => frame.name === "NodeSucceeded" && (frame.data as Record<string, unknown>).node_id === node)
    .map((frame) => frame.data as Record<string, any>)
}

/** Starts a chat job of `name` with no deliveries and runs it to waiting at its first take; returns the job. `runs`
 *  and `runId` are `templateJob`'s. */
export async function waitingChat(
  fake: FakeLLM,
  name = "chat",
  inputs: Record<string, unknown> = {},
  { runs, runId }: { runs?: string; runId?: string } = {},
): Promise<Job> {
  const rec = new TemplateOffice(name)
  const job = templateJob(name, rec, inputs, { runs, runId })
  await run(job, rec, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#0/heard"])
  return job
}

/** Holds the reply's first model call (answering `held`), sends "queued", interrupts, then releases; returns the
 *  recorder of that run, which answers "queued" as its next turn and waits at the one after. With `held.hold_after`,
 *  the interrupt waits until the run has streamed text. The run logs under `runs` (a temp folder by default) as
 *  `r1`. */
export async function interruptMidReply(
  fake: FakeLLM,
  held: ScriptedReply,
  { runs }: { runs?: string } = {},
): Promise<Recorder> {
  fake.script({ ...held, hold: true }, { content: "Got it." })
  const job = await waitingChat(fake, "chat", {}, { runs })
  const cut = new TemplateOffice()
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s1", "one")] }), cut, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  if (held.hold_after) {
    const streamed = () => cut.streams.some((frame) => frame.type === "chunk" && frame.text !== "")
    await waitFor(streamed, { timeout: 10_000, what: "the first chunk" })
  }
  expect(await worker.deliver(send("queued", "queued"))).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "queued"), { timeout: 10_000, what: "the send" })
  expect(await worker.deliver({ id: "cut", op: "interrupt", inbox: "messages" })).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "cut"), { timeout: 10_000, what: "the interrupt" })
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  // The queued message the cut reply never read is the next turn, taken by the same worker.
  expect(waitingAt(cut)).toEqual(["chat#2/heard"])
  return cut
}

/** Writes the leading records of the run log `log` while `keep` holds for each to `<runs>/<run id>/log.jsonl`, under
 *  the same run id: what a crash leaves. Returns the new log's path. */
export function logPrefix(log: string, keep: (entry: RunLogEntry) => boolean, runs: string): string {
  let end = 0
  for (const entry of iterRunRecords(log, { payloads: true })) {
    if (!keep(entry)) break
    end = entry.end
  }
  const out = path.join(runs, path.basename(path.dirname(log)), "log.jsonl")
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, fs.readFileSync(log).subarray(0, end))
  return out
}

// The session actor over an office, real worker processes and the fake LLM (Python's `make_harness` and friends).

/** A model turn that asks the user to pick A or B. */
export const ASK_USER: ScriptedReply = {
  tool_calls: [{ name: "ask_user", arguments: { question: "Which?", options: ["A", "B"] } }],
}

/** A model question's `ask_user` request, as a worker sends it. */
export const ASKED = {
  question: "Which?",
  questions: null,
  answer_schema: null,
  title: null,
  node_id: null,
  options: null,
}

/** A model turn that asks the person's manager. */
export const ASK_MANAGER: ScriptedReply = {
  tool_calls: [{ name: "company_ask_manager", arguments: { question: "Budget?" } }],
}

/** A human designer, lan, managed by the CEO. */
export const LAN = {
  "people/lan/person.yaml": { handle: "lan", name: "Lan", kind: "human", title: "Designer", manager: CEO },
}

/** An agent, kai, who manages minh. */
export const KAI = {
  "people/kai/person.yaml": person("minh", { handle: "kai", name: "Kai" }),
  "people/minh/person.yaml": person("minh", { manager: "kai" }),
}

/** A main flow that only asks its `setup` pages at its node (a flow `ask`), declaring what the office passes but
 *  the inbox, which a flow must read. */
export const GATE = `id: gate
name: gate
typedefs:
  Person:
    name: str
    handle: str
    title: str
    company: str
    reports_to: str
input:
  person: !Person
  talking_to: !str
  summary: !str
  history: !list(list(Message))
  turns: !int
  max_turns: !int
  profile: !FileMemory
nodes:
  setup:
    kind: tool
    tool_id: ask
    input:
      questions:
        - question: Which database?
          header: db
          options: [{label: Postgres}, {label: SQLite}]
        - question: Which features?
          header: features
          multi_select: true
          options: [{label: auth}, {label: search}]
output: \${setup.output}
`

/** minh's main flow is the gate. */
export const GATE_FILES = {
  "people/minh/gate.yaml": GATE,
  "people/minh/person.yaml": person("minh", { main: "gate.yaml" }),
}

/** An answer to the gate's pages. */
export const GATE_ANSWER = { db: "Postgres", features: ["auth"] }

/** Prices the fake's model at $1 an input token, so one call can pass the company's $5 cap. */
export const PRICES = { stub: { input: 1_000_000, output: 0 } }

/** A model turn that calls the toolbox's `noop` and costs $6 at `PRICES`, over the company's $5 cap. */
export const PRICEY: ScriptedReply = {
  tool_calls: [{ name: "toolbox_noop", arguments: {} }],
  usage: { prompt_tokens: 6, completion_tokens: 1 },
}

/** A `noop` tool (`groups`, for `chatOffice`) that answers only once the cap stopped a watched worker, so the reply
 *  still runs when the stop comes; a resumed reply's call answers at once. */
export function capGate(): {
  groups: Record<string, Record<string, OfficeTool>>
  /** How often the watched workers were stopped. */
  stops: () => number
  /** Watches `o`'s next spawned worker. */
  watch: (o: ChatOffice) => void
} {
  let stops = 0
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  const noop: OfficeTool = {
    description: "Does nothing.",
    parameters: EMPTY,
    call: async () => {
      await opened
      return "ok"
    },
  }
  return {
    groups: { toolbox: { noop } },
    stops: () => stops,
    watch(o) {
      o.afterSpawn((worker) => {
        const stop = worker.stop.bind(worker)
        worker.stop = () => {
          stops += 1
          // Opened once the stop frame is written, so the worker reads the stop before the tool's answer.
          const sent = stop()
          sent.then(open, open)
          return sent
        }
      })
    },
  }
}

/** A model turn saying `content` that costs nothing. */
export function free(content: string): ScriptedReply {
  return { content, usage: { prompt_tokens: 0, completion_tokens: 0 } }
}

/** The open "raise the cost cap" work item, if any. */
export function capItem(o: ChatOffice): WorkItemRecord | undefined {
  return o.office.store
    .listWorkItems({ status: ["open", "in_progress"] })
    .find((item) => item.title.startsWith("Raise the cost cap"))
}

/** Each worker a chat office spawned: its pid and start time. */
const spawnedWorkers: { pid: number; started: number | null }[] = []

/** The workers the chat offices spawned that still run. */
export function livingWorkers(): { pid: number; started: number | null }[] {
  return spawnedWorkers.filter(({ pid, started }) => started !== null && sameProcess(pid, started))
}

/** Waits up to 10 s for every worker the chat offices spawned to be gone; each actor test file's `afterAll`. */
export async function noWorkersLeft(): Promise<void> {
  await waitFor(() => livingWorkers().length === 0, { timeout: 10_000, what: "the workers to exit" })
}

/** Records each worker `registry` spawns, so `noWorkersLeft` waits for it too; returns `registry`. */
export function followWorkers(registry: WorkerRegistry): WorkerRegistry {
  const spawn = registry.spawn.bind(registry)
  registry.spawn = async (...args) => {
    const worker = await spawn(...args)
    spawnedWorkers.push({ pid: worker.pid, started: startTime(worker.pid) })
    return worker
  }
  return registry
}

/** An office for session actors: its registry, the context its actors share, and what its spawns did. */
export interface ChatOffice {
  readonly office: Office
  readonly registry: WorkerRegistry
  readonly ctx: ActorContext
  /** Each job's kind, spawned or sent to a parked worker, in order. */
  readonly kinds: string[]
  /** Each job, spawned or sent to a parked worker, in order. */
  readonly jobs: Job[]
  readonly transcript: Transcript
  /** The live relay its actors feed, over `transcript` and the office's bus. */
  readonly live: LiveRelay
  readonly hooks: Hooks
  readonly answers: Answers
  /** The lines the actors, hooks and answers logged. */
  readonly logs: string[]
  /** Each live event published on the office's bus, in order. */
  readonly lives: LiveEvent[]
  /** How often the workspace stand-in was interrupted. */
  readonly workspace: { interrupts: number }
  /** The actors made through these helpers; each is closed when the test finishes. */
  readonly actors: SessionActor[]
  /** Holds the next spawn, or job sent to a parked worker, before it starts; `entered` resolves once it is held. */
  hold(): { entered: Promise<void>; release: () => void }
  /** Makes the next spawn, or job sent to a parked worker, throw before it starts. */
  failNextSpawn(): void
  /** Runs `fn` with the next worker to start a job (spawned, or parked and sent one) once it has started it. */
  afterSpawn(fn: (worker: Worker) => void): void
  /** How many reply node starts (or wakes) its workers have told their actors of. */
  replyStarts(): number
  /** How many jobs went to a parked worker (`next`) instead of a new one. */
  reused(): number
  /** Another registry over the office, its spawns recorded, held, failed or followed as `registry`'s are; it stops
   *  when the test finishes. */
  newRegistry(): WorkerRegistry
}

/**
 * An office over the base company with the template's chat flow (and `files` on top), its `office` connection on
 * `fake` (`llmConfig`, the fake's env, `prices`), each of `connections` (name to model) added on `fake` too, the
 * company `defaults` merged in, and a registry whose `spawn` is wrapped to record, hold, fail or follow each spawn.
 * Its actors share one `Hooks`, `Answers`, `Transcript` and `LiveRelay`, and a run spec from `mainSpec` over a
 * workspace stand-in, with the tools of `groups` merged into its groups. `office` builds the office from the company
 * files (default `makeOffice`'s). At test end the actors close, then the workers stop, before the office's store
 * closes.
 */
export async function chatOffice(
  fake: FakeLLM,
  {
    files = {},
    prices = {},
    llmConfig = LLM_CONFIG,
    defaults = {},
    groups = {},
    office: build = (files) => makeOffice({ files }),
    connections = {},
  }: {
    files?: Record<string, unknown>
    prices?: Record<string, unknown>
    llmConfig?: Record<string, unknown>
    defaults?: Record<string, unknown>
    groups?: Record<string, Record<string, OfficeTool>>
    office?: (files: Record<string, unknown>) => Office
    connections?: Record<string, string>
  } = {},
): Promise<ChatOffice> {
  const actors: SessionActor[] = []
  const registries: WorkerRegistry[] = []
  // Registered before makeOffice's, so it runs first.
  onTestFinished(async () => {
    for (const actor of actors) actor.close()
    for (const registry of registries) await registry.closeAll(5000)
  })
  const company = baseFiles()["company.yaml"] as { defaults: Record<string, unknown> }
  const office = build({
    ...CHAT_FILES,
    "company.yaml": { ...company, defaults: { ...company.defaults, ...defaults } },
    ...files,
  })
  office.connections.ensureDir()
  const lives: LiveEvent[] = []
  const publishLive = office.bus.publishLive.bind(office.bus)
  office.bus.publishLive = (event) => {
    lives.push(event)
    publishLive(event)
  }
  const provider = { llm_config: { ...llmConfig }, env: fake.env(), prices }
  await writePrivate(path.join(office.connections.dir, "office.json"), JSON.stringify(provider))
  for (const [name, model] of Object.entries(connections)) {
    await office.connections.put(name, ConnectionFile.parse({ llm_config: { ...llmConfig, model }, env: fake.env() }))
  }
  const kinds: string[] = []
  const jobs: Job[] = []
  const holds: { entered: () => void; released: Promise<void> }[] = []
  const afters: ((worker: Worker) => void)[] = []
  let failNext = false
  let replies = 0
  let reused = 0
  /** Records `job`, counts the reply starts `handlers` see, then holds or fails the start as asked. */
  const track = async (job: Job, handlers: WorkerHandlers<Worker>) => {
    kinds.push(job.kind)
    jobs.push(job)
    const held = holds.shift()
    if (held !== undefined) {
      held.entered()
      await held.released
    }
    if (failNext) {
      failNext = false
      throw new Error("the spawn failed")
    }
    const event = handlers.event.bind(handlers)
    handlers.event = (worker, frame) => {
      const data = frame.data as { node_id?: unknown } | undefined
      const starts = frame.name === "NodeStarted" || frame.name === "NodeWoken"
      if (starts && MAIN_CHAT.isReply(typeof data?.node_id === "string" ? data.node_id : null)) replies += 1
      event(worker, frame)
    }
  }
  const newRegistry = () => {
    const registry = followWorkers(makeRegistry(office.store))
    const spawn = registry.spawn.bind(registry)
    registry.spawn = async (job, sessionDir, handlers, options) => {
      await track(job, handlers)
      const worker = await spawn(job, sessionDir, handlers, options)
      afters.shift()?.(worker)
      return worker
    }
    const next = registry.next.bind(registry)
    registry.next = async (worker, job, handlers) => {
      await track(job, handlers)
      const sent = await next(worker, job, handlers)
      if (sent) {
        reused += 1
        afters.shift()?.(worker)
      }
      return sent
    }
    registries.push(registry)
    return registry
  }
  const registry = newRegistry()
  const logs: string[] = []
  const log = (line: string) => void logs.push(line)
  const hooks = new Hooks({ log })
  const answers = new Answers(office.store, { log })
  const transcript = new Transcript(office.paths.runs)
  const live = new LiveRelay({ bus: office.bus, transcript, log })
  const monitor = new Monitor(office.paths.company, office.store, new SecretStore(office.paths.secrets))
  const workspace = { interrupts: 0 }
  const standIn = {
    call: async (tool: string) => ({ output: "ok", audit: { tool, argsSummary: "", exit: 0, duration: 0 } }),
    interrupt: () => void (workspace.interrupts += 1),
  }
  const { store, git } = office
  const ctx: ActorContext = {
    store,
    git,
    paths: office.paths,
    bus: office.bus,
    connections: office.connections,
    workers: registry,
    hooks,
    answers,
    transcript,
    live,
    spec: async (session) => {
      const repo = loadRepo(await git.pin(session.repo_commit))
      const carried = (q: QuestionRecord) => answers.carried(q)
      const spec = mainSpec({ store, git, repo, session, workspace: standIn, monitor, carried })
      return {
        ...spec,
        groups: (c) => {
          const built = spec.groups(c)
          for (const [group, named] of Object.entries(groups)) built[group] = { ...built[group], ...named }
          return built
        },
      }
    },
    scheduler: realScheduler,
    log,
  }
  return {
    office,
    registry,
    ctx,
    kinds,
    jobs,
    transcript,
    live,
    hooks,
    answers,
    logs,
    lives,
    workspace,
    actors,
    hold() {
      let release!: () => void
      let entered!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const enteredP = new Promise<void>((resolve) => (entered = resolve))
      holds.push({ entered, released })
      return { entered: enteredP, release }
    },
    failNextSpawn() {
      failNext = true
    },
    afterSpawn(fn) {
      afters.push(fn)
    },
    replyStarts: () => replies,
    reused: () => reused,
    newRegistry,
  }
}

/** Stores a `starting` main chat of minh's in a fresh folder, with its work item, as a start opens one; `openedBy`
 *  is the human who opened it, `connection` and `model` what it runs on (`office` and its own model by default).
 *  Returns its id. */
export async function newSession(
  o: ChatOffice,
  {
    openedBy = null,
    connection = OFFICE,
    model = null,
  }: { openedBy?: string | null; connection?: string; model?: string | null } = {},
): Promise<string> {
  const { store, git } = o.office
  const cwd = tempDir()
  const t = now()
  const item = store.createWorkItem(
    WorkItem.parse({
      id: newId(),
      title: `Chat with Minh in ${path.basename(cwd)}`,
      kind: "task",
      status: "in_progress",
      requester: openedBy ?? CEO,
      assignee: "minh",
      created_at: t,
      updated_at: t,
    }),
  )
  const session = store.createSession(
    Session.parse({
      id: newId(),
      person: "minh",
      harness: "composer",
      office: os.hostname(),
      cwd,
      repo_commit: await git.head(),
      status: "starting",
      kind: "main",
      work_item_id: item.id,
      opened_by: openedBy,
      connection,
      model,
      created_at: t,
      updated_at: t,
    }),
  )
  return session.id
}

/** A new actor over session `sid`, on `o`'s context with `overrides` on top, closed when the test finishes. */
export function makeActor(o: ChatOffice, sid: string, overrides: Partial<ActorContext> = {}): SessionActor {
  const actor = new SessionActor({ ...o.ctx, ...overrides }, sid)
  o.actors.push(actor)
  return actor
}

/** A new session (`newSession`'s options) and its actor, started; resolves once the session is idle. */
export async function startActor(
  o: ChatOffice,
  options: { openedBy?: string | null } = {},
): Promise<{ actor: SessionActor; sid: string }> {
  const sid = await newSession(o, options)
  const actor = makeActor(o, sid)
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  return { actor, sid }
}

/** Waits until `actor` has no running worker, closes it and waits for its parked worker to exit, and returns a new
 *  actor over its session: the session asleep, as an office that stopped and started again would find it. */
export async function reopen(o: ChatOffice, actor: SessionActor): Promise<SessionActor> {
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  actor.close()
  // The closed actor's parked worker goes too, as the office stop ends it.
  await waitFor(() => o.registry.get(actor.sessionId) === undefined, { what: "the parked worker to exit" })
  return makeActor(o, actor.sessionId)
}

/** Makes run `runId` of `office` look as if its worker never started it: no log, and its row not marked started. */
export function neverStarted(office: Office, runId: string): void {
  fs.rmSync(path.join(office.paths.runs, runId, "log.jsonl"))
  office.store.db.prepare("UPDATE runs SET started_at = NULL WHERE run_id = ?").run(runId)
}

/** A started session, asleep under a new actor (Python's `asleep`). */
export async function asleep(o: ChatOffice): Promise<{ actor: SessionActor; sid: string }> {
  const { actor, sid } = await startActor(o)
  return { actor: await reopen(o, actor), sid }
}

/** Sends `text` and waits for one more assistant text and the session idle; returns that text. */
export async function say(o: ChatOffice, actor: SessionActor, sid: string, text: string): Promise<string> {
  const n = texts(o, sid).length
  await actor.prompt(text)
  await waitFor(() => texts(o, sid).length > n && status(o, sid) === "idle", { what: `the reply to ${text}` })
  return texts(o, sid).at(-1)!
}

/** Waits for session `sid`'s open question from `source`; returns it. */
export async function card(o: ChatOffice, sid: string, source: string): Promise<QuestionRecord> {
  const open = () => o.office.store.listQuestions({ sessionId: sid, status: "open", source })
  await waitFor(() => open().length > 0, { what: `the ${source} card` })
  return open()[0]!
}

/** The text parts of session `sid`'s messages with `role`, in order. */
export function texts(o: ChatOffice, sid: string, role = "assistant"): string[] {
  return o.transcript
    .messages(sid, session(o, sid).run_ids)
    .filter((message) => message.role === role)
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

/** The messages of the error parts of session `sid`'s live `message.updated` events, in order: the notices, which
 *  the transcript never returns. */
export function errors(o: ChatOffice, sid: string): string[] {
  return o.lives
    .filter((event) => event.type === "message.updated" && event.session_id === sid)
    .flatMap((event) => (event.data.parts as { type: string; message?: string }[]).filter((p) => p.type === "error"))
    .map((part) => part.message!)
}

/** Waits until `o`'s workers have told their actors of `n` reply starts: the `NodeStarted` reached the actor's queue,
 *  so a command sent after it finds the reply running. The model getting the request shows only the worker's side. */
export async function replyRunning(o: ChatOffice, n = 1): Promise<void> {
  await waitFor(() => o.replyStarts() >= n, { what: "the actor to see the reply start" })
}

/** Session `sid` as stored. */
export function session(o: ChatOffice, sid: string): SessionRecord {
  return o.office.store.getSession(sid)!
}

/** Session `sid`'s status. */
export function status(o: ChatOffice, sid: string): string {
  return session(o, sid).status
}

/** Session `sid`'s run state: its status, who it waits on and whether its cap holds it. */
export function state(o: ChatOffice, sid: string): Pick<SessionRecord, "status" | "waiting_on" | "capped"> {
  const { status, waiting_on, capped } = session(o, sid)
  return { status, waiting_on, capped }
}

/** The turn's unsettled take on the messages inbox. */
export const TAKE: Wait = {
  node: "chat#0/heard",
  call_id: "c1",
  tool: "take",
  inbox: "messages",
  deadline: null,
  settled: false,
}

/** A `waiting` result frame of run `runId` waiting on `waits`. */
export function waitingResult(runId: string, waits: Wait[] = [TAKE]): Record<string, unknown> {
  return { type: "result", status: "waiting", run_id: runId, output: null, failure: null, waits }
}

/** A worker a test drives in place of a process: its job, the handlers the actor gave it, each delivery sent to it,
 *  and what its `deliver` answers for a delivery (true by default). */
export interface ScriptedWorker {
  readonly worker: ActorWorker
  readonly job: Job
  readonly handlers: WorkerHandlers<ActorWorker>
  readonly deliveries: Delivery[]
  accept: (delivery: Delivery) => boolean | Promise<boolean>
  /** Every delivery it got: its job's, then each one sent to it. */
  given(): Delivery[]
}

/** Makes `o`'s spawns return scripted workers (still recording each kind and job) whose `deliver` records the
 *  delivery and returns what the worker's `accept` says; a `chat` job's worker makes its run's log, as a worker
 *  that starts the run does. A job sent to a parked scripted worker gets a scripted worker of its own over the same
 *  worker, and closing a scripted worker's channel exits it 0. Returns the scripted workers, in order. */
export function scriptedWorker(o: ChatOffice): ScriptedWorker[] {
  const spawned: ScriptedWorker[] = []
  /** What a job sent to a parked worker does, by worker. */
  const nexts = new Map<ActorWorker, (job: Job, handlers: WorkerHandlers<ActorWorker>) => void>()
  /** The scripted worker of `job` and `handlers` over `worker`, recorded. */
  const scriptedOf = (worker: ActorWorker, job: Job, handlers: WorkerHandlers<ActorWorker>): ScriptedWorker => {
    o.kinds.push(job.kind)
    o.jobs.push(job)
    const deliveries: Delivery[] = []
    const scripted: ScriptedWorker = {
      worker,
      job,
      handlers,
      deliveries,
      accept: () => true,
      given: () => [...job.deliver, ...deliveries],
    }
    spawned.push(scripted)
    return scripted
  }
  o.registry.spawn = async (job, _sessionDir, handlers) => {
    if (job.kind === "chat") {
      fs.mkdirSync(path.dirname(job.log), { recursive: true })
      fs.writeFileSync(job.log, "")
    }
    let current: ScriptedWorker
    let gone: Promise<number> | null = null
    const worker: ActorWorker = {
      job,
      pid: NO_GROUP,
      deliver: async (delivery) => {
        current.deliveries.push(delivery)
        return current.accept(delivery)
      },
      stop: async () => true,
      follow: async () => true,
      // As a parked worker that sees its channel close: it exits 0.
      closeChannel: () => {
        gone ??= Promise.resolve().then(() => {
          current.handlers.exited(worker, 0)
          return 0
        })
      },
      wait: async () => (gone === null ? null : await gone),
    }
    current = scriptedOf(worker, job, handlers)
    // A job sent to the parked worker gets a scripted worker of its own over the same worker.
    nexts.set(worker, (next, nextHandlers) => {
      ;(worker as { job: Job }).job = next
      current = scriptedOf(worker, next, nextHandlers)
    })
    return worker as Worker
  }
  o.registry.next = async (worker, job, handlers) => {
    nexts.get(worker)!(job, handlers)
    return true
  }
  return spawned
}

/** A lister that gives each connection in `listings` (name to model ids) as listed, and any other connection only
 *  its configured model; it never reaches the network. */
export function listed(listings: Record<string, string[]>): Lister {
  return async (conn, name) =>
    Object.hasOwn(listings, name)
      ? { connection: name, models: listings[name]!.map((id) => ({ id, name: null })), listed: true, error: null }
      : ownModels(conn, name)
}

/**
 * A real `ChatHarness` over a `chatOffice` (its options but `office`) whose first registry it spawns in, with a real
 * `Monitor` and the real workspace tools of `harness.spec`, the tools of `groups` merged into its groups;
 * `office.harness` and `office.workers` are the harness. `scheduler` is its actors' (default `realScheduler`).
 * `folder` is a folder to chat in. `connections` (`{name: model}`) adds connections on `fake`, each on `model`. With
 * `codex`, the office is `makeCodex`'s and its Codex sessions over a fake app-server are `office.codex`, on the
 * harness's hooks (minh may then use Codex unless `files` replace him); `codex` is what `makeCodex` returned. With
 * `questions`, the questions extension is registered on each harness (`office.cards`).
 * The harness's start choice lists models through `lister`, else `listed(listings)`, never the network, and
 * waits `chooseDeadlineMs` if given.
 * `reopen()` closes the harness and the cards, the store left open, and puts a second harness over the same office
 * in `harness`, on a new registry: the office stopped and started again. Call inside a test: when it finishes the
 * harness closes before the store does.
 */
export async function makeHarness(
  fake: FakeLLM,
  {
    codex = false,
    scheduler = realScheduler,
    questions = false,
    listings = {},
    lister = listed(listings),
    chooseDeadlineMs,
    ...options
  }: Omit<NonNullable<Parameters<typeof chatOffice>[1]>, "office"> & {
    codex?: boolean
    scheduler?: Scheduler
    questions?: boolean
    listings?: Record<string, string[]>
    lister?: Lister
    chooseDeadlineMs?: number
  } = {},
) {
  let harness: ChatHarness | undefined
  // Registered first, so it runs before the registries stop and the store closes.
  onTestFinished(() => harness?.closeAll())
  let c: Codex | undefined
  const o = await chatOffice(fake, {
    ...options,
    ...(codex ? { office: (files: Record<string, unknown>) => (c = makeCodex({ files })).office } : {}),
  })
  const { office } = o
  const codexed = c as Codex | undefined
  const hooks = codexed?.hooks ?? o.hooks
  office.codex = codexed?.sessions
  // The office's one transcript and relay, which the harness's actors share with these helpers.
  office.transcript = o.transcript
  office.live = o.live
  const models = new ModelCache(office.connections, { lister })
  const make = (workers: WorkerRegistry) => {
    harness = new ChatHarness(office, {
      monitor: new Monitor(office.paths.company, office.store, office.secrets),
      hooks,
      workers,
      scheduler,
      log: (line) => void o.logs.push(line),
      models,
      ...(chooseDeadlineMs === undefined ? {} : { chooseDeadlineMs }),
    })
    const { groups } = options
    if (groups !== undefined) {
      const spec = harness.spec.bind(harness)
      harness.spec = async (session) => {
        const built = await spec(session)
        return {
          ...built,
          groups: (c) => {
            const all = built.groups(c)
            for (const [group, named] of Object.entries(groups)) all[group] = { ...all[group], ...named }
            return all
          },
        }
      }
    }
    office.harness = harness
    office.workers = harness
    if (questions) registerQuestions(office)
    return harness
  }
  const h = {
    ...o,
    harness: make(o.registry),
    store: office.store,
    hooks,
    folder: codexed?.workspace ?? tempDir(),
    codex: codexed,
    async reopen(): Promise<ChatHarness> {
      // The office's stop, in its order: the harness, then its cards.
      await h.harness.closeAll()
      await office.cards?.close()
      h.registry = o.newRegistry()
      h.harness = make(h.registry)
      return h.harness
    },
  }
  return h
}

/** Whether a worker of session `sid` runs a job in `registry`: one parked between jobs doesn't. */
export function running(registry: WorkerRegistry, sid: string): boolean {
  const worker = registry.get(sid)
  return worker !== undefined && !worker.parked
}

/** A `makeHarness` office. */
export type HarnessOffice = Awaited<ReturnType<typeof makeHarness>>

/** Leaves each session's run holding a message it never read, as an office that died just after the message reached
 *  the run's log would, then stops the office and starts a new one (`h.reopen`), not yet restored: its restore must
 *  advance each run. */
export async function unreadAtRestart(h: HarnessOffice, ...sids: string[]): Promise<void> {
  const exited = (sid: string) => waitFor(() => !running(h.registry, sid), { what: "the run call to end" })
  for (const sid of sids) {
    await exited(sid)
    // Over the company's $5 cap the message only reaches the run's log.
    h.store.updateSession(sid, { cost: 6 })
    expect(await h.harness.prompt(sid, "hello")).toBe("queued")
    await exited(sid)
  }
  await h.reopen()
  for (const sid of sids) h.store.updateSession(sid, { cost: 0 })
}
