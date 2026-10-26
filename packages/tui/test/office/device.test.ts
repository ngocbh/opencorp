import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, serveUnix, type FakeOffice } from "../fixture/fake-office"
import {
  createOfficeClient,
  OfficeError,
  UnknownDevice,
  request,
  subscribe,
  type StreamEvent,
  emptyState,
  createOfficeSync,
} from "@opencorp/client"
import { newToken, tokenSha256 } from "@opencorp/client/node"
import { until } from "../fixture/until"

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )
function fake() {
  const office = createFakeOffice()
  cleanup.push(office.stop)
  return office
}
/** Lists a new token for `handle` in `office`, as `person.yaml` would; returns the token. */
function trust(office: FakeOffice, handle: string, name = "mac") {
  const token = newToken()
  const person = office.state.people.find((p) => p.handle === handle)!
  person.devices = [...(person.devices ?? []), { name, token_sha256: tokenSha256(token) }]
  return token
}

test("a token goes in the Authorization header, and only when there is one", async () => {
  const seen: (string | null)[] = []
  const srv = serveUnix((req) => (seen.push(req.headers.get("authorization")), Response.json({})))
  cleanup.push(srv.stop)
  const token = newToken()
  await request(srv.socket, "GET", "/people", undefined, { token })
  await request(srv.socket, "POST", "/feedback", { x: 1 }, { token })
  await request(srv.socket, "GET", "/people")
  expect(seen).toEqual([`Bearer ${token}`, `Bearer ${token}`, null])
})

test("a 401 is one line that says to log in, without the token", async () => {
  const token = newToken()
  const srv = serveUnix(() =>
    Response.json({ error: "bad_token", message: "the office doesn't know this device" }, { status: 401 }),
  )
  cleanup.push(srv.stop)
  const e = await failure(request(srv.socket, "GET", "/people", undefined, { token }))
  expect(e).toBeInstanceOf(UnknownDevice)
  expect(e).toBeInstanceOf(OfficeError)
  expect([e.status, e.code, e.message]).toEqual([401, "bad_token", "the office doesn't know this device: run `opencorp login`"])
  expect(String(e)).not.toContain(token)
})

test("the event stream carries the token, and a refused one is reported as an unknown device", async () => {
  const office = fake()
  const token = trust(office, "ngocbh")
  const seen: StreamEvent[] = []
  const good = subscribe(office.socket, (e) => seen.push(e), { token, minDelayMs: 10 })
  cleanup.push(good.close)
  await until(() => seen.some((e) => e.type === "connected"))
  expect(office.requests.find((r) => r.path === "/events")?.authorization).toBe(`Bearer ${token}`)
  const refused: StreamEvent[] = []
  const bad = subscribe(office.socket, (e) => refused.push(e), { minDelayMs: 10 })
  cleanup.push(bad.close)
  await until(() => refused.length > 0)
  expect(refused[0].type).toBe("unreachable")
  expect((refused[0] as { error?: unknown }).error).toBeInstanceOf(UnknownDevice)
})

test("the TUI's sync shows a refused device as an error, not as no office", async () => {
  const office = fake()
  trust(office, "ngocbh")
  const state = emptyState()
  const sync = createOfficeSync({
    client: createOfficeClient({ socket: office.socket, token: newToken() }),
    cwd: "/tmp/proj",
    state: () => state,
    mutate: (f) => f(state),
    stream: { minDelayMs: 10, maxDelayMs: 40 },
  })
  sync.start()
  cleanup.push(sync.stop)
  await until(() => sync.status() === "error")
  expect(sync.error()).toBe("the office doesn't know this device: run `opencorp login`")
})

test("the stub office: open as the CEO until a human has a device, then a token is needed", async () => {
  const office = fake()
  const open = createOfficeClient({ socket: office.socket })
  expect(await open.whoami()).toEqual({ person: "ngocbh", device: null })
  const token = newToken()
  // The first device needs no token: the bootstrap.
  const person = await open.devices.add("ngocbh", { name: "mac", token_sha256: tokenSha256(token) })
  expect(person.devices).toEqual([{ name: "mac", token_sha256: tokenSha256(token) }])
  expect((await failure(open.people.list())).code).toBe("unauthenticated")
  expect((await failure(createOfficeClient({ socket: office.socket, token: newToken() }).whoami())).code).toBe(
    "bad_token",
  )
  const me = createOfficeClient({ socket: office.socket, token })
  expect(await me.whoami()).toEqual({ person: "ngocbh", device: "mac" })
  expect(await request<unknown>(office.socket, "GET", "/health")).toEqual({ ok: true })
  // The same device again changes nothing; the name with another token is refused.
  expect((await me.devices.add("ngocbh", { name: "mac", token_sha256: tokenSha256(token) })).devices).toHaveLength(1)
  expect((await failure(me.devices.add("ngocbh", { name: "mac", token_sha256: tokenSha256(newToken()) }))).code).toBe(
    "device_exists",
  )
  expect((await failure(me.devices.add("minh", { name: "x", token_sha256: tokenSha256(newToken()) }))).code).toBe(
    "not_a_human",
  )
  expect((await failure(me.devices.remove("ngocbh", "nope"))).status).toBe(404)
  expect((await me.devices.remove("ngocbh", "mac")).devices).toBeUndefined()
  // With no devices left, the office is open again.
  expect(await open.whoami()).toEqual({ person: "ngocbh", device: null })
  expect(office.requests.find((r) => r.method === "DELETE")?.raw).toBe("/people/ngocbh/devices/nope")
})
