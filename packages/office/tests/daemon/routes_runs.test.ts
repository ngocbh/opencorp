/** The run routes: GET /runs/{id}/live over a real socket; the other run routes are a 501 stub until the run views
 *  land. */
import http from "node:http"
import { RunLiveRecord } from "@opencorp/protocol"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import type { LiveJoin, LiveRelay, LiveWorker } from "../../src/daemon/live.ts"
import type { Office } from "../../src/daemon/office.ts"
import { readEvents, refresh } from "../../src/runs/reader.ts"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"
import type { Frame as WorkerFrame } from "../../src/worker/channel.ts"
import { fakeLlm, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { waitFor } from "../helpers.ts"
import { advanceJob, run } from "../worker/helpers.ts"
import {
  type Frame,
  ULID,
  checkedLive,
  frames,
  joinedRun,
  liveRelay,
  makeOffice,
  request,
  served,
  storedRun,
  stubWorker,
  take,
  within,
} from "./helpers.ts"

setDefaultTimeout(30_000)

test("every runs route answers 501 not implemented", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const cases: [string, string][] = [
    ["/runs", "/runs"],
    ["/runs/R1", "/runs/:id"],
    ["/runs/R1/nodes", "/runs/:id/nodes"],
    ["/runs/R1/events", "/runs/:id/events"],
    ["/runs/R1/events/3", "/runs/:id/events/:seq"],
    ["/runs/R1/log", "/runs/:id/log"],
  ]
  for (const [target, pattern] of cases) {
    const r = await request(sock, "GET", target)
    expect(r.status).toBe(501)
    expect(r.json()).toEqual({ error: "not_implemented", message: `GET ${pattern} is not implemented yet` })
  }
})

/** Opens `target` with a `node:http` request; resolves with the response. The request is destroyed when the test
 *  finishes. */
function open(sock: string, target: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: target, agent: false }, (res) => {
      // The cleanup's destroy cuts an unfinished response, which then errors with nobody reading it.
      res.on("error", () => {})
      resolve(res)
    })
    onTestFinished(() => req.destroy())
    req.on("error", reject)
    req.end()
  })
}

/** Every frame of `res` until the stream ends, within 5 s. */
async function all(res: http.IncomingMessage): Promise<Frame[]> {
  return within(Array.fromAsync(frames(res)))
}

/** The record frame of each record of the log `log`, by seq, as its run page shows it. */
async function recordFrames(log: string): Promise<Frame[]> {
  const page = readEvents(log, await refresh(log, null), { after: null, limit: 10_000 })
  expect(page.next_after).toBeNull()
  return page.events.map((event): Frame => {
    return ["record", null, JSON.parse(JSON.stringify({ seq: event.seq, record: event }))]
  })
}

/** The next `n` frames of `it`, each checked as a live frame. */
async function read(it: AsyncIterator<Frame>, n: number): Promise<Frame[]> {
  return checkedLive(await take(it, n))
}

/** Every frame left in `it` until the stream ends, within 5 s, each checked as a live frame. */
async function rest(it: AsyncIterator<Frame>): Promise<Frame[]> {
  const got: Frame[] = []
  await within(
    (async () => {
      for (let step = await it.next(); !step.done; step = await it.next()) got.push(step.value)
    })(),
  )
  return checkedLive(got)
}

/** A stored run with a finished chat turn answering with `replies`, recorded at its log path: its id, log, the live
 *  frames its worker sent, a stand-in worker of it and the relay on `office.live`, which has been fed nothing. */
async function recordedRun(
  office: Office,
  replies: ScriptedReply[],
): Promise<{ runId: string; log: string; fed: WorkerFrame[]; worker: LiveWorker; relay: LiveRelay }> {
  const { runId, sessionId, log } = storedRun(office, { turns: null })
  const fake = await fakeLlm()
  fake.script(...replies)
  const job = await waitingChat(fake, "chat", {}, { runId, runs: office.paths.runs })
  expect(job.log).toBe(log)
  const rec = await run(advanceJob(job, { deliver: [send("s1", "hi")] }), new TemplateOffice(), { env: fake.env() })
  expect(rec.streams[0]?.type).toBe("snapshot")
  return { runId, log, fed: rec.streams, worker: stubWorker(runId, sessionId, log), relay: liveRelay(office) }
}

/** The step key of a call or chunk: `node:n`. */
function stepKey(data: unknown): string {
  const { node, n } = data as { node: string; n: number }
  return `${node}:${n}`
}

/** The frames a stream of the log `log` sends after `after` with no worker: connected, a record per page event, then
 *  run_end. */
async function expected(log: string, after: number | null): Promise<Frame[]> {
  const records = (await recordFrames(log)).filter(([, , data]) => (data as { seq: number }).seq > (after ?? -1))
  return [["comment", null, "connected"], ...records, ["run_end", null, {}]]
}

