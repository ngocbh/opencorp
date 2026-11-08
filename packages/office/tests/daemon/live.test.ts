/** The live relay: one LiveView per running worker, built from its snapshot and fed its frames; gaps followed again;
 *  bus events from the transcript's projection. */
import fs from "node:fs"
import path from "node:path"
import { iterRunRecords, type LiveFrame, type LiveSnapshot, LiveView, type RunLogEntry } from "@ngocbh/yian/run"
import { pending } from "@ngocbh/yian/tools"
import type { LiveEvent, Message, Part } from "@opencorp/protocol"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { Transcript } from "../../src/chat/transcript.ts"
import { MAIN_CHAT } from "../../src/chat/turns.ts"
import { PING } from "../../src/daemon/bus.ts"
import { type LiveJoin, LiveRelay, type LiveViewer, type LiveWorker, type ViewerFrame } from "../../src/daemon/live.ts"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import type { Job } from "../../src/worker/job.ts"
import { advance, fakeLlm, logPrefix, send, TemplateOffice, waitingAt, waitingChat } from "../chat/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { advanceJob, inProcessWorker, run, type TestWorker, waitsOf } from "../worker/helpers.ts"

setDefaultTimeout(30_000)

const REPLY = "chat#0/reply"

/** A finished template chat turn answering `content` (or the model's `replies`), run as `runId` (`r1` by default)
 *  under `runs` (a temp folder by default): its job and the live frames its advance's worker sent (the template office,
 *  a `Recorder`, keeps them as `streams`). */
async function recordedTurn(
  content: string | ScriptedReply[],
  runId = "r1",
  runs?: string,
): Promise<{ job: Job; frames: Frame[] }> {
  const fake = await fakeLlm()
  fake.script(...(typeof content === "string" ? [{ content }] : content))
  const job = await waitingChat(fake, "chat", {}, { runId, runs })
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
  readonly job: LiveWorker["job"]
  follows = 0

  constructor(job: LiveWorker["job"]) {
    this.job = job
  }

  follow(): Promise<boolean> {
    this.follows++
    return Promise.resolve(true)
  }
}

/** A relay over a transcript of the runs folder `runs` (with none, one that shows nothing), whose bus events and log
 *  lines are collected. */
function makeRelay(
  runs?: string,
  queueSize?: number,
): {
  relay: LiveRelay
  events: LiveEvent[]
  lines: string[]
  transcript: Pick<Transcript, "messages">
} {
  const events: LiveEvent[] = []
  const lines: string[] = []
  const transcript = runs === undefined ? { messages: () => [] } : new Transcript(runs)
  const relay = new LiveRelay({
    bus: { publishLive: (event) => void events.push(event) },
    transcript,
    log: (line) => void lines.push(line),
    queueSize,
  })
  return { relay, events, lines, transcript }
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
  // Its view will never be built again, so a client has nothing to wait for.
  expect(relay.join("r1")).toBeNull()
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
  const { viewer } = joinOf(relay)
  // Its step record drops the call, so the view has passed it.
  relay.frame(worker, { type: "record", seq: step.seq })
  expect(relay.calls("r1")).toEqual([])
  expect(await drainQueued(viewer)).toEqual([{ type: "record", seq: step.seq, line: logLines(job.log)[step.seq]! }])
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
  relay.frame(worker, snapshot(lastSeq(job.log)))
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
  // Before its snapshot the relay doesn't hold the worker, so a malformed frame is ignored.
  relay.frame(worker, null)
  expect(lines).toEqual([])
  expect(worker.follows).toBe(0)
  expect(relay.calls("r1")).toBeNull()
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
  expect(worker.follows).toBe(bad.length)
})

test("only a snapshot opens a workers view", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay, lines } = makeRelay()
  const a = new StubWorker(job)
  const b = new StubWorker(job)
  const end = { type: "end", node: REPLY, n: 1, error: null }
  relay.frame(a, end)
  expect(relay.join("r1")).toBeNull()
  relay.frame(a, snapshot(last, [{ node: REPLY, n: 1, chunks: ["Hi"], next_index: 1 }]))
  const viewer = joinOf(relay).viewer
  // A frame of a worker the relay doesn't hold leaves the held one as it was.
  relay.frame(b, end)
  relay.frame(b, { type: "chunk", node: REPLY, n: 1, index: 1, text: "!" })
  expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "Hi", nextIndex: 1 }])
  expect(viewer.queued).toBe(0)
  relay.detach(a)
  relay.frame(a, end)
  expect(relay.join("r1")).toBeNull()
  expect(relay.calls("r1")).toBeNull()
  expect(lines).toEqual([])
  expect(a.follows + b.follows).toBe(0)
})

