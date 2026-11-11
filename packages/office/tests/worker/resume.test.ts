/** Moving a run on in a new worker: a killed run resumes, and an advance yian refuses before it appends is reported
 *  `not_resumed`. */
import fs from "node:fs"
import path from "node:path"
import { FileMemory, type MemorySession, RunBusyError } from "@ngocbh/yian"
import { inspectRun } from "@ngocbh/yian/run"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { loadRepo } from "../../src/company/loader.ts"
import { killGroup } from "../../src/install/proc.ts"
import { Answers } from "../../src/questions/ask.ts"
import { companyTools } from "../../src/tools/company/work.ts"
import { type FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Job, JobInput } from "../../src/worker/job.ts"
import { advanceAppended, EXIT_FAILED, notResumed } from "../../src/worker/main.ts"
import type { WorkerHandlers } from "../../src/worker/rpc.ts"
import type { Worker } from "../../src/worker/spawn.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { captureStderr } from "../helpers.ts"
import { fifoAt } from "../runs/helpers.ts"
import { openStore, session, workItem } from "../store/helpers.ts"
import { company } from "../company/helpers.ts"
import {
  advanceJob,
  agentFlow,
  base,
  inProcessWorker,
  makeJob,
  makeRegistry,
  profileMemory,
  Recorder,
  run,
  runWorker,
  type TestWorker,
  writeFiles,
} from "./helpers.ts"

setDefaultTimeout(60_000)

/** The `toolbox` group with one `shout` spec described as `description`. */
function shout(description: string): JobInput["groups"] {
  return {
    toolbox: [
      {
        name: "shout",
        description,
        parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      },
    ],
  }
}

/** Starts `job` in an in-process worker with `handlers`, holds its model call and stops it; the run is then
 *  stopped. */
async function stoppedRun(fake: FakeLLM, job: Job, handlers: WorkerHandlers<TestWorker> = new Recorder()) {
  onTestFinished(() => fake.release())
  fake.script({ content: "lost", hold: true })
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.stop()).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(inspectRun(job.log).status).toBe("stopped")
  fake.release()
}

/** Advances `job` in process with `env`; expects a `not_resumed` result naming `errorType` and a log the advance
 *  left as it was. */
async function expectNotResumed(job: Job, errorType: string, env: Record<string, string> = {}): Promise<void> {
  const before = fs.readFileSync(job.log, "utf8")
  const rec = await run(job, new Recorder(), { env })
  expect(rec.order).toEqual(["result"])
  expect(rec.outcome).toEqual({ type: "result", status: "not_resumed", run_id: "r1", error_type: errorType })
  expect(fs.readFileSync(job.log, "utf8")).toBe(before)
}

test("a killed run resumes in a new worker", async () => {
  const fake = await fakeLlm()
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const job = makeJob(where)
  fake.script({ content: "lost", hold: true })
  const worker = await registry.spawn(job, sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  killGroup(worker.pgid)
  expect(await worker.wait(10_000)).toBe(-9)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  fake.release()
  fake.script({ content: "recovered" })
  const rec = await runWorker(registry, advanceJob(job), new Recorder(), sessionDir, { env: fake.env() })
  expect([rec.returncode, rec.outcome?.status, rec.outcome?.run_id, rec.outcome?.output]).toEqual([
    0,
    "succeeded",
    "r1",
    "recovered",
  ])
})

test("a killed run whose provider has a key resumes with that key", async () => {
  const fake = await fakeLlm()
  const where = base()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  const key = "sk-test-resume-0123456789"
  const job = makeJob(where, undefined, { llm_config: { ...LLM_CONFIG, base_url: `${fake.baseUrl}/v1`, api_key: key } })
  fake.script({ content: "lost", hold: true })
  const worker = await registry.spawn(job, sessionDir, new Recorder(), { env: {} })
  await fake.waitForRequests(1, 30_000)
  killGroup(worker.pgid)
  expect(await worker.wait(10_000)).toBe(-9)
  fake.release()
  fake.script({ content: "recovered" })
  const rec = await runWorker(registry, advanceJob(job), new Recorder(), sessionDir, { env: {} })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "recovered"])
  expect(fake.authorizations().at(-1)).toBe(`Bearer ${key}`)
})

