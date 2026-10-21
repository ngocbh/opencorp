import { expect, test } from "bun:test"
import { readLimit, readQueue } from "../src/runs/queue"

/** A read that waits until `release` is called, logging when it starts. */
function gate(log: string[], name: string) {
  let release!: () => void
  const done = new Promise<void>((r) => (release = r))
  return { read: async () => (log.push(name), await done), release: () => release() }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

test("reads run one at a time, in the order they were queued", async () => {
  const log: string[] = []
  const queue = readQueue()
  const a = gate(log, "a")
  queue(a.read)
  queue(async () => void log.push("b"))
  await tick()
  expect(log).toEqual(["a"])
  a.release()
  await tick()
  expect(log).toEqual(["a", "b"])
})

test("a keyed read isn't queued again while one with its key waits to start", async () => {
  const log: string[] = []
  const queue = readQueue()
  const slow = gate(log, "slow")
  queue(slow.read)
  for (let i = 0; i < 5; i++) queue(async () => void log.push("reread"), "reread")
  slow.release()
  await tick()
  await tick()
  expect(log).toEqual(["slow", "reread"])
})

test("once a keyed read has started, the next one with its key queues", async () => {
  const log: string[] = []
  const queue = readQueue()
  const first = gate(log, "reread")
  queue(first.read, "reread")
  await tick()
  queue(async () => void log.push("again"), "reread")
  queue(async () => void log.push("dropped"), "reread")
  first.release()
  await tick()
  await tick()
  expect(log).toEqual(["reread", "again"])
})

test("a failed read doesn't stop the reads after it", async () => {
  const log: string[] = []
  const queue = readQueue()
  queue(async () => {
    throw new Error("boom")
  })
  queue(async () => void log.push("after"))
  await tick()
  await tick()
  expect(log).toEqual(["after"])
})

test("a limit runs at most n reads at once, the rest in the order they came", async () => {
  const log: string[] = []
  const limit = readLimit(2)
  const reads = ["a", "b", "c", "d"].map((name) => gate(log, name))
  const answers = reads.map((r, i) => limit(async () => (await r.read(), i)))
  await tick()
  expect(log).toEqual(["a", "b"])
  reads[1]!.release()
  await tick()
  expect(log).toEqual(["a", "b", "c"])
  reads[0]!.release()
  reads[2]!.release()
  reads[3]!.release()
  expect(await Promise.all(answers)).toEqual([0, 1, 2, 3])
  expect(log).toEqual(["a", "b", "c", "d"])
})

test("a limit frees a read's slot when it fails, and passes the failure on", async () => {
  const log: string[] = []
  const limit = readLimit(1)
  const failed = limit(async () => {
    throw new Error("boom")
  })
  const next = limit(async () => void log.push("next"))
  await expect(failed).rejects.toThrow("boom")
  await next
  expect(log).toEqual(["next"])
})
