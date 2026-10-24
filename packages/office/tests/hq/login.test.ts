/** Signing a browser in with a handle and password: the throttle, the dummy hash, and two checks at a time. */
import { expect, test } from "bun:test"
import { checkPassword, DUMMY_HASH, hashPassword } from "../../src/auth/passwords.ts"
import { BadCredentials, Busy, Logins, MAX_KEYS, Throttle, Throttled } from "../../src/hq/login.ts"
import { passwordFp } from "../../src/hq/sessions.ts"
import { waitFor } from "../helpers.ts"

const PASSWORD = "correct horse battery"
// A synthetic PHC string: never hashed, the injected check compares it as text.
const PHC = "$scrypt$ln=16,r=8,p=1$c3ludGhldGljIHNhbHQ$c3ludGhldGljIGhhc2ggb2YgdGhlIHBhc3N3b3Jk"

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
  const cost = /\$scrypt\$ln=\d+,r=\d+,p=\d+\$/
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
    { passwordHash: async () => null },
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

test("an unknown handle is checked against the dummy hash and fails", async () => {
  const checked: string[] = []
  const logins = new Logins(
    { passwordHash: async () => null },
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

test("a throttled pair is refused before the password is checked", async () => {
  const clock = clockAt()
  const checked: string[] = []
  const logins = new Logins(
    { passwordHash: async () => PHC },
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
    { passwordHash: async () => PHC },
    { clock: clockAt().call, checkPassword: async (password, phc) => password === PASSWORD && phc === PHC },
  )
  for (let i = 0; i < 4; i++)
    expect(await rejection(logins.check("p", "ngocbh", "a wrong guess"))).toBeInstanceOf(BadCredentials)
  expect(await logins.check("p", "ngocbh", PASSWORD)).toBe(passwordFp(PHC))
  for (let i = 0; i < 4; i++)
    expect(await rejection(logins.check("p", "ngocbh", "a wrong guess"))).toBeInstanceOf(BadCredentials)
  expect(logins.throttle.wait(["p", "ngocbh"])).toBeNull()
})