test("a not resumed advance refuses the deliveries it still holds", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base(), "flows/steerable.yaml", { groups: shout("Shouts the text.") })
  await stoppedRun(fake, chat)
  // Offline, the interrupt waits for RunResumed, which a refused advance never writes.
  const job = advanceJob(chat, {
    groups: shout("Whispers the text."),
    deliver: [{ id: "i1", op: "interrupt", inbox: "steers" }],
  })
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.order).toEqual(["deliver_reply", "result"])
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "i1", refused: "not_started" }])
  expect(rec.outcome).toEqual({ type: "result", status: "not_resumed", run_id: "r1", error_type: "RangeError" })
})

test("an advance whose code file is gone is not resumed", async () => {
  const where = base()
  const chat = makeJob(where, "flows/coded.yaml", { inputs: {} })
  // The run starts in a worker process, as the office starts it, so this process has no compiled flow of the run's
  // to reuse: the advance recompiles the recorded flow.
  const sessionDir = path.join(where.root, "sessions", "s1")
  expect((await runWorker(makeRegistry(), chat, new Recorder(), sessionDir)).outcome?.status).toBe("waiting")
  fs.rmSync(path.join(where.pin, "flows", "helpers.ts"))
  await expectNotResumed(advanceJob(chat), "LoadError")
})

test("an advance refused for a changed tool spec is not resumed", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base(), "flows/tools.yaml", { groups: shout("Shouts the text.") })
  await stoppedRun(fake, chat)
  await expectNotResumed(advanceJob(chat, { groups: shout("Whispers the text.") }), "RangeError", fake.env())
})

/** minh's profile in `root` as `profileMemory` builds it, counting the sessions it opens. */
function counted(root: string): FileMemory & { opens: number } {
  const memory = Object.assign(profileMemory(root), { opens: 0 })
  const open = memory.open.bind(memory)
  memory.open = (o): Promise<MemorySession> => {
    memory.opens += 1
    return open(o)
  }
  return memory
}

/** The system prompt of the fake's `n`th request. */
function systemOf(fake: FakeLLM, n: number): string {
  const [system] = fake.requests()[n]!.messages as { role: string; content: string }[]
  return system!.content
}

test("an advance whose memory isn't bound is not resumed", async () => {
  const fake = await fakeLlm()
  const where = base()
  const handlers = new Recorder({ memories: { profile: profileMemory(path.join(where.root, "memory"), "# Minh\n") } })
  const chat = makeJob(where, "flows/profiled.yaml", {}, handlers)
  await stoppedRun(fake, chat, handlers)
  await expectNotResumed(advanceJob(chat, { memory: [] }), "RangeError", fake.env())
})

test("an advance of a waiting run binds its memory again and keeps the recall it started with", async () => {
  const fake = await fakeLlm()
  const where = base()
  const root = path.join(where.root, "memory")
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, "profile.md"), "# Minh\nTerse.\n")
  const first = counted(root)
  const handlers = new Recorder({ memories: { profile: first } })
  const chat = makeJob(where, "flows/profiled_inbox.yaml", { inputs: {} }, handlers)
  expect((await run(chat, handlers)).outcome?.status).toBe("waiting")
  expect(first.opens).toBe(1)
  fs.writeFileSync(path.join(root, "profile.md"), "# Minh\nChatty.\n")
  fake.script({ content: "ok" })
  const again = counted(root)
  const send = { id: "s1", op: "send" as const, inbox: "messages", event: "hi" }
  const rec = await run(advanceJob(chat, { deliver: [send] }), new Recorder({ memories: { profile: again } }), {
    env: fake.env(),
  })
  expect(rec.outcome?.status).toBe("succeeded")
  expect(again.opens).toBe(1)
  expect(systemOf(fake, 0)).toBe('<memory name="profile"># Minh\nTerse.\n</memory>')
})

