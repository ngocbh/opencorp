import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { createOfficeClient } from "../src/client"
import { OfficeError, OfficeTimeout, OfficeUnavailable, UnknownDevice } from "../src/errors"
import { transportOf } from "../src/http"
import { subscribe, type StreamEvent } from "../src/sse"
import { emptyState } from "../src/store"
import { createOfficeSync, type OfficeStatus } from "../src/sync"
import { onStop, serve, stopServers } from "./serve"

afterEach(stopServers)

const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )

test("a browser write with no body sends {} as JSON", async () => {
  const { seen, base } = serve()
  await createOfficeClient({ baseUrl: base }).sessions.interrupt("S1")
  expect(seen).toEqual([
    { method: "POST", path: "/api/sessions/S1/interrupt", query: "", type: "application/json", body: "{}" },
  ])
})

test("a browser read sends neither a body nor a content type", async () => {
  const { seen, base } = serve()
  await createOfficeClient({ baseUrl: base }).whoami()
  expect(seen).toEqual([{ method: "GET", path: "/api/whoami", query: "", type: null, body: "" }])
})

test("a socket write with no body still sends none", async () => {
  const dir = mkdtempSync("/tmp/oct-")
  onStop(() => rmSync(dir, { recursive: true, force: true }))
  const { seen } = serve({ unix: path.join(dir, "o.sock") })
  await createOfficeClient({ socket: path.join(dir, "o.sock") }).sessions.interrupt("S1")
  expect(seen).toEqual([{ method: "POST", path: "/sessions/S1/interrupt", query: "", type: null, body: "" }])
})

test("a base URL's trailing slashes are dropped", async () => {
  expect(transportOf({ baseUrl: "http://127.0.0.1:1/api//" })).toEqual({ baseUrl: "http://127.0.0.1:1/api" })
  const { seen, base } = serve()
  await createOfficeClient({ baseUrl: `${base}/` }).whoami()
  expect(seen.map((r) => r.path)).toEqual(["/api/whoami"])
})

test("a client takes a socket or a base URL, not both", () => {
  // The typecheck runs this test: it fails if the directive's line type-checks.
  // @ts-expect-error: a socket and a base URL at once
  const both: Parameters<typeof createOfficeClient>[0] = { socket: "/x", baseUrl: "/api" }
  expect(both).toBeDefined()
})

test("an unreachable base URL is OfficeUnavailable, naming the URL", async () => {
  // A port a server just let go of: nothing listens there now.
  const { base, stop } = serve()
  stop()
  const e = await failure(createOfficeClient({ baseUrl: base }).whoami())
  expect(e).toBeInstanceOf(OfficeUnavailable)
  expect(e.message).toContain(base)
})

test("a base URL read that gets no answer in time is OfficeTimeout", async () => {
  const { base } = serve({ answer: () => Bun.sleep(1000).then(() => Response.json({})) })
  const e = await failure(createOfficeClient({ baseUrl: base, timeoutMs: 50 }).whoami())
  expect(e).toBeInstanceOf(OfficeTimeout)
  expect([e.status, e.code]).toEqual([0, "timeout"])
})

test("a 401 over a base URL is UnknownDevice, saying to pair this browser again, whatever its body", async () => {
  for (const body of ['{"error": "bad_session", "message": "no session"}', "<html>sign in</html>"]) {
    const { base } = serve({ answer: () => new Response(body, { status: 401 }) })
    const e = await failure(createOfficeClient({ baseUrl: base }).whoami())
    expect(e).toBeInstanceOf(UnknownDevice)
    expect(e.status).toBe(401)
    expect(e.message).toContain("pair this browser again")
    stopServers()
  }
})

test("a 401 from signing in with a password is bad_credentials, not UnknownDevice, whatever its body", async () => {
  for (const body of ['{"error": "bad_credentials", "message": "wrong handle or password"}', "<html>sign in</html>"]) {
    const { base } = serve({ answer: () => new Response(body, { status: 401 }) })
    const e = await failure(createOfficeClient({ baseUrl: base }).signIn({ handle: "ann", password: "pw" }))
    expect(e).toBeInstanceOf(OfficeError)
    expect(e).not.toBeInstanceOf(UnknownDevice)
    expect([e.status, e.code, e.message]).toEqual([401, "bad_credentials", "wrong handle or password"])
    stopServers()
  }
})

