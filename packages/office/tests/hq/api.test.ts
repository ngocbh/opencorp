/** HQ's /api: the allowlist. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import type { RunIndexRow } from "@ngocbh/yian/run"
import { RunLiveRecord } from "@opencorp/protocol"
import { parse, stringify } from "yaml"
import { hashPassword } from "../../src/auth/passwords.ts"
import { SECRET_KEYS } from "../../src/company/secret_keys.ts"
import type { Office } from "../../src/daemon/office.ts"
import type { Hq } from "../../src/hq/core.ts"
import { TTL } from "../../src/hq/sessions.ts"
import { readEvents, refresh } from "../../src/runs/reader.ts"
import { RunLogs } from "../../src/runs/service.ts"
import { newId } from "../../src/store/store.ts"
import { git } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  CEO,
  type Frame,
  ULID,
  checkedLive,
  frames,
  joinedRun,
  makeOffice,
  parse as parseReply,
  raw,
  type Reply,
  storedRun,
  take,
  within,
} from "../daemon/helpers.ts"
import { chatLog } from "../runs/helpers.ts"
import { question, session, workItem } from "../store/helpers.ts"
import { HOST, ORIGIN, PORT, dist, makeHq, signedIn, web } from "./helpers.ts"

type Body = Record<string, unknown>
type PersonBody = { devices: unknown[]; password_hash: string | null; skills: string[] }

test("health is open and says both keys", async () => {
  const office = makeOffice()
  dist(office.paths.home)
  const hq = await makeHq(office)
  const r = await (await web(hq)).get("/api/health")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({ ok: true, office: { api: hq.api }, app: { build: "b1", api: "x" } })
})

test("anything else under api needs a session first", async () => {
  const r = await (await web(await makeHq(makeOffice()))).get("/api/people")
  expect(r.status).toBe(401)
  expect((r.json() as { error: string }).error).toBe("sign_in_required")
})

test("anything else under api is a json 404", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(`opencorp_hq_${PORT}`, cookie)
  for (const target of ["/api", "/api/people", "/api/hq/pair", "/api/hq/browsers"]) {
    const r = await client.get(target)
    expect([r.status, (r.json() as Body).error, target]).toEqual([404, "no_route", target])
  }
})

test("company is the head snapshot without devices", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const file = path.join(office.paths.company, "people", CEO, "person.yaml")
  const data = parse(fs.readFileSync(file, "utf8")) as Body
  data.devices = [{ name: "mac", token_sha256: "a".repeat(64) }] // a device, not a password: the session lives on
  fs.writeFileSync(file, stringify(data))
  git(office.paths.company, "commit", "-qam", "a device")
  const r = await client.get("/api/company")
  const body = r.json() as {
    sha: string
    company: { ceo: string }
    people: PersonBody[]
    groups: { id: string }[]
    issues: unknown[]
  }
  expect(r.status).toBe(200)
  expect(body.sha).toBe(await office.git.head())
  expect(body.company.ceo).toBe(CEO)
  for (const p of body.people) {
    expect(p.devices).toEqual([])
    expect(p.password_hash).toBeNull()
  }
  expect(body.groups.map((g) => g.id)).toEqual(["eng"])
  expect(body.issues).toEqual([])
})

test("company strips devices and password hashes whatever the snapshot holds", async () => {
  // The snapshot strips them already; the handler strips them again, since the reply goes to a browser.
  const hq = await makeHq(makeOffice())
  const client = await signedIn(hq)
  const view = (await hq.snapshots.head())!
  const hash = await hashPassword("a secret")
  const leaky = {
    ...view,
    people: view.people.map((p) => ({
      ...p,
      devices: [{ name: "mac", token_sha256: "a".repeat(64) }],
      password_hash: hash,
    })),
  }
  hq.snapshots.head = async () => leaky
  const r = await client.get("/api/company")
  const people = (r.json() as { people: PersonBody[] }).people
  expect(r.status).toBe(200)
  expect(people.length).toBeGreaterThan(0)
  for (const p of people) {
    expect(p.devices).toEqual([])
    expect(p.password_hash).toBeNull()
  }
  expect(r.text).not.toContain("token_sha256")
  expect(r.text).not.toContain("$scrypt$")
})

test("company blanks by secret keys", async () => {
  const hq = await makeHq(makeOffice())
  const client = await signedIn(hq)
  const view = await hq.snapshots.head()
  // Loaded before the change, so only the handler can blank them.
  expect(view!.people.some((p) => p.skills.length > 0)).toBe(true)
  const keys = SECRET_KEYS as Set<string>
  keys.add("skills")
  try {
    const r = await client.get("/api/company")
    expect(r.status).toBe(200)
    for (const p of (r.json() as { people: PersonBody[] }).people) expect(p.skills).toEqual([])
  } finally {
    keys.delete("skills")
  }
})

test.each([
  ["repeated", ["busy", "idle"]],
  ["comma separated", ["busy,idle"]],
] as const)("sessions filter by status [%s]", async (_case, status) => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  const a = office.store.createSession(session({ status: "busy" }))
  const b = office.store.createSession(session({ status: "idle" }))
  office.store.createSession(session({ status: "ended" }))
  const r = await client.get("/api/sessions", { query: status.map((s) => ["status", s] as [string, string]) })
  expect(new Set((r.json() as Body[]).map((x) => x.id))).toEqual(new Set([a.id, b.id]))
})

test("open questions a work item and costs", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const s = office.store.createSession(session())
  const q = office.store.addQuestion(question(s.id))
  const item = office.store.createWorkItem(workItem({ assignee: CEO }))
  const open = await client.get("/api/questions", { query: { status: "open" } })
  expect(open.status).toBe(200)
  expect((open.json() as Body[]).map((x) => x.id)).toEqual([q.id])
  expect(((await client.get(`/api/work-items/${item.id}`)).json() as Body).assignee).toBe(CEO)
  const r = await client.get("/api/costs", { query: { since: "2026-10-19T00:00:00.000Z" } })
  expect(r.status).toBe(200)
  expect((r.json() as Body).since).toBe("2026-10-19T00:00:00.000Z")
})

test.each(["/api/people", "/api/sessions/X/messages", "/api/connections", "/api/hq"])(
  "routes off the allowlist are a json 404 [%s]",
  async (target) => {
    const r = await (await signedIn(await makeHq(makeOffice()))).get(target)
    expect(r.status).toBe(404)
    expect((r.json() as Body).error).toBe("no_route")
  },
)

test("writes off the allowlist are a json 404", async () => {
  const client = await signedIn(await makeHq(makeOffice()))
  for (const target of ["/api/sessions", "/api/people", "/api/questions/X/answer"])
    expect([(await client.post(target, {})).status, target]).toEqual([404, target])
})

test("get office isnt on the hq allowlist", async () => {
  const office = makeOffice()
  dist(office.paths.home)
  const client = await signedIn(await makeHq(office))
  const r = await client.get("/api/office")
  expect(r.status).toBe(404)
  expect((r.json() as Body).error).toBe("no_route")
  const page = await client.get("/office", { headers: { "sec-fetch-dest": "document" } })
  expect(page.status).toBe(200)
  expect(page.headers["content-type"]).toStartWith("text/html")
  expect(page.text).toBe(fs.readFileSync(path.join(office.paths.home, "dist", "index.html"), "utf8"))
  expect(page.text).not.toContain("pid")
  expect(page.text).not.toContain("home")
})

test("a wrong method under api is a json 404", async () => {
  const client = await signedIn(await makeHq(makeOffice()))
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  for (const [method, target] of [
    ["POST", "/api/health"],
    ["DELETE", "/api/company"],
    ["PATCH", "/api/company"],
  ]) {
    // Raw: under `bun test` the node:http client drops a DELETE's body.
    const head = [`${method} ${target} HTTP/1.1`, `host: ${HOST}`, `origin: ${ORIGIN}`, `cookie: ${cookie}`]
    const sent = [...head, "content-type: application/json", "content-length: 2", "connection: close"]
    const r = parseReply((await raw(client.sock, `${sent.join("\r\n")}\r\n\r\n{}`)).text)
    expect([r.status, (JSON.parse(r.body) as Body).error, target]).toEqual([404, "no_route", target])
    expect(r.head.toLowerCase()).not.toContain("\r\nallow:")
  }
})

test("the live route is on the allowlist and needs a session", async () => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  const { runId } = storedRun(office)
  const res = await client.stream(`/api/runs/${runId}/live`)
  expect(res.statusCode).toBe(200)
  expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8")
  res.destroy()
  client.cookies.clear()
  const r = await client.get(`/api/runs/${runId}/live`)
  expect([r.status, (r.json() as Body).error]).toEqual([401, "sign_in_required"])
})

test("the hq live route refuses head", async () => {
  const office = makeOffice()
  const client = await signedIn(await makeHq(office))
  const { runId } = storedRun(office)
  const r = await client.request("HEAD", `/api/runs/${runId}/live`)
  expect([r.status, r.headers.allow]).toEqual([405, "GET"])
})

test("the hq live route streams a runs log then run end", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await signedIn(hq)
  const sid = office.store.listHqSessions()[0]!.id
  const { runId, log } = storedRun(office)
  const got = await within(Array.fromAsync(frames(await client.stream(`/api/runs/${runId}/live`))))
  const page = readEvents(log, await refresh(log, null), { after: null, limit: 10_000 })
  const records = page.events.map((e): Frame => ["record", null, JSON.parse(JSON.stringify({ seq: e.seq, record: e }))])
  expect(got).toEqual([["comment", null, "connected"], ...records, ["run_end", null, {}]])
  for (const [event, , data] of got) if (event === "record") RunLiveRecord.parse(data)
  await waitFor(() => office.bus.subscriberCount === 0 && hq.sessions.streams(sid) === 0, {
    timeout: 5000,
    what: "the stream to be unregistered",
  })
})

test("the hq live route answers 404 for an unknown run", async () => {
  const client = await signedIn(await makeHq(makeOffice()))
  const r = await client.get(`/api/runs/${ULID}/live`)
  expect(r.status).toBe(404)
  expect(r.json()).toEqual({ error: "not_found", message: `no run ${ULID}` })
})

/** An HQ live stream of a run a worker feeds, read past its log to its first ping (every 50 ms): the stream is open.
 *  Returns its frames' iterator, the HQ session's id, HQ and the office. */
