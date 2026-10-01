import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { readIdentity, tokenSha256 } from "@agent-corp/tui/office/identity"
import { createFakeOffice, type FakeOffice } from "../../tui/script/stub"
import { main } from "../src/main"

// Two devices on one office: each home has its own identity.json, and both reach the office
// through the first home's socket.
const root = fs.mkdtempSync("/tmp/acd-")
const trusted = path.join(root, "a")
const other = path.join(root, "b")
const saved = process.env.AGENT_CORP_HOME
let office: FakeOffice
// Every line ac printed in this file, checked at the end for any token it wrote.
const printed: string[] = []
// Tokens made during a test, kept so the check still covers identities logout deleted.
const issued: string[] = []

beforeEach(() => {
  fs.mkdirSync(path.join(trusted, "office"), { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.symlinkSync(path.join(trusted, "office"), path.join(other, "office"))
  office = createFakeOffice({ socket: path.join(trusted, "office", "office.sock") })
})
afterEach(() => {
  office.stop()
  const tokens = [trusted, other].flatMap((home) => {
    const me = readIdentity(path.join(home, "identity.json"), () => {})
    return me ? [me.token] : []
  })
  for (const t of [...tokens, ...issued]) for (const line of printed) expect(line).not.toContain(t)
  issued.length = 0
  fs.rmSync(trusted, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
  process.env.AGENT_CORP_HOME = saved
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
/** Runs `ac argv` as the device whose home is `home`, capturing stdout and stderr. */
async function ac(home: string, ...argv: string[]) {
  process.env.AGENT_CORP_HOME = home
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await main(argv), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
    printed.push(...out, ...err)
    const me = readIdentity(path.join(home, "identity.json"), () => {})
    if (me) issued.push(me.token)
  }
}
const identity = (home: string) => readIdentity(path.join(home, "identity.json"))!
const devices = (handle = "ngocbh") => office.state.people.find((p) => p.handle === handle)?.devices

test("login on a new office: a 0600 identity, registered for the CEO", async () => {
  const r = await ac(trusted, "login", "--device", "mac")
  expect(r).toEqual({ code: 0, out: `This device is mac, acting as @ngocbh; its token is in ${trusted}/identity.json.`, err: "" })
  const me = identity(trusted)
  expect([me.handle, me.device]).toEqual(["ngocbh", "mac"])
  expect(me.token).toMatch(/^act_[A-Za-z0-9_-]{43}$/)
  expect(fs.statSync(path.join(trusted, "identity.json")).mode & 0o777).toBe(0o600)
  expect(devices()).toEqual([{ name: "mac", token_sha256: tokenSha256(me.token) }])
  // The bootstrap POST went without a token; everything after carries this one.
  expect(office.requests.find((r) => r.method === "POST")?.authorization).toBeUndefined()
  expect((await ac(trusted, "whoami")).out).toBe(
    `This device: mac, as @ngocbh (${trusted}/identity.json)\nThe office: @ngocbh, from device mac`,
  )
  expect(office.requests.at(-1)?.authorization).toBe(`Bearer ${me.token}`)
})

test("login keeps an identity unless --force, and a trusted one vouches for its replacement", async () => {
  await ac(trusted, "login", "--device", "mac")
  const first = identity(trusted)
  expect(await ac(trusted, "login", "--device", "mac2")).toEqual({
    code: 1,
    out: "",
    err: `ac login: this device already has an identity (${trusted}/identity.json); pass --force to replace it`,
  })
  expect(identity(trusted)).toEqual(first)
  expect((await ac(trusted, "login", "--device", "mac2", "--force")).code).toBe(0)
  expect(devices()?.map((d) => d.name)).toEqual(["mac", "mac2"])
  expect(identity(trusted).device).toBe("mac2")
})

test("login from an untrusted device says what to run on a trusted one", async () => {
  await ac(trusted, "login", "--device", "mac")
  // The office won't list its people to an unknown device.
  expect(await ac(other, "login", "--device", "laptop")).toEqual({
    code: 2,
    out: "",
    err: "ac login: the office won't list its people to this device; pass --handle",
  })
  const r = await ac(other, "login", "--handle", "ngocbh", "--device", "laptop")
  const hash = tokenSha256(identity(other).token)
  expect(r).toEqual({
    code: 1,
    out: "",
    err: `ac login: the office doesn't trust this device yet. On a device it trusts, run:\n  ac devices add ngocbh laptop ${hash}`,
  })
  expect((await ac(other, "whoami")).err).toBe("ac whoami: the office doesn't know this device: run `ac login`")
  expect(await ac(trusted, "devices", "add", "ngocbh", "laptop", hash)).toEqual({
    code: 0,
    out: "@ngocbh has device laptop.",
    err: "",
  })
  expect((await ac(other, "whoami")).out).toContain("The office: @ngocbh, from device laptop")
})

test("devices list shows names, and hashes only on --hashes", async () => {
  await ac(trusted, "login", "--device", "mac")
  const hash = tokenSha256(identity(trusted).token)
  expect(await ac(trusted, "devices", "list")).toEqual({ code: 0, out: "mac  (this device)", err: "" })
  expect((await ac(trusted, "devices", "list", "ngocbh", "--hashes")).out).toBe(`mac  ${hash}  (this device)`)
  expect((await ac(trusted, "devices", "list", "minh")).out).toBe("@minh has no devices.")
  expect((await ac(trusted, "devices", "list", "nobody")).err).toBe("ac devices: no person @nobody")
  expect((await ac(trusted, "devices", "frob")).code).toBe(2)
  expect((await ac(trusted, "devices", "add", "minh", "x", hash.replace(/./, "0"))).err).toBe(
    "ac devices: @minh is an agent; only humans have devices",
  )
  expect(await ac(trusted, "devices", "remove", "ngocbh", "nope")).toEqual({
    code: 1,
    out: "",
    err: "ac devices: no device nope for @ngocbh",
  })
})

test("logout removes this device with its own token, then the identity", async () => {
  await ac(trusted, "login", "--device", "mac")
  const token = identity(trusted).token
  expect(await ac(trusted, "logout")).toEqual({
    code: 0,
    out: "Removed mac in people/ngocbh/person.yaml. This device is logged out.",
    err: "",
  })
  const del = office.requests.find((r) => r.method === "DELETE")!
  expect([del.raw, del.authorization]).toEqual(["/people/ngocbh/devices/mac", `Bearer ${token}`])
  expect(devices()).toBeUndefined()
  expect(fs.existsSync(path.join(trusted, "identity.json"))).toBe(false)
  expect(await ac(trusted, "logout")).toEqual({ code: 1, out: "", err: "ac logout: this device isn't logged in" })
})

test("logout with no office forgets the device here and says the entry remains", async () => {
  await ac(trusted, "login", "--device", "mac")
  office.stop()
  expect(await ac(trusted, "logout")).toEqual({
    code: 0,
    out: "The office isn't running, so mac in people/ngocbh/person.yaml remains; remove it with `ac devices remove ngocbh mac`. This device is logged out.",
    err: "",
  })
  expect(fs.existsSync(path.join(trusted, "identity.json"))).toBe(false)
  office = createFakeOffice({ socket: path.join(trusted, "office", "office.sock") }) // for afterEach
})

test("whoami with no identity on an open office; a loose file warns", async () => {
  expect(await ac(trusted, "whoami")).toEqual({
    code: 0,
    out: "This device has no identity; run `ac login`\nThe office: @ngocbh, the CEO (no human has a device yet, so it needs no token)",
    err: "",
  })
  await ac(trusted, "login", "--device", "mac")
  const file = path.join(trusted, "identity.json")
  fs.chmodSync(file, 0o644)
  expect((await ac(trusted, "whoami")).err).toBe(
    `ac: warning: ${file} is readable by others (mode 644); run \`chmod 600 ${file}\``,
  )
})

test("other commands send the token, and an unknown device gets the one-line 401", async () => {
  await ac(trusted, "login", "--device", "mac")
  const r = await ac(other, "end")
  expect(r).toEqual({ code: 1, out: "", err: "ac end: the office doesn't know this device: run `ac login`" })
  expect(await ac(other, "--continue")).toEqual({
    code: 1,
    out: "",
    err: "ac: the office doesn't know this device: run `ac login`",
  })
  const token = identity(trusted).token
  await ac(trusted, "end")
  expect(office.requests.at(-1)?.authorization).toBe(`Bearer ${token}`)
})