test("an office without /api/login refuses it as it refuses any session-less write: that 401 stays sign_in_required", async () => {
  const { base } = serve({
    answer: () => Response.json({ error: "sign_in_required", message: "sign in first" }, { status: 401 }),
  })
  const e = await failure(createOfficeClient({ baseUrl: base }).signIn({ handle: "ann", password: "pw" }))
  expect(e).toBeInstanceOf(UnknownDevice)
  expect([e.status, e.code]).toEqual([401, "sign_in_required"])
})

test("a Retry-After header in seconds rides on the error; one that isn't seconds is left out", async () => {
  const tooMany = (retry: string) => () =>
    Response.json(
      { error: "too_many_attempts", message: "too many tries" },
      { status: 429, headers: { "retry-after": retry } },
    )
  const { base } = serve({ answer: tooMany("120") })
  const e = await failure(createOfficeClient({ baseUrl: base }).signIn({ handle: "ann", password: "pw" }))
  expect([e.status, e.code, e.retryAfterS]).toEqual([429, "too_many_attempts", 120])
  stopServers()
  const { base: other } = serve({ answer: tooMany("Wed, 21 Oct 2026 07:28:00 GMT") })
  const dated = await failure(createOfficeClient({ baseUrl: other }).signIn({ handle: "ann", password: "pw" }))
  expect([dated.code, dated.retryAfterS]).toEqual(["too_many_attempts", undefined])
})

test("a 401 over the socket still says to log in", async () => {
  const dir = mkdtempSync("/tmp/oct-")
  onStop(() => rmSync(dir, { recursive: true, force: true }))
  serve({ unix: path.join(dir, "o.sock"), answer: () => new Response("<html></html>", { status: 401 }) })
  const e = await failure(createOfficeClient({ socket: path.join(dir, "o.sock") }).whoami())
  expect(e).toBeInstanceOf(UnknownDevice)
  expect([e.code, e.message]).toEqual(["unauthenticated", "the office doesn't know this device: run `opencorp login`"])
})

test("a 200 HTML body (a dev server's index.html fallback) is bad_response", async () => {
  const { base } = serve({ answer: () => new Response("<!doctype html><html></html>", { status: 200 }) })
  const e = await failure(createOfficeClient({ baseUrl: base }).whoami())
  expect(e).toBeInstanceOf(OfficeError)
  expect([e.status, e.code]).toEqual([200, "bad_response"])
})

test("the event stream follows a base URL", async () => {
  const { seen, base } = serve({
    answer: () => new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } }),
  })
  const first = await new Promise<StreamEvent>((resolve) => {
    const sub = subscribe({ baseUrl: base }, (e) => {
      sub.close()
      resolve(e)
    })
  })
  expect(first).toEqual({ type: "connected" })
  expect(seen[0].path).toBe("/api/events")
})

test("a refused stream is an OfficeError with the response's status", async () => {
  const { base } = serve({ answer: () => new Response("forbidden", { status: 403 }) })
  const first = await new Promise<StreamEvent>((resolve) => {
    const sub = subscribe({ baseUrl: base }, (e) => {
      sub.close()
      resolve(e)
    })
  })
  const error = (first as { error?: any }).error
  expect(first.type).toBe("unreachable")
  expect(error).toBeInstanceOf(OfficeError)
  expect([error.status, error.code]).toEqual([403, "bad_response"])
})

test("a 401 on the stream reaches onStatus as an UnknownDevice the app can recognize", async () => {
  const { base } = serve({ answer: () => new Response("", { status: 401 }) })
  const seen: [OfficeStatus, string | undefined, unknown][] = []
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ baseUrl: base }),
    state: () => state,
    mutate: (f) => f(state),
    onStatus: (s, error, cause) => seen.push([s, error, cause]),
    stream: { minDelayMs: 10, maxDelayMs: 40 },
  })
  sync.start()
  onStop(sync.stop)
  while (!seen.length) await Bun.sleep(5)
  const [status, message, cause] = seen[0]
  expect(status).toBe("error")
  expect(cause).toBeInstanceOf(UnknownDevice)
  expect(message).toBe((cause as UnknownDevice).message)
  expect(message).toContain("pair this browser again")
})

test("a refusal after an outage is reported: 503, then 401, ends as an UnknownDevice error", async () => {
  let status = 503
  const { base } = serve({ answer: () => new Response("", { status }) })
  const seen: [OfficeStatus, unknown][] = []
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ baseUrl: base }),
    state: () => state,
    mutate: (f) => f(state),
    onStatus: (s, _error, cause) => seen.push([s, cause]),
    stream: { minDelayMs: 10, maxDelayMs: 40 },
  })
  sync.start()
  onStop(sync.stop)
  while (!seen.length) await Bun.sleep(5)
  expect(seen[0][0]).toBe("offline")
  expect((seen[0][1] as OfficeError).status).toBe(503)
  status = 401
  while (seen.length < 2) await Bun.sleep(5)
  expect(seen.length).toBe(2)
  expect(seen[1][0]).toBe("error")
  expect(seen[1][1]).toBeInstanceOf(UnknownDevice)
})

