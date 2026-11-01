/** Signing a browser in with a handle and password: the throttle, the dummy hash, and two checks at a time. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { parse, stringify } from "yaml"
import { checkPassword, DUMMY_HASH, hashPassword } from "../../src/auth/passwords.ts"
import type { Hq } from "../../src/hq/core.ts"
import {
  BadCredentials,
  Busy,
  CHECKS,
  LIMIT,
  Logins,
  MAX_KEYS,
  Throttle,
  Throttled,
  UnreadablePerson,
} from "../../src/hq/login.ts"
import { passwordFp } from "../../src/hq/sessions.ts"
import { git } from "../company/helpers.ts"
import { CEO, type Reply, addHuman, makeOffice } from "../daemon/helpers.ts"
import { waitFor } from "../helpers.ts"
import { type HqClient, ORIGIN, PORT, handEdit, hqClient, makeHq, pairCode, web } from "./helpers.ts"

setDefaultTimeout(30_000)

const PASSWORD = "correct horse battery"
// A synthetic PHC string: never hashed, the injected check compares it as text.
const PHC = "$scrypt$ln=16,r=8,p=1$c3ludGhldGljIHNhbHQ$c3ludGhldGljIGhhc2ggb2YgdGhlIHBhc3N3b3Jk"

type Body = Record<string, unknown>
type Check = (password: string, phc: string) => Promise<boolean>

/** Commits `hash` as `handle`'s password hash in `company`. */
function setPassword(company: string, handle: string, hash: string): void {
  const file = path.join(company, "people", handle, "person.yaml")
  const data = { ...(parse(fs.readFileSync(file, "utf8")) as Body), password_hash: hash }
  fs.writeFileSync(file, stringify(data))
  git(company, "commit", "-qam", `password for ${handle}`)
}

/** An office with HQ and a `web` client; the CEO has `PASSWORD` (Python's `web` and `with_password`). */
async function withPassword({ logs }: { logs?: string[] } = {}) {
  const office = makeOffice({ log: (line) => logs?.push(line) })
  const hq = await makeHq(office, { logs })
  setPassword(office.paths.company, CEO, await hashPassword(PASSWORD))
  return { office, hq, client: await web(hq) }
}

function login(client: HqClient, handle = CEO, password = PASSWORD, extra: Body = {}): Promise<Reply> {
  return client.post("/api/login", { handle, password, ...extra })
}

/** Replaces `hq.logins` with one whose password check calls `check`; returns a setter for that check, so a test
 *  can change it without resetting the throttle or the slots. */
function delegating(hq: Hq, check: Check): (next: Check) => void {
  let current = check
  hq.logins = new Logins(hq.sessions, { checkPassword: (pw, phc) => current(pw, phc) })
  return (next) => {
    current = next
  }
}

/** Password checks without scrypt's cost: the throttle tests make many (Python's `fast_checks`). */
const fast: Check = async (pw, phc) => pw === PASSWORD && phc !== DUMMY_HASH

/** The message part of each log line in `lines`. */
function messages(lines: string[]): string[] {
  return lines.map((line) => line.slice(line.indexOf(": ") + 2))
}

const BAD = { error: "bad_credentials", message: "wrong handle or password" }

test("the right password signs in", async () => {
  const { client } = await withPassword()
  const r = await login(client, CEO, PASSWORD, { label: "Firefox on Linux" })
  const body = r.json() as Body
  expect(r.status).toBe(200)
  expect(body).toMatchObject({ person: CEO, via: "login", issued_by: CEO, label: "Firefox on Linux" })
  expect(body).not.toHaveProperty("secret_sha256")
  expect((await client.get("/api/whoami")).json()).toEqual({ person: CEO, device: body.name })
})

test("the cookie is the one pairing sets", async () => {
  const { client } = await withPassword()
  const cookie = (await login(client)).headers["set-cookie"]![0]!
  expect(cookie.startsWith(`opencorp_hq_${PORT}=`)).toBe(true)
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) expect(cookie).toContain(part)
  expect(cookie).not.toContain("Secure")
})

