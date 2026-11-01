import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { readIdentity, tokenSha256 } from "@opencorp/client/node"
import { createFakeOffice, type FakeOffice } from "@opencorp/tui/fake-office"
import { main } from "../src/main"
import { usePrompter, type Prompter } from "../src/prompt"

// Two devices on one office: each home has its own identity.json, and both reach the office
// through the first home's socket.
const root = fs.mkdtempSync("/tmp/acd-")
const trusted = path.join(root, "a")
const other = path.join(root, "b")
const saved = process.env.OPENCORP_HOME
let office: FakeOffice
// Every line opencorp printed in this file, checked at the end for any token it wrote.
const printed: string[] = []
// Tokens made during a test, kept so the check still covers identities logout deleted.
const issued: string[] = []
const PASSWORD = "pw-sentinel-9b2e"

/** A terminal that gives `answers` in order and records every question; with none, there's no terminal. */
class Scripted implements Prompter {
  readonly asked: string[] = []
  readonly interactive: boolean
  constructor(readonly answers: string[] = []) {
    this.interactive = answers.length > 0
  }
  async ask(question: string, fallback = "") {
    this.asked.push(question)
    return this.answers.shift() || fallback
  }
  async secret(question: string) {
    this.asked.push(question)
    return this.answers.shift() ?? ""
  }
}
let terminal = new Scripted()
let restore = () => {}
/** Gives the next commands a terminal that answers `answers`. */
const answering = (...answers: string[]) => {
  restore()
  terminal = new Scripted(answers)
  restore = usePrompter(terminal)
  return terminal
}