test("a stream refused with one status and then another reports each; repeated network failures report once", async () => {
  let status = 503
  const { base, stop } = serve({ answer: () => new Response("", { status }) })
  const seen: StreamEvent[] = []
  const sub = subscribe({ baseUrl: base }, (e) => seen.push(e), { minDelayMs: 5, maxDelayMs: 10 })
  onStop(sub.close)
  while (seen.length < 1) await Bun.sleep(5)
  await Bun.sleep(50) // more 503s: still one report
  expect(seen.length).toBe(1)
  status = 403
  while (seen.length < 2) await Bun.sleep(5)
  expect(((seen[1] as { error?: any }).error as OfficeError).status).toBe(403)
  stop()
  while (seen.length < 3) await Bun.sleep(5)
  await Bun.sleep(50) // more refused connections: still one report
  expect(seen.map((e) => e.type)).toEqual(["unreachable", "unreachable", "unreachable"])
  expect((seen[2] as { error?: any }).error).not.toBeInstanceOf(OfficeError)
})

/** A client over a recording unix socket server. */
function socketClient() {
  const dir = mkdtempSync("/tmp/oct-")
  onStop(() => rmSync(dir, { recursive: true, force: true }))
  const socket = path.join(dir, "o.sock")
  const { seen } = serve({ unix: socket })
  return { client: createOfficeClient({ socket }), seen }
}

type Client = ReturnType<typeof createOfficeClient>
const body = {} as never

/** Each method that puts a caller's value in the path, how to call it with `bad` there, and the office's not_found. */
const GUARDED: [string, (c: Client, bad: string) => Promise<unknown>, (bad: string) => string][] = [
  ["sessions.get", (c, b) => c.sessions.get(b), (b) => `no session ${b}`],
  ["sessions.messages", (c, b) => c.sessions.messages(b), (b) => `no session ${b}`],
  ["sessions.prompt", (c, b) => c.sessions.prompt(b, body), (b) => `no session ${b}`],
  ["sessions.steer", (c, b) => c.sessions.steer(b, body), (b) => `no session ${b}`],
  ["sessions.interrupt", (c, b) => c.sessions.interrupt(b), (b) => `no session ${b}`],
  ["sessions.end", (c, b) => c.sessions.end(b), (b) => `no session ${b}`],
  ["sessions.continue", (c, b) => c.sessions.continue(b), (b) => `no session ${b}`],
  ["sessions.costCap", (c, b) => c.sessions.costCap(b, body), (b) => `no session ${b}`],
  ["sessions.setModel", (c, b) => c.sessions.setModel(b, body), (b) => `no session ${b}`],
  ["questions.get", (c, b) => c.questions.get(b), (b) => `no question ${b}`],
  ["questions.answer", (c, b) => c.questions.answer(b, body), (b) => `no question ${b}`],
  ["questions.side", (c, b) => c.questions.side(b, body), (b) => `no question ${b}`],
  ["questions.sendBack", (c, b) => c.questions.sendBack(b, body), (b) => `no question ${b}`],
  ["questions.stop", (c, b) => c.questions.stop(b), (b) => `no question ${b}`],
  ["questions.dismissCarried", (c, b) => c.questions.dismissCarried(b), (b) => `no question ${b}`],
  ["runs.get", (c, b) => c.runs.get(b), (b) => `no run ${b}`],
  ["runs.nodes", (c, b) => c.runs.nodes(b), (b) => `no run ${b}`],
  ["runs.events", (c, b) => c.runs.events(b), (b) => `no run ${b}`],
  ["runs.event", (c, b) => c.runs.event(b, 1), (b) => `no run ${b}`],
  ["devices.add", (c, b) => c.devices.add(b, body), (b) => `no person @${b}`],
  ["devices.remove", (c, b) => c.devices.remove(b, "mac"), (b) => `no person @${b}`],
  ["devices.remove (name)", (c, b) => c.devices.remove("ann", b), () => "@ann has no device by that name"],
  ["people.setPassword", (c, b) => c.people.setPassword(b, body), (b) => `no person @${b}`],
  ["hq.removeBrowser", (c, b) => c.hq.removeBrowser(b), (b) => `no browser session ${b}`],
  ["connections.models", (c, b) => c.connections.models(b), (b) => `there is no connection '${b}' on this office`],
  ["connections.remove", (c, b) => c.connections.remove(b), (b) => `there is no connection '${b}' on this office`],
  ["connections.login", (c, b) => c.connections.login(b), (b) => `no sign-in ${b}`],
  ["connections.cancelLogin", (c, b) => c.connections.cancelLogin(b), (b) => `no sign-in ${b}`],
  ["workItems.get", (c, b) => c.workItems.get(b), (b) => `no work item ${b}`],
  ["workItems.comments", (c, b) => c.workItems.comments(b), (b) => `no work item ${b}`],
  ["profiles.get", (c, b) => c.profiles.get(b), (b) => `no person ${b}`],
  ["profiles.put", (c, b) => c.profiles.put(b, body), (b) => `no person ${b}`],
  ["profiles.manager", (c, b) => c.profiles.manager(b, body), (b) => `no person ${b}`],
  ["profiles.proposals", (c, b) => c.profiles.proposals(b), (b) => `no person ${b}`],
  ["proposals.apply", (c, b) => c.proposals.apply(b), (b) => `no profile proposal ${b}`],
]

