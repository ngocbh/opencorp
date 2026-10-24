// A fixture HQ for Playwright: the app as built into e2e/dist, served with the office's headers and static rules, and /api
// answered from in-memory state. It tests the app, not the office.
// Its CSP and security headers are the office's own, imported from HQ's guard.
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { CSP, HEADERS } from "@opencorp/office/hq/guard"
import type { BrowserSession, RunDetail, RunEvent, RunSummary } from "@opencorp/protocol"
import { acme, source, type Data, type Source } from "./company"
import { runLogs, runPages, summaryOf, wholeEvents, type RunPages, type Runs } from "./runs"

const DIST = path.join(import.meta.dir, "dist")
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4791)
const build = JSON.parse(readFileSync(path.join(DIST, "build.json"), "utf8"))

/** `path` with its %-escapes decoded; an escape that isn't valid UTF-8 stays as it is, as uvicorn decodes paths. */
function decodePath(path: string) {
  return path.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** A file of the built app, index.html for a document navigation, or a plain 404, as the office serves them. */
function serveStatic(req: Request, url: URL): Response {
  // The office serves the app to GET and HEAD only.
  if (req.method !== "GET" && req.method !== "HEAD")
    return json(
      { error: "method_not_allowed", message: `${req.method} is not allowed on ${url.pathname}` },
      405,
      { allow: "GET, HEAD" },
    )
  const rel = decodePath(url.pathname).replace(/^\/+/, "")
  const file = path.join(DIST, rel)
  if (rel && !rel.split("/").includes("..") && existsSync(file) && statSync(file).isFile())
    return new Response(Bun.file(file), {
      headers: {
        ...HEADERS,
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    })
  const dest = req.headers.get("sec-fetch-dest")
  if (rel.startsWith("assets/") || path.extname(rel) || (dest && dest !== "document"))
    return new Response("not found", { status: 404, headers: HEADERS })
  return new Response(Bun.file(path.join(DIST, "index.html")), { headers: { ...HEADERS, "cache-control": "no-cache" } })
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...headers } })

type Fixture = Data & {
  signedIn: boolean
  /** Codes that sign a browser in once, with who issued each. */
  codes: Record<string, string>
  /** Overrides for /api/health: another office key, another build, or no build at all. */
  health: { officeApi?: string; build?: string; app?: null }
  whoami: { person: string; device: string | null }
  /** Milliseconds to hold a route's answer, by path ("/api/runs?parent" for reads of one run's children only). */
  delay: Record<string, number>
  /** A status to fail a route with (an `internal` error), or the whole error to answer, by path (as `delay`). */
  fail: Record<string, number | { status: number; error: string; message: string }>
  /** Each human's password, by handle; an agent never has one. */
  passwords: Record<string, string>
  /** /api/login's throttle: `retryAfter` (seconds) answers every sign-in 429, `busy` answers 503. */
  login: { retryAfter: number | null; busy: boolean }
  /** The company repo, for Source. */
  source: Source
  /** Run Logs: the top-level runs and each run's children. */
  runs: Runs
  /** Each run's page (header, nodes, records), by run id. */
  runPages: RunPages
  /** The whole record GET /api/runs/{id}/events/{seq} answers, by run id and seq, where it differs from the page's. */
  wholeEvents: Record<string, Record<number, RunEvent>>
  /** An office older than Run Logs: /api/runs and everything under it answer 404 no_route. */
  noRuns: boolean
}
const fresh = (): Fixture => ({
  ...acme(), signedIn: false, codes: {}, health: {}, whoami: { person: "ngocbh", device: "web-abc123" }, delay: {},
  fail: {}, passwords: { ngocbh: "correct horse", ann: "ann's password" }, login: { retryAfter: null, busy: false },
  source: source(),
  runs: runLogs(),
  runPages: runPages(runLogs()),
  wholeEvents: wholeEvents(),
  noRuns: false,
})
// `logins` keeps each sign-in's handle and label, never its password.
const emptyLog = () => ({ pairs: [] as unknown[], logins: [] as unknown[], logouts: 0, health: 0, costs: [] as string[], workItems: [] as string[], api: [] as string[],
  files: [] as { at: string; path: string }[], runs: [] as string[], runReads: [] as string[],
  /** The most reads of one run's children (`GET /api/runs?parent=`) in flight at once. */
  parentPeak: 0 })