async function openLive(): Promise<{ office: Office; hq: Hq; sid: string; it: AsyncIterator<Frame> }> {
  const office = makeOffice()
  const hq = await makeHq(office)
  hq.pingMs = 50
  const client = await signedIn(hq)
  const sid = office.store.listHqSessions()[0]!.id
  const { runId, lastSeq } = joinedRun(office)
  const it = frames(await client.stream(`/api/runs/${runId}/live`))
  const head = checkedLive(await take(it, 3 + lastSeq))
  expect(head[0]).toEqual(["comment", null, "connected"])
  expect(head.at(-1)).toEqual(["comment", null, "ping"])
  expect(hq.sessions.streams(sid)).toBe(1)
  return { office, hq, sid, it }
}

/** Reads `it` until the stream ends, within 5 s, expecting only pings; then waits until HQ holds no stream of `sid`
 *  and the bus no subscriber. */
async function endsWithPings(it: AsyncIterator<Frame>, office: Office, hq: Hq, sid: string): Promise<void> {
  const got: Frame[] = []
  await within(
    (async () => {
      for (let step = await it.next(); !step.done; step = await it.next()) got.push(step.value)
    })(),
  )
  expect(checkedLive(got).filter(([, , data]) => data !== "ping")).toEqual([])
  await waitFor(() => office.bus.subscriberCount === 0 && hq.sessions.streams(sid) === 0, {
    timeout: 5000,
    what: "the stream to be unregistered",
  })
}