test("without a session the 401 names both ways to sign in", async () => {
  const message = ((await (await web(await makeHq(makeOffice()))).get("/api/whoami")).json() as Body).message
  expect(message).toContain("handle and password")
  expect(message).toContain("`opencorp pair`")
})

test("a wrong password is 401 bad credentials", async () => {
  const { client } = await withPassword()
  const r = await login(client, CEO, "not the password")
  expect([r.status, r.json()]).toEqual([401, BAD])
  expect(r.headers).not.toHaveProperty("set-cookie")
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("without an origin the guard refuses", async () => {
  const { hq } = await withPassword()
  const r = await login(await hqClient(hq))
  expect([r.status, (r.json() as Body).error]).toEqual([403, "origin_not_allowed"])
})

test("only post api login skips the session check", async () => {
  const { client } = await withPassword()
  expect((await client.get("/api/login")).status).toBe(401)
  for (const target of ["/api/login/", "/api/login/x", "/api/loginx"]) {
    const r = await client.post(target, { handle: CEO, password: PASSWORD })
    expect([r.status, (r.json() as Body).error, target]).toEqual([401, "sign_in_required", target])
  }
})

test("a bad body is 422 and doesnt quote the password", async () => {
  const { client } = await withPassword()
  for (const body of [
    { handle: CEO, password: PASSWORD, extra: PASSWORD },
    { handle: "Not A Handle", password: PASSWORD },
  ]) {
    const r = await client.post("/api/login", body)
    expect(r.status).toBe(422)
    expect(r.text).not.toContain(PASSWORD)
  }
})

test("a control character label is 422 and isnt quoted", async () => {
  const lines: string[] = []
  const { client } = await withPassword({ logs: lines })
  const r = await login(client, CEO, PASSWORD, { label: "evil\r\nINFO forged" })
  expect([r.status, (r.json() as Body).error]).toEqual([422, "invalid_body"])
  for (const echoed of ["INFO forged", PASSWORD]) expect(r.text).not.toContain(echoed)
  expect(messages(lines).filter((m) => m.startsWith("sign-in"))).toEqual([])
})

test("signing in again revokes the old session", async () => {
  const { office, client } = await withPassword()
  const first = ((await login(client)).json() as Body).id as string
  const second = ((await login(client)).json() as Body).id as string
  expect(office.store.getHqSession(first)).toBeUndefined()
  expect(office.store.getHqSession(second)).toBeDefined()
})

test("signing in with a cookie that proves nothing revokes nothing", async () => {
  const { office, hq, client } = await withPassword()
  const [other] = await hq.sessions.issue(CEO, { issuedBy: CEO, label: null })
  client.cookies.set(`opencorp_hq_${PORT}`, `${other.id}.forged`)
  expect((await login(client)).status).toBe(200)
  expect(office.store.getHqSession(other.id)).toBeDefined()
})

test("signing in with a planted cookie in front replaces the real session", async () => {
  const { office, client } = await withPassword()
  const first = ((await login(client)).json() as Body).id as string
  const name = `opencorp_hq_${PORT}`
  const headers = { cookie: `${name}=junk; ${name}=${client.cookies.get(name)}` }
  const r = await client.post("/api/login", { handle: CEO, password: PASSWORD }, { headers })
  expect(r.status).toBe(200)
  expect(office.store.getHqSession(first)).toBeUndefined()
  expect(office.store.getHqSession((r.json() as Body).id as string)).toBeDefined()
})

test("a password change ends a signed in session", async () => {
  const { office, client } = await withPassword()
  expect((await login(client)).status).toBe(200)
  setPassword(office.paths.company, CEO, await hashPassword("a different password"))
  expect((await client.get("/api/whoami")).status).toBe(401)
})

test("the password is never logged", async () => {
  const lines: string[] = []
  const { client } = await withPassword({ logs: lines })
  await login(client, CEO, "a wrong guess here")
  const r = await login(client)
  const secret = r.headers["set-cookie"]![0]!.split("=")[1]!.split(";")[0]!.split(".")[1]!
  const text = lines.join("\n")
  for (const leak of [PASSWORD, "a wrong guess here", secret]) expect(text).not.toContain(leak)
  expect(messages(lines)).toContain("sign-in for @ngocbh from 127.0.0.1 failed")
  expect(messages(lines)).toContain("sign-in for @ngocbh from 127.0.0.1 ok")
})

test.each(["wrong password", "unknown handle", "agent", "human without a password"])(
  "every failure is the same 401 [%s]",
  async (kase) => {
    const office = makeOffice()
    const client = await web(await makeHq(office))
    if (kase !== "human without a password") setPassword(office.paths.company, CEO, await hashPassword(PASSWORD))
    // A hash on an agent signs nobody in.
    if (kase === "agent") setPassword(office.paths.company, "minh", await hashPassword(PASSWORD))
    const [handle, password] = {
      "wrong password": [CEO, "not the password"],
      "unknown handle": ["nobody", PASSWORD],
      agent: ["minh", PASSWORD],
      "human without a password": [CEO, PASSWORD],
    }[kase]!
    const r = await login(client, handle, password)
    expect([r.status, r.json()]).toEqual([401, BAD])
    expect(r.headers).not.toHaveProperty("set-cookie")
  },
)

test.each(["nobody", "minh", CEO])("a handle without a password still costs a full check [%s]", async (handle) => {
  const hq = await makeHq(makeOffice())
  const client = await web(hq)
  const checked: string[] = []
  delegating(hq, (pw, phc) => {
    checked.push(phc)
    return checkPassword(pw, phc)
  })
  expect((await login(client, handle)).status).toBe(401)
  expect(checked).toEqual([DUMMY_HASH])
})

/** A clock the test moves by setting `now`, in seconds. */
function clockAt(): { now: number; call: () => number } {
  const clock = { now: 1000, call: () => clock.now }
  return clock
}

/** The error `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

test("the dummy hash costs what a real one does", async () => {
  const cost = /^\$scrypt\$ln=\d+,r=\d+,p=\d+\$/
  expect(cost.exec(DUMMY_HASH)?.[0]).toBe(cost.exec(await hashPassword("x".repeat(12)))![0])
  expect(await checkPassword(PASSWORD, DUMMY_HASH)).toBe(false)
})

test("five failures in fifteen minutes lock the pair and each lock doubles to fifteen minutes", () => {
  const clock = clockAt()
  const t = new Throttle(clock.call)
  for (let i = 0; i < 4; i++) t.failed(["p", "a"])
  expect(t.wait(["p", "a"])).toBeNull()
  const waits: number[] = []
  for (let i = 0; i < 5; i++) {
    t.failed(["p", "a"])
    waits.push(t.wait(["p", "a"])!)
    clock.now += waits.at(-1)! // waits it out, then fails again
    expect(t.wait(["p", "a"])).toBeNull()
  }
  expect(waits).toEqual([60, 120, 240, 480, 900])
  for (let i = 0; i < 4; i++) t.failed(["p", "a"]) // a 15-minute wait outlasts the pair's memory: it starts over
  expect(t.wait(["p", "a"])).toBeNull()
})

test("the wait is whole seconds rounded up", () => {
  const clock = clockAt()
  const t = new Throttle(clock.call)
  for (let i = 0; i < 5; i++) t.failed(["p", "a"])
  clock.now += 0.5
  const wait = t.wait(["p", "a"])
  expect(wait).toBe(60)
  expect(Number.isInteger(wait)).toBe(true)
})

test("failures older than fifteen minutes dont count", () => {
  const clock = clockAt()
  const t = new Throttle(clock.call)
  for (let i = 0; i < 4; i++) t.failed(["p", "a"])
  clock.now += 15 * 60
  t.failed(["p", "a"])
  expect(t.wait(["p", "a"])).toBeNull()
})

test("a success clears the pair and only that pair", () => {
  const t = new Throttle(clockAt().call)
  for (let i = 0; i < 5; i++) {
    t.failed(["p", "a"])
    t.failed(["p", "b"])
  }
  t.succeeded(["p", "a"])
  expect(t.wait(["p", "a"])).toBeNull()
  expect(t.wait(["p", "b"])).toBe(60)
})

test("the throttle is bounded", () => {
  const clock = clockAt()
  const t = new Throttle(clock.call)
  for (let i = 0; i < 5; i++) t.failed(["p", "target"])
  for (let i = 0; i < MAX_KEYS + 10; i++) t.failed(["p", `h${i}`])
  expect(t.size).toBe(MAX_KEYS)
  clock.now += 15 * 60
  t.failed(["p", "new"])
  expect(t.size).toBe(1) // entries go 15 minutes after their last failure
})

test("filling the table evicts unlocked pairs never a lock", () => {
  const t = new Throttle(clockAt().call)
  for (let i = 0; i < 5; i++) t.failed(["p", "target"])
  for (let i = 0; i < MAX_KEYS; i++) t.failed(["p", `h${i}`])
  expect(t.size).toBe(MAX_KEYS)
  expect(t.wait(["p", "target"])).toBe(60)
})

test("a table full of locks refuses new pairs until the first lock ends", () => {
  const clock = clockAt()
  const t = new Throttle(clock.call)
  for (let i = 0; i < MAX_KEYS; i++) {
    for (let j = 0; j < 5; j++) t.failed(["p", `h${i}`])
    clock.now += 1 / 128 // exact in binary, so the sum is too
  }
  expect(t.wait(["p", "new"])).toBe(53) // the oldest lock, from 7.8 s ago, ends first
  t.failed(["p", "new"]) // a check that started before the table filled: dropped, not a lock evicted
  expect(t.size).toBe(MAX_KEYS)
  expect(t.wait(["p", "h0"])).not.toBeNull()
  expect(t.refuse(["p", "new"])![1]).toBe(true)
  expect(t.refuse(["p", "new"])![1]).toBe(false)
  expect(t.refuse(["p", "other"])![1]).toBe(false)
  clock.now += 60
  expect(t.wait(["p", "new"])).toBeNull()
})

test("a check whose request went away still holds its slot", async () => {
  const entered: string[] = []
  const held: ((matched: boolean) => void)[] = []
  const logins = new Logins(
    { passwordHash: async () => ({ hash: null, unreadable: false }) },
    {
      checkPassword: (_password, phc) => {
        entered.push(phc)
        return new Promise<boolean>((resolve) => held.push(resolve))
      },
    },
  )
  // A promise can't be cancelled: the callers went away, and the checks run on without anyone awaiting them.
  const gone = [0, 1].map(() => logins.check("p", "ngocbh", "a wrong guess"))
  // Caught now, before the release: Bun's `expect(p).rejects` blocks until `p` settles, so it can't be attached
  // early, and a rejection with no handler would be unhandled.
  const outcomes = gone.map(rejection)
  try {
    await waitFor(() => entered.length === 2, { timeout: 5000, what: "two checks" })
    expect(await rejection(logins.check("p", "ngocbh", PASSWORD))).toBeInstanceOf(Busy)
    expect(entered).toHaveLength(2)
  } finally {
    for (const release of held) release(false)
  }
  for (const error of await Promise.all(outcomes)) expect(error).toBeInstanceOf(BadCredentials)
  expect(logins.running).toBe(0)
})

test("a check that errors gives its slot back and counts no failure", async () => {
  const error = new Error("x")
  const cases: [string, ConstructorParameters<typeof Logins>][] = [
    ["the hash read rejects", [{ passwordHash: async () => Promise.reject(error) }]],
    [
      "the check throws",
      [
        { passwordHash: async () => ({ hash: PHC, unreadable: false }) },
        {
          checkPassword: (() => {
            throw error
          }) as unknown as (password: string, phc: string) => Promise<boolean>,
        },
      ],
    ],
    [
      "the check rejects",
      [{ passwordHash: async () => ({ hash: PHC, unreadable: false }) }, { checkPassword: () => Promise.reject(error) }],
    ],
  ]
  for (const [what, args] of cases) {
    const logins = new Logins(...args)
    // More than CHECKS, so a leaked slot shows up as Busy, and more than LIMIT, so a counted failure locks.
    for (let i = 0; i < Math.max(CHECKS, LIMIT) + 1; i++)
      expect([what, await rejection(logins.check("p", "ngocbh", PASSWORD))]).toEqual([what, error])
    expect(logins.running).toBe(0)
    expect(logins.throttle.wait(["p", "ngocbh"])).toBeNull()
  }
})

test("an unknown handle is checked against the dummy hash and fails", async () => {
  const checked: string[] = []
  const logins = new Logins(
    { passwordHash: async () => ({ hash: null, unreadable: false }) },
    {
      checkPassword: async (_password, phc) => {
        checked.push(phc)
        return false
      },
    },
  )
  expect(await rejection(logins.check("p", "nobody", PASSWORD))).toBeInstanceOf(BadCredentials)
  expect(checked).toEqual([DUMMY_HASH])
})

test("an unreadable person file costs a full check then fails and counts", async () => {
  const checked: string[] = []
  let release!: () => void
  const logins = new Logins(
    { passwordHash: async () => ({ hash: null, unreadable: true }) },
    {
      clock: clockAt().call,
      checkPassword: async (_password, phc) => {
        checked.push(phc)
        if (checked.length === 1) await new Promise<void>((resolve) => (release = resolve))
        return false
      },
    },
  )
  let settled = false
  const first = rejection(logins.check("p", "ngocbh", PASSWORD)).finally(() => (settled = true))
  await waitFor(() => checked.length === 1, { timeout: 5000, what: "the check" })
  await Bun.sleep(10)
  expect(settled).toBe(false)
  release()
  const error = await first
  expect(error).toBeInstanceOf(UnreadablePerson)
  expect(error).toBeInstanceOf(BadCredentials)
  expect(checked).toEqual([DUMMY_HASH])
  for (let i = 0; i < LIMIT - 1; i++)
    expect(await rejection(logins.check("p", "ngocbh", PASSWORD))).toBeInstanceOf(UnreadablePerson)
  expect(await rejection(logins.check("p", "ngocbh", PASSWORD))).toBeInstanceOf(Throttled)
})

test("a throttled pair is refused before the password is checked", async () => {
  const clock = clockAt()
  const checked: string[] = []
  const logins = new Logins(
    { passwordHash: async () => ({ hash: PHC, unreadable: false }) },
    {
      clock: clock.call,
      checkPassword: async (password, phc) => {
        checked.push(phc)
        return password === PASSWORD
      },
    },
  )
  for (let i = 0; i < 5; i++)
    expect(await rejection(logins.check("p", "ngocbh", "a wrong guess"))).toBeInstanceOf(BadCredentials)
  const first = await rejection(logins.check("p", "ngocbh", PASSWORD))
  expect(first).toBeInstanceOf(Throttled)
  expect(first).toMatchObject({ retryAfter: 60, first: true, message: "retry after 60 s" })
  expect(checked).toHaveLength(5)
  expect(await rejection(logins.check("p", "ngocbh", PASSWORD))).toMatchObject({ retryAfter: 60, first: false })
  expect(checked).toHaveLength(5)
})

test("the right password returns the fingerprint of its hash and clears the failures", async () => {
  const logins = new Logins(
    { passwordHash: async () => ({ hash: PHC, unreadable: false }) },
    { clock: clockAt().call, checkPassword: async (password, phc) => password === PASSWORD && phc === PHC },
  )
  for (let i = 0; i < 4; i++)
    expect(await rejection(logins.check("p", "ngocbh", "a wrong guess"))).toBeInstanceOf(BadCredentials)
  expect(await logins.check("p", "ngocbh", PASSWORD)).toBe(passwordFp(PHC))
  for (let i = 0; i < 4; i++)
    expect(await rejection(logins.check("p", "ngocbh", "a wrong guess"))).toBeInstanceOf(BadCredentials)
  expect(logins.throttle.wait(["p", "ngocbh"])).toBeNull()
})

test("five failures give 429 with retry after even for the right password", async () => {
  const { hq, client } = await withPassword()
  delegating(hq, fast)
  for (let i = 0; i < 5; i++) expect((await login(client, CEO, "a wrong guess")).status).toBe(401)
  const r = await login(client)
  const body = r.json() as Body
  expect([r.status, body.error, r.headers["retry-after"]]).toEqual([429, "too_many_attempts", "60"])
  expect(r.headers["content-type"]).toBe("application/json")
  expect(body.message).toContain("opencorp pair")
  expect(r.headers).not.toHaveProperty("set-cookie")
})

test("a throttled handle leaves other handles and peers alone", async () => {
  const { hq, client } = await withPassword()
  delegating(hq, fast)
  for (let i = 0; i < 5; i++) await login(client, CEO, "a wrong guess")
  expect((await login(client, "minh", "a wrong guess")).status).toBe(401)
  const other = await hqClient(hq, { peer: "127.0.0.2", headers: { origin: ORIGIN } })
  expect((await login(other)).status).toBe(200)
})

test("pairing still works while a handle is throttled", async () => {
  const { hq, client } = await withPassword()
  delegating(hq, fast)
  for (let i = 0; i < 6; i++) await login(client, CEO, "a wrong guess")
  expect((await client.post("/api/pair", { code: await pairCode(hq) })).status).toBe(200)
})

test("a success clears the count", async () => {
  const { hq, client } = await withPassword()
  delegating(hq, fast)
  for (let i = 0; i < 4; i++) await login(client, CEO, "a wrong guess")
  expect((await login(client)).status).toBe(200)
  for (let i = 0; i < 4; i++) expect((await login(client, CEO, "a wrong guess")).status).toBe(401)
})

test("two checks at a time and a third is 503 busy at once", async () => {
  const { hq, client } = await withPassword()
  const entered: string[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const set = delegating(hq, async (_pw, phc) => {
    entered.push(phc)
    await released
    return false
  })
  const first = [0, 1].map(() => login(client, CEO, "a wrong guess"))
  try {
    await waitFor(() => entered.length === 2, { timeout: 5000, what: "two checks" })
    const r = await login(client)
    expect([r.status, (r.json() as Body).error, entered.length]).toEqual([503, "busy", 2])
  } finally {
    release()
  }
  expect((await Promise.all(first)).map((r) => r.status)).toEqual([401, 401])
  set(async (pw) => pw === PASSWORD)
  expect((await login(client)).status).toBe(200) // the busy answer counted no failure, and the slots came back
})

test("a throttled pair is logged once per lock", async () => {
  const lines: string[] = []
  const { hq, client } = await withPassword({ logs: lines })
  delegating(hq, fast)
  const clock = { now: 1000 }
  // After the replacement, so the clock lands on the live Logins.
  hq.logins.throttle.clock = () => clock.now
  for (let i = 0; i < 5; i++) await login(client, CEO, "a wrong guess")
  for (let i = 0; i < 3; i++) expect((await login(client)).status).toBe(429)
  clock.now += 60
  await login(client, CEO, "a wrong guess") // locks it again, for twice as long
  for (let i = 0; i < 2; i++) expect((await login(client)).status).toBe(429)
  expect(messages(lines).filter((m) => m.includes("throttled"))).toEqual([
    "sign-in for @ngocbh from 127.0.0.1 throttled for 60 s",
    "sign-in for @ngocbh from 127.0.0.1 throttled for 120 s",
  ])
})

test("on hq sock the peer is logged as hq sock", async () => {
  const lines: string[] = []
  const { hq } = await withPassword({ logs: lines })
  const host = "127.0.0.1:5555"
  const client = await hqClient(hq, { port: null, host, peer: null, headers: { origin: `http://${host}` } })
  expect((await login(client, CEO, "a wrong guess")).status).toBe(401)
  expect(messages(lines)).toContain("sign-in for @ngocbh from hq.sock failed")
})

test("a password changed during the check is the same 401", async () => {
  const lines: string[] = []
  const { office, hq, client } = await withPassword({ logs: lines })
  delegating(hq, async (pw, phc) => {
    const matched = await checkPassword(pw, phc)
    setPassword(office.paths.company, CEO, await hashPassword("changed meanwhile"))
    return matched
  })
  const r = await login(client)
  expect([r.status, (r.json() as Body).error]).toEqual([401, "bad_credentials"])
  expect(r.headers).not.toHaveProperty("set-cookie")
  expect(office.store.listHqSessions()).toEqual([])
  expect(messages(lines)).toContain("sign-in for @ngocbh from 127.0.0.1 failed")
})

test("a throttled request never checks the password", async () => {
  const { hq, client } = await withPassword()
  const set = delegating(hq, fast)
  for (let i = 0; i < 5; i++) await login(client, CEO, "a wrong guess")
  const checked: string[] = []
  set(async (_pw, phc) => {
    checked.push(phc)
    return true
  })
  expect((await login(client)).status).toBe(429)
  expect(checked).toEqual([])
})

test("an encoded login path is the open login route", async () => {
  const { office, hq, client } = await withPassword()
  const r = await client.post("/api/%6cogin", { handle: CEO, password: PASSWORD })
  expect([r.status, (r.json() as Body).via]).toEqual([200, "login"])
  expect(r.headers["set-cookie"]).toHaveLength(1)
  // Only the session check decodes %2F as a slash: it lets the request through as POST /api/login, and the router,
  // which splits on the raw slashes first, matches no route.
  const miss = await (await web(hq)).post("/api%2Flogin", { handle: CEO, password: PASSWORD })
  expect([miss.status, (miss.json() as Body).error]).toEqual([404, "no_route"])
  expect(miss.headers).not.toHaveProperty("set-cookie")
  expect(office.store.listHqSessions()).toHaveLength(1)
})

test("a sign in while the person file cant be read is the same 401 and logged apart", async () => {
  const lines: string[] = []
  const { office, client } = await withPassword({ logs: lines })
  handEdit(office.paths.company, CEO, { nickname: "typo" })
  const r = await login(client)
  expect([r.status, r.json()]).toEqual([401, BAD])
  expect(r.headers).not.toHaveProperty("set-cookie")
  expect(messages(lines)).toContain(
    "sign-in for @ngocbh from 127.0.0.1 refused: people/ngocbh/person.yaml can't be read",
  )
  expect(messages(lines).filter((m) => m.endsWith(" failed"))).toEqual([])
  expect(lines.join("\n")).not.toContain(PASSWORD)
})

test("a password typed as the handle never reaches the log", async () => {
  const lines: string[] = []
  const { hq, client } = await withPassword({ logs: lines })
  const typed = "hunter2-secret-pw"
  delegating(hq, fast)
  const clock = { now: 1000 }
  hq.logins.throttle.clock = () => clock.now
  for (let i = 0; i < LIMIT; i++) expect((await login(client, typed, PASSWORD)).status).toBe(401)
  expect((await login(client, typed, PASSWORD)).status).toBe(429)
  expect(messages(lines)).toContain("sign-in for an unknown handle from 127.0.0.1 failed")
  expect(messages(lines)).toContain("sign-in for an unknown handle from 127.0.0.1 throttled for 60 s")
  expect(lines.join("\n")).not.toContain(typed)
})

test("an agent handle is still named", async () => {
  const lines: string[] = []
  const { client } = await withPassword({ logs: lines })
  expect((await login(client, "minh")).status).toBe(401)
  expect(messages(lines)).toContain("sign-in for @minh from 127.0.0.1 failed")
})

test("a failing handle lookup logs an unknown handle", async () => {
  const lines: string[] = []
  const { hq, client } = await withPassword({ logs: lines })
  // An own property over the prototype's method, deleted below so the method is back.
  Object.assign(hq.sessions, { knows: async () => Promise.reject(new Error("git went away")) })
  try {
    const r = await login(client, CEO, "a wrong guess")
    expect([r.status, r.json()]).toEqual([401, BAD])
  } finally {
    delete (hq.sessions as { knows?: unknown }).knows
  }
  expect(messages(lines)).toContain("sign-in for an unknown handle from 127.0.0.1 failed")
})

test("signing in replaces the old session even while its person file cant be read", async () => {
  const { office, hq, client } = await withPassword()
  addHuman(office.paths.company, "lan")
  setPassword(office.paths.company, "lan", await hashPassword(PASSWORD))
  const first = ((await login(client)).json() as Body).id as string
  handEdit(office.paths.company, CEO, { nickname: "typo" })
  expect(hq.sessions.proven(client.cookies.get(`opencorp_hq_${PORT}`))).toBe(first)
  const r = await login(client, "lan")
  expect([r.status, (r.json() as Body).person]).toEqual([200, "lan"])
  expect(office.store.getHqSession(first)).toBeUndefined()
})
