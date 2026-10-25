/** The live relay: one LiveView per running worker, built from its snapshot and fed its frames; gaps followed again. */
import { iterRunRecords, type LiveFrame, type LiveSnapshot, LiveView, type RunLogEntry } from "@ngocbh/yian/run"
import type { LiveEvent } from "@opencorp/protocol"
import { expect, setDefaultTimeout, test } from "bun:test"
import { LiveRelay, type LiveWorker } from "../../src/daemon/live.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { Job } from "../../src/worker/job.ts"
import { fakeLlm, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { advanceJob, run } from "../worker/helpers.ts"

setDefaultTimeout(30_000)

const REPLY = "chat#0/reply"

/** A finished template chat turn answering `content`, run as `runId` (`r1` by default): its job and the live frames
 *  its advance's worker sent (the template office, a `Recorder`, keeps them as `streams`). */
async function recordedTurn(content: string, runId = "r1"): Promise<{ job: Job; frames: Frame[] }> {
  const fake = await fakeLlm()
  fake.script({ content })
  const job = await waitingChat(fake, "chat", {}, { runId })
  const rec = await run(advanceJob(job, { deliver: [send("s1", "hi")] }), new TemplateOffice(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  expect(rec.streams[0]?.type).toBe("snapshot")
  return { job, frames: rec.streams }
}

/** A template chat run waiting at its first take, as `runId`; returns its job. */
async function waitingRun(runId = "r1"): Promise<Job> {
  return waitingChat(await fakeLlm(), "chat", {}, { runId })
}

/** The seq of the last record of the run log `log`. */
function lastSeq(log: string): number {
  return [...iterRunRecords(log, { payloads: false })].at(-1)!.seq
}

/** A snapshot frame after record `last` with `calls`. */
function snapshot(last: number, calls: LiveSnapshot["calls"] = []): Frame {
  return { type: "snapshot", snapshot: { last_seq: last, calls } }
}

/** A stand-in worker of `job` that counts its `follow` calls. */
class StubWorker implements LiveWorker {
  readonly job: Job
  follows = 0

  constructor(job: Job) {
    this.job = job
  }

  follow(): Promise<boolean> {
    this.follows++
    return Promise.resolve(true)
  }
}

/** A relay whose bus events and log lines are collected. */
function makeRelay(): { relay: LiveRelay; events: LiveEvent[]; lines: string[] } {
  const events: LiveEvent[] = []
  const lines: string[] = []
  const relay = new LiveRelay({
    bus: { publishLive: (event) => void events.push(event) },
    transcript: { messages: () => [] },
    log: (line) => void lines.push(line),
  })
  return { relay, events, lines }
}

/** The gap line for a frame of `type`. */
function gapLine(type: string, runId = "r1"): string {
  return `run ${runId}: live frames have a gap (${type}); following again`
}

/** Whether the run-log entry `entry` is a model call's step. */
function isModelCall(entry: RunLogEntry): boolean {
  return (
    entry.kind === "node_step" &&
    (entry.envelope.record as unknown as { step: { kind: string } }).step.kind === "model_call"
  )
}

test("a workers frames build its runs view", async () => {
  const content = "Hello there my good friend"
  const { job, frames } = await recordedTurn(content)
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  expect(relay.calls("r1")).toBeNull()
  let text = ""
  for (const frame of frames) {
    relay.frame(worker, frame)
    if (frame.type !== "chunk") continue
    expect(frame.node).toBe(REPLY)
    text += frame.text
    const calls = relay.calls("r1")!
    expect(calls).toEqual([{ node: REPLY, n: frame.n as number, text, nextIndex: (frame.index as number) + 1 }])
  }
  expect(text).toBe(content)
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toEqual([])
  expect(worker.follows).toBe(0)
})

test("a gap is logged and the view follows again", async () => {
  const content = "Hello there my good friend"
  const { job, frames } = await recordedTurn(content)
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  relay.frame(worker, frames[0])
  const { last_seq: last } = frames[0]!.snapshot as LiveSnapshot
  const skipping = frames.find((frame) => frame.type === "record" && frame.seq === last + 2)!
  relay.frame(worker, skipping)
  expect(lines).toEqual([gapLine("record")])
  expect(worker.follows).toBe(1)
  expect(relay.calls("r1")).toEqual([])
  relay.frame(worker, frames.find((frame) => frame.type === "chunk")!)
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toHaveLength(1)
  // The next snapshot rebuilds the view, which then follows every later frame.
  let text = ""
  for (const frame of frames) {
    relay.frame(worker, frame)
    if (frame.type !== "chunk") continue
    text += frame.text
    expect(relay.calls("r1")!.map((call) => call.text)).toEqual([text])
  }
  expect(text).toBe(content)
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toHaveLength(1)
  expect(worker.follows).toBe(1)
})

test("a view that cant be built stops following after three tries", async () => {
  const { job, frames } = await recordedTurn("Hello there my good friend")
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  const past = snapshot(lastSeq(job.log) + 5)
  for (let i = 0; i < 3; i++) relay.frame(worker, past)
  expect(lines).toEqual([gapLine("snapshot"), gapLine("snapshot"), "run r1: live view can't be built; not following"])
  expect(worker.follows).toBe(2)
  for (const frame of frames) relay.frame(worker, frame)
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toHaveLength(3)
  expect(worker.follows).toBe(2)
})

test("an over cap record is read from the log", async () => {
  const { job, frames } = await recordedTurn("Hello there my good friend")
  const step = [...iterRunRecords(job.log)].find((entry) => entry.nodeId === REPLY && isModelCall(entry))!
  const at = frames.findIndex((frame) => frame.type === "record" && frame.seq === step.seq)
  expect(at).toBeGreaterThan(0)
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  for (const frame of frames.slice(0, at)) relay.frame(worker, frame)
  expect(relay.calls("r1")!.map((call) => call.node)).toEqual([REPLY])
  // Its step record drops the call, so the view has passed it.
  relay.frame(worker, { type: "record", seq: step.seq })
  expect(relay.calls("r1")).toEqual([])
  for (const frame of frames.slice(at + 1)) relay.frame(worker, frame)
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toEqual([])
  expect(worker.follows).toBe(0)
})

test("an over cap record the log doesnt hold is a gap", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  relay.frame(worker, snapshot(last, [{ node: REPLY, n: 1, chunks: ["Hi"], next_index: 1 }]))
  relay.frame(worker, { type: "record", seq: last + 1 })
  expect(lines).toEqual([gapLine("record")])
  expect(worker.follows).toBe(1)
  expect(relay.calls("r1")).toEqual([])
})

test("a follow that fails is logged by its type", async () => {
  const job = await waitingRun()
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  worker.follow = () => {
    worker.follows++
    return Promise.reject(new TypeError("secret text"))
  }
  expect(() => relay.frame(worker, { type: "nope" })).not.toThrow()
  await Promise.resolve()
  expect(lines).toEqual([gapLine("unknown"), "run r1: live follow failed (TypeError)"])
  expect(lines.some((line) => line.includes("secret text"))).toBe(false)
  expect(worker.follows).toBe(1)
})

test("a new worker starts with no live calls of the old one", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay, lines } = makeRelay()
  const a = new StubWorker(job)
  const b = new StubWorker(job)
  relay.frame(a, snapshot(last, [{ node: REPLY, n: 1, chunks: ["Hel", "lo"], next_index: 2 }]))
  expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "Hello", nextIndex: 2 }])
  relay.frame(b, snapshot(last))
  expect(relay.calls("r1")).toEqual([])
  expect(lines).toEqual([])
})