test("the live route answers 404 for a run the store does not hold", async () => {
  // A row whose session is gone can't be set up: runs.session_id references sessions with ON DELETE CASCADE.
  const office = makeOffice()
  const { sock } = await served(office)
  const r = await request(sock, "GET", `/runs/${ULID}/live`)
  expect(r.status).toBe(404)
  expect(r.headers["content-type"]).toStartWith("application/json")
  expect(r.json()).toEqual({ error: "not_found", message: `no run ${ULID}` })
})

test("the live route answers 404 no log for a run without a log", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office, { turns: null })
  const r = await request(sock, "GET", `/runs/${runId}/live`)
  expect(r.status).toBe(404)
  expect(r.json()).toEqual({
    error: "no_log",
    message: "this run has no log: it didn't start, or its log is gone",
  })
})

test("the live route refuses an after that is not a seq without echoing it", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office)
  for (const value of ["-1", "1.5", "x", "99999999999999999999"]) {
    const r = await request(sock, "GET", `/runs/${runId}/live?after=${value}`)
    expect([r.status, value]).toEqual([422, value])
    expect(r.json()).toEqual({ error: "invalid_body", message: "after must be a record seq from 0" })
    expect(r.text).not.toContain(value)
  }
})

test("the live route refuses head", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId } = storedRun(office)
  const r = await request(sock, "HEAD", `/runs/${runId}/live`)
  expect(r.status).toBe(405)
  expect(r.headers.allow).toBe("GET")
})

test("a run no worker feeds streams its log then run end", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  // Over 64 records, so the stream yields to the event loop between batches.
  const { runId, log } = storedRun(office, { turns: 10 })
  const res = await open(sock, `/runs/${runId}/live`)
  expect(res.statusCode).toBe(200)
  expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8")
  expect(res.headers["cache-control"]).toBe("no-cache")
  const got = await all(res)
  const want = await expected(log, null)
  expect(want.length).toBe(86)
  expect(got).toEqual(want)
  for (const [event, , data] of got) if (event === "record") RunLiveRecord.parse(data)
})

test("the live route skips records up to after", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log } = storedRun(office)
  for (const after of [0, 5, 18]) {
    const got = await all(await open(sock, `/runs/${runId}/live?after=1&after=${after}`))
    expect(got).toEqual(await expected(log, after))
    expect((got[1]![2] as { seq: number }).seq).toBe(after + 1)
  }
  const past = await all(await open(sock, `/runs/${runId}/live?after=19`))
  expect(past).toEqual([
    ["comment", null, "connected"],
    ["run_end", null, {}],
  ])
})

test("a live stream sends the log to the joins seq then the calls then frames", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, fed, worker, relay } = await recordedRun(office, [
    { content: "Let me check that", tool_calls: [{ id: "c1", name: "toolbox_stub" }] },
    { content: "All done now friend" },
  ])
  const full = new Map<string, string>()
  for (const frame of fed) {
    if (frame.type === "chunk") full.set(stepKey(frame), (full.get(stepKey(frame)) ?? "") + frame.text)
  }
  expect([...full.values()]).toEqual(["Let me check that", "All done now friend"])
  // Joined mid call, after the first call's second chunk.
  const at = fed.findIndex((frame) => frame.type === "chunk" && frame.index === 1) + 1
  for (const frame of fed.slice(0, at)) relay.frame(worker, frame)
  const peek = relay.join(runId) as LiveJoin
  peek.viewer.close()
  expect(peek.calls.some((call) => call.text !== "")).toBe(true)
  const records = await recordFrames(log)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  const head = await read(it, 2 + peek.lastSeq + peek.calls.length)
  expect(head).toEqual([
    ["comment", null, "connected"],
    ...records.slice(0, peek.lastSeq + 1),
    ...peek.calls.map(({ node, n, text, nextIndex }): Frame => {
      return ["call", null, { node, n, text, next_index: nextIndex }]
    }),
  ])
  const later = fed.slice(at)
  for (const frame of later) relay.frame(worker, frame)
  relay.detach(worker)
  const tail = await rest(it)
  // The frames as fed, chunks aside (a lagging stream's chunks of one call merge), then the log past the last record
  // fed, then run_end.
  const fedSeqs = later.filter((frame) => frame.type === "record").map((frame) => frame.seq as number)
  const want: Frame[] = []
  for (const frame of later) {
    const { type, node, n } = frame as { type: string; node: string; n: number }
    if (type === "record") want.push(records[frame.seq as number]!)
    else if (type === "start") {
      const { model, purpose, started_at } = frame
      want.push(["start", null, { node, n, model, purpose, started_at }])
    } else if (type === "end") want.push(["end", null, { node, n, error: frame.error }])
  }
  expect(fedSeqs.length).toBeGreaterThan(0)
  expect(want.filter(([event]) => event === "start" || event === "end").length).toBeGreaterThanOrEqual(3)
  want.push(...records.slice(Math.max(peek.lastSeq, ...fedSeqs) + 1), ["run_end", null, {}])
  expect(tail.filter(([event]) => event !== "chunk")).toEqual(want)
  // Every record once, in order: no gap, no duplicate.
  const seqs = [...head, ...tail]
    .filter(([event]) => event === "record")
    .map(([, , data]) => (data as { seq: number }).seq)
  expect(seqs).toEqual(records.map((_, seq) => seq))
  const texts = new Map(peek.calls.map((call) => [stepKey(call), call.text]))
  for (const [event, , data] of tail) {
    if (event === "chunk") texts.set(stepKey(data), (texts.get(stepKey(data)) ?? "") + (data as { text: string }).text)
  }
  expect(texts).toEqual(full)
})

