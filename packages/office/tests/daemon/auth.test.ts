/** Device tokens at the office: enforcement, the acting person, the open probe, and device routes. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { z } from "zod"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { actingPerson } from "../../src/daemon/auth.ts"
import type { Route } from "../../src/daemon/http.ts"
import type { RequestContext } from "../../src/daemon/office.ts"
import { git } from "../company/helpers.ts"
import {
  Conn,
  addHuman,
  bearer,
  exchange,
  giveDevice,
  makeOffice,
  parse,
  raw,
  request,
  served,
} from "./helpers.ts"

setDefaultTimeout(30_000)

const UNAUTHENTICATED = {
  error: "unauthenticated",
  message: "this office needs a device token; run `opencorp login`",
}

/** A stand-in GET route answering `[]`, for route areas not served here. */
function standIn(path: string): Route<RequestContext> {
  return { method: "GET", path, handler: () => [] }
}

const errorOf = (reply: { json(): unknown }) => (reply.json() as { error: string }).error

test("without devices an unauthenticated request acts as the ceo", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await request(sock, "GET", "/whoami")
  expect([r.status, r.json()]).toEqual([200, { person: "ngocbh", device: null }])
})

test("without enforcement a token is still checked", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  addHuman(office.paths.company, "ava")
  let r = await request(sock, "GET", "/whoami", { headers: bearer(newToken()) })
  expect([r.status, errorOf(r)]).toEqual([401, "bad_token"])
  r = await request(sock, "GET", "/whoami", { headers: { authorization: "Basic x" } })
  expect([r.status, errorOf(r)]).toEqual([401, "bad_token"])
})

test("once a human has a device unauthenticated requests are refused", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  giveDevice(office.paths.company, "ngocbh", "mac", newToken())
  for (const [method, target] of [
    ["GET", "/people"],
    ["GET", "/whoami"],
    ["POST", "/sessions"],
  ] as const) {
    const r = await request(sock, method, target)
    expect(r.status).toBe(401)
    expect(r.json()).toEqual(UNAUTHENTICATED)
  }
})

test("a token acts as its person", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true, extra: [standIn("/people")] })
  const company = office.paths.company
  addHuman(company, "ava")
  const ava = newToken()
  giveDevice(company, "ava", "pc", ava)
  expect((await request(sock, "GET", "/whoami", { headers: bearer(ava) })).json()).toEqual({
    person: "ava",
    device: "pc",
  })
  expect((await request(sock, "GET", "/people", { headers: bearer(ava) })).status).toBe(200)
  const r = await request(sock, "GET", "/people", { headers: bearer(newToken()) })
  expect([r.status, errorOf(r)]).toEqual([401, "bad_token"])
})

test("a refusal never echoes the token", async () => {
  const office = makeOffice()
  const lines: string[] = []
  const { sock } = await served(office, { tokens: true, log: (line) => lines.push(line) })
  giveDevice(office.paths.company, "ngocbh", "mac", newToken())
  const token = newToken()
  for (const header of [`Bearer ${token}`, `Bearer ${token}!`, token]) {
    const r = await request(sock, "GET", "/whoami", { headers: { authorization: header } })
    expect(r.status).toBe(401)
    expect(r.text).not.toContain(token)
  }
  expect(lines.filter((line) => line.includes(token))).toEqual([])
})

test("the health probe answers without a token", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  giveDevice(office.paths.company, "ngocbh", "mac", newToken())
  const r = await request(sock, "GET", "/health")
  expect([r.status, r.text, r.json()]).toEqual([200, '{"ok":true}', { ok: true }])
  expect((await request(sock, "HEAD", "/health")).status).toBe(200)
  expect((await request(sock, "GET", "/health/x")).status).toBe(401)
  // The open routes skip the check entirely, so a bad token there is never looked at.
  expect((await request(sock, "GET", "/health", { headers: { authorization: "Bearer junk" } })).status).toBe(200)
})

test("a route reads the body after the check", async () => {
  const office = makeOffice()
  const echo: Route<RequestContext> = {
    method: "POST",
    path: "/echo",
    body: z.string(),
    handler: (ctx, _params, body) => ({ person: actingPerson(ctx), body }),
  }
  const { sock } = await served(office, { tokens: true, extra: [echo] })
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  const r = await request(sock, "POST", "/echo", {
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify("hello"),
  })
  expect(r.json()).toEqual({ person: "ngocbh", body: "hello" })
})

