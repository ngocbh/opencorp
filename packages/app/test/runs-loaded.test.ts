import { expect, test } from "bun:test"
import type { RunLoading } from "@opencorp/protocol"
import { untilLoaded } from "../src/runs/loaded"

const loading = (retry_ms: number): RunLoading => ({ loading: true, retry_ms })

test("a read the office is still replaying is asked again after each wait it names, until its result comes", async () => {
  const replies: (RunLoading | { n: number })[] = [loading(500), loading(250), { n: 7 }]
  const waited: number[] = []
  let asked = 0
  const result = await untilLoaded(
    async () => replies[asked++]!,
    undefined,
    async (ms) => void waited.push(ms),
  )
  expect([result, asked, waited]).toEqual([{ n: 7 }, 3, [500, 250]])
})

test("a result that comes at once is the only ask, and a failure is the read's", async () => {
  let asked = 0
  expect(await untilLoaded(async () => (asked++, "now"), undefined, async () => {})).toBe("now")
  expect(asked).toBe(1)
  await expect(untilLoaded(async () => Promise.reject(new Error("409 not_supported")))).rejects.toThrow("409 not_supported")
})

test("once its reader leaves it asks no more, waiting or not", async () => {
  const left = new AbortController()
  let asked = 0
  const reading = untilLoaded(
    async () => (asked++, loading(10)),
    left.signal,
    (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true })
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 35))
  left.abort()
  await expect(reading).rejects.toThrow()
  const before = asked
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect([before > 1, asked]).toEqual([true, before])
  await expect(untilLoaded(async () => "late", left.signal)).rejects.toThrow()
})