beforeEach(() => {
  fs.mkdirSync(path.join(trusted, "office"), { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.symlinkSync(path.join(trusted, "office"), path.join(other, "office"))
  office = createFakeOffice({ socket: path.join(trusted, "office", "office.sock") })
  answering() // no terminal unless a test gives one
})
afterEach(() => {
  restore()
  office.stop()
  const tokens = [trusted, other].flatMap((home) => {
    const me = readIdentity(path.join(home, "identity.json"), () => {})
    return me ? [me.token] : []
  })
  for (const t of [...tokens, ...issued, PASSWORD]) for (const line of printed) expect(line).not.toContain(t)
  issued.length = 0
  fs.rmSync(trusted, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
  process.env.OPENCORP_HOME = saved
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
/** Runs `opencorp argv` as the device whose home is `home`, capturing stdout and stderr. */
async function opencorp(home: string, ...argv: string[]) {
  process.env.OPENCORP_HOME = home
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
  const r = await opencorp(trusted, "login", "--device", "mac")
  expect(r).toEqual({ code: 0, out: `This device is mac, acting as @ngocbh; its token is in ${trusted}/identity.json.`, err: "" })
  const me = identity(trusted)
  expect([me.handle, me.device]).toEqual(["ngocbh", "mac"])
  expect(me.token).toMatch(/^act_[A-Za-z0-9_-]{43}$/)
  expect(fs.statSync(path.join(trusted, "identity.json")).mode & 0o777).toBe(0o600)
  expect(devices()).toEqual([{ name: "mac", token_sha256: tokenSha256(me.token) }])
  // The bootstrap POST went without a token; everything after carries this one.
  expect(office.requests.find((r) => r.method === "POST")?.authorization).toBeUndefined()
  expect((await opencorp(trusted, "whoami")).out).toBe(
    `This device: mac, as @ngocbh (${trusted}/identity.json)\nThe office: @ngocbh, from device mac`,
  )
  expect(office.requests.at(-1)?.authorization).toBe(`Bearer ${me.token}`)
})

test("login on a device the office already knows asks nothing; --force replaces it, vouched for by the old one", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const first = identity(trusted)
  const asked = answering(PASSWORD)
  expect(await opencorp(trusted, "login", "--device", "mac2")).toEqual({
    code: 0,
    out: `This device is already logged in: mac, acting as @ngocbh (${trusted}/identity.json).`,
    err: "",
  })
  expect(asked.asked).toEqual([])
  expect(identity(trusted)).toEqual(first)
  answering()
  expect(await opencorp(trusted, "login", "--device", "mac2", "--force")).toEqual({
    code: 0,
    out:
      `This device is mac2, acting as @ngocbh; its token is in ${trusted}/identity.json.\n` +
      "Removed mac from people/ngocbh/person.yaml.",
    err: "",
  })
  // The device it replaced is gone, removed with its own token.
  expect(devices()?.map((d) => d.name)).toEqual(["mac2"])
  const del = office.requests.find((r) => r.method === "DELETE")!
  expect([del.raw, del.authorization]).toEqual(["/people/ngocbh/devices/mac", `Bearer ${first.token}`])
  // Only once the new device is in.
  expect(office.requests.indexOf(del)).toBeGreaterThan(office.requests.findLastIndex((r) => r.method === "POST"))
  expect(identity(trusted).device).toBe("mac2")
})

test("a --force login over an identity the office doesn't know removes nothing", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  await opencorp(other, "login", "--handle", "ngocbh", "--device", "laptop") // untrusted: never listed
  office.passwords.set("ngocbh", PASSWORD)
  answering("ngocbh", PASSWORD)
  expect(await opencorp(other, "login", "--device", "laptop2", "--force")).toEqual({
    code: 0,
    out: `This device is laptop2, acting as @ngocbh; its token is in ${other}/identity.json.`,
    err: "",
  })
  expect(devices()?.map((d) => d.name)).toEqual(["mac", "laptop2"])
  expect(office.requests.some((r) => r.method === "DELETE")).toBe(false)
})

test("a --force login the office won't take yet keeps the old device and says so", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.state.people.push({ handle: "ann", name: "Ann", kind: "human", title: "Designer", manager: "ngocbh" })
  await opencorp(other, "login", "--handle", "ann", "--device", "laptop")
  await opencorp(trusted, "devices", "add", "ann", "laptop", tokenSha256(identity(other).token))
  // Ann's device can't add one for the CEO, so it says what to run on a trusted one.
  const r = await opencorp(other, "login", "--handle", "ngocbh", "--device", "laptop2", "--force")
  expect(r.code).toBe(1)
  expect(r.err).toContain(`opencorp devices add ngocbh laptop2 ${tokenSha256(identity(other).token)}`)
  // Possibly the person's last device, so it stays until the new one is listed.
  expect(r.err.split("\n").at(-1)).toBe(
    "laptop in people/ann/person.yaml remains; remove it with `opencorp devices remove ann laptop`",
  )
  expect(devices("ann")?.map((d) => d.name)).toEqual(["laptop"])
})

test("a --force login whose old device can't be removed still logs in and says the entry remains", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.broken.add("DELETE /people/:handle/devices/:name")
  expect(await opencorp(trusted, "login", "--device", "mac2", "--force")).toEqual({
    code: 0,
    out: `This device is mac2, acting as @ngocbh; its token is in ${trusted}/identity.json.`,
    err: "mac in people/ngocbh/person.yaml remains; remove it with `opencorp devices remove ngocbh mac`",
  })
  expect(devices()?.map((d) => d.name)).toEqual(["mac", "mac2"])
})

test("a --force login the office refuses keeps the identity it would have replaced", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const first = identity(trusted)
  const r = await opencorp(trusted, "login", "--device", "mac", "--force")
  expect(r.code).toBe(1)
  expect(r.err).toContain("already has a device named mac")
  expect(identity(trusted)).toEqual(first)
  expect((await opencorp(trusted, "whoami")).out).toContain("The office: @ngocbh, from device mac")
})

