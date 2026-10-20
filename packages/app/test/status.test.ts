import { expect, test } from "bun:test"
import type { Question, Session } from "@opencorp/protocol"
import { buildTree } from "../src/company/tree"
import { branchStatus, statusByPerson } from "../src/company/status"
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
