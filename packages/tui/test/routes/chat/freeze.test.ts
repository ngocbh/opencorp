import { expect, test } from "bun:test"
import type { Message } from "@opencorp/protocol"
import { freeze, frozenList, frozenView, INTERRUPTED_TEXT, unfreeze } from "../../../src/routes/chat/freeze"

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

// A turn answering "A" is stopped while "B" waits as a steer; the next turn answers B.
const A = msg("A", "user", text("a", "A"))
const heldAtEsc = msg("H", "assistant", text("h", "Held "))
const heldFinal = msg("H", "assistant", text("h", "Held " + INTERRUPTED_TEXT))
const B = msg("B", "user", text("b", "B steer"))
const ansB = msg("AB", "assistant", text("ab", "Answer to B."))
const texts = (list: Message[]) => list.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("|"))

test("the answer to a steer queued before Esc shows while frozen and after the next send", () => {
  const f = freeze([A, heldAtEsc, B], undefined, {})
  const now = [A, heldFinal, B, ansB]
  expect(texts(frozenList(f, now))).toEqual(["A", "Held " + INTERRUPTED_TEXT, "B steer", "Answer to B."])
  const C = msg("C", "user", text("c", "C"))
  const ansC = msg("AC", "assistant", text("ac", "Answer to C."))
  const after = unfreeze(f, now)
  expect(texts(frozenList(after, [...now, C, ansC]))).toEqual([
    "A",
    "Held " + INTERRUPTED_TEXT,
    "B steer",
    "Answer to B.",
    "C",
    "Answer to C.",
  ])
})

test("a steer sent before Esc that the office publishes after it still gets its answer shown", () => {
  const f = freeze([A, heldAtEsc], undefined, {})
  expect(texts(frozenList(f, [A, heldFinal, B, ansB]))).toEqual([
    "A",
    "Held " + INTERRUPTED_TEXT,
    "B steer",
    "Answer to B.",
  ])
})

test("the stopped turn's own late messages stay hidden, even after an earlier turn's user message", () => {
  const prev = msg("P", "assistant", text("p", "Earlier answer"))
  const late = msg("M", "assistant", text("m", "late"))
  // Esc before the stopped turn wrote anything: the last reply belongs to the turn before.
  const f = freeze([prev, A], undefined, { [prev.id]: true })
  expect(texts(frozenList(f, [prev, A, late]))).toEqual(["Earlier answer", "A"])
  expect(texts(frozenList(unfreeze(f, [prev, A, late]), [prev, A, late]))).toEqual(["Earlier answer", "A"])
  // A late message of the stopped turn after its last one, with no user message between, stays hidden too.
  const g = freeze([A, heldAtEsc], undefined, {})
  expect(texts(frozenList(g, [A, heldFinal, late]))).toEqual(["A", "Held " + INTERRUPTED_TEXT])
})

test("without the turn's start, everything new while frozen stays hidden", () => {
  const f = freeze([A, heldAtEsc, B])
  expect(texts(frozenList(f, [A, heldFinal, B, ansB]))).toEqual(["A", "Held " + INTERRUPTED_TEXT, "B steer"])
  expect(texts(frozenList(unfreeze(f, [A, heldFinal, B, ansB]), [A, heldFinal, B, ansB]))).toEqual([
    "A",
    "Held " + INTERRUPTED_TEXT,
    "B steer",
  ])
})

test("a second Esc after the answer showed freezes it at its length", () => {
  const f1 = freeze([A, heldAtEsc, B], undefined, {})
  const f2 = freeze([A, heldFinal, B, ansB], f1, { [heldAtEsc.id]: true })
  const grown = msg("AB", "assistant", text("ab", "Answer to B. And more"))
  expect(texts(frozenList(f2, [A, heldFinal, B, grown]))).toEqual([
    "A",
    "Held " + INTERRUPTED_TEXT,
    "B steer",
    "Answer to B.",
  ])
})

test("a second Esc before the answer appears stops that turn too, so its answer stays hidden", () => {
  const f1 = freeze([A, heldAtEsc, B], undefined, {})
  const f2 = freeze([A, heldFinal, B], f1, { [heldAtEsc.id]: true })
  const now = [A, heldFinal, B, ansB]
  expect(texts(frozenList(f2, now))).toEqual(["A", "Held " + INTERRUPTED_TEXT, "B steer"])
  expect(texts(frozenList(unfreeze(f2, now), now))).toEqual(["A", "Held " + INTERRUPTED_TEXT, "B steer"])
})

test("an Esc before the next send's answer appears hides that answer, past the last stopped turn's late output", () => {
  const late = msg("M", "assistant", text("m", "late"))
  const C = msg("C", "user", text("c", "C"))
  const ansC = msg("AC", "assistant", text("ac", "Answer to C."))
  // C goes out while the stopped reply still winds down, so the turn's start stays where Esc left it.
  const sent = unfreeze(freeze([A, heldAtEsc], undefined, {}), [A, heldFinal, late, C])
  const f = freeze([A, heldFinal, late, C], sent, { [heldAtEsc.id]: true })
  expect(texts(frozenList(f, [A, heldFinal, late, C, ansC]))).toEqual(["A", "Held " + INTERRUPTED_TEXT, "C"])
})