test("a new device counts once it is committed", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  expect((await request(sock, "GET", "/whoami")).status).toBe(200)
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  expect((await request(sock, "GET", "/whoami")).status).toBe(401)
  const r = await request(sock, "GET", "/whoami", { headers: bearer(token) })
  expect((r.json() as { person: string }).person).toBe("ngocbh")
})

test("an uncommitted device does not count", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const token = newToken()
  const file = path.join(office.paths.company, "people/ngocbh/person.yaml")
  fs.appendFileSync(file, `devices:\n- name: mac\n  token_sha256: ${tokenSha256(token)}\n`)
  expect(((await request(sock, "GET", "/whoami")).json() as { person: string }).person).toBe("ngocbh")
  expect((await request(sock, "GET", "/whoami", { headers: bearer(token) })).status).toBe(401)
})

test("the event stream is checked like any get", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  const r = await request(sock, "GET", "/events")
  expect([r.status, errorOf(r)]).toEqual([401, "unauthenticated"])
  const req = http.request({ socketPath: sock, path: "/events", headers: bearer(token), agent: false })
  try {
    const { status, line } = await new Promise<{ status: number; line: string }>((resolve, reject) => {
      req.on("error", reject)
      req.on("response", (res) => {
        // Destroying the request cuts the response, which then errors with nobody reading it.
        res.on("error", () => {})
        res.setEncoding("utf8")
        let got = ""
        res.on("data", (chunk: string) => {
          got += chunk
          if (got.includes("\n")) resolve({ status: res.statusCode!, line: got.split("\n")[0]! })
        })
        // A refused stream sends a short body and ends, maybe without a newline.
        res.on("end", () => resolve({ status: res.statusCode!, line: got.split("\n")[0]! }))
      })
      req.end()
    })
    expect(status).toBe(200)
    expect(line).toBe(": connected")
  } finally {
    req.destroy()
  }
})

test("tokens work on a real socket", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true, extra: [standIn("/folders/*cwd/people")] })
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  expect((await request(sock, "GET", "/health")).status).toBe(200)
  // Raw, since under `bun test` the node:http client is fetch-based and may rewrite an odd path.
  const target = `/folders/${encodeURIComponent("/tmp/a b")}/people`
  const { text } = await raw(
    sock,
    `GET ${target} HTTP/1.1\r\nhost: office\r\nauthorization: Bearer ${token}\r\nconnection: close\r\n\r\n`,
  )
  expect(parse(text).status).toBe(200)
})

test("the check adds well under a millisecond", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  await request(sock, "GET", "/whoami", { headers: bearer(token) }) // load the roster
  const rounds = 10
  const n = 50
  const conn = await Conn.open(sock)

  const timed = async (head: string): Promise<number> => {
    const start = performance.now()
    for (let i = 0; i < n; i++) {
      conn.send(head)
      expect((await conn.response()).status).toBe(200)
    }
    return (performance.now() - start) / n
  }

  // Load on the machine only adds time, so each side's fastest round is its truest cost; alternating rounds puts
  // both under the same conditions. A check that slows every request (one that reloads the roster each time) still
  // fails.
  const open: number[] = []
  const checked: number[] = []
  for (let i = 0; i < rounds; i++) {
    // /health skips the check; otherwise as small a route as /whoami.
    open.push(await timed("GET /health HTTP/1.1\r\nhost: office\r\n\r\n"))
    checked.push(await timed(`GET /whoami HTTP/1.1\r\nhost: office\r\nauthorization: Bearer ${token}\r\n\r\n`))
  }
  expect(Math.min(...checked) - Math.min(...open)).toBeLessThan(0.5)
})

test("an encoded open path still needs a token", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  giveDevice(office.paths.company, "ngocbh", "mac", newToken())
  const r = await exchange(sock, "GET", "/%68ealth")
  expect(r.status).toBe(401)
  expect((JSON.parse(r.body) as { error: string }).error).toBe("unauthenticated")
})

test("without a ceo a tokenless request has no person to act as", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  git(company, "rm", "-q", "company.yaml")
  git(company, "commit", "-qm", "no company")
  const r = await request(sock, "GET", "/whoami")
  expect([r.status, r.json()]).toEqual([
    401,
    { error: "unauthenticated", message: "this request has no person to act as" },
  ])
  expect((await request(sock, "GET", "/health")).status).toBe(200)
})