test("a checked frame keeps only its own fields", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay } = makeRelay()
  const worker = new StubWorker(job)
  const call = { node: REPLY, n: 1, chunks: [], next_index: 0, extra: "x" }
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: last, calls: [call], extra: "x" }, extra: "x" })
  expect(relay.calls("r1")).toEqual([{ node: REPLY, n: 1, text: "", nextIndex: 0 }])
  const { viewer } = joinOf(relay)
  relay.frame(worker, { type: "chunk", node: REPLY, n: 1, index: 0, text: "Hi", extra: "x" })
  relay.frame(worker, { type: "end", node: REPLY, n: 1, error: null, extra: "x" })
  expect(await drainQueued(viewer)).toEqual([
    { type: "chunk", node: REPLY, n: 1, index: 0, text: "Hi" },
    { type: "end", node: REPLY, n: 1, error: null },
  ])
})

// Bus events: the transcript's projection of a worker's run, published as it changes.

/** The runs folder `job` logs under. */
function runsOf(job: Job): string {
  return path.dirname(path.dirname(job.log))
}

/** The id of the message the record at `seq` of `runId` opens. */
function messageId(seq: number, runId = "r1"): string {
  return `${runId}:${String(seq).padStart(12, "0")}`
}

/** The ids of the messages the replies of the run log `log` open, in log order: each reply's first `node_started`. */
function replyIds(log: string): string[] {
  const started = [...iterRunRecords(log, { kinds: ["node_started"] })]
  return started.filter((entry) => MAIN_CHAT.isReply(entry.nodeId)).map((entry) => messageId(entry.seq, entry.runId))
}

/** The assistant messages `transcript` shows of `job`'s run with no live calls. */
function fetched(transcript: Pick<Transcript, "messages">, job: Job): Message[] {
  return transcript.messages(job.session_id, [job.run_id]).filter((message) => message.role === "assistant")
}

/** Puts `part` into `message`, replacing the part of its id. */
function putPart(message: Message, part: Part): void {
  const at = message.parts.findIndex((p) => p.id === part.id)
  if (at === -1) message.parts.push(structuredClone(part))
  else message.parts[at] = structuredClone(part)
}

/** The messages a client builds from `events`, as its store does: messages inserted by id and merged by part id,
 *  parts put by id (under a placeholder message when the message is unknown), deltas appended to a known text part.
 *  A client that read the session as `fetched` before `events` starts from it and, as its store's `replay` does,
 *  skips a part's deltas until a full copy of the part came after the read. */
function fold(events: readonly LiveEvent[], fetched?: Message[]): Message[] {
  const list: Message[] = structuredClone(fetched ?? [])
  const whole = fetched === undefined ? null : new Set<string>()
  const find = (id: string) => list.find((message) => message.id === id)
  const insert = (message: Message) => {
    const at = list.findIndex((m) => m.id > message.id)
    list.splice(at === -1 ? list.length : at, 0, message)
  }
  for (const { type, session_id, data } of events) {
    if (type === "message.updated") {
      const { parts, ...rest } = data as unknown as Message
      for (const part of parts) whole?.add(part.id)
      const local = find(rest.id)
      if (local === undefined) insert(structuredClone({ ...rest, parts }))
      else {
        Object.assign(local, structuredClone(rest))
        for (const part of parts) putPart(local, part)
      }
    } else if (type === "part.updated") {
      const { message_id, part } = data as { message_id: string; part: Part }
      whole?.add(part.id)
      let local = find(message_id)
      if (local === undefined) {
        local = { id: message_id, session_id, role: "assistant", author: null, parts: [], created_at: "" }
        insert(local)
      }
      putPart(local, part)
    } else {
      const { message_id, part_id, text } = data as { message_id: string; part_id: string; text: string }
      if (whole !== null && !whole.has(part_id)) continue
      const part = find(message_id)?.parts.find((p) => p.id === part_id)
      if (part?.type === "text") part.text += text
    }
  }
  return list
}

/** `messages` without their empty text parts. */
function withoutEmptyText(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m, parts: m.parts.filter((part) => part.type !== "text" || part.text !== "") }))
}

/** The part `event` puts, if it is a `part.updated`. */
function partOf(event: LiveEvent): Part | undefined {
  return event.type === "part.updated" ? (event.data as { part: Part }).part : undefined
}

/** A template office that hands each live frame to `relay` as it arrives and detaches the worker at its exit. */
class LiveOffice extends TemplateOffice {
  readonly #relay: LiveRelay

  constructor(relay: LiveRelay) {
    super()
    this.#relay = relay
  }

