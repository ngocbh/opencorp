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
