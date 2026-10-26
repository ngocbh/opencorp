/** The run routes: GET /runs/{id}/live over a real socket; the other run routes are a 501 stub until the run views
 *  land. */
import http from "node:http"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { RunLiveRecord } from "@opencorp/protocol"
import { readEvents, refresh } from "../../src/runs/reader.ts"
import { type Frame, ULID, frames, launchRun, makeOffice, request, served, within } from "./helpers.ts"

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

/** The frames a stream of the log `log` sends after `after` with no worker: connected, a record per page event, then
 *  run_end. Each record frame parses with RunLiveRecord. */
async function expected(log: string, after: number | null): Promise<Frame[]> {
  const page = readEvents(log, await refresh(log, null), { after, limit: 10_000 })
  expect(page.next_after).toBeNull()
  const records = page.events.map(
    (event): Frame => ["record", null, JSON.parse(JSON.stringify({ seq: event.seq, record: event }))],
  )
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
  const { runId } = launchRun(office, { turns: null })
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
  const { runId } = launchRun(office)
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
  const { runId } = launchRun(office)
  const r = await request(sock, "HEAD", `/runs/${runId}/live`)
  expect(r.status).toBe(405)
  expect(r.headers.allow).toBe("GET")
})

test("a run no worker feeds streams its log then run end", async () => {
  const office = makeOffice()
  const { sock } = await served(office)
  // Over 64 records, so the stream yields to the event loop between batches.
  const { runId, log } = launchRun(office, { turns: 10 })
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
  const { runId, log } = launchRun(office)
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