  override stream(worker: TestWorker, frame: Frame): void {
    super.stream(worker, frame)
    this.#relay.frame(worker, frame.frame)
  }

  override exited(worker: TestWorker, returncode: number | null): void {
    super.exited(worker, returncode)
    this.#relay.detach(worker)
  }
}

test("a reply streams live under the transcripts ids", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello there friend" })
  const job = await waitingChat(fake)
  const { relay, events, lines, transcript } = makeRelay(runsOf(job))
  const office = new LiveOffice(relay)
  await run(advanceJob(job, { deliver: [send("s1", "hi")] }), office, { env: fake.env() })
  expect(waitingAt(office)).toEqual(["chat#1/heard"])
  const reply = [...iterRunRecords(job.log, { kinds: ["node_started"] })].find((entry) => entry.nodeId === REPLY)!
  const want = fetched(transcript, job)
  expect(want.map((m) => m.id)).toEqual([messageId(reply.seq)])
  expect(fold(events)).toEqual(want)
  expect(events.every((event) => event.session_id === job.session_id)).toBe(true)
  expect(lines).toEqual([])
})

test("a chunk of a shown live part is published as a delta", async () => {
  const content = "Hello there my good friend"
  const { job, frames } = await recordedTurn(content)
  const step = [...iterRunRecords(job.log)].find((entry) => entry.nodeId === REPLY && isModelCall(entry))!
  // The log as the worker had it while the call streamed: up to its step record.
  const crashed = tempDir()
  const log = logPrefix(job.log, (entry) => entry.seq < step.seq, crashed)
  const { relay, events, lines } = makeRelay(crashed)
  const worker = new StubWorker({ ...job, log })
  const at = frames.findIndex((frame) => frame.type === "record" && frame.seq === step.seq)
  for (const frame of frames.slice(0, at)) relay.frame(worker, frame)
  const start = frames.find((frame) => frame.type === "start")!
  const partId = `r1:${REPLY}:${start.n}`
  const opened = events.find((event) => event.type === "message.updated")!
  expect((opened.data as unknown as Message).parts).toEqual([{ id: partId, type: "text", text: "" }])
  const deltas = events.filter((event) => event.type === "part.delta").map((event) => event.data)
  expect(deltas.length).toBeGreaterThan(1)
  const messageOf = replyIds(job.log)[0]
  expect(deltas.every((data) => data.message_id === messageOf && data.part_id === partId)).toBe(true)
  expect(deltas.map((data) => data.text).join("")).toBe(content)
  expect(fold(events).flatMap((m) => m.parts)).toEqual([{ id: partId, type: "text", text: content }])
  expect(lines).toEqual([])
})

test("a part whose call ends is sent whole once", async () => {
  const content = "Hello there my good friend"
  const { job, frames } = await recordedTurn(content)
  // The log as the worker had it at each frame, cut step by step, so no render reads ahead of the frames.
  const cut = tempDir()
  const upTo = (seq: number) => logPrefix(job.log, (entry) => entry.seq <= seq, cut)
  const log = upTo((frames[0]!.snapshot as LiveSnapshot).last_seq)
  const { relay, events, lines, transcript } = makeRelay(cut)
  const worker = new StubWorker({ ...job, log })
  // A client's reads of the session between two chunks of the reply, each with the events published after it.
  const reads: { messages: Message[]; from: number }[] = []
  for (const frame of frames) {
    if (frame.type === "record") upTo(frame.seq as number)
    relay.frame(worker, frame)
    if (frame.type !== "chunk") continue
    const messages = transcript.messages(job.session_id, [job.run_id], relay).filter((m) => m.role === "assistant")
    reads.push({ messages, from: events.length })
  }
  expect(reads.length).toBeGreaterThan(1)
  const partId = `r1:${REPLY}:${frames.find((frame) => frame.type === "start")!.n}`
  const whole = events.map(partOf).filter((part) => part?.id === partId)
  expect(whole).toEqual([{ id: partId, type: "text", text: content }])
  const want = fetched(new Transcript(runsOf(job)), job)
  expect(want.flatMap((m) => m.parts)).toEqual([{ id: partId, type: "text", text: content }])
  for (const { messages, from } of reads) expect(fold(events.slice(from), messages)).toEqual(want)
  expect(lines).toEqual([])
})