test("a crash resume binds the memory again and logs that it changed", async () => {
  const fake = await fakeLlm()
  const where = base()
  const root = path.join(where.root, "memory")
  const handlers = new Recorder({ memories: { profile: profileMemory(root, "# Minh\nTerse.\n") } })
  const chat = makeJob(where, "flows/profiled.yaml", {}, handlers)
  await stoppedRun(fake, chat, handlers)
  fs.writeFileSync(path.join(root, "profile.md"), "# Minh\nChatty.\n")
  const lines = captureStderr()
  fake.script({ content: "recovered" })
  const again = counted(root)
  const rec = await run(advanceJob(chat), new Recorder({ memories: { profile: again } }), { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "recovered"])
  expect(again.opens).toBe(1)
  expect(systemOf(fake, 1)).toBe('<memory name="profile"># Minh\nTerse.\n</memory>')
  expect(lines).toContain("opencorp __worker: memory profile changed since the run started")
})

test("an advance whose yian settings differ is not resumed", async () => {
  const fake = await fakeLlm()
  const chat = makeJob(base())
  await stoppedRun(fake, chat)
  await expectNotResumed(advanceJob(chat), "DefaultsMismatchError", { ...fake.env(), YIAN_MAX_EVENT_BYTES: "12345" })
})

/** A run of `flows/inbox.yaml` waiting for a message. */
async function waitingInbox(): Promise<Job> {
  const waiting = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  expect((await run(waiting, new Recorder())).outcome?.status).toBe("waiting")
  return waiting
}

const HI = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const

test("an advance whose log has a bad line is not resumed and refuses its deliveries", async () => {
  const waiting = await waitingInbox()
  fs.appendFileSync(waiting.log, "garbage\n")
  const before = fs.readFileSync(waiting.log, "utf8")
  const rec = await run(advanceJob(waiting, { deliver: [HI] }), new Recorder())
  expect(rec.order).toEqual(["deliver_reply", "result"])
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.outcome).toEqual({
    type: "result",
    status: "not_resumed",
    run_id: "r1",
    error_type: "RangeError",
    unreadable: true,
  })
  expect(fs.readFileSync(waiting.log, "utf8")).toBe(before)
})

test("an advance whose log is gone is not resumed", async () => {
  const waiting = await waitingInbox()
  fs.rmSync(path.dirname(waiting.log), { recursive: true })
  const rec = await run(advanceJob(waiting, { deliver: [HI] }), new Recorder())
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.outcome).toEqual({
    type: "result",
    status: "not_resumed",
    run_id: "r1",
    error_type: "ENOENT",
    unreadable: true,
  })
  expect(fs.existsSync(path.dirname(waiting.log))).toBe(false)
})

test("an advance whose log is a fifo is not resumed", async () => {
  const waiting = await waitingInbox()
  fs.rmSync(waiting.log)
  fifoAt(waiting.log)
  const rec = await run(advanceJob(waiting, { deliver: [HI] }), new Recorder())
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.outcome).toEqual({
    type: "result",
    status: "not_resumed",
    run_id: "r1",
    error_type: "EINVAL",
    unreadable: true,
  })
})

test("a delivery-only job on an unreadable log is not resumed", async () => {
  const waiting = await waitingInbox()
  fs.appendFileSync(waiting.log, "garbage\n")
  const rec = await run(advanceJob(waiting, { advance: false, deliver: [HI] }), new Recorder())
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.outcome).toEqual({
    type: "result",
    status: "not_resumed",
    run_id: "r1",
    error_type: "RangeError",
    unreadable: true,
  })
})

