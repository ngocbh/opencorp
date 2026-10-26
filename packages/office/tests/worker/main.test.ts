/** The worker's frame loop: the start frame, closing frames, deliveries after the last frame, the linger, and how a run
 *  ends: waiting, stopped, orphaned or refused. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import {
  inspectRun,
  iterRunRecords,
  type LiveFrame,
  type LiveSnapshot,
  LiveView,
  type RunLogEntry,
} from "@ngocbh/yian/run"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import type { Frame } from "../../src/worker/channel.ts"
import { groupSpecs, type JobInput, STOP_REASON } from "../../src/worker/job.ts"
import { EXIT_FAILED, EXIT_OK, EXIT_ORPHANED, isOfficeChannel, report, serve } from "../../src/worker/main.ts"
import type { AskRequest, OfficeTool } from "../../src/worker/rpc.ts"
import { fakeLlm, logPrefix, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { shortDir, tempDir, waitFor } from "../helpers.ts"
import {
  advanceJob,
  base,
  channelPair,
  inProcessWorker,
  lastFrame,
  makeJob,
  Recorder,
  run,
  spawnWorker,
  startWorker,
  type TestWorker,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const STOPPED = `Error: ${STOP_REASON}`

const shout: OfficeTool = {
  description: "Return text in capitals.",
  parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  call: ({ text }) => String(text).toUpperCase(),
}

/** A recorder whose questions are never answered. */
class Unanswered extends Recorder {
  override askUser(_worker: TestWorker, request: AskRequest): unknown {
    this.asked.push(request)
    return new Promise(() => {})
  }
}

/** Each line of the run log `log` without its newline, by seq. */
function logLines(log: string): string[] {
  const bytes = fs.readFileSync(log)
  const lines: string[] = []
  for (const entry of iterRunRecords(log, { payloads: false })) {
    lines[entry.seq] = bytes.subarray(entry.offset, entry.end - 1).toString("utf8")
  }
  return lines
}

/** Whether the run-log entry `entry` is a model call's step. */
function isModelCall(entry: RunLogEntry): boolean {
  return (
    entry.kind === "node_step" &&
    (entry.envelope.record as unknown as { step: { kind: string } }).step.kind === "model_call"
  )
}

/** The snapshot of the follow frame `frame`; fails unless it is one. */
function snapshotOf(frame: Frame | undefined): LiveSnapshot {
  expect(frame?.type).toBe("snapshot")
  return frame!.snapshot as LiveSnapshot
}

/** Checks the live frames `streams` a worker sent against its run's log `log` and returns their first snapshot: a
 *  snapshot comes first; the record frames run from its `last_seq + 1` to the log's last seq, each with the log's
 *  line at its seq, but those of `bare` seqs, which have no line; a view from the log and the snapshot applies every
 *  later frame and ends with no calls. */
function checkLive(streams: Frame[], log: string, { bare = [] }: { bare?: number[] } = {}): LiveSnapshot {
  const snapshot = snapshotOf(streams[0])
  const lines = logLines(log)
  const records = streams.filter((frame) => frame.type === "record")
  expect(records[0]?.seq).toBe(snapshot.last_seq + 1)
  expect(records.map((frame) => frame.seq)).toEqual(
    Array.from({ length: lines.length - snapshot.last_seq - 1 }, (_, i) => snapshot.last_seq + 1 + i),
  )
  for (const frame of records) {
    const seq = frame.seq as number
    if (bare.includes(seq)) expect(frame).toEqual({ type: "record", seq })
    else expect(frame.line).toBe(lines[seq]!)
  }
  replay(log, snapshot, streams.slice(1), lines)
  return snapshot
}

/** Builds a view from the log `log` and `snapshot`, and checks it applies each of `frames` (a record without its line
 *  given the log's, from `lines`) and ends with no calls. */
function replay(log: string, snapshot: LiveSnapshot, frames: Frame[], lines = logLines(log)): void {
  const view = LiveView.from(iterRunRecords(log, { payloads: false }), snapshot)
  for (const frame of frames) {
    const bare = frame.type === "record" && frame.line === undefined
    const whole = bare ? { ...frame, line: lines[frame.seq as number] } : frame
    expect(view.apply(whole as LiveFrame)).toBe(true)
  }
  expect(view.calls()).toEqual([])
}

