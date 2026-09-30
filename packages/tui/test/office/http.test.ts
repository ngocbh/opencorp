import { afterEach, expect, test } from "bun:test"
import { serveUnix } from "../../script/stub"
import {
  OfficeError,
  OfficeTimeout,
  OfficeUnavailable,
  VersionConflictError,
  isNotImplemented,
} from "../../src/office/errors"
import { request } from "../../src/office/http"

const stops: (() => void)[] = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))
/** The error `p` rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )
function serve(fetch: (req: Request) => Response | Promise<Response>) {
  const server = serveUnix(fetch)
  stops.push(server.stop)
  return server.socket
}

test("GET returns the parsed body", async () => {
  const seen: string[] = []
  const socket = serve(
    (req) => (seen.push(`${req.method} ${new URL(req.url).pathname}`), Response.json([{ id: "p1" }])),
  )
  expect(await request<unknown[]>(socket, "GET", "/people")).toEqual([{ id: "p1" }])
  expect(seen).toEqual(["GET /people"])
})

test("POST sends a JSON body", async () => {
  let body: unknown
  const types: (string | null)[] = []
  const socket = serve(async (req) => {
    body = await req.json()
    types.push(req.headers.get("content-type"))
    return Response.json({ ok: true })
  })
  expect(await request<object>(socket, "POST", "/sessions/s1/prompt", { text: "hi" })).toEqual({ ok: true })
  expect(body).toEqual({ text: "hi" })
  expect(types).toEqual(["application/json"])
})

test("an ApiError body becomes an OfficeError", async () => {
  const socket = serve(() =>
    Response.json({ error: "not_implemented", message: "POST /sessions is not implemented yet" }, { status: 501 }),
  )
  const err = await failure(request(socket, "POST", "/sessions", {}))
  expect(err).toBeInstanceOf(OfficeError)
  expect([err.status, err.code, err.message]).toEqual([501, "not_implemented", "POST /sessions is not implemented yet"])
  expect(isNotImplemented(err)).toBe(true)
})

test("a VersionConflict body becomes a VersionConflictError", async () => {
  const socket = serve(() => Response.json({ expected: "aaa", current: "bbb" }, { status: 409 }))
  const err = await failure(request(socket, "PUT", "/profiles/minh", { text: "x", base_version: "aaa" }))
  expect(err).toBeInstanceOf(VersionConflictError)
  expect([err.status, err.expected, err.current]).toEqual([409, "aaa", "bbb"])
})

test("a body that isn't JSON is a bad_response", async () => {
  const socket = serve(() => new Response("<html>", { status: 502 }))
  const err = await failure(request(socket, "GET", "/people"))
  expect([err.status, err.code]).toEqual([502, "bad_response"])
})

test("a missing socket is OfficeUnavailable", async () => {
  const err = await failure(request("/tmp/act-missing/o.sock", "GET", "/people"))
  expect(err).toBeInstanceOf(OfficeUnavailable)
  expect([err.status, err.code]).toEqual([0, "office_unavailable"])
})

test("a body that breaks off mid-read is a bad_response", async () => {
  const socket = serve(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"id":'))
            setTimeout(() => c.error(new Error("gone")), 20) // after the headers are out
          },
        }),
      ),
  )
  const err = await failure(request(socket, "GET", "/people"))
  expect(err).toBeInstanceOf(OfficeError)
  expect(err.code).toBe("bad_response")
})

test("a request with no answer inside timeoutMs is an OfficeTimeout", async () => {
  const socket = serve(() => new Promise<Response>(() => {}))
  const started = Date.now()
  const err = await failure(request(socket, "GET", "/people", undefined, { timeoutMs: 50 }))
  expect(err).toBeInstanceOf(OfficeTimeout)
  expect([err.status, err.code]).toEqual([0, "timeout"])
  expect(Date.now() - started).toBeLessThan(1000)
})

test("a body that stalls past timeoutMs is an OfficeTimeout", async () => {
  const socket = serve(
    () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("[")) })),
  )
  const err = await failure(request(socket, "GET", "/people", undefined, { timeoutMs: 50 }))
  expect(err).toBeInstanceOf(OfficeTimeout)
})

test("the caller's abort is passed through, not turned into a timeout", async () => {
  const socket = serve(() => new Promise<Response>(() => {}))
  const ctl = new AbortController()
  const p = failure(request(socket, "GET", "/people", undefined, { signal: ctl.signal, timeoutMs: 5000 }))
  ctl.abort()
  const err = await p
  expect(err).not.toBeInstanceOf(OfficeError)
  expect(err.name).toBe("AbortError")
})
