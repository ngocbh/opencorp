import { expect, test } from "bun:test"
import type { Question, Session } from "@opencorp/protocol"
import { buildTree } from "../src/company/tree"
import { branchStatus, needsYou, recipient, statusByPerson, totals } from "../src/company/status"
import { person } from "./people"

const s = (id: string, who: string, status: Session["status"], kind: Session["kind"] = "main") =>
  ({ id, person: who, status, kind, updated_at: "2026-10-19T10:00:00.000Z" }) as Session
const q = (id: string, session: string, over: Partial<Question> = {}) =>
  ({ id, session_id: session, status: "open", source: "ask_user", node_id: null, asker: "x", ...over }) as Question

test("first match wins: waiting, busy, idle, away; only main and side sessions count", () => {
  const m = statusByPerson(
    [s("1", "ann", "idle"), s("2", "ann", "busy"), s("3", "bo", "idle"), s("4", "cy", "busy", "profile_manager"),
     s("5", "dee", "idle"), s("6", "eve", "debriefing", "side"), s("7", "fay", "ended"), s("8", "fay", "failed")],
    [q("q1", "5")],
  )
  expect(Object.fromEntries(m)).toEqual({ ann: "busy", bo: "idle", dee: "waiting", eve: "busy" })
})

test("a chat's own turn isn't a waiting card", () => {
  const turn = q("t", "1", { source: "human_input", node_id: "chat#2/ask" })
  expect(statusByPerson([s("1", "ann", "idle")], [turn]).get("ann")).toBe("idle")
})

test("only open questions count, and not on the office's own sessions", () => {
  const m = statusByPerson(
    [s("1", "ann", "idle"), s("2", "bo", "idle", "profile_manager")],
    [q("a", "1", { status: "answered" }), q("b", "1", { status: "stale" }), q("c", "2"), q("d", "missing")],
  )
  expect(Object.fromEntries(m)).toEqual({ ann: "idle" })
})

test("a branch takes its most urgent member's status", () => {
  const tree = buildTree([person("ceo", null), person("al", "ceo"), person("bo", "al")], { name: "A", ceo: "ceo" })
  const m = new Map([["bo", "waiting" as const], ["al", "idle" as const]])
  expect(branchStatus(tree.roots[0], m)).toBe("waiting")
  expect(branchStatus(tree.roots[0], new Map([["al", "idle" as const]]))).toBe("idle")
  expect(branchStatus(tree.roots[0], new Map())).toBe("away")
})

test("ask_manager goes to its work item's assignee; anything else to who opened the session, else the CEO", () => {
  const sessions = new Map([["1", { ...s("1", "minh", "idle"), opened_by: "ann" } as Session], ["2", s("2", "minh", "idle")]])
  const assignee = (id: string) => (id === "W1" ? "lead" : undefined)
  expect(recipient(q("a", "1", { source: "ask_manager", work_item_id: "W1" }), sessions.get("1"), "ceo", assignee)).toBe("lead")
  expect(recipient(q("b", "1"), sessions.get("1"), "ceo", assignee)).toBe("ann")
  expect(recipient(q("c", "2"), sessions.get("2"), "ceo", assignee)).toBe("ceo")
  expect(recipient(q("d", "1", { source: "ask_manager", work_item_id: "W9" }), sessions.get("1"), "ceo", assignee)).toBeNull()
  expect(recipient(q("e", "1", { source: "ask_manager", work_item_id: null }), sessions.get("1"), "ceo", assignee)).toBeNull()
  expect(recipient(q("f", "2"), sessions.get("2"), null, assignee)).toBeNull()
})

test("needs you counts, per asking person, the open cards whose recipient is the viewer", () => {
  const sessions = [{ ...s("1", "minh", "idle"), opened_by: "ceo" } as Session, { ...s("2", "kai", "idle"), opened_by: "ann" } as Session]
  const questions = [q("a", "1"), q("b", "1"), q("c", "2"), q("t", "1", { source: "human_input", node_id: "chat/ask" })]
  expect(Object.fromEntries(needsYou("ceo", sessions, questions, "ceo", () => undefined))).toEqual({ minh: 2 })
  expect(Object.fromEntries(needsYou("ann", sessions, questions, "ceo", () => undefined))).toEqual({ kai: 1 })
})

test("a card on a session the app doesn't have counts for its asker", () => {
  expect(Object.fromEntries(needsYou("ceo", [], [q("a", "gone", { asker: "zoe" })], "ceo", () => undefined))).toEqual({ zoe: 1 })
})

test("a collapsed branch totals people, busy, waiting, needs you and cost", () => {
  const tree = buildTree([person("ceo", null), person("al", "ceo"), person("bo", "al")], { name: "A", ceo: "ceo" })
  const status = new Map([["al", "busy" as const], ["bo", "waiting" as const]])
  const needs = new Map([["bo", 2]])
  const costs = { since: "x", people: { al: { usd: 1.5, unpriced_sessions: 0 }, bo: { usd: 0.25, unpriced_sessions: 3 } } }
  expect(totals(tree.roots[0], status, needs, costs)).toEqual({ people: 3, busy: 1, waiting: 1, needsYou: 2, usd: 1.75, unpriced: 3 })
  expect(totals(tree.roots[0].children[0].children[0], status, needs, null)).toEqual(
    { people: 1, busy: 0, waiting: 1, needsYou: 2, usd: 0, unpriced: 0 },
  )
})
