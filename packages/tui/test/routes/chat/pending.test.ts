import { expect, test } from "bun:test"
import { dropped, noPending, pendingMessage, published, sent } from "../../../src/routes/chat/pending"

const at = "2026-10-28T00:00:00Z"

test("the office's user messages take the pending sends, oldest first", () => {
  const first = sent(noPending(), "fix the test", at)
  const second = sent(first.pending, "and the lint", at)
  expect(second.pending.messages.map((m) => m.text)).toEqual(["fix the test", "and the lint"])
  expect(second.id).not.toBe(first.id)

  // The office's message carries its own id and the parts it built, so only the order matches them up.
  const one = published(second.pending, ["R1:4"])
  expect(one.messages.map((m) => m.text)).toEqual(["and the lint"])
  // The same message again (a resync after the live event) takes no second send.
  expect(published(one, ["R1:4"])).toBe(one)
  expect(published(one, ["R1:4", "R1:7"]).messages).toEqual([])
})

test("the user messages a transcript already had take no pending send", () => {
  const loaded = published(noPending(), ["R1:1", "R1:2"])
  const after = sent(loaded, "fix the test", at)
  expect(published(after.pending, ["R1:1", "R1:2"]).messages.map((m) => m.text)).toEqual(["fix the test"])
})

test("a send that failed drops its own message and leaves the rest", () => {
  const first = sent(noPending(), "fix the test", at)
  const second = sent(first.pending, "and the lint", at)
  expect(dropped(second.pending, first.id).messages.map((m) => m.text)).toEqual(["and the lint"])
  // Dropping twice, or dropping one the office already took, changes nothing.
  const once = dropped(second.pending, first.id)
  expect(dropped(once, first.id)).toBe(once)
})

test("a pending send renders as a user message of the session, with the text that was typed", () => {
  const { pending, id } = sent(noPending(), "fix the test", at)
  expect(pendingMessage("S1", pending.messages[0])).toEqual({
    id,
    session_id: "S1",
    role: "user",
    author: null,
    parts: [{ id: `${id}:0`, type: "text", text: "fix the test" }],
    created_at: at,
  })
})
