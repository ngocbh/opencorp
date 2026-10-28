/** Device tokens at the office: enforcement, the acting person, the open probe, and device routes. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { OfficeInfo } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { checkPassword, hashPassword } from "../../src/auth/passwords.ts"
import { newToken, tokenSha256 } from "../../src/auth/tokens.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { DeviceTokens, OPEN, actingPerson } from "../../src/daemon/auth.ts"
import type { Route } from "../../src/daemon/http.ts"
import type { RequestContext } from "../../src/daemon/office.ts"
import { officeAnswers } from "../../src/install/launch.ts"
import { git } from "../company/helpers.ts"
import {
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
  const { sock } = await served(office, { tokens: true })
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
  const { sock } = await served(office, { tokens: true })
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

test("the check reads the head per request and the roster only when it moves", async () => {
  // Counting the work rather than timing it: a timing limit fails whenever the machine is loaded.
  const office = makeOffice()
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  const spies = Object.getOwnPropertyNames(CompanyGit.prototype)
    .filter((name) => name !== "constructor")
    .map((name) => [name, spyOn(office.git, name as keyof CompanyGit)] as const)
  /** The `CompanyGit` calls `run` makes, by method. */
  const work = async (run: () => Promise<void>): Promise<Record<string, number>> => {
    for (const [, spy] of spies) spy.mockClear()
    await run()
    return Object.fromEntries(spies.map(([name, spy]) => [name, spy.mock.calls.length]).filter(([, n]) => n !== 0))
  }
  const tokens = new DeviceTokens(office)
  const check = async (): Promise<void> => {
    const info = {
      method: "GET",
      path: "/whoami",
      query: new URLSearchParams(),
      headers: bearer(token),
      signal: new AbortController().signal,
    }
    expect((await tokens.context(info)).person).toBe("ngocbh")
  }

  expect(await work(check)).toMatchObject({ readHead: 1, files: 1, readBlobs: 1 }) // the first loads the roster
  const n = 50
  const checks = async (): Promise<void> => {
    for (let i = 0; i < n; i++) await check()
  }
  // Each request only reads HEAD from the ref files: no git process, no roster reload.
  expect(await work(checks)).toEqual({ readHead: n })
  // A commit moves HEAD, so the next check loads the roster again, and only that one.
  addHuman(office.paths.company, "ava")
  expect(await work(check)).toMatchObject({ readHead: 1, files: 1, readBlobs: 1 })
  expect(await work(check)).toEqual({ readHead: 1 })
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

test("get office answers pid home started at and version", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await request(sock, "GET", "/office")
  expect(r.status).toBe(200)
  expect(r.json()).toEqual({
    pid: process.pid,
    home: office.paths.home,
    started_at: office.startedAt,
    version: VERSION,
    tools: {},
    guards: { install: [], tools: [], path: [] },
  })
  expect(OfficeInfo.parse(r.json())).toEqual(r.json() as OfficeInfo)
})

test("get office names the tools and guards the office pinned", async () => {
  const office = makeOffice({
    tools: { git: "/usr/bin/git", ps: "/bin/ps" },
    guards: { install: ["/opt/x"], tools: ["/usr/bin/git"], path: ["/usr/bin"], home: "/Users/x" },
  })
  const { sock } = await served(office, { tokens: true })
  const r = await request(sock, "GET", "/office")
  expect(r.status).toBe(200)
  const info = r.json() as OfficeInfo
  expect(info.tools).toEqual({ git: "/usr/bin/git", ps: "/bin/ps" })
  // The user's home dir is one of the guards but never part of the reply.
  expect(info.guards).toEqual({ install: ["/opt/x"], tools: ["/usr/bin/git"], path: ["/usr/bin"] })
  expect(r.text).not.toContain("/Users/x")
  expect(OfficeInfo.parse(info)).toEqual(info)
})

test("get office needs a token once tokens are needed", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  const r = await request(sock, "GET", "/office")
  expect([r.status, r.json()]).toEqual([401, UNAUTHENTICATED])
  expect((await request(sock, "GET", "/office", { headers: bearer(token) })).status).toBe(200)
  expect(OPEN.has("GET /office")).toBe(false)
})

