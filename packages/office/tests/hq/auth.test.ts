/** HQ's session check on /api: the open requests, the cookie named for the port, and the 401 without a session. */
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { newToken } from "../../src/auth/tokens.ts"
import { HttpError } from "../../src/daemon/http.ts"
import { COOKIE_KEY_FILE, SIGN_IN, browserAuth, cookieKey } from "../../src/hq/auth.ts"
import { Hq } from "../../src/hq/core.ts"
import type { BrowserSessions, Who } from "../../src/hq/sessions.ts"
import { tempDir } from "../helpers.ts"
import { CEO, addHuman, makeOffice } from "../daemon/helpers.ts"
import { type HqClient, PORT, cookieOf, handEdit, hqClient, makeHq, pairCode, web } from "./helpers.ts"

setDefaultTimeout(30_000)

type Cookie = string | null | undefined

const HOST = "127.0.0.1:49380"
const KEY = "0123456789abcdef0123456789abcdef"
const NAME = `opencorp_hq_49380_${KEY}`

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
    ["POST", "/api/logout"],
    ["GET", "/"],
    ["GET", "/assets/x.js"],
    // Decoded to /api/login, as uvicorn decoded the path Python matched.
    ["POST", "/api/%6cogin"],
  ]
  for (const [method, url] of open) {
    const s = sessions()
    expect(await browserAuth(s, request(method, url), KEY)).toBeNull()
    expect(s.asked).toEqual([])
  }
  for (const [method, url] of [
    ["GET", "/api/login"],
    ["POST", "/api/login/"],
    ["POST", "/api/loginx"],
    ["GET", "/api/logout"],
    ["POST", "/api/logout/"],
  ] as const) {
    const s = sessions(WHO)
    expect(await browserAuth(s, request(method, url), KEY)).toBe(WHO)
    expect(s.asked).toEqual([undefined])
  }
})

test("the session check reads the cookie named for the host port and the key", async () => {
  const ask = async (cookie: string, host = HOST) => {
    const s = sessions(WHO)
    await browserAuth(s, request("GET", "/api/x", [["Host", host], ["Cookie", cookie]]), KEY)
    return s.asked
  }
  expect(await ask(`a=b; opencorp_hq_1_${KEY}=x; opencorp_hq_49380=x; ${NAME}=sid.secret`)).toEqual(["sid.secret"])
  expect(await ask(`${NAME}=no; opencorp_hq_127.0.0.1_${KEY}=yes`, "127.0.0.1")).toEqual(["yes"])
  expect(await ask(`${NAME}=; ${NAME}=later`)).toEqual(["later"])
  expect(await ask(`${NAME}=real; ${NAME}=`)).toEqual(["real"])
  // A page on another port can't learn the key, so whatever it plants misses the name: a cookie at a deeper path,
  // or a nameless `=name=value` one, which the browser sends as a bare `name=value`.
  expect(await ask(`opencorp_hq_49380=junk; ${NAME}=sid.secret; opencorp_hq_49380=junk`)).toEqual(["sid.secret"])
  expect(await ask(`opencorp_hq_49380_${"f".repeat(32)}=junk`)).toEqual([undefined])
})

test("only the first cookie header counts", async () => {
  const s = sessions(WHO)
  const headers: [string, string][] = [
    ["Host", HOST],
    ["Cookie", "a=b"],
    ["Cookie", `${NAME}=sid.secret`],
  ]
  await browserAuth(s, request("GET", "/api/x", headers), KEY)
  expect(s.asked).toEqual([undefined])
})

test("the cookie key is random, kept in the office dir, and replaced when unreadable", () => {
  const dir = tempDir()
  const key = cookieKey(dir)
  expect(key).toMatch(/^[0-9a-f]{32}$/)
  const file = path.join(dir, COOKIE_KEY_FILE)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(cookieKey(dir)).toBe(key)
  expect(cookieKey(tempDir())).not.toBe(key)
  fs.writeFileSync(file, "opencorp_hq\n")
  const fresh = cookieKey(dir)
  expect(fresh).toMatch(/^[0-9a-f]{32}$/)
  expect(fs.readFileSync(file, "utf8").trim()).toBe(fresh)
})

test("hq keeps its cookie name across restarts", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  expect(Hq.create(office, { log: () => {} }).cookieKey).toBe(hq.cookieKey)
})

test("without a live session the api is 401 sign in required", async () => {
  for (const headers of [
    [["Host", HOST]],
    [["Host", HOST], ["Authorization", "Bearer act_0123456789abcdef"]],
  ] as [string, string][][]) {
    let error: unknown
    try {
      await browserAuth(sessions(), request("GET", "/api/x", headers), KEY)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401, code: "sign_in_required", message: SIGN_IN })
  }
  expect(await browserAuth(sessions(WHO), request("GET", "/api/x"), KEY)).toBe(WHO)
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
  client.cookies.set(cookieOf(hq), cookie)
  expect((await client.get("/api/whoami")).json()).toEqual({ person: CEO, device: session.name })
})