/** A start frame whose job lacks `run_id`, as with an office and worker of different versions. */
function badStart(): Frame {
  const job: Record<string, unknown> = { ...makeJob(base()) }
  delete job.run_id
  return { type: "start", job }
}

test("a bad start frame is an error that never shows the env", async () => {
  const job: Record<string, unknown> = {
    ...makeJob(base(), "flows/echo.yaml", { llm_config: { ...LLM_CONFIG, api_key: "sk-SECRET" } }),
    env: { OPENAI_API_KEY: "sk-SECRET" },
  }
  delete job.run_id
  const { office } = await startWorker()
  await office.send({ type: "start", job })
  const frame = await office.recv()
  expect(frame.type).toBe("error")
  const message = String(frame.message)
  const traceback = String(frame.traceback)
  expect(message).toContain("run_id")
  expect(message).not.toContain("sk-SECRET")
  expect(traceback).not.toContain("sk-SECRET")
  for (const line of traceback.split("\n")) expect(line).toMatch(/^\s+at /)
})

test("after its last frame a worker answers deliveries until the office closes", async () => {
  const { office, out } = await startWorker()
  await office.send(badStart())
  expect((await office.recv()).type).toBe("error")
  await office.send({ type: "deliver", id: "d1", op: "send", inbox: "steers", event: "too late" })
  expect(await office.recv()).toEqual({ type: "deliver_reply", id: "d1", refused: "not_started" })
  expect(out.code).toBeUndefined()
  office.closeSend()
  await waitFor(() => out.code !== undefined, { timeout: 5000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_FAILED)
})

test("a worker returns only once its last reply is written", async () => {
  const { office, worker } = await channelPair()
  // The reply's write is held, as a slow socket would hold it: the worker exits once `serve` returns, and a write
  // still in flight then is lost.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const send = worker.send.bind(worker)
  worker.send = async (frame) => {
    if (frame.type === "deliver_reply") await held
    return send(frame)
  }
  const out: { code?: number } = {}
  const done = serve(worker, { env: {}, exit: () => {} }).then((code) => {
    out.code = code
  })
  await office.send(badStart())
  expect((await office.recv()).type).toBe("error")
  await office.send({ type: "deliver", id: "d1", op: "send", inbox: "steers", event: "too late" })
  office.closeSend()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(out.code).toBeUndefined()
  release()
  expect(await office.recv()).toEqual({ type: "deliver_reply", id: "d1", refused: "not_started" })
  await done
  expect(out.code).toBe(EXIT_FAILED)
})

test("a worker stops waiting for the office after a while", async () => {
  const { office, out } = await startWorker({ linger: 200 })
  await office.send(badStart())
  expect((await office.recv()).type).toBe("error")
  await waitFor(() => out.code !== undefined, { timeout: 2000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_FAILED)
})

test("a result too large to send becomes an error", async () => {
  const { office, worker } = await channelPair({ maxFrame: 2000 })
  const reply = { type: "deliver_reply", id: "d1", seq: 4 }
  const code = await report(worker, [reply, { type: "result", output: "x".repeat(5000) }], EXIT_OK)
  expect(code).toBe(EXIT_FAILED)
  expect(await office.recv()).toEqual(reply)
  const error = await office.recv()
  expect(error.type).toBe("error")
  expect(String(error.message).startsWith("FrameTooLarge")).toBe(true)
})

test("a worker exits 3 when the office closes before the start frame", async () => {
  const { office, out } = await startWorker()
  office.close()
  await waitFor(() => out.code !== undefined, { timeout: 5000, what: "the worker to return" })
  expect(out.code).toBe(EXIT_ORPHANED)
  expect(out.exit).toBeUndefined()
})

test("a frame other than start is an error", async () => {
  const { office } = await startWorker()
  await office.send({ type: "deliver", id: "d1", op: "send", inbox: "steers", event: "y" })
  const frame = await office.recv()
  expect(frame.type).toBe("error")
  expect(frame.message).toBe("TypeError: expected a start frame")
})

test("a waiting run ends normally with its status", async () => {
  const fake = await fakeLlm()
  const where = base()
  const rec = await run(makeJob(where, "flows/nap.yaml", { inputs: {} }), new Recorder(), { env: fake.env() })
  expect(rec.order).toEqual(["result"])
  expect(rec.outcome?.status).toBe("waiting")
  expect(rec.outcome?.waits).toEqual([
    {
      node: "nap",
      call_id: expect.any(String),
      tool: "sleep",
      inbox: null,
      deadline: expect.any(String),
      settled: false,
    },
  ])
  expect(rec.returncode).toBe(EXIT_OK)
  expect(fake.requests()).toEqual([])
})

test("a chat jobs parent is in its run started record", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi." })
  const job = makeJob(base(), "flows/echo.yaml", { parent: { run_id: "run-card", node: "ask" } })
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  const [first] = iterRunRecords(job.log, { payloads: true })
  expect(first!.kind).toBe("run_started")
  expect((first!.envelope.record as unknown as { parent: unknown }).parent).toEqual({ runId: "run-card", node: "ask" })
})

test("a stop frame stops the run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hi", hold: true })
  const job = makeJob(base())
  const rec = new Recorder()
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  await fake.waitForRequests(1)
  expect(await worker.stop()).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message)).toContain(STOPPED)
  expect(inspectRun(job.log).status).toBe("stopped")
  fake.release()
})