test("a render or publish that fails is logged by its type", async () => {
  const failed = "run r1: live events were not published (TypeError)"
  const job = await waitingRun()
  const lines: string[] = []
  const throwing = () => {
    throw new TypeError("secret text")
  }
  const rendering = new LiveRelay({
    bus: { publishLive: () => {} },
    transcript: { messages: throwing },
    log: (line) => void lines.push(line),
  })
  expect(() => rendering.frame(new StubWorker(job), snapshot(lastSeq(job.log)))).not.toThrow()
  expect(lines).toEqual([failed])
  expect(rendering.calls("r1")).toEqual([])
  const { job: recorded, frames } = await recordedTurn("Hello there my good friend", "r1")
  lines.length = 0
  const publishing = new LiveRelay({
    bus: { publishLive: throwing },
    transcript: new Transcript(runsOf(recorded)),
    log: (line) => void lines.push(line),
  })
  const worker = new StubWorker(recorded)
  for (const frame of frames) expect(() => publishing.frame(worker, frame)).not.toThrow()
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.every((line) => line === failed)).toBe(true)
  // The view still applied every frame.
  expect(publishing.calls("r1")).toEqual([])
  expect(worker.follows).toBe(0)
})

test("a lagging relay never doubles a reply", async () => {
  const { job, frames } = await recordedTurn("Hello there my good friend")
  const { relay, events, lines, transcript } = makeRelay(runsOf(job))
  const worker = new StubWorker(job)
  // Every render reads the finished log, ahead of the frames.
  for (const frame of frames) relay.frame(worker, frame)
  expect(events.filter((event) => event.type === "part.delta")).toEqual([])
  expect(fold(events)).toEqual(fetched(transcript, job))
  expect(lines).toEqual([])
})

test("a reply that started but sent no chunk already shows", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello there", hold: true })
  const job = await waitingChat(fake)
  const { relay, events } = makeRelay(runsOf(job))
  const office = new LiveOffice(relay)
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s1", "hi")] }), office, { env: fake.env() })
  const start = await waitFor(() => office.streams.find((frame) => frame.type === "start"), { what: "the start" })
  const empty: Part = { id: `r1:${REPLY}:${start.n}`, type: "text", text: "" }
  await waitFor(() => events.some((event) => event.type === "message.updated"), { what: "the reply's message" })
  const opened = events.find((event) => event.type === "message.updated")!
  expect((opened.data as unknown as Message).parts).toEqual([empty])
  // A hold that starts after a release would never end.
  await fake.waitForRequests(1, 30_000)
  fake.release()
  expect(await worker.wait()).not.toBeNull()
})

test("an answer applied before the workers first frame is published", async () => {
  const fake = await fakeLlm()
  fake.script(
    { content: "", tool_calls: [{ id: "q1", name: "ask_user", arguments: { question: "Which?" } }] },
    { content: "Rome." },
  )
  const job = await waitingChat(fake)
  const { relay, events, lines, transcript } = makeRelay(runsOf(job))
  class Asking extends LiveOffice {
    override askUser(): unknown {
      return pending()
    }
  }
  const asking = new Asking(relay)
  await run(advanceJob(job, { deliver: [send("s1", "pick one")] }), asking, { env: fake.env() })
  expect(waitingAt(asking)).toEqual([REPLY])
  // The call's live part, empty when its step showed only the tool call, left the render with nothing to empty.
  expect(withoutEmptyText(fold(events)).flatMap((m) => m.parts)).toMatchObject([
    { type: "tool", call_id: "q1", state: "running" },
  ])
  const later = events.length
  const answer = { id: "a1", op: "complete" as const, call_id: String(waitsOf(asking)[0]!.call_id) }
  const office = new LiveOffice(relay)
  await run(advanceJob(job, { deliver: [{ ...answer, result: { output: "Rome" } }] }), office, { env: fake.env() })
  const second = events.slice(later)
  const completed = second.findIndex((event) => {
    const part = partOf(event)
    return part?.type === "tool" && part.call_id === "q1" && part.state === "completed"
  })
  expect(completed).toBeGreaterThanOrEqual(0)
  const delta = second.findIndex((event) => event.type === "part.delta")
  expect(delta === -1 || completed < delta).toBe(true)
  const want = fetched(transcript, job)
  const shown = want.flatMap((m) => m.parts).map((part) => (part.type === "tool" ? part.state : part.type))
  expect(shown).toEqual(["completed", "text"])
  expect(want.flatMap((m) => m.parts).find((part) => part.type === "text")).toMatchObject({ text: "Rome." })
  expect(withoutEmptyText(fold(events))).toEqual(want)
  expect(lines).toEqual([])
})