/** Methods with no caller value in the path (a query string carries any). */
const NO_PATH_SEGMENT = new Set([
  "whoami",
  "health",
  "company.get",
  "company.tree",
  "company.file", // its path goes in the query
  "costs.since",
  "runs.list",
  "runs.children", // the parent goes in the query
  "pair",
  "signIn",
  "logout",
  "hq.status",
  "hq.pair",
  "hq.browsers",
  "login",
  "people.list",
  "people.inFolder", // a folder path, slashes and all: tested on its own
  "people.hire",
  "sessions.list",
  "sessions.create",
  "connections.list",
  "connections.add",
  "connections.setDefault",
  "connections.startLogin",
  "questions.list",
  "events.subscribe",
])

/** Methods that put an id in the path but aren't guarded. */
const UNGUARDED = new Set([
  "runs.logUrl", // builds a link and sends nothing
  "runs.live", // HQ-only stream: the office answers no_route, which its caller reports
])

test("an id no path segment can carry is not_found, in the office's words, and nothing is sent", async () => {
  const { client, seen } = socketClient()
  for (const [name, call, missing] of GUARDED)
    for (const bad of ["", ".", "..", "a/b", "../x"]) {
      let p: Promise<unknown>
      try {
        p = call(client, bad)
      } catch (e) {
        throw new Error(`${name}(${JSON.stringify(bad)}) threw instead of rejecting: ${e}`)
      }
      const e = await failure(p)
      expect([name, bad, e instanceof OfficeError, e.status, e.code, e.message]).toEqual([
        name,
        bad,
        true,
        404,
        "not_found",
        missing(bad),
      ])
    }
  expect(seen).toEqual([])
})

test("ids a path segment can carry are sent, encoded", async () => {
  const { client, seen } = socketClient()
  for (const id of ["S1", "a.b", "...", "%2e", "a%2Fb"]) await client.sessions.get(id)
  expect(seen.map((r) => r.path)).toEqual([
    "/sessions/S1",
    "/sessions/a.b",
    "/sessions/...",
    "/sessions/%252e",
    "/sessions/a%252Fb",
  ])
})

test("people.inFolder answers [] for a folder no request can name, and sends a folder path whole", async () => {
  const { client, seen } = socketClient()
  for (const cwd of ["", ".", "..", "/a/../b", "../x"]) expect(await client.people.inFolder(cwd)).toEqual([])
  expect(seen).toEqual([])
  await client.people.inFolder("/Users/me/proj")
  expect(seen.map((r) => r.path)).toEqual(["/folders/%2FUsers%2Fme%2Fproj/people"])
})

test("every client method is guarded, carries no path value, or is listed as unguarded", () => {
  const names: string[] = []
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o))
      if (typeof v === "function") names.push(prefix + k)
      else if (v && typeof v === "object") walk(v as Record<string, unknown>, `${prefix}${k}.`)
  }
  walk(createOfficeClient({ socket: "/nowhere" }), "")
  const guarded = new Set(GUARDED.map(([name]) => name.split(" ")[0]))
  expect(names.filter((n) => !guarded.has(n) && !NO_PATH_SEGMENT.has(n) && !UNGUARDED.has(n))).toEqual([])
})