test("a stop frame stops a run waiting on a question", async () => {
  const fake = await fakeLlm()
  const job = makeJob(base(), "flows/chat.yaml", { inputs: {} })
  const rec = new Unanswered()
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  await waitFor(() => rec.asked.length === 1, { timeout: 10_000, what: "the question" })
  expect(await worker.stop()).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message)).toContain(STOPPED)
  expect(inspectRun(job.log).status).toBe("stopped")
})

test("a stop frame stops a run waiting on an office tool", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "shout", arguments: { text: "hi" } }] })
  let called = false
  const hanging: OfficeTool = {
    ...shout,
    call: () => {
      called = true
      return new Promise(() => {})
    },
  }
  const rec = new Recorder({ tools: { toolbox: { shout: hanging } } })
  const job = makeJob(base(), "flows/tools.yaml", { groups: groupSpecs(rec.tools) })
  const worker = await inProcessWorker(job, rec, { env: fake.env() })
  await waitFor(() => called, { timeout: 10_000, what: "the tool call" })
  expect(await worker.stop()).toBe(true)
  expect(await worker.wait()).toBe(EXIT_FAILED)
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message)).toContain(STOPPED)
  expect(inspectRun(job.log).status).toBe("stopped")
})

test("a reused run id is refused", async () => {
  const fake = await fakeLlm()
  const where = base()
  fs.mkdirSync(path.join(where.runs, "r1"), { recursive: true })
  const rec = await run(makeJob(where), new Recorder(), { env: fake.env() })
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message)).toContain("EEXIST")
  expect(rec.returncode).toBe(EXIT_FAILED)
  expect(fake.requests()).toEqual([])
})

test("a worker exits 3 when the office closes during the run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hi", hold: true })
  const worker = await inProcessWorker(makeJob(base()), new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1)
  worker.closeChannel()
  expect(await worker.wait()).toBe(EXIT_ORPHANED)
  fake.release()
})

test("a delivery to a missing log is refused as not started", async () => {
  const job = makeJob(base(), "flows/inbox.yaml", {
    kind: "advance",
    deliver: [{ id: "s1", op: "send", inbox: "messages", event: "hi" }],
  })
  const rec = await run(job, new Recorder())
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "s1", refused: "not_started" }])
  expect(rec.order).toEqual(["deliver_reply", "error"])
  expect(String(rec.outcome?.message)).toContain("ENOENT")
  expect(rec.returncode).toBe(EXIT_FAILED)
  expect(fs.existsSync(job.log)).toBe(false)
})

test("a reserved tool name is refused before any model call", async () => {
  // The two reserved-name messages differ in wording: yian checks a group's tool names and a group's key in
  // different places.
  const cases: [string, Partial<JobInput>, string][] = [
    [
      "flows/tools.yaml",
      { groups: groupSpecs({ toolbox: { take: shout } }) },
      "RangeError: group 'toolbox' has a tool named 'take', a reserved name",
    ],
    [
      "flows/echo.yaml",
      { groups: groupSpecs({ sleep: { shout } }) },
      'RangeError: tools["sleep"]: the name is reserved by yian',
    ],
  ]
  for (const [flow, over, start] of cases) {
    const fake = await fakeLlm()
    const rec = await run(makeJob(base(), flow, over), new Recorder(), { env: fake.env() })
    expect(rec.outcome?.type).toBe("error")
    expect(String(rec.outcome?.message)).toStartWith(start)
    expect(rec.returncode).toBe(EXIT_FAILED)
    expect(fake.requests()).toEqual([])
  }
})