test("a failed attempt leaves no text behind", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Half an", cut: true, hold: true }, { content: "Whole answer." })
  const job = await waitingChat(fake)
  const { relay, events, lines, transcript } = makeRelay(runsOf(job))
  const office = new LiveOffice(relay)
  // The cut attempt is held until the relay has shown its part: the worker runs ahead of the relay's frames, and a
  // render that already reads the failed step never shows the part this test needs emptied.
  const advanced = run(advanceJob(job, { deliver: [send("s1", "hi")] }), office, { env: fake.env() })
  await waitFor(() => events.some((event) => event.type === "message.updated"), { what: "the reply's message" })
  // A hold that starts after a release would never end.
  await fake.waitForRequests(1, 30_000)
  fake.release()
  await advanced
  expect(waitingAt(office)).toEqual(["chat#1/heard"])
  const starts = office.streams.filter((frame) => frame.type === "start" && frame.node === REPLY)
  expect(starts.map((frame) => frame.n)).toEqual([starts[0]!.n, (starts[0]!.n as number) + 1])
  const failed = `r1:${REPLY}:${starts[0]!.n}`
  const emptied = events.map(partOf).some((part) => part?.id === failed && part.type === "text" && part.text === "")
  expect(emptied).toBe(true)
  const folded = fold(events)
  const retried = `r1:${REPLY}:${starts[1]!.n}`
  expect(folded.flatMap((m) => m.parts).find((part) => part.id === retried)).toEqual({
    id: retried,
    type: "text",
    text: "Whole answer.",
  })
  expect(withoutEmptyText(folded)).toEqual(fetched(transcript, job))
  expect(lines).toEqual([])
})

// The call after a steer goes live under its own step's n (ngocbh/yian#1171), so the record that ends it ends its
// live part too, and its text shows once while the worker runs.
test("a steered reply shows its text once while its worker runs", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Working", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Rome." })
  const job = await waitingChat(fake)
  const { relay, events, lines, transcript } = makeRelay(runsOf(job))
  const steer = send("during", "Also mention Rome.")
  // What a client saw just before the worker exited: the session read with live calls merged, and the live events.
  let beforeExit: { read: Message[]; live: Message[] } | null = null
  class Steering extends LiveOffice {
    override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
      await worker.deliver(steer)
      await waitFor(() => this.replies.some((reply) => reply.id === steer.id), { timeout: 10_000, what: "the steer" })
      return await super.toolCall(worker, group, name, args)
    }

    override exited(worker: TestWorker, returncode: number | null): void {
      const read = transcript.messages(job.session_id, [job.run_id], relay).filter((m) => m.role === "assistant")
      beforeExit = { read, live: fold(events) }
      super.exited(worker, returncode)
    }
  }
  await run(advanceJob(job, { deliver: [send("s1", "Plan the trip.")] }), new Steering(relay), { env: fake.env() })
  const { read, live } = await waitFor(() => beforeExit, { what: "the worker's exit" })
  const want = fetched(transcript, job)
  const texts = (messages: Message[]) =>
    messages.flatMap((m) => m.parts.flatMap((part) => (part.type === "text" && part.text !== "" ? [part.text] : [])))
  expect(texts(want)).toEqual(["Working", "Rome."])
  for (const shown of [read, live]) expect(withoutEmptyText(shown)).toEqual(want)
  expect(withoutEmptyText(fold(events))).toEqual(want)
  expect(lines).toEqual([])
})

test("detach shows a cut tool call interrupted", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Done." })
  const job = await waitingChat(fake)
  await advance(job, fake, [send("s1", "go")])
  const step = [...iterRunRecords(job.log)].find((entry) => entry.nodeId === REPLY && isModelCall(entry))!
  const crashed = tempDir()
  const log = logPrefix(job.log, (entry) => entry.seq <= step.seq, crashed)
  const { relay, events, lines } = makeRelay(crashed)
  const worker = new StubWorker({ ...job, log })
  relay.frame(worker, snapshot(step.seq))
  expect(fold(events).flatMap((m) => m.parts)).toMatchObject([{ type: "tool", call_id: "c1", state: "running" }])
  const later = events.length
  relay.detach(worker)
  expect(events.slice(later).map(partOf)).toMatchObject([{ type: "tool", call_id: "c1", state: "interrupted" }])
  expect(relay.calls("r1")).toBeNull()
  expect(lines).toEqual([])
})

