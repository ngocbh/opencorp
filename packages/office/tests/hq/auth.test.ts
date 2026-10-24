/** HQ's session check on /api: the open requests, the cookie named for the port, and the 401 without a session. */
import type { IncomingMessage } from "node:http"
import { expect, setDefaultTimeout, test } from "bun:test"
import { newToken } from "../../src/auth/tokens.ts"
import { HttpError } from "../../src/daemon/http.ts"
import { SIGN_IN, browserAuth } from "../../src/hq/auth.ts"
import type { Hq } from "../../src/hq/core.ts"
import type { BrowserSessions, Who } from "../../src/hq/sessions.ts"
import { CEO, makeOffice } from "../daemon/helpers.ts"
import { type HqClient, PORT, hqClient, makeHq, pairCode, web } from "./helpers.ts"

setDefaultTimeout(30_000)

type Cookie = string | null | undefined

const HOST = "127.0.0.1:49380"

/** A stand-in request: only the method, target and raw headers are read. */
function request(method: string, url: string, headers: [string, string][] = [["Host", HOST]]): IncomingMessage {
  return { method, url, rawHeaders: headers.flat() } as IncomingMessage
}

/** A stand-in sessions object that records each cookie it is asked about and answers `who`. */
function sessions(who: Who | null = null): Pick<BrowserSessions, "check"> & { asked: Cookie[] } {
  const asked: Cookie[] = []
  return {
    asked,
    check: async (cookie) => {
      asked.push(cookie)
      return who
    },
  }
}

const WHO: Who = { id: "s1", person: "ceo", name: "laptop", view: {} as Who["view"] }

test("the open requests and the app need no session", async () => {
  const open: [string, string][] = [
    ["GET", "/api/health"],
    ["HEAD", "/api/health"],
    ["POST", "/api/pair"],
    ["POST", "/api/login"],
    ["GET", "/"],
    ["GET", "/assets/x.js"],
    // Decoded to /api/login, as uvicorn decoded the path Python matched.
    ["POST", "/api/%6cogin"],
  ]
  for (const [method, url] of open) {
    const s = sessions()
    expect(await browserAuth(s, request(method, url))).toBeNull()
    expect(s.asked).toEqual([])
  }
  for (const [method, url] of [
    ["GET", "/api/login"],
    ["POST", "/api/login/"],
    ["POST", "/api/loginx"],
  ] as const) {
    const s = sessions(WHO)
    expect(await browserAuth(s, request(method, url))).toBe(WHO)
    expect(s.asked).toEqual([undefined])
  }
})

test("the session check reads the cookie named for the host port", async () => {
  let s = sessions(WHO)
  const cookie = "a=b; opencorp_hq_1=x; opencorp_hq_49380=sid.secret"
  await browserAuth(s, request("GET", "/api/x", [["Host", HOST], ["Cookie", cookie]]))
  expect(s.asked).toEqual(["sid.secret"])

  s = sessions(WHO)
  const bare = "opencorp_hq_49380=no; opencorp_hq_127.0.0.1=yes"
  await browserAuth(s, request("GET", "/api/x", [["Host", "127.0.0.1"], ["Cookie", bare]]))
  expect(s.asked).toEqual(["yes"])

  s = sessions(WHO)
  const empty = "opencorp_hq_49380=; opencorp_hq_49380=later"
  await browserAuth(s, request("GET", "/api/x", [["Host", HOST], ["Cookie", empty]]))
  expect(s.asked).toEqual(["later"])
})

test("only the first cookie header counts", async () => {
  const s = sessions(WHO)
  const headers: [string, string][] = [
    ["Host", HOST],
    ["Cookie", "a=b"],
    ["Cookie", "opencorp_hq_49380=sid.secret"],
  ]
  await browserAuth(s, request("GET", "/api/x", headers))
  expect(s.asked).toEqual([undefined])
})

test("without a live session the api is 401 sign in required", async () => {
  for (const headers of [
    [["Host", HOST]],
    [["Host", HOST], ["Authorization", "Bearer act_0123456789abcdef"]],
  ] as [string, string][][]) {
    let error: unknown
    try {
      await browserAuth(sessions(), request("GET", "/api/x", headers))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401, code: "sign_in_required", message: SIGN_IN })
  }
  expect(await browserAuth(sessions(WHO), request("GET", "/api/x"))).toBe(WHO)
})

type Body = Record<string, unknown>

test("without a cookie api is 401 even with no devices", async () => {
  const r = await (await web(await makeHq(makeOffice()))).get("/api/whoami")
  const body = r.json() as Body
  expect(r.status).toBe(401)
  expect(body.error).toBe("sign_in_required")
  expect(body.message).toContain("opencorp pair")
  expect(r.headers).toHaveProperty("content-security-policy")
})