let state = fresh()
let log = emptyLog()
let parentsInFlight = 0
let downUntil = 0

// Open event streams, written to by /__fixture/emit and ended by /__fixture/drop and /__fixture/reset.
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()
function write(text: string) {
  for (const c of streams) {
    try {
      c.enqueue(enc.encode(text))
    } catch {
      streams.delete(c)
    }
  }
}
function closeAll() {
  for (const c of streams) {
    try {
      c.close()
    } catch {}
  }
  streams.clear()
}
setInterval(() => write(": ping\n\n"), 15_000) // as the office's 15 s ping

let seq = 0
/** A meta frame as the office writes it (`event`, `id`, `data`). */
function frame(e: { type: string; data: Record<string, unknown> }) {
  const event = { id: `E${String(++seq).padStart(25, "0")}`, at: new Date().toISOString(), subject_id: String(e.data.id ?? ""), ...e }
  return `event: meta\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`
}

function health() {
  const app = state.health.app === null ? null : { build: state.health.build ?? build.build, api: build.api }
  return { ok: true, office: { api: state.health.officeApi ?? build.api }, app }
}

function events() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      streams.add(c)
      c.enqueue(enc.encode(": connected\n\n"))
    },
    cancel() {
      streams.delete(ctl)
    },
  })
  return new Response(body, { headers: { ...HEADERS, "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const MAX_AGE = 30 * 86_400

/** A browser session as /api/pair and /api/login return it. */
function session(via: BrowserSession["via"], issued_by: string, label: string | null): BrowserSession {
  const at = new Date()
  return {
    id: "01JA1H0000000000000000000A", person: state.whoami.person, name: "web-abc123", label, via, issued_by,
    created_at: at.toISOString(), expires_at: new Date(at.getTime() + MAX_AGE * 1000).toISOString(), last_used_at: null,
  }
}

/** The session cookie the office sets on a sign-in. */
const cookie = () => ({ "set-cookie": `opencorp_hq_${port}=fixture; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}` })

/** POST /api/login as the office answers it: one 401 for every failure, so nobody learns which handles exist. */
async function login(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  const keys = body && typeof body === "object" ? Object.keys(body) : []
  if (
    !body ||
    typeof body.handle !== "string" ||
    !HANDLE.test(body.handle) ||
    typeof body.password !== "string" ||
    !body.password ||
    keys.some((k) => !["handle", "password", "label"].includes(k)) ||
    (body.label != null && (typeof body.label !== "string" || body.label.length > 100))
  )
    return json({ error: "invalid_body", message: "the body isn't an HqLoginRequest" }, 422)
  const { handle, password, label = null } = body
  log.logins.push({ handle, label })
  if (state.login.retryAfter !== null)
    return json({ error: "too_many_attempts", message: "too many tries; wait, or run `opencorp pair`" }, 429, {
      "retry-after": String(state.login.retryAfter),
    })
  if (state.login.busy) return json({ error: "busy", message: "the office is busy; try again" }, 503)
  const human = state.view.people.some((p) => p.handle === handle && p.kind === "human")
  if (!human || state.passwords[handle] !== password)
    return json({ error: "bad_credentials", message: "wrong handle or password" }, 401)
  state.signedIn = true
  state.whoami = { person: handle, device: "web-abc123" }
  return json(session("login", handle, label), 200, cookie())
}

/** POST /api/logout as the office's guard, then its route, answer it: ends the session and clears the cookie. */
function logout(req: Request): Response {
  if (!req.headers.get("origin")) return json({ error: "origin_not_allowed", message: "HQ's API answers only its own pages" }, 403)
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({ error: "json_required", message: "HQ's API takes only JSON bodies" }, 415)
  if (!state.signedIn) return json({ error: "sign_in_required", message: SIGN_IN }, 401)
  log.logouts++
  state.signedIn = false
  return json({ ok: true }, 200, { "set-cookie": `opencorp_hq_${port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
}

const SIGN_IN = "Sign in: run `opencorp pair` on the office machine and open the link it prints."
const EXPIRED = "This link has expired or was already used. Run `opencorp pair` again."

/** HQ's /api, as the office answers it, from `state`. */
async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname
  log.api.push(p)
  if (Date.now() < downUntil) return json({ error: "office_unavailable", message: "the office is restarting" }, 503)
  // A read of one run's children also answers to the key "/api/runs?parent", so a test can hold or fail only those.
  const parentRead = p === "/api/runs" && url.searchParams.has("parent")
  const delay = (parentRead && state.delay["/api/runs?parent"]) || state.delay[p]
  if (parentRead) log.parentPeak = Math.max(log.parentPeak, ++parentsInFlight)
  try {
    if (delay) await Bun.sleep(delay)
  } finally {
    if (parentRead) parentsInFlight--
  }
  const fail = (parentRead && state.fail["/api/runs?parent"]) || state.fail[p]
  if (typeof fail === "number" && fail) return json({ error: "internal", message: `${p} failed` }, fail)
  if (typeof fail === "object") return json({ error: fail.error, message: fail.message }, fail.status)
  if (p === "/api/health") return log.health++, json(health())
  if (p === "/api/pair" && req.method === "POST") {
    const body = await req.json().catch(() => ({}))
    log.pairs.push(body)
    const issued_by = state.codes[body.code]
    if (!issued_by) return json({ error: "pair_code_invalid", message: EXPIRED }, 400)
    delete state.codes[body.code]
    state.signedIn = true
    return json(session("pair", issued_by, body.label ?? null), 200, cookie())
  }
  if (p === "/api/login" && req.method === "POST") return login(req)
  if (p === "/api/logout" && req.method === "POST") return logout(req)
  if (!state.signedIn) return json({ error: "sign_in_required", message: SIGN_IN }, 401)
  if (req.method !== "GET") return json({ error: "no_route", message: `no route ${req.method} ${p}` }, 404)
  if (state.noRuns && (p === "/api/runs" || p.startsWith("/api/runs/")))
    return json({ error: "no_route", message: `no route GET ${p}` }, 404)
  const workItem = /^\/api\/work-items\/([^/]+)$/.exec(p)?.[1]
  if (workItem) {
    log.workItems.push(workItem)
    const found = state.workItems[workItem]
    return found ? json(found) : json({ error: "not_found", message: `no work item ${workItem}` }, 404)
  }
  const runPath = /^\/api\/runs\/([^/]+)(\/nodes|\/events|\/events\/(\d+)|\/log)?$/.exec(p)
  if (runPath) return runRoute(url, runPath[1]!, runPath[2] ?? "", runPath[3])
  switch (p) {
    case "/api/whoami":
      return json(state.whoami)
    case "/api/company":
      return json(state.view)
    case "/api/sessions": {
      const wanted = url.searchParams.getAll("status").flatMap((x) => x.split(","))
      return json(state.sessions.filter((x) => !wanted.length || wanted.includes(x.status)))
    }
    case "/api/questions":
      return json(state.questions.filter((q) => q.status === "open"))
    case "/api/costs": {
      const since = url.searchParams.get("since") ?? ""
      log.costs.push(since)
      return json({ since, people: state.costs })
    }
    case "/api/events":
      return events()
    case "/api/company/tree":
      return companyTree()
    case "/api/company/file":
      return companyFile(url)
    case "/api/runs":
      return listRuns(url)
  }
  // Everything else, GET /api/questions/{id} included, is off HQ's allowlist.
  return json({ error: "no_route", message: `no route GET ${p}` }, 404)
}

/** GET /api/company/tree: HEAD's listing; the office then serves files at its commit (the last 8 HEADs listed). */
function companyTree(): Response {
  const src = state.source
  const id = src.tree.commit.id
  if (src.serve) src.served = [id, ...src.served.filter((x) => x !== id)].slice(0, 8)
  return json(src.tree)
}

/** GET /api/company/file?at=&path=, with the office's three errors: 409 stale_commit, 400 bad_path, 404 no_file. */
function companyFile(url: URL): Response {
  const at = url.searchParams.get("at") ?? ""
  const path = url.searchParams.get("path") ?? ""
  log.files.push({ at, path })
  // The office's order: the path's shape, then the commit, then the listing.
  if (!path || path.startsWith("/") || path.endsWith("/") || path.split("/").some((s) => !s || s === "." || s === ".."))
    return json({ error: "bad_path", message: "the path isn't repo-relative and /-separated" }, 400)
  if (!state.source.served.includes(at))
    return json({ error: "stale_commit", message: "that commit isn't served any more; read the tree again" }, 409)
  const file = state.source.files[path]
  if (!file) return json({ error: "no_file", message: `${path} isn't a file at ${at}` }, 404)
  // Every key, as the office's model_dump(mode="json") writes them.
  return json({ path, commit: at, text: null, target: null, reason: null, rewritten: false, ...file })
}

const RUN_STATUSES = ["running", "waiting", "idle", "finished", "failed", "interrupted"]

/** GET /api/runs as the office answers it: top-level runs newest first, each with `children_total` and no children, a
 * parent shown when it or a child matches, `limit` (50) at a time from `before`; `?parent=` pages one run's children
 * that match, the same way. `status` is a comma-separated list (any matches); `since` (inclusive) and `until`
 * (exclusive) bound `launched_at`; `recent` keeps open runs (running, waiting, idle) and those launched at or after it,
 * and can't go with `since` or `until`; a bad one of these is a 422. */
function listRuns(url: URL): Response {
  const p = url.searchParams
  log.runs.push(url.search)
  const [flow, person, q] = ["flow", "person", "q"].map((k) => p.get(k))
  const statuses = p.get("status")?.split(",") ?? []
  const unknown = statuses.find((s) => !RUN_STATUSES.includes(s))
  if (unknown !== undefined) return json({ error: "invalid_body", message: `unknown status ${unknown}` }, 422)
  const [since, until, recent] = ["since", "until", "recent"].map((k) => (p.has(k) ? Date.parse(p.get(k)!) : null))
  if (Number.isNaN(since) || Number.isNaN(until) || Number.isNaN(recent))
    return json({ error: "invalid_body", message: "since, until and recent are ISO timestamps" }, 422)
  if (recent !== null && (since !== null || until !== null))
    return json({ error: "invalid_body", message: "recent can't be combined with since or until" }, 422)
  const open = (r: RunSummary) => ["running", "waiting", "idle"].includes(r.status)
  const match = (r: RunSummary) =>
    (!flow || r.flow === flow) && (!person || r.driver === person || (r.participants ?? []).includes(person)) &&
    (!statuses.length || statuses.includes(r.status)) && (!q || r.run_id.includes(q.toUpperCase())) &&
    (since === null || Date.parse(r.launched_at) >= since) && (until === null || Date.parse(r.launched_at) < until) &&
    (recent === null || open(r) || Date.parse(r.launched_at) >= recent)
  const kids = (id: string) => state.runs.children[id] ?? []
  const parent = p.get("parent")
  let shown: RunSummary[]
  if (parent) {
    if (!summaryOf(state.runs, parent)) return json({ error: "not_found", message: `no run ${parent}` }, 404)
    shown = kids(parent).filter(match)
  } else
    shown = state.runs.runs
      .filter((r) => match(r) || kids(r.run_id).some(match))
      .map((r) => ({ ...r, children: [], children_total: kids(r.run_id).length }))
  const before = p.get("before")
  const from = before ? shown.findIndex((r) => r.run_id < before) : 0
  const limit = Number(p.get("limit") ?? 50)
  const page = from < 0 ? [] : shown.slice(from, from + limit)
  const more = from >= 0 && from + limit < shown.length
  return json({ runs: page, next: more ? page[page.length - 1]!.run_id : null })
}

/** One run's routes as the office answers them, from `state.runPages`. */
function runRoute(url: URL, id: string, rest: string, seq: string | undefined): Response {
  log.runReads.push(`${id}${rest}${url.search}`)
  const page = state.runPages[id]
  if (!page) return json({ error: "not_found", message: `no run ${id}` }, 404)
  const { log_state, log_message, bytes_done, bytes_total } = page.detail
  if (rest === "") return json(page.detail)
  // The download comes before the log-state checks: a log this office can't read still downloads.
  if (rest === "/log")
    return new Response(page.events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { ...HEADERS,
      "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="${id}.jsonl"` } })
  if (log_state === "not_started" || log_state === "missing") return json({ error: "no_log", message: "this run has no log" }, 404)
  if (log_state === "unsupported_schema") return json({ error: "unsupported_schema", message: log_message }, 409)
  const indexing = log_state === "indexing" || page.indexing
  const progress = { bytes_done: bytes_done ?? 120 << 20, bytes_total: bytes_total ?? 480 << 20 }
  if (rest === "/nodes") {
    if (indexing) return json({ nodes: [], dividers: [], indexing: true, ...progress })
    const before = url.searchParams.get("before")
    const older = page.nodes.filter((n) => before === null || n.seq < Number(before))
    const shown = older.slice(0, 8) // the office's page is 1,000; 8 here, so unfolding older pages is tested
    const low = shown.length ? shown[shown.length - 1]!.seq : 0
    return json({ nodes: shown, dividers: page.dividers.filter((d) => d.seq >= low && (before === null || d.seq < Number(before))),
                  next_before: older.length > shown.length ? low : null, dropped: false, indexing: false })
  }
  if (page.fail) return json({ error: page.fail, message: `${page.fail} here` }, 503)
  if (rest === "/events") {
    if (indexing) return json({ events: [], indexing: true, ...progress })
    const after = Number(url.searchParams.get("after") ?? -1)
    const events = page.events.filter((e) => e.seq > after)
    // The office's page is 500 records; 4 here, so loading more is tested.
    return json({ events: events.slice(0, 4), next_after: events.length > 4 ? events[3]!.seq : null, cut: false })
  }
  if (seq !== undefined) {
    if (indexing) return json({ error: "indexing", message: "the log is still being read; try again" }, 503)
    const found = state.wholeEvents[id]?.[Number(seq)] ?? page.events.find((e) => e.seq === Number(seq))
    return found ? json(found) : json({ error: "not_found", message: `run ${id} has no record ${seq}` }, 404)
  }
  return json({ error: "not_found", message: `no route ${url.pathname}` }, 404)
}

/** /__fixture/*: how tests set the office up and read what the app asked for. */
async function control(req: Request, url: URL): Promise<Response> {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {}
  switch (url.pathname) {
    case "/__fixture/reset":
      state = fresh()
      log = emptyLog()
      downUntil = 0
      closeAll()
      return json({ ok: true })
    case "/__fixture/set": {
      // `view` and `source` merge into theirs; anything else replaces the key.
      const { view, source, ...rest } = body
      Object.assign(state, rest)
      if (view) state.view = { ...state.view, ...view }
      if (source) state.source = { ...state.source, ...source }
      return json({ ok: true })
    }
    case "/__fixture/code":
      state.codes[body.code] = body.issued_by ?? "ngocbh"
      return json({ ok: true })
    case "/__fixture/log":
      return json(log)
    case "/__fixture/emit":
      write(frame(body.event))
      return json({ ok: true })
    case "/__fixture/drop":
      downUntil = Date.now() + (body.ms ?? 0)
      closeAll()
      return json({ ok: true })
    case "/__fixture/run": {
      // Changes one run's page: `detail` merges into its header (`detail.run` into its summary); `add` puts newer
      // node attempts before its others; `addEvents` puts newer records after its others; `indexing` sets whether its
      // node and record pages answer "indexing"; `fail` is an error code its record reads answer with (null for
      // none). A run with no page gets one from its summary.
      const summary = summaryOf(state.runs, body.id)!
      const page = (state.runPages[body.id] ??= { nodes: [], dividers: [], events: [], detail: { run: summary,
        parent: null, repo_commit: "a".repeat(40), usage: null, models: {}, log_state: "ok" } as RunDetail })
      const { run, ...rest } = body.detail ?? {}
      page.detail = { ...page.detail, ...rest, run: { ...page.detail.run, ...run } }
      if (body.add) page.nodes = [...body.add, ...page.nodes]
      if ("indexing" in body) page.indexing = body.indexing
      if ("fail" in body) page.fail = body.fail
      if (body.addEvents) page.events = [...page.events, ...body.addEvents]
      return json({ ok: true })
    }
  }
  return json({ error: "no_route" }, 404)
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0, // event streams stay quiet for longer than Bun's 10 s default
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/__fixture/")) return control(req, url)
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(req, url)
    return serveStatic(req, url)
  },
})
