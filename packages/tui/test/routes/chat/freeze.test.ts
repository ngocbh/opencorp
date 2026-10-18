import { expect, test } from "bun:test"
import type { Message } from "@opencorp/protocol"
import { freeze, frozenView, INTERRUPTED_TEXT, unfreeze } from "../../../src/routes/chat/freeze"

const at = "2026-09-30T00:00:00Z"
const msg = (id: string, role: Message["role"], ...parts: Message["parts"]): Message => ({
  id,
  session_id: "S",
  role,
  created_at: at,
  parts,
})
const text = (id: string, t: string) => ({ id, type: "text" as const, text: t })

test("after a freeze, a frozen reply keeps its text and parts; new replies hide until unfreeze", () => {
  const user = msg("U", "user", text("u", "fix it"))
  const reply = msg("M", "assistant", text("a", "Looking"))
  const f = freeze([user, reply])
  const grown = msg("M", "assistant", text("a", "Looking at it"), text("b", "Done"))
  expect(frozenView(f, grown)).toEqual(msg("M", "assistant", text("a", "Looking")))
  expect(frozenView(f, user)).toBe(user)
  const late = msg("L", "assistant", text("l", "late"))
  expect(frozenView(f, late)).toBeUndefined()
  expect(frozenView(f, msg("V", "user", text("v", "a steer")))).toBeDefined()

  const after = unfreeze(f, [user, grown, late])
  expect(frozenView(after, late)).toBeUndefined()
  expect(frozenView(after, grown)).toEqual(msg("M", "assistant", text("a", "Looking")))
  const next = msg("N", "assistant", text("n", "Fresh"))
  expect(frozenView(after, next)).toBe(next)
})

test("a second freeze keeps what the first hid", () => {
  const reply = msg("M", "assistant", text("a", "Looking"))
  const late = msg("L", "assistant", text("l", "late"))
  const first = unfreeze(freeze([reply]), [msg("M", "assistant", text("a", "Looking more")), late])
  const second = freeze([msg("M", "assistant", text("a", "Looking more more")), late], first)
  expect(frozenView(second, late)).toBeUndefined()
  expect(frozenView(second, msg("M", "assistant", text("a", "Looking more more")))?.parts).toEqual([
    text("a", "Looking"),
  ])
  expect(frozenView(undefined, late)).toBe(late)
})

test("a second Esc before the next send keeps hiding what arrived after the first", () => {
  const reply = msg("M", "assistant", text("a", "Looking"))
  const late = msg("L", "assistant", text("l", "late"))
  const steer = msg("V", "user", text("v", "a steer"))
  const first = freeze([reply])
  const second = freeze([reply, late, steer], first)
  expect(second.active).toBe(true)
  expect(frozenView(second, late)).toBeUndefined()
  expect(frozenView(second, steer)).toBe(steer)
  expect(frozenView(second, reply)).toBe(reply)
  // It stays hidden after the next send too.
  const after = unfreeze(second, [reply, late, steer])
  expect(frozenView(after, late)).toBeUndefined()
})

test("the interrupted marker the office ends a stopped reply with shows through the freeze", () => {
  const reply = msg("M", "assistant", text("a", "Looking"))
  const f = freeze([reply])
  // Appended to a frozen text part, it shows after the frozen text, even if more text came first.
  expect(frozenView(f, msg("M", "assistant", text("a", "Looking" + INTERRUPTED_TEXT)))?.parts).toEqual([
    text("a", "Looking" + INTERRUPTED_TEXT),
  ])
  expect(frozenView(f, msg("M", "assistant", text("a", "Looking at it" + INTERRUPTED_TEXT)))?.parts).toEqual([
    text("a", "Looking" + INTERRUPTED_TEXT),
  ])
  // As its own part after Esc, it shows; any other new part stays hidden.
  const marker = text("i", "[interrupted]")
  expect(frozenView(f, msg("M", "assistant", text("a", "Looking"), text("b", "Done"), marker))?.parts).toEqual([
    text("a", "Looking"),
    marker,
  ])
  expect(frozenView(f, msg("M", "assistant", text("b", "Done [interrupted]")))?.parts).toEqual([])
  // A reply that arrived after Esc stays hidden, marker and all.
  expect(frozenView(f, msg("L", "assistant", marker))).toBeUndefined()
})