// Device routes.

function device(name: string, token: string): { name: string; token_sha256: string } {
  return { name, token_sha256: tokenSha256(token) }
}

/** The devices in `handle`'s `person.yaml` in the repo at `company`, or `undefined` without the key. */
function devices(company: string, handle: string): unknown {
  const file = path.join(company, "people", handle, "person.yaml")
  return (parseYaml(fs.readFileSync(file, "utf8")) as { devices?: unknown }).devices
}

function subjects(company: string): string[] {
  return git(company, "log", "--format=%s").split("\n")
}

/** A `method target` request with `body` as JSON. */
function send(sock: string, method: string, target: string, body: unknown, headers: Record<string, string> = {}) {
  return request(sock, method, target, {
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

type PersonReply = { handle: string; devices: { name: string; token_sha256: string }[] }
const personOf = (reply: { json(): unknown }) => reply.json() as PersonReply

test("bootstrap an unauthenticated request adds the first device", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  const token = newToken()
  const r = await send(sock, "POST", "/people/ngocbh/devices", device("mac", token))
  expect(r.status).toBe(200)
  expect(personOf(r).devices).toEqual([device("mac", token)])
  expect(subjects(company)[0]).toBe("devices(@ngocbh): add mac")
  expect(devices(company, "ngocbh")).toEqual([device("mac", token)])
  expect((await request(sock, "GET", "/people")).status).toBe(401) // tokens are needed now
  expect((await request(sock, "GET", "/people", { headers: bearer(token) })).status).toBe(200)
})

test("a device change answers without the password hash", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const file = path.join(office.paths.company, "people/ngocbh/person.yaml")
  fs.appendFileSync(file, 'password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA"\n')
  const r = await send(sock, "POST", "/people/ngocbh/devices", device("mac", newToken()))
  expect(r.status).toBe(200)
  expect(r.text).not.toContain("scrypt")
  expect(fs.readFileSync(file, "utf8")).toContain("scrypt") // kept in the file
})

test("a human adds and removes their own devices", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "ava")
  const pc = newToken()
  const laptop = newToken()
  giveDevice(company, "ava", "pc", pc)
  let r = await send(sock, "POST", "/people/ava/devices", device("laptop", laptop), bearer(pc))
  expect(r.status).toBe(200)
  expect(personOf(r).devices).toEqual([device("pc", pc), device("laptop", laptop)])
  r = await request(sock, "DELETE", "/people/ava/devices/pc", { headers: bearer(laptop) })
  expect(r.status).toBe(200)
  expect(personOf(r).devices).toEqual([device("laptop", laptop)])
  expect(subjects(company).slice(0, 2)).toEqual(["devices(@ava): remove pc", "devices(@ava): add laptop"])
  expect((await request(sock, "GET", "/whoami", { headers: bearer(pc) })).status).toBe(401)
})

test("subjects never carry a hash", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  const token = newToken()
  expect((await send(sock, "POST", "/people/ngocbh/devices", device("mac", token))).status).toBe(200)
  expect((await request(sock, "DELETE", "/people/ngocbh/devices/mac", { headers: bearer(token) })).status).toBe(200)
  const log = git(company, "log", "--format=%B")
  expect(log).not.toContain(tokenSha256(token))
  expect(log).not.toContain(token)
})

test("the same device again changes nothing and a new hash conflicts", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  const token = newToken()
  giveDevice(company, "ngocbh", "mac", token)
  const head = subjects(company)
  let r = await send(sock, "POST", "/people/ngocbh/devices", device("mac", token), bearer(token))
  expect(r.status).toBe(200)
  expect(personOf(r).devices).toEqual([device("mac", token)])
  expect(subjects(company)).toEqual(head)
  r = await send(sock, "POST", "/people/ngocbh/devices", device("mac", newToken()), bearer(token))
  expect([r.status, errorOf(r)]).toEqual([409, "device_exists"])
  expect(subjects(company)).toEqual(head)
})