test("a fresh run shows no live calls before its worker starts", async () => {
  const r1 = await waitingRun("r1")
  const r2 = await waitingRun("r2")
  const { relay } = makeRelay()
  relay.frame(new StubWorker(r1), snapshot(lastSeq(r1.log), [{ node: REPLY, n: 1, chunks: ["One"], next_index: 1 }]))
  expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "One", nextIndex: 1 }])
  expect(relay.calls("r2")).toBeNull()
  relay.frame(new StubWorker(r2), snapshot(lastSeq(r2.log), [{ node: REPLY, n: 3, chunks: ["Two"], next_index: 1 }]))
  expect(relay.calls("r2")).toEqual([{ node: REPLY, n: 3, text: "Two", nextIndex: 1 }])
  expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "One", nextIndex: 1 }])
})

test("a worker reaches only its own run", async () => {
  const one = await recordedTurn("alpha beta gamma delta", "r1")
  const two = await recordedTurn("one two three four five", "r2")
  const { relay, lines } = makeRelay()
  const turns = [one, two].map((turn) => ({ ...turn, worker: new StubWorker(turn.job), view: null as LiveView | null }))
  // Yian's own fold of each run's frames alone is what its calls must be.
  const step = (turn: (typeof turns)[number], frame: Frame) => {
    relay.frame(turn.worker, frame)
    if (frame.type === "snapshot") {
      turn.view = LiveView.from(iterRunRecords(turn.job.log, { payloads: false }), frame.snapshot as LiveSnapshot)
    } else {
      expect(turn.view!.apply(frame as LiveFrame)).toBe(true)
    }
  }
  let both = false
  for (let i = 0; i < Math.max(one.frames.length, two.frames.length); i++) {
    for (const turn of turns) {
      const frame = turn.frames[i]
      if (frame !== undefined) step(turn, frame)
    }
    for (const turn of turns) expect(relay.calls(turn.job.run_id)).toEqual(turn.view!.calls())
    if (relay.calls("r1")!.length > 0 && relay.calls("r2")!.length > 0) both = true
  }
  expect(both).toBe(true)
  expect(relay.calls("r1")).toEqual([])
  expect(relay.calls("r2")).toEqual([])
  expect(lines).toEqual([])
})

test("a malformed frame is logged and ignored", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  // Before any view, a malformed frame still asks for a snapshot.
  relay.frame(worker, null)
  expect(lines).toEqual([gapLine("unknown")])
  expect(worker.follows).toBe(1)
  expect(relay.calls("r1")).toEqual([])
  const live = snapshot(last, [{ node: REPLY, n: 1, chunks: ["Hi"], next_index: 1 }])
  const bad: [unknown, string][] = [
    [null, "unknown"],
    [{}, "unknown"],
    [{ type: 3 }, "unknown"],
    [{ type: "chunk", node: REPLY, n: 1, index: 1, text: 5 }, "chunk"],
    [{ type: "record", seq: -1, line: "{}" }, "record"],
    [{ type: "start", node: REPLY, n: 2, purpose: "reply", model: 7 }, "start"],
    [{ type: "start", node: REPLY, n: 2, purpose: "reply", model: null }, "start"],
    [{ type: "end", node: REPLY, n: Number.MAX_SAFE_INTEGER + 1, error: null }, "end"],
    [snapshot(last, [{ node: REPLY, n: 1, chunks: [1 as unknown as string], next_index: 1 }]), "snapshot"],
  ]
  for (const [frame, type] of bad) {
    relay.frame(worker, live)
    expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "Hi", nextIndex: 1 }])
    lines.length = 0
    expect(() => relay.frame(worker, frame)).not.toThrow()
    expect(lines).toEqual([gapLine(type)])
    expect(relay.calls("r1")).toEqual([])
  }
  expect(worker.follows).toBe(1 + bad.length)
})
