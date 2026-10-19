import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { createOfficeClient } from "../src/client"
import { OfficeUnavailable } from "../src/errors"
import { subscribe, type StreamEvent } from "../src/sse"

type Seen = { method: string; path: string; type: string | null; body: string }
let stop = () => {}
afterEach(() => stop())

/** A server that records each request and answers `{ok: true}`, on TCP or, with `unix`, on a socket. */
function serve(unix?: string) {
  const seen: Seen[] = []
  const fetch = async (req: Request) => {
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      type: req.headers.get("content-type"),
      body: await req.text(),
    })
    return Response.json({ ok: true })
  }
  const server = unix ? Bun.serve({ unix, fetch }) : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  stop = () => server.stop(true)
  return { seen, base: `http://127.0.0.1:${server.port}/api` }
}

test("a browser write with no body sends {} as JSON", async () => {
  const { seen, base } = serve()
  await createOfficeClient({ baseUrl: base }).sessions.interrupt("S1")
  expect(seen).toEqual([{ method: "POST", path: "/api/sessions/S1/interrupt", type: "application/json", body: "{}" }])
})

test("a browser read sends neither a body nor a content type", async () => {
  const { seen, base } = serve()
  await createOfficeClient({ baseUrl: base }).whoami()
  expect(seen).toEqual([{ method: "GET", path: "/api/whoami", type: null, body: "" }])
})

test("a socket write with no body still sends none", async () => {
  const dir = mkdtempSync("/tmp/oct-")
  const { seen } = serve(path.join(dir, "o.sock"))
  const prev = stop
  stop = () => (prev(), rmSync(dir, { recursive: true, force: true }))
  await createOfficeClient({ socket: path.join(dir, "o.sock") }).sessions.interrupt("S1")
  expect(seen).toEqual([{ method: "POST", path: "/sessions/S1/interrupt", type: null, body: "" }])
})

test("an unreachable base URL is OfficeUnavailable, naming the URL", async () => {
  const e = await createOfficeClient({ baseUrl: "http://127.0.0.1:9/api" })
    .whoami()
    .catch((e) => e)
  expect(e).toBeInstanceOf(OfficeUnavailable)
  expect(e.message).toContain("http://127.0.0.1:9/api")
})

test("the event stream follows a base URL", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      paths.push(new URL(req.url).pathname)
      return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  stop = () => server.stop(true)
  const first = await new Promise<StreamEvent>((resolve) => {
    const sub = subscribe({ baseUrl: `http://127.0.0.1:${server.port}/api` }, (e) => {
      sub.close()
      resolve(e)
    })
  })
  expect(first).toEqual({ type: "connected" })
  expect(paths[0]).toBe("/api/events")
})
