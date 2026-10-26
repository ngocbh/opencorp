/** A session's model, as a failure tells it: which connection a refused key names (part of Python's
 *  `tests/chat/test_session_model.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { refusedKey } from "../../src/chat/session_actor.ts"
import { waitFor } from "../helpers.ts"
import { errors, fakeLlm, makeHarness, noWorkersLeft, status } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

test("a refused key says which connection to check", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 401 }, { error: 500 })
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder, { connection: "second" })
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  await h.harness.prompt(s.id, "hi")
  await waitFor(() => h.store.getSession(s.id)!.run_ids.length === 2 && status(h, s.id) === "idle", {
    what: "the new run",
  })
  const [error, ...rest] = errors(h, s.id)
  expect(rest).toEqual([])
  expect(error).toEndWith("Send your message again. Check connection 'second', or pick another model with /model.")
  await h.harness.prompt(s.id, "again")
  await waitFor(() => errors(h, s.id).length === 2, { what: "the second failure" })
  // A failure that isn't the key says nothing of it.
  expect(errors(h, s.id)[1]).not.toContain("/model")
})

test("a refused key is told by its cause or status not any 401", () => {
  expect(refusedKey({ cause_type: "OpenAIAuthenticationError" }, "")).toBe(true)
  expect(refusedKey({ cause_type: "PermissionDeniedError" }, "")).toBe(true)
  expect(refusedKey({ cause_type: "APIStatusError" }, "APIStatusError: Error code: 401 - unauthorized")).toBe(true)
  const tokens = "BadRequestError: your messages resulted in 140100 tokens"
  expect(refusedKey({ cause_type: "BadRequestError" }, tokens)).toBe(false)
  expect(refusedKey({}, "no reason given")).toBe(false)
})

test("a refused key is told by the provider error kind", () => {
  const why = (kind: string) => `ProviderError: azure returned HTTP 418 (${kind}): no`
  expect(refusedKey({ cause_type: "ProviderError" }, why("auth"))).toBe(true)
  expect(refusedKey({ cause_type: "ProviderError" }, why("permission"))).toBe(true)
  expect(refusedKey({ cause_type: "ProviderError" }, why("rate_limit"))).toBe(false)
})