test("a worker reaches only its own session", async () => {
  const runs = tempDir()
  const one = await recordedTurn("alpha beta gamma delta", "r1", runs)
  const two = await recordedTurn("one two three four five", "r2", runs)
  const { relay, events, lines } = makeRelay(runs)
  const turns = [
    { frames: one.frames, worker: new StubWorker({ ...one.job, session_id: "s1" }), events: [] as LiveEvent[] },
    { frames: two.frames, worker: new StubWorker({ ...two.job, session_id: "s2" }), events: [] as LiveEvent[] },
  ]
  for (let i = 0; i < Math.max(one.frames.length, two.frames.length); i++) {
    for (const turn of turns) {
      const frame = turn.frames[i]
      if (frame === undefined) continue
      const before = events.length
      relay.frame(turn.worker, frame)
      turn.events.push(...events.slice(before))
    }
  }
  for (const turn of turns) {
    const session = turn.worker.job.session_id
    expect(turn.events.length).toBeGreaterThan(0)
    expect(turn.events.every((event) => event.session_id === session)).toBe(true)
    const messages = turn.events.filter((event) => event.type === "message.updated").map((event) => event.data)
    expect(messages.every((message) => message.session_id === session)).toBe(true)
  }
  expect(lines).toEqual([])
})

test("the first contact shows a run from its floor and later renders only its changes", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "One." }, { content: "Two." }, { content: "Three.", hold: true })
  const job = await waitingChat(fake)
  await advance(job, fake, [send("s1", "first")])
  await advance(job, fake, [send("s2", "second")])
  const { relay, events, lines } = makeRelay(runsOf(job))
  const office = new LiveOffice(relay)
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s3", "third")] }), office, {
    env: fake.env(),
  })
  // Held, the third reply's step can't be in the log before its live part shows.
  const third = (event: LiveEvent) =>
    event.type === "message.updated" &&
    (event.data as unknown as Message).parts.some((part) => part.id.startsWith("r1:chat#2/reply:"))
  await waitFor(() => events.some(third), { what: "the third reply" })
  await fake.waitForRequests(3, 30_000)
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  const replies = replyIds(job.log)
  expect(replies).toHaveLength(3)
  const opened = events.filter((event) => event.type === "message.updated").map((event) => event.data.id)
  expect(opened).toEqual([replies[1], replies[2]])
  expect(events.some((event) => JSON.stringify(event.data).includes(`"${replies[0]}"`))).toBe(false)
  events.length = 0
  const again = new StubWorker(job)
  relay.frame(again, snapshot(lastSeq(job.log)))
  relay.detach(again)
  expect(events).toEqual([])
  expect(lines).toEqual([])
})

test("a forgotten run is shown from its floor again", async () => {
  const { job, frames } = await recordedTurn("Hello there my good friend")
  const { relay, events } = makeRelay(runsOf(job))
  const worker = new StubWorker(job)
  for (const frame of frames) relay.frame(worker, frame)
  relay.detach(worker)
  relay.forget(["r1"])
  events.length = 0
  relay.frame(new StubWorker(job), snapshot(lastSeq(job.log)))
  expect(events.map((event) => [event.type, event.data.id])).toEqual([["message.updated", replyIds(job.log)[0]]])
})

// Viewers: a run's frames as its view applied them, for a client following the run.

/** `relay`'s join of `runId`, whose viewer closes when the test finishes; fails on `"rebuilding"` or null. */
function joinOf(relay: LiveRelay, runId = "r1"): LiveJoin {
  const joined = relay.join(runId)
  if (joined === null || joined === "rebuilding") throw new Error(`no join of ${runId}: ${joined}`)
  onTestFinished(() => joined.viewer.close())
  return joined
}

/** Every item `viewer` holds until it ends; fails on a `PING`. */
async function drain(viewer: LiveViewer): Promise<ViewerFrame[]> {
  const items: ViewerFrame[] = []
  for (;;) {
    const item = await viewer.next(1000)
    if (item === null) return items
    if (item === PING) throw new Error("the viewer went idle before it ended")
    items.push(item)
  }
}

/** The items `viewer` holds now, without waiting for more. */
async function drainQueued(viewer: LiveViewer): Promise<(ViewerFrame | typeof PING | null)[]> {
  const items: (ViewerFrame | typeof PING | null)[] = []
  while (viewer.queued > 0) items.push(await viewer.next(1000))
  return items
}

/** The lines of the run log `log` by seq, without their newlines. */
function logLines(log: string): string[] {
  const bytes = fs.readFileSync(log)
  return [...iterRunRecords(log, { payloads: false })].map((entry) =>
    bytes.subarray(entry.offset, entry.end - 1).toString("utf8"),
  )
}

/** The key of a call's step: `node:n`. */
function callKey(call: { node?: unknown; n?: unknown }): string {
  return `${call.node}:${call.n}`
}

