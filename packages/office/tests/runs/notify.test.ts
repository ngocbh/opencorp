/** Node changes go out as run.updated: the first at once, then at most one a second per run, the last always sent. */
import { expect, onTestFinished, test } from "bun:test"
import type { Scheduler } from "@ngocbh/yian/platform"
import type { Event } from "@opencorp/protocol"
import { RunNotifier, runUpdated } from "../../src/runs/notify.ts"

/** A scheduler on a clock the test moves: a sleep ends once `advance` passes its deadline and rejects on abort. */
function manualScheduler() {
  let clock = 0
  let armed = 0
  const sleepers: { at: number; wake: () => void }[] = []
  const scheduler: Scheduler = {
    now: () => clock,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        armed += 1
        if (signal?.aborted) return reject(signal.reason)
        if (ms <= 0) return resolve()
        const sleeper = { at: clock + ms, wake: resolve }
        sleepers.push(sleeper)
        signal?.addEventListener(
          "abort",
          () => {
            sleepers.splice(sleepers.indexOf(sleeper), 1)
            reject(signal.reason)
          },
          { once: true },
        )
      }),
  }
  return {
    scheduler,
    /** Sleeps waiting now. */
    sleeping: () => sleepers.length,
    /** Sleeps ever armed. */
    armed: () => armed,
    /** Moves the clock to `to` ms, ends the sleeps it passes and lets their callbacks run. */
    async advance(to: number) {
      clock = to
      for (const sleeper of sleepers.filter((s) => s.at <= clock)) {
        sleepers.splice(sleepers.indexOf(sleeper), 1)
        sleeper.wake()
      }
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/** Builds that stand in for events: the tests compare what was sent, not an event's shape. */
const as = (value: string) => () => value as unknown as Event

test("the first change goes at once then one trailing event per interval", async () => {
  const sent: unknown[] = []
  const fake = manualScheduler()
  const n = new RunNotifier((e) => sent.push(e), { every: 200, scheduler: fake.scheduler })
  onTestFinished(() => n.close())
  n.changed("r1", as("e1"))
  expect(sent).toEqual(["e1"])
  n.changed("r1", as("e2"))
  n.changed("r1", as("e3"))
  expect(sent).toEqual(["e1"])
  await fake.advance(199)
  expect(sent).toEqual(["e1"])
  await fake.advance(200)
  expect(sent).toEqual(["e1", "e3"])
  await fake.advance(500)
  expect(sent).toEqual(["e1", "e3"])
  expect(fake.sleeping()).toBe(0)
})

test("a run due sooner re arms the timer", async () => {
  const sent: unknown[] = []
  const fake = manualScheduler()
  const n = new RunNotifier((e) => sent.push(e), { every: 1000, scheduler: fake.scheduler })
  onTestFinished(() => n.close())
  n.changed("r2", as("b1"))
  await fake.advance(500)
  n.changed("r1", as("a1"))
  await fake.advance(600)
  n.changed("r1", as("a2"))
  await fake.advance(700)
  n.changed("r2", as("b2"))
  expect(fake.sleeping()).toBe(1)
  await fake.advance(1000)
  expect(sent).toEqual(["b1", "a1", "b2"])
  await fake.advance(1500)
  expect(sent).toEqual(["b1", "a1", "b2", "a2"])
  expect(fake.sleeping()).toBe(0)
})

test("runs are throttled apart and none sends nothing", () => {
  const sent: unknown[] = []
  const n = new RunNotifier((e) => sent.push(e), { every: 10_000, scheduler: manualScheduler().scheduler })
  onTestFinished(() => n.close())
  n.changed("r1", as("a"))
  n.changed("r2", as("b"))
  n.changed("r3", () => null)
  expect(sent).toEqual(["a", "b"])
})

test("close stops the timer and drops what waits", async () => {
  const sent: unknown[] = []
  const fake = manualScheduler()
  const n = new RunNotifier((e) => sent.push(e), { every: 10_000, scheduler: fake.scheduler })
  onTestFinished(() => n.close())
  n.changed("r1", as("a"))
  n.changed("r1", as("b"))
  expect(fake.sleeping()).toBe(1)
  n.close()
  expect(fake.sleeping()).toBe(0)
  expect(sent).toEqual(["a"])
  await fake.advance(20_000)
  n.changed("r9", as("c"))
  expect(sent).toEqual(["a"])
  expect(fake.sleeping()).toBe(0)
})

test("runs long quiet are forgotten even when nothing is coalesced", async () => {
  const fake = manualScheduler()
  const n = new RunNotifier(() => {}, { every: 10, scheduler: fake.scheduler })
  onTestFinished(() => n.close())
  for (let r = 0; r < 1000; r++) n.changed(`old${r}`, () => null)
  await fake.advance(1000)
  for (let r = 0; r < 300; r++) n.changed(`new${r}`, () => null)
  expect(fake.armed()).toBe(0)
  expect([...n.remembered.keys()].some((r) => r.startsWith("old"))).toBe(false)
})

test("a failing build is logged and the next still goes", () => {
  const sent: unknown[] = []
  const lines: string[] = []
  const n = new RunNotifier((e) => sent.push(e), {
    every: 0,
    scheduler: manualScheduler().scheduler,
    log: (line) => lines.push(line),
  })
  onTestFinished(() => n.close())
  n.changed("r1", () => {
    throw new RangeError("a value the log must not quote")
  })
  n.changed("r2", as("b"))
  expect(sent).toEqual(["b"])
  expect(lines).toEqual(["couldn't send a run.updated (RangeError)"])
})

test("a run updated event is an event with a run updated payload", () => {
  const e = runUpdated("01JA1H00000000000000000001", "01JA1H000000000000000000S1", null, "running", ["chat#1/reply"])
  expect([e.type, e.subject_id, e.data.current_nodes, e.data.parent_run_id]).toEqual([
    "run.updated",
    "01JA1H00000000000000000001",
    ["chat#1/reply"],
    null,
  ])
})
