import { expect, test } from "bun:test"
import type { RunLoading } from "@opencorp/protocol"
import { BACKOFF_MS, LOADING_MS, StillLoading, untilLoaded } from "../src/runs/loaded"

const loading = (retry_ms: number): RunLoading => ({ loading: true, retry_ms })

test("a read the office is still replaying is asked again, backing off from the wait it names, until it comes", async () => {
  const replies: (RunLoading | { n: number })[] = [loading(500), loading(250), loading(500), loading(500), loading(500),
                                                   loading(6000), { n: 7 }]
  const waited: number[] = []
  let asked = 0
  const result = await untilLoaded(async () => replies[asked++]!, undefined, { wait: async (ms) => void waited.push(ms) })
  // 0.5, 1, 2, then 4 s at most, or longer when the office asks it.
  expect([result, asked, waited]).toEqual([{ n: 7 }, 7, [500, 1000, 2000, 4000, 4000, 6000]])
  expect(BACKOFF_MS).toEqual([500, 1000, 2000, 4000])
})

test("a result that comes at once is the only ask, and a failure is the read's", async () => {
  let asked = 0
  expect(await untilLoaded(async () => (asked++, "now"), undefined, { wait: async () => {} })).toBe("now")
  expect(asked).toBe(1)
  await expect(untilLoaded(async () => Promise.reject(new Error("409 not_supported")))).rejects.toThrow("409 not_supported")
})

test("past LOADING_MS of asking it gives up, saying the office is still reading it", async () => {
  const clock = { now: 0 }
  let asked = 0
  const reading = untilLoaded(async () => (asked++, loading(500)), undefined, {
    now: () => clock.now,
    wait: async (ms) => void (clock.now += ms),
  })
  const error = await reading.catch((e: unknown) => e)
  expect([error instanceof StillLoading, (error as Error).message]).toEqual([
    true, "the office is still reading this from the log; try again in a while",
  ])
  expect(clock.now).toBeGreaterThanOrEqual(LOADING_MS)
  expect(clock.now).toBeLessThan(LOADING_MS + 4000)
  expect(asked).toBeLessThan(60)
})

test("once its reader leaves it asks no more, waiting or not", async () => {
  const left = new AbortController()
  let asked = 0
  const reading = untilLoaded(async () => (asked++, loading(10)), left.signal, {
    wait: (_ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5)
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true })
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 35))
  left.abort()
  await expect(reading).rejects.toThrow()
  const before = asked
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect([before > 1, asked]).toEqual([true, before])
  await expect(untilLoaded(async () => "late", left.signal)).rejects.toThrow()
})