test("a revoke ends an open live stream", async () => {
  const { office, hq, sid, it } = await openLive()
  await hq.sessions.revoke(sid)
  await endsWithPings(it, office, hq, sid)
})

test("a company update that drops the person ends the live stream", async () => {
  const { office, hq, sid, it } = await openLive()
  git(office.paths.company, "rm", "-q", `people/${CEO}/person.yaml`)
  git(office.paths.company, "commit", "-qm", "drop the ceo")
  const sha = await office.git.readHead()
  office.store.emit("company.updated", sha, { sha })
  await endsWithPings(it, office, hq, sid)
  expect(office.store.getHqSession(sid)).toBeUndefined()
})

test("an expired session ends the live stream at its next frame", async () => {
  const { office, hq, sid, it } = await openLive()
  // Past any session issued now.
  hq.sessions.clock = () => new Date(Date.now() + 2 * TTL)
  await endsWithPings(it, office, hq, sid)
})

const T = "2026-10-20T10:00:00.000Z"

/** A run row of a new ended session at `commit`, launched at T. */
function addRun(office: Office, flow: string, driver: string, commit?: string): string {
  const s = office.store.createSession(session({ status: "ended", ...(commit && { repo_commit: commit }) }))
  const runId = newId()
  office.store.addRun({
    runId,
    sessionId: s.id,
    driver,
    flow,
    flowPath: `shared/flows/${flow}.yaml`,
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: T,
  })
  return runId
}