test("login from an untrusted device says what to run on a trusted one", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  // The office won't list its people to an unknown device.
  expect(await opencorp(other, "login", "--device", "laptop")).toEqual({
    code: 2,
    out: "",
    err: "opencorp login: the office won't list its people to this device; pass --handle",
  })
  const r = await opencorp(other, "login", "--handle", "ngocbh", "--device", "laptop")
  const hash = tokenSha256(identity(other).token)
  expect(r).toEqual({
    code: 1,
    out: "",
    err: `opencorp login: the office doesn't trust this device yet. On a device it trusts, run:\n  opencorp devices add ngocbh laptop ${hash}`,
  })
  expect((await opencorp(other, "whoami")).err).toBe("opencorp whoami: the office doesn't know this device: run `opencorp login`")
  expect(await opencorp(other, "login")).toEqual({
    code: 1,
    out: "",
    err: `opencorp login: this device already has an identity (${other}/identity.json) the office doesn't know yet; pass --force to replace it`,
  })
  expect(await opencorp(trusted, "devices", "add", "ngocbh", "laptop", hash)).toEqual({
    code: 0,
    out: "@ngocbh has device laptop.",
    err: "",
  })
  expect((await opencorp(other, "whoami")).out).toContain("The office: @ngocbh, from device laptop")
})

test("devices list shows names, and hashes only on --hashes", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const hash = tokenSha256(identity(trusted).token)
  expect(await opencorp(trusted, "devices", "list")).toEqual({ code: 0, out: "mac  (this device)", err: "" })
  expect((await opencorp(trusted, "devices", "list", "ngocbh", "--hashes")).out).toBe(`mac  ${hash}  (this device)`)
  expect((await opencorp(trusted, "devices", "list", "minh")).out).toBe("@minh has no devices.")
  expect((await opencorp(trusted, "devices", "list", "nobody")).err).toBe("opencorp devices: no person @nobody")
  expect((await opencorp(trusted, "devices", "frob")).code).toBe(2)
  expect((await opencorp(trusted, "devices", "add", "minh", "x", hash.replace(/./, "0"))).err).toBe(
    "opencorp devices: the person is an agent; agents have no devices",
  )
  expect(await opencorp(trusted, "devices", "remove", "ngocbh", "nope")).toEqual({
    code: 1,
    out: "",
    err: "opencorp devices: no device nope for @ngocbh",
  })
})

const day = (ts: string) => new Date(ts).toLocaleDateString()

test("devices list adds this office's browsers: name, label, who paired it, last use, expiry", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ann", label: "Safari on Mac" })
  const used = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", last_used_at: "2026-10-18T09:00:00Z" })
  expect(await opencorp(trusted, "devices", "list")).toEqual({
    code: 0,
    out: [
      "mac  (this device)",
      "Browsers (this office):",
      `  ${used.id}  ${used.name}  paired by @ngocbh  last used ${day("2026-10-18T09:00:00Z")}  expires ${day(used.expires_at)}`,
      `  ${b.id}  ${b.name} (Safari on Mac)  paired by @ann  last used never  expires ${day(b.expires_at)}`,
    ].join("\n"),
    err: "",
  })
})

test("devices list says a browser signed in with a password was signed in, not paired", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", via: "login" })
  expect((await opencorp(trusted, "devices", "list")).out.split("\n").at(-1)).toBe(
    `  ${b.id}  ${b.name}  signed in  last used never  expires ${day(b.expires_at)}`,
  )
})

test("devices list says a session the office hasn't cleaned up yet has expired", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", expires_at: "2026-09-01T09:00:00Z" })
  expect((await opencorp(trusted, "devices", "list")).out.split("\n").at(-1)).toBe(
    `  ${b.id}  ${b.name}  paired by @ngocbh  last used never  expired ${day("2026-09-01T09:00:00Z")}`,
  )
})

test("devices list shows control characters in browser fields as escapes", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({
    person: "ngocbh",
    issued_by: "ngocbh",
    name: "web-\u0007x",
    label: "evil\u001b[2J\r\nline\u009b\t\u007f",
  })
  const out = (await opencorp(trusted, "devices", "list")).out
  expect(out.split("\n").at(-1)).toBe(
    `  ${b.id}  web-\\x07x (evil\\x1b[2J\\r\\nline\\x9b\\t\\x7f)  paired by @ngocbh  last used never  ` +
      `expires ${day(b.expires_at)}`,
  )
  expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
})