test("a merged chunk carries its last index", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const records = await recordFrames(log)
  const last = records.length - 1
  const calls = [{ node: "a", n: 1, chunks: ["x"], next_index: 1 }]
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: last, calls } })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 2 + last + 1)).toEqual([
    ["comment", null, "connected"],
    ...records,
    ["call", null, { node: "a", n: 1, text: "x", next_index: 1 }],
  ])
  // In one go, so they queue before the stream reads them.
  for (const [index, text] of ["b", "c", "d", "e"].entries()) {
    relay.frame(worker, { type: "chunk", node: "a", n: 1, index: index + 1, text })
  }
  relay.detach(worker)
  expect(await rest(it)).toEqual([
    ["chunk", null, { node: "a", n: 1, index: 4, text: "bcde" }],
    ["run_end", null, {}],
  ])
})

test("run end reads the log past the last seq sent", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, sessionId, log } = storedRun(office)
  const relay = liveRelay(office)
  const worker = stubWorker(runId, sessionId, log)
  const records = await recordFrames(log)
  // The view stands four records before the log's end, as when the worker appended them without frames.
  const from = records.length - 5
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: from, calls: [] } })
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 2 + from)).toEqual([["comment", null, "connected"], ...records.slice(0, from + 1)])
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  expect(await rest(it)).toEqual([["start", null, start], ...records.slice(from + 1), ["run_end", null, {}]])
})

test("a dropped viewer gets reset", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, lastSeq, relay, worker } = joinedRun(office)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  await read(it, 2 + lastSeq)
  // A record past the next seq is a gap: the relay drops the run's viewers.
  relay.frame(worker, { type: "record", seq: lastSeq + 100, line: "" })
  expect(await rest(it)).toEqual([["reset", null, null]])
})

test("a rebuilding view is joined again", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, log, lastSeq, relay, worker } = joinedRun(office)
  relay.frame(worker, { type: "record", seq: lastSeq + 100, line: "" })
  expect(relay.join(runId)).toBe("rebuilding")
  const it = frames(await open(sock, `/runs/${runId}/live`))
  expect(await read(it, 1)).toEqual([["comment", null, "connected"]])
  // Long enough for the stream to try a join or two more.
  await new Promise((resolve) => setTimeout(resolve, 150))
  relay.frame(worker, { type: "snapshot", snapshot: { last_seq: lastSeq, calls: [] } })
  const records = await recordFrames(log)
  expect(await read(it, records.length)).toEqual(records)
  // A stream that had found no worker would have ended at run_end, without this frame.
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  expect(await rest(it)).toEqual([["start", null, start], ["run_end", null, {}]])
})

test("a client that leaves closes its viewer", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  const { runId, lastSeq, relay } = joinedRun(office)
  const join = spyOn(relay, "join")
  const res = await open(sock, `/runs/${runId}/live`)
  await read(frames(res), 2 + lastSeq)
  const { viewer } = join.mock.results[0]!.value as LiveJoin
  const close = spyOn(viewer, "close")
  res.destroy()
  await waitFor(() => close.mock.calls.length > 0, { timeout: 5000, what: "the viewer to close" })
  expect(await viewer.next(1000)).toBeNull()
})

test("a ping keeps an idle live stream open", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { pingMs: 50 })
  const { runId, lastSeq, relay, worker } = joinedRun(office)
  const it = frames(await open(sock, `/runs/${runId}/live`))
  await read(it, 2 + lastSeq)
  expect(await read(it, 2)).toEqual([
    ["comment", null, "ping"],
    ["comment", null, "ping"],
  ])
  const start = { node: "a", n: 1, model: null, purpose: "reply", started_at: "2026-10-20T10:00:00Z" }
  relay.frame(worker, { type: "start", ...start })
  relay.detach(worker)
  const tail = await rest(it)
  expect(tail.filter(([event]) => event !== "comment")).toEqual([["start", null, start], ["run_end", null, {}]])
})