test("health and the app stay open", async () => {
  const client = await web(await makeHq(makeOffice()))
  expect((await client.get("/api/health")).status).toBe(200)
  expect((await client.get("/", { headers: { "sec-fetch-dest": "document" } })).status).not.toBe(401)
})

test("a bearer token is ignored", async () => {
  const client = await web(await makeHq(makeOffice()))
  expect((await client.get("/api/whoami", { headers: { authorization: `Bearer ${newToken()}` } })).status).toBe(401)
})

test("a valid cookie acts as its person", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const [session, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(`opencorp_hq_${PORT}`, cookie)
  expect((await client.get("/api/whoami")).json()).toEqual({ person: CEO, device: session.name })
})

test("a cookie named for another port doesnt count", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set("opencorp_hq_1", cookie)
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("on hq sock the cookie is named for the forwarded port", async () => {
  const hq = await makeHq(makeOffice())
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  const client = await hqClient(hq, {
    port: null,
    host: "127.0.0.1:5555",
    headers: { cookie: `opencorp_hq_5555=${cookie}` },
  })
  expect(((await client.get("/api/whoami")).json() as Body).person).toBe(CEO)
})

/** Pairs `client` as the CEO with a fresh code, naming the browser `label`. */
async function pair(client: HqClient, hq: Hq, label = "Safari on Mac") {
  return client.post("/api/pair", { code: await pairCode(hq), label })
}

test("pairing sets a strict http only cookie and returns the session", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const r = await pair(client, hq)
  const body = r.json() as Record<string, unknown>
  expect(r.status).toBe(200)
  expect(body.person).toBe(CEO)
  expect(body.label).toBe("Safari on Mac")
  expect(body.issued_by).toBe(CEO)
  expect(body).not.toHaveProperty("secret_sha256")
  const cookies = r.headers["set-cookie"]!
  expect(cookies).toHaveLength(1)
  const cookie = cookies[0]!
  expect(cookie.startsWith(`opencorp_hq_${PORT}=`)).toBe(true)
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) expect(cookie).toContain(part)
  expect(cookie).not.toContain("Secure")
  expect(((await client.get("/api/whoami")).json() as { person: string }).person).toBe(CEO)
})

test("a used or wrong code says to pair again", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const code = await pairCode(hq)
  expect((await client.post("/api/pair", { code })).status).toBe(200)
  for (const bad of [code, "nonsense"]) {
    const r = await client.post("/api/pair", { code: bad })
    const body = r.json() as Body
    expect([r.status, body.error]).toEqual([400, "pair_code_invalid"])
    expect(body.message).toContain("opencorp pair")
    expect(r.text).not.toContain(bad)
  }
})

test("pairing never logs the code or the cookie", async () => {
  const lines: string[] = []
  const hq = await makeHq(makeOffice({ log: (line) => lines.push(line) }), { logs: lines })
  const client = await web(hq)
  const code = await pairCode(hq)
  const r = await client.post("/api/pair", { code })
  const secret = r.headers["set-cookie"]![0]!.split("=")[1]!.split(";")[0]!.split(".")[1]!
  const text = lines.join("\n")
  expect(lines.length).toBeGreaterThan(0) // the mint's line, at least
  expect(text).not.toContain(code)
  expect(text).not.toContain(secret)
})

test("pairing again in the same browser revokes the old session", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const first = ((await pair(client, hq)).json() as Body).id as string
  const second = ((await pair(client, hq)).json() as Body).id as string
  expect(office.store.getHqSession(first)).toBeUndefined()
  expect(office.store.getHqSession(second)).toBeDefined()
})

test("pairing with a cookie that proves nothing revokes nothing", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const [other] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(`opencorp_hq_${PORT}`, `${other.id}.forged`)
  expect((await pair(client, hq)).status).toBe(200)
  expect(office.store.getHqSession(other.id)).toBeDefined()
})

test("logout ends the session and clears the cookie", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const sid = ((await pair(client, hq)).json() as Body).id as string
  const r = await client.post("/api/logout", {})
  expect(r.json()).toEqual({ ok: true })
  expect(r.headers["set-cookie"]![0]).toContain("Max-Age=0")
  expect(office.store.getHqSession(sid)).toBeUndefined()
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("logout needs a session", async () => {
  const client = await web(await makeHq(makeOffice()))
  expect((await client.post("/api/logout", {})).status).toBe(401)
})

test("a failing check of the old cookie doesnt burn the code", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const code = await pairCode(hq)
  // An own property over the prototype's method, deleted below so the method is back.
  Object.assign(hq.sessions, { check: async () => Promise.reject(new Error("git went away")) })
  try {
    expect((await client.post("/api/pair", { code })).status).toBe(500)
  } finally {
    delete (hq.sessions as { check?: unknown }).check
  }
  expect((await client.post("/api/pair", { code })).status).toBe(200)
})