test("devices list shows line separators in browser fields as escapes", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", name: "web", label: "a\u2028b\u2029c" })
  const out = (await opencorp(trusted, "devices", "list")).out
  expect(out.split("\n").at(-1)).toBe(
    `  ${b.id}  web (a\\u2028b\\u2029c)  paired by @ngocbh  last used never  expires ${day(b.expires_at)}`,
  )
  expect(out).not.toMatch(/[\u2028\u2029]/u)
})

test("an agent's list asks for no browsers", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  expect((await opencorp(trusted, "devices", "list", "minh")).out).toBe("@minh has no devices.")
  expect(office.requests.some((r) => r.path.startsWith("/hq/browsers"))).toBe(false)
})

test("a human who isn't the CEO sees someone else's devices as today, without their browsers", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.state.people.push({ handle: "ann", name: "Ann", kind: "human", title: "Designer", manager: "ngocbh" })
  office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", label: "Safari on Mac" })
  await opencorp(other, "login", "--handle", "ann", "--device", "laptop") // untrusted: prints the add command
  await opencorp(trusted, "devices", "add", "ann", "laptop", tokenSha256(identity(other).token))
  expect(await opencorp(other, "devices", "list", "ngocbh")).toEqual({ code: 0, out: "mac", err: "" }) // 403 left out
})

test("an office without HQ, or from before it, lists devices as today; another failure is said", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.addBrowser({ person: "ngocbh", issued_by: "ngocbh" })
  const today = { code: 0, out: "mac  (this device)", err: "" }
  office.notImplemented.add("GET /hq/browsers")
  expect(await opencorp(trusted, "devices", "list")).toEqual(today)
  office.notImplemented.clear()
  office.broken.add("GET /hq/browsers")
  expect(await opencorp(trusted, "devices", "list")).toEqual({
    code: 1,
    out: "mac  (this device)",
    err: "opencorp devices: GET /hq/browsers failed",
  })
  const state = office.state
  office.stop()
  office = createFakeOffice({ socket: path.join(trusted, "office", "office.sock"), seed: state, missing: ["GET /hq/browsers"] })
  expect(await opencorp(trusted, "devices", "list")).toEqual(today)
})

test("remove-browser signs a browser out; a second time it's gone", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh" })
  expect(await opencorp(trusted, "devices", "remove-browser", b.id)).toEqual({
    code: 0,
    out: `Signed out browser ${b.name}.`,
    err: "",
  })
  expect(await opencorp(trusted, "devices", "remove-browser", b.id)).toEqual({
    code: 1,
    out: "",
    err: `opencorp devices: no browser session ${b.id}`,
  })
  expect((await opencorp(trusted, "devices", "remove-browser")).code).toBe(2)
  office.notImplemented.add("DELETE /hq/browsers/:id")
  expect(await opencorp(trusted, "devices", "remove-browser", b.id)).toEqual({
    code: 1,
    out: "",
    err: "opencorp devices: this office has no HQ yet; update the checkout and run `opencorp restart`",
  })
})

test("remove-browser takes one of your own sessions by its web- name too", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh" })
  expect(await opencorp(trusted, "devices", "remove-browser", b.name)).toEqual({
    code: 0,
    out: `Signed out browser ${b.name}.`,
    err: "",
  })
  expect(office.requests.at(-1)?.raw).toBe(`/hq/browsers/${b.id}`)
  expect((await opencorp(trusted, "devices", "remove-browser", b.id)).err).toBe(`opencorp devices: no browser session ${b.id}`)
})

test("remove-browser shows control characters in the name as escapes", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const b = office.addBrowser({ person: "ngocbh", issued_by: "ngocbh", name: "web-\u001b[2Jx" })
  expect(await opencorp(trusted, "devices", "remove-browser", b.id)).toEqual({
    code: 0,
    out: "Signed out browser web-\\x1b[2Jx.",
    err: "",
  })
})