test("a token already listed is refused", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "ava")
  const token = newToken()
  giveDevice(company, "ngocbh", "mac", token)
  let r = await send(sock, "POST", "/people/ngocbh/devices", device("other", token), bearer(token))
  expect([r.status, errorOf(r)]).toEqual([409, "token_in_use"])
  r = await send(sock, "POST", "/people/ava/devices", device("pc", token), bearer(token))
  expect([r.status, errorOf(r)]).toEqual([409, "token_in_use"])
})

test("the ceo changes anyones devices and others cannot", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "ava")
  addHuman(company, "bo")
  const [ceo, ava, bo] = [newToken(), newToken(), newToken()]
  giveDevice(company, "ngocbh", "mac", ceo)
  giveDevice(company, "bo", "pc", bo)
  let r = await send(sock, "POST", "/people/ava/devices", device("pc", ava), bearer(ceo))
  expect(r.status).toBe(200)
  r = await send(sock, "POST", "/people/ava/devices", device("x", newToken()), bearer(bo))
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  r = await request(sock, "DELETE", "/people/ngocbh/devices/mac", { headers: bearer(ava) })
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  r = await request(sock, "DELETE", "/people/bo/devices/pc", { headers: bearer(ceo) })
  expect(r.status).toBe(200)
  expect(personOf(r).devices).toEqual([])
})

test("agents have no devices", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await send(sock, "POST", "/people/minh/devices", device("box", newToken()))
  expect([r.status, errorOf(r)]).toEqual([422, "not_a_human"])
  // A 422 says which field failed, never its value.
  expect((r.json() as { message: string }).message).toBe("the person is an agent; agents have no devices")
})

test("unknown people and devices are 404", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  let r = await send(sock, "POST", "/people/ghost/devices", device("mac", newToken()))
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  r = await request(sock, "DELETE", "/people/ngocbh/devices/pc", { headers: bearer(token) })
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test("a device name that cannot exist is 404 and changes nothing", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  const token = newToken()
  giveDevice(company, "ngocbh", "mac", token)
  const head = subjects(company)
  const r = await request(sock, "DELETE", "/people/ngocbh/devices/Bad%20Name", { headers: bearer(token) })
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
  expect((r.json() as { message: string }).message).not.toContain("Bad Name")
  expect(subjects(company)).toEqual(head)
})

test("a malformed device is invalid body", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await send(sock, "POST", "/people/ngocbh/devices", { name: "Mac", token_sha256: "A".repeat(64) })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
})

test("removing the last device turns enforcement off", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  const token = newToken()
  giveDevice(company, "ngocbh", "mac", token)
  const r = await request(sock, "DELETE", "/people/ngocbh/devices/mac", { headers: bearer(token) })
  expect(r.status).toBe(200)
  expect(devices(company, "ngocbh")).toBeUndefined()
  expect((await request(sock, "GET", "/whoami")).json()).toEqual({ person: "ngocbh", device: null })
})

test("the liveness probe works once tokens are needed", async () => {
  const office = makeOffice()
  giveDevice(office.paths.company, "ngocbh", "mac", newToken())
  const { sock } = await served(office, { tokens: true })
  expect(await officeAnswers(sock)).toBe(true)
})

// Logging in with a password, and setting one.

const PASSWORD = "pw-sentinel-c41e"

/** Commits `PASSWORD`'s hash for `handle`, as `opencorp init` would have. */
async function givePassword(company: string, handle: string): Promise<void> {
  const file = path.join(company, "people", handle, "person.yaml")
  fs.appendFileSync(file, `password_hash: ${JSON.stringify(await hashPassword(PASSWORD))}\n`)
  git(company, "commit", "-qam", `password for ${handle}`)
}

function login(handle: string, password: string, name: string, token: string) {
  return { handle, password, device: name, token_sha256: tokenSha256(token) }
}

test("a password logs a new device in without a token", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  await givePassword(company, "ngocbh")
  giveDevice(company, "ngocbh", "mac", newToken()) // tokens are enforced
  const laptop = newToken()
  const r = await send(sock, "POST", "/login", login("ngocbh", PASSWORD, "laptop", laptop))
  expect(r.status).toBe(200)
  expect(personOf(r).handle).toBe("ngocbh")
  expect(r.text).not.toContain("scrypt")
  expect(personOf(r).devices.map((d) => d.name)).toEqual(["mac", "laptop"])
  expect(subjects(company)[0]).toBe("devices(@ngocbh): add laptop")
  expect((await request(sock, "GET", "/whoami", { headers: bearer(laptop) })).json()).toEqual({
    person: "ngocbh",
    device: "laptop",
  })
})