test("runs are on the allowlist", async () => {
  const office = makeOffice({ log: () => {} })
  const client = await signedIn(await makeHq(office))
  // yian's run index links the child to its parent. The top run has no outcome and the child's index row is
  // cancelled, so both read interrupted.
  const index = new Map<string, RunIndexRow>()
  office.runs = new RunLogs({ store: office.store, runsDir: office.paths.runs, index: () => index })
  const runId = addRun(office, "chat", CEO)
  const kid = addRun(office, "side_chat", "lan")
  index.set(kid, {
    runId: kid,
    flow: "shared/flows/side_chat.yaml",
    status: "cancelled",
    startedAt: T,
    endedAt: null,
    parentRunId: runId,
    lastSeq: 3,
    result: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    offset: 10,
    waits: [],
    ready: false,
    wakeAt: null,
  })
  const ids = (r: Reply) => (r.json() as { runs: { run_id: string }[] }).runs.map((x) => x.run_id)
  let r = await client.get("/api/runs", {
    query: { status: "interrupted,failed", since: "2026-10-13T10:00:00.000Z", limit: "50" },
  })
  expect([r.status, ids(r)]).toEqual([200, [runId]])
  expect((r.json() as { runs: { children_total: number }[] }).runs[0]!.children_total).toBe(1)
  r = await client.get("/api/runs", { query: { parent: runId } })
  expect(ids(r)).toEqual([kid])
  expect((await client.get("/api/runs", { query: { status: "busy" } })).status).toBe(422)
  r = await client.get("/api/runs", { query: { recent: "2026-10-13T10:00:00.000Z", limit: "50" } })
  expect(ids(r)).toEqual([runId])
  const both = { recent: "2026-10-13T10:00:00.000Z", since: "2026-10-13T10:00:00Z" }
  expect((await client.get("/api/runs", { query: both })).status).toBe(422)
})

test("runs need a session", async () => {
  expect((await (await web(await makeHq(makeOffice()))).get("/api/runs")).status).toBe(401)
})

test("one runs routes are on the allowlist", async () => {
  const office = makeOffice({ log: () => {} })
  const client = await signedIn(await makeHq(office))
  // A run of a new ended session at the company's head whose log is a synthetic chat log.
  const runId = addRun(office, "chat", CEO, await office.git.head())
  const file = office.runs.logPath(runId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  chatLog(file)
  for (const suffix of ["", "/nodes", "/events", "/events/0", "/log"])
    expect([(await client.get(`/api/runs/${runId}${suffix}`)).status, suffix]).toEqual([200, suffix])
  // No HEAD on the download: HQ's GET catch-all answers it, as any method HQ doesn't serve.
  expect((await client.request("HEAD", `/api/runs/${runId}/log`)).status).toBe(404)
})
