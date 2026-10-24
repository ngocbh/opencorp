/** HQ's session check on /api: the open requests, the cookie named for the port, and the 401 without a session. */
import type { IncomingMessage } from "node:http"
import { expect, test } from "bun:test"
import { HttpError } from "../../src/daemon/http.ts"
import { SIGN_IN, browserAuth } from "../../src/hq/auth.ts"
import type { Hq } from "../../src/hq/core.ts"
import type { BrowserSessions, Who } from "../../src/hq/sessions.ts"
import { CEO, makeOffice } from "../daemon/helpers.ts"
import { type HqClient, PORT, makeHq, pairCode, web } from "./helpers.ts"

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
