/** HQ's routes on office.sock: status, minting links, and browser sessions. */
import { expect, test } from "bun:test"
import { newToken } from "../../src/auth/tokens.ts"
import { DeviceTokens } from "../../src/daemon/auth.ts"
import type { Office } from "../../src/daemon/office.ts"
import { allRoutes } from "../../src/daemon/routes/index.ts"
import type { Hq } from "../../src/hq/core.ts"
import { CEO, addHuman, bearer, giveDevice, makeOffice, request, serve } from "../daemon/helpers.ts"
import { makeHq } from "./helpers.ts"

type Headers = Record<string, string>

/** A client of the office socket's own table, with device tokens; `log` gets the pipeline's log lines. */
async function socketClient(office: Office, { log }: { log?: (line: string) => void } = {}) {
  const { sock } = await serve(allRoutes(), { context: new DeviceTokens(office).context, log })
  const send = async (method: string, target: string, headers: Headers = {}, json?: unknown) => {
    const body = json === undefined ? undefined : JSON.stringify(json)
    if (body !== undefined) headers = { ...headers, "content-type": "application/json" }
    const r = await request(sock, method, target, { headers, body })
    return { status: r.status, json: () => r.json() as any }
  }
  return {
    get: (target: string, headers?: Headers) => send("GET", target, headers),
    post: (target: string, json: unknown, headers?: Headers) => send("POST", target, headers, json),
    delete: (target: string, headers?: Headers) => send("DELETE", target, headers),
  }
}

/** An office with HQ attached and a client of its socket (Python's `sock`, `hq` and `company` fixtures). */
async function setup({ logs, log }: { logs?: string[]; log?: (line: string) => void } = {}) {
  const office = makeOffice({ log })
  const hq: Hq = await makeHq(office, { logs })
  return { office, hq, company: office.paths.company, sock: await socketClient(office, { log }) }
}

test("no device mode pairs as the ceo and stays unenforced", async () => {
  const { hq, sock } = await setup()
  const r = await sock.post("/hq/pair", {})
  expect(r.status).toBe(200)
  expect(r.json().path).toStartWith("/pair#")
  expect(r.json().url).toBeNull()
  expect(hq.codes.redeem(r.json().path.split("#")[1])!.issuer).toBe(CEO)
  // Still no token needed.
  expect((await sock.get("/whoami")).json()).toEqual({ person: CEO, device: null })
})

test("pairing never logs the code", async () => {
  const logs: string[] = []
  const lines: string[] = []
  const { sock } = await setup({ logs, log: (line) => lines.push(line) })
  const code = (await sock.post("/hq/pair", { open_file: true })).json().path.split("#")[1]
  expect(code).toBeTruthy()
  expect([...logs, ...lines].some((line) => line.includes(code))).toBe(false)
})

test("the handle must be a known human", async () => {
  const { sock } = await setup()
  expect((await sock.post("/hq/pair", { handle: "minh" })).json().error).toBe("not_a_human")
  expect((await sock.post("/hq/pair", { handle: "nobody" })).status).toBe(404)
})

test("only the person or the ceo may pair for them", async () => {
  const { hq, company, sock } = await setup()
  addHuman(company, "ann")
  const [ceo, ann] = [newToken(), newToken()]
  giveDevice(company, CEO, "mac", ceo)
  giveDevice(company, "ann", "laptop", ann)
  expect((await sock.post("/hq/pair", {})).status).toBe(401)
  expect((await sock.post("/hq/pair", { handle: CEO }, bearer(ann))).status).toBe(403)
  const r = await sock.post("/hq/pair", { handle: "ann" }, bearer(ceo))
  expect(r.status).toBe(200)
  expect(hq.codes.redeem(r.json().path.split("#")[1])!.handle).toBe("ann")
  expect((await sock.post("/hq/pair", {}, bearer(ann))).status).toBe(200)
})

test("browsers are listed and removed by their person or the ceo", async () => {
  const { hq, company, sock } = await setup()
  addHuman(company, "ann")
  const [ceo, ann] = [newToken(), newToken()]
  giveDevice(company, CEO, "mac", ceo)
  giveDevice(company, "ann", "laptop", ann)
  const [mine, cookie] = await hq.sessions.issue("ann", { issuedBy: CEO, label: "Firefox" })
  const listed = (await sock.get("/hq/browsers", bearer(ann))).json()
  expect(listed.map((b: { [k: string]: unknown }) => [b.id, b.issued_by, b.label])).toEqual([[mine.id, CEO, "Firefox"]])
  expect("secret_sha256" in listed[0]!).toBe(false)
  expect("password_fp" in listed[0]!).toBe(false)
  expect((await sock.get(`/hq/browsers?person=${CEO}`, bearer(ann))).status).toBe(403)
  expect((await sock.get("/hq/browsers?person=ann", bearer(ceo))).status).toBe(200)
  const [theirs] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  expect((await sock.delete(`/hq/browsers/${theirs.id}`, bearer(ann))).status).toBe(403)
  expect((await sock.delete(`/hq/browsers/${mine.id}`, bearer(ann))).json()).toEqual({ ok: true })
  expect(await hq.sessions.check(cookie)).toBeNull()
  expect((await sock.delete(`/hq/browsers/${mine.id}`, bearer(ceo))).status).toBe(404)
  expect((await sock.delete(`/hq/browsers/${theirs.id}`, bearer(ceo))).json()).toEqual({ ok: true })
})

test("status", async () => {
  const { hq, sock } = await setup()
  const r = await sock.get("/hq")
  expect(r.status).toBe(200)
  expect(r.json().socket).toEndWith("hq.sock")
  expect(r.json().tcp.enabled).toBe(false)
  expect(r.json().health.office.api).toBe(hq.api)
})

test("without hq the routes are 501", async () => {
  const office = makeOffice()
  const sock = await socketClient(office)
  expect(office.hq).toBeUndefined()
  expect((await sock.get("/hq")).status).toBe(501)
  expect((await sock.post("/hq/pair", {})).status).toBe(501)
})

test("get hq reports off retrying and listening", async () => {
  const { hq, sock } = await setup()
  expect((await sock.get("/hq")).json().tcp.listening).toBe(false)
  hq.tcpError = "Address already in use"
  hq.nextRetryAt = "2026-10-19T10:00:05.000Z"
  let body = (await sock.get("/hq")).json()
  expect(body.tcp.error).toBe("Address already in use")
  expect(body.url).toBeNull()
  hq.tcpError = hq.nextRetryAt = null
  hq.boundPort = 49999
  body = (await sock.get("/hq")).json()
  expect(body.tcp).toEqual({ enabled: false, port: 49999, listening: true, error: null, next_retry_at: null })
  expect(body.url).toBe("http://127.0.0.1:49999/")
})
