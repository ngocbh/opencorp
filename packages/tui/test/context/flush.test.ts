import { expect, test } from "bun:test"
import { createFlush } from "../../src/context/flush"

function setup() {
  const applied: string[] = []
  const flush = createFlush<string[]>((fns) => fns.forEach((fn) => fn(applied)), 5)
  return { applied, flush }
}

test("settled resolves only once the queued change is applied", async () => {
  const { applied, flush } = setup()
  flush.mutate((s) => s.push("a"))
  expect(applied).toEqual([])
  await flush.settled()
  expect(applied).toEqual(["a"])
})

test("settled resolves at once with nothing queued", async () => {
  const { flush } = setup()
  let done = false
  void flush.settled().then(() => (done = true))
  await Promise.resolve()
  expect(done).toBe(true)
})

test("a settled waiting when the queue is disposed resolves", async () => {
  const { applied, flush } = setup()
  flush.mutate((s) => s.push("a"))
  const waiting = flush.settled()
  flush.dispose()
  await waiting
  expect(applied).toEqual([])
})

test("settled after dispose resolves, with a change queued after it", async () => {
  const { flush } = setup()
  flush.mutate((s) => s.push("a"))
  flush.dispose()
  flush.mutate((s) => s.push("b"))
  await flush.settled()
})

test("after dispose, queued changes, later callbacks and new ones never run", async () => {
  const { applied, flush } = setup()
  const calls: string[] = []
  flush.mutate((s) => s.push("a"))
  flush.later(() => calls.push("queued"))
  flush.dispose()
  flush.mutate((s) => s.push("b"))
  flush.later(() => calls.push("new"))
  await Bun.sleep(30)
  expect(applied).toEqual([])
  expect(calls).toEqual([])
})

test("later runs at once with nothing queued, and after the flush otherwise", async () => {
  const { applied, flush } = setup()
  const calls: string[][] = []
  flush.later(() => calls.push([...applied]))
  flush.mutate((s) => s.push("a"))
  flush.later(() => calls.push([...applied]))
  await flush.settled()
  expect(calls).toEqual([[], ["a"]])
})