test("a worker process runs a job and exits 0", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello from the worker." })
  const { office, exited } = spawnWorker({ cwd: tempDir(), env: fake.env() })
  await office!.send({ type: "start", job: makeJob(base()) })
  const frame = await lastFrame(office!)
  expect(frame.type, String(frame.message)).toBe("result")
  expect(frame.status).toBe("succeeded")
  expect(frame.output).toBe("Hello from the worker.")
  office!.closeSend()
  expect(await exited).toEqual({ code: EXIT_OK, signal: null })
})

test("a worker process exits 3 when the office closes the channel", async () => {
  const { office, exited } = spawnWorker({ cwd: tempDir() })
  office!.close()
  expect(await exited).toEqual({ code: EXIT_ORPHANED, signal: null })
})

test("a worker process with no channel on fd 3 exits 3", async () => {
  const { exited, stderr } = spawnWorker({ cwd: tempDir(), channel: false })
  expect(await exited).toEqual({ code: EXIT_ORPHANED, signal: null })
  expect(stderr()).toContain("no office channel on fd 3")
})

test("the office channel must be a socket on fd 3", async () => {
  // No process has this many fds open, so it is never an open fd.
  expect(isOfficeChannel(2 ** 30)).toBe(false)
  // An open fd that isn't a socket (a file here; Bun's own fd 3 is a pipe) isn't the channel.
  const file = path.join(tempDir(), "f")
  fs.writeFileSync(file, "")
  const regular = fs.openSync(file, "r")
  try {
    expect(isOfficeChannel(regular)).toBe(false)
  } finally {
    fs.closeSync(regular)
  }
  const where = path.join(shortDir(), "s")
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(where, resolve))
  const socket = net.createConnection(where)
  try {
    await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject))
    // Bun's net socket shows its fd only on the internal handle.
    const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd
    expect(isOfficeChannel(fd)).toBe(true)
  } finally {
    socket.destroy()
    server.close()
  }
})

test("a run sends its live frames from a snapshot at its first record", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hello there friend" })
  const job = makeJob(base())
  const rec = await run(job, new Recorder(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  expect(checkLive(rec.streams, job.log)).toEqual({ last_seq: 0, calls: [] })
  expect(rec.streams.find((frame) => frame.type === "start")?.node).toBe("reply")
  const chunks = rec.streams.filter((frame) => frame.type === "chunk").map((frame) => frame.text)
  expect(chunks.join("")).toBe("hello there friend")
})

test("an advanced run follows from its log without a gap", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello." })
  const job = await waitingChat(fake)
  const waited = inspectRun(job.log).lastSeq!
  const rec = await run(advanceJob(job, { deliver: [send("s1", "hi")] }), new TemplateOffice(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  const sent = rec.replies.find((reply) => reply.id === "s1")?.seq as number
  expect(sent).toBeGreaterThan(waited)
  const kinds = ["run_resumed", "node_woken", "node_started"]
  const first = [...iterRunRecords(job.log, { payloads: false, kinds })].find((entry) => entry.seq > sent)!
  expect(checkLive(rec.streams, job.log).last_seq).toBe(first.seq)
})

test("an advance that appends nothing sends no live frame", async () => {
  const fake = await fakeLlm()
  const job = await waitingChat(fake)
  const rec = await run(advanceJob(job), new TemplateOffice(), { env: fake.env() })
  expect(rec.outcome?.status).toBe("waiting")
  expect(rec.streams).toEqual([])
})

test("a resumed run follows after its offline deliveries without a gap", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "hello there" }, { content: "hello again" })
  // The heard flow's reply reads no steer: in the template chat flow the offline send would be one, and a steer
  // before a model call makes that call's live frames name the wrong step at this yian pin.
  const job = makeJob(base(), "flows/heard.yaml", { inputs: {} })
  expect((await run(job, new Recorder(), { env: fake.env() })).outcome?.status).toBe("waiting")
  const hi = { id: "s1", op: "send", inbox: "messages", event: "hi" } as const
  expect((await run(advanceJob(job, { deliver: [hi] }), new Recorder(), { env: fake.env() })).outcome?.status).toBe(
    "succeeded",
  )
  const replyCall = (entry: RunLogEntry) => entry.kind === "node_step" && entry.nodeId === "reply" && isModelCall(entry)
  const log = logPrefix(job.log, (entry) => !replyCall(entry), tempDir())
  expect(inspectRun(log).status).toBe("crashed")
  const more = { ...hi, event: "more" }
  const rec = await run(advanceJob(job, { log, deliver: [more] }), new Recorder(), { env: fake.env() })
  expect(rec.outcome).toMatchObject({ type: "result", status: "succeeded", output: "hello again" })
  const sent = rec.replies.find((reply) => reply.id === "s1")?.seq as number
  expect(sent).toBeGreaterThan(0)
  expect(checkLive(rec.streams, log).last_seq).toBeGreaterThanOrEqual(sent)
})