test("a chat job whose runs folder is a file sends an error frame with its code and syscall", async () => {
  const where = base()
  fs.writeFileSync(where.runs, "")
  const rec = await run(makeJob(where, "flows/inbox.yaml", { inputs: {} }), new Recorder())
  expect(rec.outcome?.type).toBe("error")
  expect(["ENOTDIR", "EEXIST"]).toContain(rec.outcome?.code as string)
  expect(rec.outcome?.syscall).toBe("mkdir")
})

test("a refusal after the advance appended a record is an error", () => {
  expect(notResumed(new RangeError("x"), true)).toBe(false)
  expect(notResumed(new RangeError("x"), false)).toBe(true)
  expect(notResumed(new RunBusyError("/l"), false)).toBe(false)
})

test("only records an advance writes count as appended", async () => {
  const waiting = makeJob(base(), "flows/inbox.yaml", { inputs: {} })
  expect((await run(waiting, new Recorder())).outcome?.status).toBe("waiting")
  const quiet = inspectRun(waiting.log).lastSeq
  expect(quiet).not.toBeNull()
  const send = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  const delivered = await run(advanceJob(waiting, { advance: false, deliver: [send] }), new Recorder())
  expect(delivered.outcome?.status).toBe("waiting")
  expect(inspectRun(waiting.log).lastSeq).toBeGreaterThan(quiet!)
  expect(advanceAppended(waiting.log, quiet)).toBe(false)

  const fake = await fakeLlm()
  const stopped = makeJob(base())
  await stoppedRun(fake, stopped)
  const before = inspectRun(stopped.log).lastSeq
  fake.script({ content: "Done." })
  expect((await run(advanceJob(stopped), new Recorder(), { env: fake.env() })).outcome?.status).toBe("succeeded")
  expect(advanceAppended(stopped.log, before)).toBe(true)

  expect(advanceAppended(waiting.log, null)).toBe(true)
})

test("an ask_manager call a crash cut off is sent again on resume, and gets the question it stored", async () => {
  const fake = await fakeLlm()
  const where = base()
  writeFiles(where.pin, { "flows/managed.yaml": agentFlow("managed", { node: "    tools: [company]\n" }) })
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const item = store.createWorkItem(workItem({ requester: "minh" }))
  const s = store.createSession(session({ person: "minh", work_item_id: item.id }))
  const answers = new Answers(store)
  const tools = { company: companyTools(store, loadRepo(company()), s, "r1", (q, o) => answers.ask(q, o)) }
  const calls: string[] = []
  /** Serves the company tools; the first call stores its question, then kills the worker before it replies. */
  class CrashAfterAsking extends Recorder {
    override async toolCall(worker: Worker, group: string, name: string, args: Record<string, unknown>, id?: string) {
      const result = await super.toolCall(worker, group, name, args, id)
      calls.push(id!)
      if (calls.length > 1) return result
      killGroup(worker.pgid)
      return await new Promise(() => {})
    }
  }
  const job = makeJob(where, "flows/managed.yaml", {}, new CrashAfterAsking({ tools }))
  fake.script({ tool_calls: [{ name: "company_ask_manager", arguments: { question: "Deploy now?" } }] })
  const worker = await registry.spawn(job, sessionDir, new CrashAfterAsking({ tools }), { env: fake.env() })
  expect(await worker.wait(30_000)).toBe(-9)
  expect(inspectRun(job.log).status).toBe("crashed")
  const resumed = new CrashAfterAsking({ tools })
  const rec = await runWorker(registry, advanceJob(job), resumed, sessionDir, { env: fake.env() })
  expect(rec.outcome?.status, String(rec.outcome?.message)).toBe("waiting")
  expect(calls).toEqual(["r1/reply/1/0", "r1/reply/1/0"])
  expect(store.listQuestions().map((q) => [q.call_id, q.status])).toEqual([["r1/reply/1/0", "open"]])
  // The model was never asked again: the call pends on the question it asked before the crash.
  expect(fake.requests()).toHaveLength(1)
})