test("the CEO signs out someone else's browser, confirmed by its id", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.state.people.push({ handle: "ann", name: "Ann", kind: "human", title: "Designer", manager: "ngocbh" })
  const b = office.addBrowser({ person: "ann", issued_by: "ann" })
  expect(await opencorp(trusted, "devices", "remove-browser", b.id)).toEqual({
    code: 0,
    out: `Signed out browser ${b.id}.`,
    err: "",
  })
  expect((await opencorp(trusted, "devices", "remove-browser", b.id)).err).toBe(`opencorp devices: no browser session ${b.id}`)
})

const OPEN_NOW =
  "opencorp: warning: no human lists a device now, so the office takes requests without a token as @ngocbh; " +
  "run `opencorp login` to need tokens again"

test("devices remove of the last human device warns", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  expect(await opencorp(trusted, "devices", "remove", "ngocbh", "mac")).toEqual({
    code: 0,
    out: "Removed device mac from @ngocbh.",
    err: OPEN_NOW,
  })
})

test("no warning while another human's device remains", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.state.people.push({ handle: "ann", name: "Ann", kind: "human", title: "Designer", manager: "ngocbh" })
  await opencorp(other, "login", "--handle", "ann", "--device", "laptop") // untrusted: prints the add command
  await opencorp(trusted, "devices", "add", "ann", "laptop", tokenSha256(identity(other).token))
  expect(await opencorp(trusted, "logout")).toEqual({
    code: 0,
    out: "Removed mac in people/ngocbh/person.yaml. This device is logged out.",
    err: "",
  })
  expect(await opencorp(other, "devices", "remove", "ann", "laptop")).toEqual({
    code: 0,
    out: "Removed device laptop from @ann.",
    err: OPEN_NOW,
  })
})

test("logout removes this device with its own token, then the identity", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const token = identity(trusted).token
  expect(await opencorp(trusted, "logout")).toEqual({
    code: 0,
    out: "Removed mac in people/ngocbh/person.yaml. This device is logged out.",
    err: OPEN_NOW,
  })
  const del = office.requests.find((r) => r.method === "DELETE")!
  expect([del.raw, del.authorization]).toEqual(["/people/ngocbh/devices/mac", `Bearer ${token}`])
  // The check after it goes without a token: it asks whether the office still needs one.
  expect([office.requests.at(-1)?.path, office.requests.at(-1)?.authorization]).toEqual(["/whoami", undefined])
  expect(devices()).toBeUndefined()
  expect(fs.existsSync(path.join(trusted, "identity.json"))).toBe(false)
  expect(await opencorp(trusted, "logout")).toEqual({ code: 1, out: "", err: "opencorp logout: this device isn't logged in" })
})

test("logout with no office forgets the device here and says the entry remains", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.stop()
  expect(await opencorp(trusted, "logout")).toEqual({
    code: 0,
    out: "The office isn't running, so mac in people/ngocbh/person.yaml remains; remove it with `opencorp devices remove ngocbh mac`. This device is logged out.",
    err: "",
  })
  expect(fs.existsSync(path.join(trusted, "identity.json"))).toBe(false)
  office = createFakeOffice({ socket: path.join(trusted, "office", "office.sock") }) // for afterEach
})

test("whoami with no identity on an open office; a loose file warns", async () => {
  expect(await opencorp(trusted, "whoami")).toEqual({
    code: 0,
    out: "This device has no identity; run `opencorp login`\nThe office: @ngocbh, the CEO (no human has a device yet, so it needs no token)",
    err: "",
  })
  await opencorp(trusted, "login", "--device", "mac")
  const file = path.join(trusted, "identity.json")
  fs.chmodSync(file, 0o644)
  expect((await opencorp(trusted, "whoami")).err).toBe(
    `opencorp: warning: ${file} is readable by others (mode 644); run \`chmod 600 ${file}\``,
  )
})