test("joining mid run gives no gap and no duplicate", async () => {
  const { job, frames } = await recordedTurn([
    { content: "Let me check that", tool_calls: [{ id: "c1", name: "toolbox_stub" }] },
    { content: "All done now friend" },
  ])
  const lines = logLines(job.log)
  const full = new Map<string, string>()
  for (const frame of frames) {
    if (frame.type === "chunk") full.set(callKey(frame), (full.get(callKey(frame)) ?? "") + frame.text)
  }
  expect([...full.values()]).toEqual(["Let me check that", "All done now friend"])
  expect(frames.filter((frame) => frame.type === "chunk").length).toBeGreaterThan(4)
  let midCall = false
  for (let j = 0; j <= frames.length; j++) {
    const { relay, lines: logged } = makeRelay()
    const worker = new StubWorker(job)
    for (const frame of frames.slice(0, j)) relay.frame(worker, frame)
    if (j === 0) {
      expect(relay.join("r1")).toBeNull()
      continue
    }
    const joined = joinOf(relay)
    for (const frame of frames.slice(j)) relay.frame(worker, frame)
    relay.detach(worker)
    const items = await drain(joined.viewer)
    const seqs = [...iterRunRecords(job.log, { payloads: false })]
      .filter((entry) => entry.seq <= joined.lastSeq)
      .map((entry) => entry.seq)
    const texts = new Map(joined.calls.map((call) => [callKey(call), call.text]))
    if (joined.calls.some((call) => call.text !== "")) midCall = true
    for (const item of items) {
      if (item.type === "record") {
        seqs.push(item.seq)
        expect(item.line).toBe(lines[item.seq]!)
      } else if (item.type === "chunk") {
        texts.set(callKey(item), (texts.get(callKey(item)) ?? "") + item.text)
      }
    }
    expect(seqs).toEqual(lines.map((_, seq) => seq))
    for (const [key, text] of texts) expect(text).toBe(full.get(key)!)
    expect(items.at(-1)).toEqual({ type: "run_end" })
    expect(logged).toEqual([])
  }
  expect(midCall).toBe(true)
})

test("a lagging viewers chunks of one call merge into one", async () => {
  const job = await waitingRun()
  const lines = logLines(job.log)
  const from = lines.length - 5
  expect(from).toBeGreaterThanOrEqual(0)
  const chunk = (node: string, index: number, text: string) => ({ type: "chunk" as const, node, n: 1, index, text })
  const record = (seq: number) => ({ type: "record" as const, seq, line: lines[seq]! })
  /** A relay whose view is at record `from` with calls `a` and `b` in flight, its worker and a viewer of the run. */
  const viewed = (queueSize?: number) => {
    const { relay } = makeRelay(undefined, queueSize)
    const worker = new StubWorker(job)
    const calls = ["a", "b"].map((node) => ({ node, n: 1, chunks: [], next_index: 0 }))
    relay.frame(worker, snapshot(from, calls))
    return { relay, worker, viewer: joinOf(relay).viewer }
  }

  const one = viewed()
  const words = Array.from({ length: 50 }, (_, i) => `w${i} `)
  words.forEach((text, i) => one.relay.frame(one.worker, chunk("a", i, text)))
  expect(one.viewer.queued).toBe(1)
  expect(await one.viewer.next(1000)).toEqual(chunk("a", 49, words.join("")))

  const two = viewed()
  for (const [node, index] of [["a", 0], ["b", 0], ["a", 1], ["b", 1]] as const) {
    two.relay.frame(two.worker, chunk(node, index, `${node}${index}`))
  }
  expect(two.viewer.queued).toBe(2)
  expect(await drainQueued(two.viewer)).toEqual([chunk("a", 1, "a0a1"), chunk("b", 1, "b0b1")])

  const apart = viewed()
  apart.relay.frame(apart.worker, chunk("a", 0, "one"))
  apart.relay.frame(apart.worker, record(from + 1))
  apart.relay.frame(apart.worker, chunk("a", 1, "two"))
  expect(await drainQueued(apart.viewer)).toEqual([chunk("a", 0, "one"), record(from + 1), chunk("a", 1, "two")])

  const capped = viewed(3)
  for (let i = 0; i < 100; i++) capped.relay.frame(capped.worker, chunk("a", i, "x"))
  expect(capped.viewer.dropped).toBe(false)
  expect(capped.viewer.queued).toBe(1)
  expect(await capped.viewer.next(1000)).toEqual(chunk("a", 99, "x".repeat(100)))
  for (let seq = from + 1; seq <= from + 3; seq++) capped.relay.frame(capped.worker, record(seq))
  expect(capped.viewer.dropped).toBe(false)
  expect(capped.viewer.queued).toBe(3)
  capped.relay.frame(capped.worker, record(from + 4))
  expect(capped.viewer.dropped).toBe(true)
  expect(capped.viewer.queued).toBe(1) // only its end: the backlog is gone
  expect(await capped.viewer.next(1000)).toBeNull()
})