test("a cookie named for another port or without the key doesnt count", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(cookieOf(hq, 1), cookie)
  expect((await client.get("/api/whoami")).status).toBe(401)
  client.cookies.set(`opencorp_hq_${PORT}`, cookie)
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("on hq sock the cookie is named for the forwarded port", async () => {
  const hq = await makeHq(makeOffice())
  const [, cookie] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  const client = await hqClient(hq, {
    port: null,
    host: "127.0.0.1:5555",
    headers: { cookie: `${cookieOf(hq, 5555)}=${cookie}` },
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
  expect(cookie.startsWith(`${cookieOf(hq)}=`)).toBe(true)
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
  client.cookies.set(cookieOf(hq), `${other.id}.forged`)
  expect((await pair(client, hq)).status).toBe(200)
  expect(office.store.getHqSession(other.id)).toBeDefined()
})

test("a pair with a control character label is 422 and keeps the code", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const code = await pairCode(hq)
  const r = await client.post("/api/pair", { code, label: "Safari\u001b[2J" })
  expect([r.status, (r.json() as Body).error]).toEqual([422, "invalid_body"])
  expect((r.json() as Body).message).toContain("label")
  for (const echoed of ["\u001b", "Safari", code]) expect(r.text).not.toContain(echoed)
  expect((await client.post("/api/pair", { code })).status).toBe(200)
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

test("planted cookies around it dont block use or logout", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const sid = ((await pair(client, hq)).json() as Body).id as string
  const name = cookieOf(hq)
  // What another port can plant without the key: a cookie at a deeper path in front, a nameless one behind.
  const planted = `opencorp_hq_${PORT}=junk`
  const headers = { cookie: `${planted}; ${name}=${client.cookies.get(name)}; ${planted}` }
  expect((await client.get("/api/whoami", { headers })).json()).toMatchObject({ person: CEO })
  const r = await client.post("/api/logout", {}, { headers })
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  expect(office.store.getHqSession(sid)).toBeUndefined()
})

test("pairing again with planted cookies around it replaces the real session", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const first = ((await pair(client, hq)).json() as Body).id as string
  const name = cookieOf(hq)
  // What another port can plant without the key: a cookie at a deeper path in front, a nameless one behind.
  const planted = `opencorp_hq_${PORT}=junk`
  const headers = { cookie: `${planted}; ${name}=${client.cookies.get(name)}; ${planted}` }
  const r = await client.post("/api/pair", { code: await pairCode(hq) }, { headers })
  expect(r.status).toBe(200)
  expect(office.store.getHqSession(first)).toBeUndefined()
  expect(office.store.getHqSession((r.json() as Body).id as string)).toBeDefined()
})

test("logout needs a session", async () => {
  const client = await web(await makeHq(makeOffice()))
  expect((await client.post("/api/logout", {})).status).toBe(401)
})

test("logout while the person file cant be read ends the session", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const sid = ((await pair(client, hq)).json() as Body).id as string
  const cookie = `${cookieOf(hq)}=${client.cookies.get(cookieOf(hq))}`
  handEdit(office.paths.company, CEO, { nickname: "typo" })
  expect((await client.get("/api/whoami")).status).toBe(401)
  const r = await client.post("/api/logout", {})
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  expect(r.headers["set-cookie"]![0]).toContain("Max-Age=0")
  expect(office.store.getHqSession(sid)).toBeUndefined()
  handEdit(office.paths.company, CEO, { nickname: undefined })
  expect((await client.get("/api/whoami", { headers: { cookie } })).status).toBe(401)
})

test("logout with a cookie that proves nothing revokes nothing", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const [other] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(cookieOf(hq), `${other.id}.forged`)
  const r = await client.post("/api/logout", {})
  expect([r.status, (r.json() as Body).error]).toEqual([401, "sign_in_required"])
  expect(office.store.getHqSession(other.id)).toBeDefined()
})

test("a cross site logout is refused and ends nothing", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  const client = await web(hq)
  const sid = ((await pair(client, hq)).json() as Body).id as string
  const cookie = `${cookieOf(hq)}=${client.cookies.get(cookieOf(hq))}`
  for (const [headers, error] of [
    [{ "sec-fetch-site": "same-site" }, "cross_site"],
    [{ "sec-fetch-site": "cross-site" }, "cross_site"],
    [{ origin: "http://evil.example" }, "origin_not_allowed"],
    [{ origin: `http://127.0.0.1:${PORT + 1}` }, "origin_not_allowed"],
  ] as const) {
    const r = await client.post("/api/logout", {}, { headers })
    expect([r.status, (r.json() as Body).error]).toEqual([403, error])
  }
  const bare = await hqClient(hq, { headers: { cookie } })
  const r = await bare.post("/api/logout", {})
  expect([r.status, (r.json() as Body).error]).toEqual([403, "origin_not_allowed"])
  expect(office.store.getHqSession(sid)).toBeDefined()
  expect((await client.get("/api/whoami")).status).toBe(200)
})

test("pairing replaces the old session even while its person file cant be read", async () => {
  const office = makeOffice()
  const hq = await makeHq(office)
  addHuman(office.paths.company, "lan")
  const client = await web(hq)
  const first = ((await pair(client, hq)).json() as Body).id as string
  handEdit(office.paths.company, CEO, { nickname: "typo" })
  const code = (await hq.mint("lan", { issuer: CEO, openFile: false })).path.split("#")[1]!
  const r = await client.post("/api/pair", { code })
  expect([r.status, (r.json() as Body).person]).toEqual([200, "lan"])
  expect(office.store.getHqSession(first)).toBeUndefined()
})

test("a failing read of the old cookie doesnt burn the code", async () => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const code = await pairCode(hq)
  // An own property over the prototype's method, deleted below so the method is back.
  Object.assign(hq.sessions, {
    proven: () => {
      throw new Error("store went away")
    },
  })
  try {
    expect((await client.post("/api/pair", { code })).status).toBe(500)
  } finally {
    delete (hq.sessions as { proven?: unknown }).proven
  }
  expect((await client.post("/api/pair", { code })).status).toBe(200)
})
