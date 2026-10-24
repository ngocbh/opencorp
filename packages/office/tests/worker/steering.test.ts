/** The steering inbox (queued steers, interrupts as a per-node signal, finished nodes and close), and steering
 *  through a run. */
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import { Inbox } from "../../src/worker/inbox.ts"
import type { JobInput } from "../../src/worker/job.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { inProcessWorker, makeJob, Recorder, run, type TestWorker, writePin } from "./helpers.ts"

setDefaultTimeout(30_000)

test("steers queue until drained", () => {
  const inbox = new Inbox()
  expect(inbox.steer("reply", "one") && inbox.steer("reply", "two")).toBe(true)
  expect(inbox.drain("reply")).toEqual(["one", "two"])
  expect(inbox.drain("reply")).toEqual([])
})

test("a finished node refuses steers and interrupts", () => {
  const inbox = new Inbox()
  inbox.steer("reply", "unread")
  expect(inbox.interrupt("reply") && inbox.interruptSignal("reply").aborted).toBe(true)
  expect(inbox.finish("reply")).toEqual(["unread"])
  expect(inbox.interruptSignal("reply").aborted).toBe(false)
  expect(inbox.steer("reply", "late") || inbox.interrupt("reply")).toBe(false)
  expect(inbox.drain("reply")).toEqual([])
})

test("close refuses new steers and returns every queued one", () => {
  const inbox = new Inbox()
  inbox.steer("a", "1")
  inbox.steer("loop#1/b", "2")
  inbox.finish("a")
  inbox.steer("never-ran", "3")
  expect(Object.fromEntries(inbox.close())).toEqual({ "loop#1/b": ["2"], "never-ran": ["3"] })
  expect(inbox.steer("c", "late") || inbox.interrupt("c")).toBe(false)
  expect(Object.fromEntries(inbox.close())).toEqual({})
})

test("an interrupt waits for its node to start", () => {
  const inbox = new Inbox()
  expect(inbox.interrupt("later") && inbox.interruptSignal("later").aborted).toBe(true)
})

test("a node is cut once it reads its interrupt", () => {
  const inbox = new Inbox()
  expect(inbox.interrupt("reply") && !inbox.cut("reply")).toBe(true)
  expect(inbox.interruptSignal("reply").aborted && inbox.cut("reply")).toBe(true)
  inbox.finish("reply")
  expect(inbox.cut("reply")).toBe(false)
})

test("an interrupt aborts the signal a running node already took", () => {
  const inbox = new Inbox()
  const signal = inbox.interruptSignal("reply")
  expect(signal.aborted || inbox.cut("reply")).toBe(false)
  expect(inbox.interrupt("reply")).toBe(true)
  expect(signal.aborted && inbox.cut("reply")).toBe(true)
})

test("after close a node gets a signal that never aborts", () => {
  const inbox = new Inbox()
  inbox.close()
  expect(inbox.interruptSignal("x").aborted || inbox.interrupt("x")).toBe(false)
})

const TOOL_THEN_DONE: ScriptedReply[] = [
  { content: "Working", tool_calls: [{ name: "shout", arguments: { text: "hi" } }] },
  { content: "Done." },
]

/** Runs `shout`, and during the call steers or interrupts the running node. */
class Steering extends Recorder {
  constructor(
    readonly action: (worker: TestWorker) => unknown,
    options: ConstructorParameters<typeof Recorder>[0] = {},
  ) {
    super(options)
  }

  override async toolCall(
    worker: TestWorker,
    _group: string,
    _name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Not awaited: the office channel writes in call order, so the worker reads this frame before the reply and
    // the node sees it before the tool returns. A failed send shows in what the test checks, so it is not kept.
    Promise.resolve(this.action(worker)).catch(() => {})
    return String(args.text).toUpperCase()
  }
}

function specGroups(): JobInput["groups"] {
  return {
    toolbox: [
      { name: "shout", parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    ],
  }
}

/** A fresh pin and runs folder for a job. */
function base(): { pin: string; runs: string } {
  const root = tempDir()
  return { pin: writePin(path.join(root, "pin")), runs: path.join(root, "runs") }
}

test("a steer reaches the next model call", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering((w) => w.steer("reply", "Also mention Rome."))
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.output).toBe("Done.")
  expect(rec.left).toEqual([])
  expect(JSON.stringify(fake.requests()[1]!.messages)).toContain("Also mention Rome.")
  const succeeded = rec.frames.filter((f) => f.name === "NodeSucceeded")
  expect(succeeded.every((f) => !Object.hasOwn(f.data as object, "interrupted"))).toBe(true)
})

test("an interrupt returns the text so far", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, new Steering((w) => w.interrupt("reply")), { env: fake.env() })
  expect([rec.outcome?.status, rec.outcome?.output]).toEqual(["succeeded", "Working"])
  expect(fake.requests().length).toBe(1)
  const ended = rec.frames
    .filter((f) => f.name === "NodeSucceeded" && (f.data as Record<string, unknown>).node_id === "reply")
    .map((f) => f.data as Record<string, unknown>)
  expect(ended.length).toBe(1)
  expect(ended[0]!.interrupted).toBe(true)
})

test("a steer the node never reads comes back", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering((w) => w.steer("reply", "Also mention Rome."))
  const job = makeJob(base(), "flows/tools.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.outcome?.output).toBe("Done.")
  expect(rec.left).toEqual([["reply", ["Also mention Rome."]]])
  expect(JSON.stringify(fake.requests()[1]!.messages)).not.toContain("Rome")
})

test("a steer for a finished node comes back at once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hello", hold: true })
  const rec = new Recorder({ answers: ["hi"] })
  const worker = await inProcessWorker(makeJob(base(), "flows/chat.yaml", { inputs: {} }), rec, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  // Dropped: the node is done.
  expect(await worker.interrupt("ask")).toBe(true)
  expect(await worker.steer("ask", "late")).toBe(true)
  await waitFor(() => rec.left.length > 0, { timeout: 10_000, what: "the steer to come back" })
  expect(rec.left).toEqual([["ask", ["late"]]])
  fake.release()
  expect(await worker.wait()).toBe(0)
  expect(rec.outcome?.output).toBe("hello")
})

test("a steer for a node that never ran comes back before the result", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering((w) => w.steer("nowhere", "Hello?"))
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const rec = await run(job, handlers, { env: fake.env() })
  expect(rec.left).toEqual([["nowhere", ["Hello?"]]])
  expect(rec.order).toEqual(["steer_left", "result"])
})

test("a steer sent as the run ends is applied or returned", async () => {
  const fake = await fakeLlm()
  fake.script(...TOOL_THEN_DONE)
  const handlers = new Steering(() => {})
  const job = makeJob(base(), "flows/steerable.yaml", { groups: specGroups() })
  const worker = await inProcessWorker(job, handlers, { env: fake.env() })
  const sent: string[] = []
  // steer() turns false once the office has read the result and closed its side (or the test end closed it).
  while (await worker.steer("reply", `<s${sent.length}>`)) {
    sent.push(`<s${sent.length}>`)
    await Bun.sleep(1)
  }
  expect(await worker.wait()).toBe(0)
  expect(handlers.outcome?.type).toBe("result")
  const applied = JSON.stringify(fake.requests().map((r) => r.messages))
  const returned = handlers.left.flatMap(([, texts]) => texts)
  expect(sent.length).toBeGreaterThan(0)
  expect(returned.length).toBe(new Set(returned).size)
  expect(sent.filter((text) => !applied.includes(text) && !returned.includes(text))).toEqual([])
})