test("a merge leaves frames other viewers hold as they were", async () => {
  const job = await waitingRun()
  const { relay } = makeRelay()
  const worker = new StubWorker(job)
  relay.frame(worker, snapshot(lastSeq(job.log), [{ node: "a", n: 1, chunks: [], next_index: 0 }]))
  const a = joinOf(relay).viewer
  const b = joinOf(relay).viewer
  const chunk = (index: number, text: string) => ({ type: "chunk" as const, node: "a", n: 1, index, text })
  relay.frame(worker, chunk(0, "a0"))
  const taken = await a.next(1000)
  relay.frame(worker, chunk(1, "a1"))
  expect(taken).toEqual(chunk(0, "a0"))
  expect(await drainQueued(b)).toEqual([chunk(1, "a0a1")])
  expect(await drainQueued(a)).toEqual([chunk(1, "a1")])
})

test("a gap drops the runs viewers", async () => {
  const { job, frames } = await recordedTurn("Hello there my good friend")
  const { relay, lines } = makeRelay()
  const worker = new StubWorker(job)
  relay.frame(worker, frames[0])
  const { viewer } = joinOf(relay)
  relay.frame(worker, frames[1])
  expect(viewer.queued).toBe(1)
  const { last_seq: last } = frames[0]!.snapshot as LiveSnapshot
  relay.frame(worker, { type: "record", seq: last + 100, line: "" })
  expect(lines).toEqual([gapLine("record")])
  expect(viewer.dropped).toBe(true)
  expect(viewer.queued).toBe(1) // only its end: the backlog is gone
  expect(await viewer.next(1000)).toBeNull()
  // Frames after the next snapshot reach a new viewer only.
  relay.frame(worker, frames[0])
  const again = joinOf(relay)
  relay.frame(worker, frames[1])
  expect(again.viewer.queued).toBe(1)
  expect(await viewer.next(1000)).toBeNull()
})

test("a viewer gets run end when its worker exits", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay } = makeRelay()
  const a = new StubWorker(job)
  const b = new StubWorker(job)
  relay.frame(a, snapshot(last))
  const first = joinOf(relay).viewer
  // A frame of a new worker for the run replaces the old one.
  relay.frame(b, snapshot(last))
  expect(await drain(first)).toEqual([{ type: "run_end" }])
  expect(first.dropped).toBe(false)
  const second = joinOf(relay).viewer
  relay.detach(a)
  expect(await second.next(10)).toBe(PING)
  relay.detach(b)
  expect(await drain(second)).toEqual([{ type: "run_end" }])
  expect(second.dropped).toBe(false)
  expect(relay.join("r1")).toBeNull()
})

test("join while the view is rebuilt says so", async () => {
  const job = await waitingRun()
  const last = lastSeq(job.log)
  const { relay } = makeRelay()
  const worker = new StubWorker(job)
  expect(relay.join("r1")).toBeNull()
  relay.frame(worker, snapshot(last))
  expect(joinOf(relay)).toMatchObject({ lastSeq: last, calls: [] })
  relay.frame(worker, { type: "record", seq: last + 5, line: "" })
  expect(relay.join("r1")).toBe("rebuilding")
  relay.frame(worker, snapshot(last, [{ node: REPLY, n: 2, chunks: ["Hel", "lo"], next_index: 2 }]))
  expect(joinOf(relay)).toMatchObject({ lastSeq: last, calls: [{ node: REPLY, n: 2, text: "Hello", nextIndex: 2 }] })
})

test("close ends every viewer", async () => {
  const r1 = await waitingRun("r1")
  const r2 = await waitingRun("r2")
  const { relay } = makeRelay()
  const w2 = new StubWorker(r2)
  relay.frame(new StubWorker(r1), snapshot(lastSeq(r1.log)))
  relay.frame(w2, snapshot(lastSeq(r2.log)))
  const one = joinOf(relay, "r1").viewer
  const two = joinOf(relay, "r2").viewer
  const closed = joinOf(relay, "r1").viewer
  const woken = closed.next(5000)
  closed.close()
  expect(await woken).toBeNull()
  // A run's frames reach only that run's viewers.
  relay.frame(w2, { type: "start", node: REPLY, n: 2, model: null, purpose: "reply", started_at: "2026-01-01T00:00:00Z" })
  expect(one.queued).toBe(0)
  expect(two.queued).toBe(1)
  const waiting = one.next(5000)
  relay.close()
  expect(await waiting).toBeNull()
  expect(await drain(two)).toHaveLength(1)
  expect(await closed.next(1000)).toBeNull()
  expect([one.dropped, two.dropped]).toEqual([false, false])
})
