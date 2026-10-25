/** Waking a sleeping session: one worker at a time, nothing lost (Python's `tests/chat/test_wake.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { waitFor } from "../helpers.ts"
import { asleep, chatOffice, fakeLlm, noWorkersLeft, reopen, say, session, startActor, texts } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Records the order in which `promise` and others like it settle under `name`. */
function track<T>(promise: Promise<T>, name: string, settled: string[]): Promise<T> {
  return promise.finally(() => settled.push(name))
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("a prompt wakes a sleeping session on its own run", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor: first, sid } = await startActor(o)
  expect(await say(o, first, sid, "a")).toBe("one")
  const second = await reopen(o, first)
  const before = o.kinds.length
  expect(await say(o, second, sid, "b")).toBe("two")
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
  // The advanced run kept the conversation.
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("one")
})

test("two prompts to a sleeping session spawn one worker and both arrive", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "r1" }, { content: "r2" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const before = o.kinds.length
  const held = o.hold()
  const settled: string[] = []
  const a = track(actor.prompt("first"), "a", settled)
  await held.entered
  const b = track(actor.prompt("second"), "b", settled)
  await pause(200)
  // No message is answered before the wake has a worker.
  expect(settled).toEqual([])
  held.release()
  await Promise.all([a, b])
  await waitFor(() => {
    const all = JSON.stringify(fake.requests())
    return all.includes("first") && all.includes("second")
  }, { what: "both messages" })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a prompt while the wake spawns waits for it and is delivered", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "r1" }, { content: "r2" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  const held = o.hold()
  const settled: string[] = []
  const a = actor.prompt("first")
  await held.entered
  expect(o.registry.get(sid)).toBeUndefined()
  const b = track(actor.prompt("second"), "b", settled)
  await pause(200)
  // It waits for the wake, not on a session with no worker yet.
  expect(settled).toEqual([])
  held.release()
  await Promise.all([a, b])
  await waitFor(() => {
    const all = JSON.stringify(fake.requests())
    return all.includes("first") && all.includes("second")
  }, { what: "both messages" })
})

test("a steer to a sleeping session wakes it and is its next message", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "steered" })
  const o = await chatOffice(fake)
  const { actor, sid } = await asleep(o)
  await actor.steer("look here")
  await waitFor(() => JSON.stringify(texts(o, sid)) === JSON.stringify(["steered"]), { what: "the reply" })
  expect(texts(o, sid, "user")).toEqual(["look here"])
})