/** A recorder whose tool calls first ask the worker to follow again and wait for the fresh snapshot. */
class Refollowing extends Recorder {
  override async toolCall(
    worker: TestWorker,
    group: string,
    name: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<unknown> {
    expect(await worker.follow()).toBe(true)
    const snapshots = () => this.streams.filter((frame) => frame.type === "snapshot").length
    await waitFor(() => snapshots() === 2, { timeout: 10_000, what: "a second snapshot" })
    return super.toolCall(worker, group, name, args, callId)
  }
}

test("a follow frame sends a fresh snapshot", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "", tool_calls: [{ name: "shout", arguments: { text: "hi" } }] }, { content: "done" })
  const rec = new Refollowing({ tools: { toolbox: { shout } } })
  const job = makeJob(base(), "flows/tools.yaml", {}, rec)
  await run(job, rec, { env: fake.env() })
  expect(rec.outcome?.status).toBe("succeeded")
  checkLive(rec.streams, job.log)
  const at = rec.streams.findIndex((frame, i) => i > 0 && frame.type === "snapshot")
  const second = snapshotOf(rec.streams[at])
  const before = rec.streams.slice(0, at).filter((frame) => frame.type === "record")
  expect(second.last_seq).toBe(before.at(-1)!.seq as number)
  replay(job.log, second, rec.streams.slice(at + 1))
})

test("a record frame over the frame limit goes without its line", async () => {
  const fake = await fakeLlm()
  const big = `${"w".repeat(1023)} `.repeat(100)
  fake.script({ content: big, tool_calls: [{ name: "shout", arguments: { text: "hi" } }] }, { content: "done" })
  const ok: OfficeTool = { ...shout, call: () => "ok" }
  const rec = new Recorder({ tools: { toolbox: { shout: ok } } })
  const job = makeJob(base(), "flows/tools.yaml", {}, rec)
  const worker = await inProcessWorker(job, rec, { env: fake.env(), maxFrame: 96 * 1024 })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(rec.outcome).toMatchObject({ type: "result", status: "succeeded", output: "done" })
  const names = rec.names()
  expect(names[0]).toBe("RunStarted")
  expect(names.at(-1)).toBe("RunSucceeded")
  const call = [...iterRunRecords(job.log)].find(isModelCall)!
  checkLive(rec.streams, job.log, { bare: [call.seq] })
})

test("a live frame too large to send is named on stderr by its type", async () => {
  const written: string[] = []
  const write = spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => {
    written.push(String(text))
    return true
  })
  onTestFinished(() => write.mockRestore())
  const fake = await fakeLlm()
  // One word, so one chunk frame over the limit.
  const word = "z".repeat(100 * 1024)
  fake.script({ content: word, tool_calls: [{ name: "shout", arguments: { text: "hi" } }] }, { content: "done" })
  const rec = new Recorder({ tools: { toolbox: { shout } } })
  const job = makeJob(base(), "flows/tools.yaml", {}, rec)
  const worker = await inProcessWorker(job, rec, { env: fake.env(), maxFrame: 96 * 1024 })
  expect(await worker.wait()).toBe(EXIT_OK)
  expect(rec.outcome?.status).toBe("succeeded")
  expect(written).toContain("opencorp __worker: a live frame was not sent (FrameTooLarge)\n")
  expect(written.join("")).not.toContain("zzzz")
})