test("other commands send the token, and an unknown device gets the one-line 401", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const r = await opencorp(other, "end")
  expect(r).toEqual({ code: 1, out: "", err: "opencorp end: the office doesn't know this device: run `opencorp login`" })
  expect(await opencorp(other, "--continue")).toEqual({
    code: 1,
    out: "",
    err: "opencorp: the office doesn't know this device: run `opencorp login`",
  })
  const token = identity(trusted).token
  await opencorp(trusted, "end")
  expect(office.requests.at(-1)?.authorization).toBe(`Bearer ${token}`)
})

test("login with a password from a device the office doesn't know", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  office.passwords.set("ngocbh", PASSWORD)
  const asked = answering("ngocbh", PASSWORD)
  const r = await opencorp(other, "login", "--device", "laptop")
  expect(r).toEqual({ code: 0, out: `This device is laptop, acting as @ngocbh; its token is in ${other}/identity.json.`, err: "" })
  expect(asked.asked).toEqual(["Your handle", "@ngocbh's password (not shown; empty if you have none)"])
  const sent = office.requests.find((q) => q.path === "/login")!
  expect([sent.authorization, (sent.body as any).device]).toEqual([undefined, "laptop"])
  expect((await opencorp(other, "whoami")).out).toContain("The office: @ngocbh, from device laptop")
})

test("login asks for the handle with the CEO as its default, and a wrong password again", async () => {
  office.passwords.set("ngocbh", PASSWORD)
  const asked = answering("", "not-it-1", PASSWORD)
  const r = await opencorp(trusted, "login", "--device", "mac")
  expect([r.code, r.err]).toEqual([0, "That doesn't work: wrong handle or password"])
  expect(asked.asked[0]).toBe("Your handle")
  expect(identity(trusted).handle).toBe("ngocbh")
})

test("login stops after three wrong passwords, leaving no identity", async () => {
  office.passwords.set("ngocbh", PASSWORD)
  answering("ngocbh", "not-it-1", "not-it-2", "not-it-3")
  const r = await opencorp(trusted, "login", "--device", "mac")
  expect([r.code, r.err.split("\n").at(-1)]).toEqual([1, "opencorp login: no password worked for @ngocbh"])
  expect(fs.existsSync(path.join(trusted, "identity.json"))).toBe(false)
  expect(devices()).toBeUndefined()
})

test("login for a human without a password falls back to vouching from a trusted device", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  answering("ngocbh", "a-guess-123")
  const r = await opencorp(other, "login", "--device", "laptop")
  const hash = tokenSha256(identity(other).token)
  expect(r.code).toBe(1)
  expect(r.err).toBe(
    "@ngocbh has no password yet; set one with `opencorp password`\n" +
      `opencorp login: the office doesn't trust this device yet. On a device it trusts, run:\n  opencorp devices add ngocbh laptop ${hash}`,
  )
})

test("password sets your password, asking twice and again on a short or mistyped one", async () => {
  await opencorp(trusted, "login", "--device", "mac")
  const asked = answering("eleven-char", PASSWORD, PASSWORD + "x", PASSWORD, PASSWORD)
  const r = await opencorp(trusted, "password")
  expect(r).toEqual({
    code: 0,
    out: "Set @ngocbh's password.",
    err: "That doesn't work: use at least 12 characters\nThat doesn't work: the two passwords differ",
  })
  const question = "New password for @ngocbh (at least 12 characters, one you use nowhere else; not shown)"
  expect(asked.asked).toEqual([question, question, "Again", question, "Again"])
  expect(office.passwords.get("ngocbh")).toBe(PASSWORD)
  expect(office.requests.at(-1)?.authorization).toBe(`Bearer ${identity(trusted).token}`)
})

test("password needs a terminal, and refuses an agent", async () => {
  expect(await opencorp(trusted, "password")).toEqual({
    code: 2,
    out: "",
    err: "opencorp password: there's no terminal to read the password on without echo",
  })
  answering(PASSWORD, PASSWORD)
  expect(await opencorp(trusted, "password", "--handle", "minh")).toEqual({
    code: 1,
    out: "",
    err: "opencorp password: the person is an agent; agents have no password",
  })
})
