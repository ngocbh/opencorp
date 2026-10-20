// A fixture HQ for Playwright: the app as built into e2e/dist, served with the office's headers and static rules, and /api
// answered from in-memory state. It tests the app, not the office.
// CSP must equal opencorp.hq.guard.CSP; packages/corp_office/tests/hq/test_app_fixture.py checks it.
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { BrowserSession } from "@opencorp/protocol"
import { acme, type Data } from "./company"

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
}
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
  /** Milliseconds to hold a route's answer, by path. */
  delay: Record<string, number>
  /** A status to fail a route with, by path. */
  fail: Record<string, number>
  /** Each human's password, by handle; an agent never has one. */
  passwords: Record<string, string>
  /** /api/login's throttle: `retryAfter` (seconds) answers every sign-in 429, `busy` answers 503. */
  login: { retryAfter: number | null; busy: boolean }
}
const fresh = (): Fixture => ({
  ...acme(), signedIn: false, codes: {}, health: {}, whoami: { person: "ngocbh", device: "web-abc123" }, delay: {},
  fail: {}, passwords: { ngocbh: "correct horse", ann: "ann's password" }, login: { retryAfter: null, busy: false },
})
// `logins` keeps each sign-in's handle and label, never its password.
const emptyLog = () => ({ pairs: [] as unknown[], logins: [] as unknown[], logouts: 0, health: 0, costs: [] as string[], workItems: [] as string[], api: [] as string[] })
let state = fresh()
let log = emptyLog()
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
  if (state.delay[p]) await Bun.sleep(state.delay[p])
  if (state.fail[p]) return json({ error: "internal", message: `${p} failed` }, state.fail[p])
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
  const workItem = /^\/api\/work-items\/([^/]+)$/.exec(p)?.[1]
  if (workItem) {
    log.workItems.push(workItem)
    const found = state.workItems[workItem]
    return found ? json(found) : json({ error: "not_found", message: `no work item ${workItem}` }, 404)
  }
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
  }
  // Everything else, GET /api/questions/{id} included, is off HQ's allowlist.
  return json({ error: "no_route", message: `no route GET ${p}` }, 404)
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
      // `view` merges into the company view; anything else replaces the key.
      const { view, ...rest } = body
      Object.assign(state, rest)
      if (view) state.view = { ...state.view, ...view }
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
