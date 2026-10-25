/** The session actor's host loop rules that have no Python test of their own. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { waitFor } from "../helpers.ts"
import { chatOffice, fakeLlm, noWorkersLeft, say, session, startActor } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

test("turns count finished replies once", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "one" }, { content: "two" })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  expect(session(o, sid).turns).toBe(0)
  await say(o, actor, sid, "a")
  await say(o, actor, sid, "b")
  await waitFor(() => !actor.hasWorker, { what: "the worker to exit" })
  expect(session(o, sid).turns).toBe(2)
})