test("a wrong password an unknown handle or an agent is a bad login", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  await givePassword(company, "ngocbh")
  const head = subjects(company)
  for (const [handle, password] of [
    ["ngocbh", "not-the-password"],
    ["ghost", PASSWORD],
    ["minh", PASSWORD],
  ] as const) {
    const r = await send(sock, "POST", "/login", login(handle, password, "laptop", newToken()))
    expect([r.status, errorOf(r)]).toEqual([401, "bad_login"])
    expect((r.json() as { message: string }).message).toBe("wrong handle or password")
    expect(r.text).not.toContain(PASSWORD)
  }
  expect(subjects(company)).toEqual(head)
})

test("a human without a password cannot log in with one", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await send(sock, "POST", "/login", login("ngocbh", PASSWORD, "laptop", newToken()))
  expect([r.status, errorOf(r)]).toEqual([409, "no_password"])
})

test("a login follows the device rules", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  await givePassword(company, "ngocbh")
  const token = newToken()
  giveDevice(company, "ngocbh", "mac", token)
  const head = subjects(company)
  let r = await send(sock, "POST", "/login", login("ngocbh", PASSWORD, "mac", token))
  expect(r.status).toBe(200)
  expect(subjects(company)).toEqual(head)
  r = await send(sock, "POST", "/login", login("ngocbh", PASSWORD, "mac", newToken()))
  expect([r.status, errorOf(r)]).toEqual([409, "device_exists"])
})

test("a human sets their password and only its hash is committed", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "ava")
  const ava = newToken()
  giveDevice(company, "ava", "pc", ava)
  let r = await send(sock, "PUT", "/people/ava/password", { password: PASSWORD }, bearer(ava))
  expect(r.status).toBe(200)
  expect(personOf(r).handle).toBe("ava")
  expect(r.text).not.toContain("scrypt")
  expect(subjects(company)[0]).toBe("password(@ava): set")
  const file = path.join(company, "people/ava/person.yaml")
  const stored = (parseYaml(fs.readFileSync(file, "utf8")) as { password_hash: string }).password_hash
  expect(await checkPassword(PASSWORD, stored)).toBe(true)
  expect(git(company, "log", "-p")).not.toContain(PASSWORD)
  r = await send(sock, "POST", "/login", login("ava", PASSWORD, "laptop", newToken()))
  expect(r.status).toBe(200)
})

test("the ceo sets anyones password and others cannot", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const company = office.paths.company
  addHuman(company, "ava")
  addHuman(company, "bo")
  const [ceo, bo] = [newToken(), newToken()]
  giveDevice(company, "ngocbh", "mac", ceo)
  giveDevice(company, "bo", "pc", bo)
  let r = await send(sock, "PUT", "/people/ava/password", { password: PASSWORD }, bearer(ceo))
  expect(r.status).toBe(200)
  r = await send(sock, "PUT", "/people/ava/password", { password: PASSWORD }, bearer(bo))
  expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  expect((r.json() as { message: string }).message).toContain("password")
})

test("bootstrap an unauthenticated request sets the ceos password", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  const r = await send(sock, "PUT", "/people/ngocbh/password", { password: PASSWORD })
  expect(r.status).toBe(200)
  expect(subjects(office.paths.company)[0]).toBe("password(@ngocbh): set")
})

test("a short password or an agents is refused", async () => {
  const office = makeOffice()
  const { sock } = await served(office, { tokens: true })
  let r: Awaited<ReturnType<typeof send>> | undefined
  for (const short of ["short", "eleven-char"]) {
    // under the schema's 8, then under the office's 12
    r = await send(sock, "PUT", "/people/ngocbh/password", { password: short })
    expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
  }
  expect((r!.json() as { message: string }).message).toBe("use at least 12 characters")
  r = await send(sock, "PUT", "/people/minh/password", { password: PASSWORD })
  expect([r.status, errorOf(r)]).toEqual([422, "not_a_human"])
})
