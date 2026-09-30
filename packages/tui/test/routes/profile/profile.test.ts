import { expect, test } from "bun:test"
import type { Message, ProfileProposal, Session } from "@agent-corp/protocol"
import {
  CONFLICT_MARKER,
  conflictText,
  diffLines,
  managerSession,
  openProposal,
  shortVersion,
  transcript,
  withoutConflict,
} from "../../../src/routes/profile/profile"

test("shortVersion keeps seven characters", () => {
  expect(shortVersion("0123456789abcdef")).toBe("0123456")
})

test("a rejected edit comes back under the marker; saving drops everything from the marker on", () => {
  const text = conflictText("# Minh\n\nNew line.\n", "# Minh\n\nMy line.\n")
  expect(text).toBe(`# Minh\n\nNew line.\n\n${CONFLICT_MARKER}\n# Minh\n\nMy line.\n`)
  expect(withoutConflict(text)).toBe("# Minh\n\nNew line.\n")
  expect(withoutConflict("plain\n")).toBe("plain\n")
})

const session = (id: string, fields: Partial<Session>) =>
  ({ id, person: "minh", kind: "profile_manager", status: "idle", created_at: id, ...fields }) as Session

test("managerSession is the person's newest live profile manager session", () => {
  const sessions = [
    session("1", {}),
    session("3", { status: "ended" }),
    session("2", {}),
    session("4", { kind: "main" }),
    session("5", { person: "lan" }),
  ]
  expect(managerSession(sessions, "minh")?.id).toBe("2")
  expect(managerSession([session("1", { status: "failed" })], "minh")).toBeUndefined()
})

const proposal = (id: string, fields: Partial<ProfileProposal>) =>
  ({ id, person: "minh", status: "open", created_at: id, ...fields }) as ProfileProposal

test("openProposal is the person's newest open proposal", () => {
  const list = [
    proposal("1", {}),
    proposal("3", { status: "applied" }),
    proposal("2", {}),
    proposal("4", { person: "lan" }),
  ]
  expect(openProposal(list, "minh")?.id).toBe("2")
  expect(openProposal([proposal("1", { status: "stale" })], "minh")).toBeUndefined()
})

test("diffLines drops the file headers and keeps hunks", () => {
  const diff = `${"=".repeat(67)}\n--- profile.md\n+++ profile.md\n@@ -1,2 +1,2 @@\n # Minh\n-old\n+new\n`
  expect(diffLines(diff)).toEqual(["@@ -1,2 +1,2 @@", " # Minh", "-old", "+new"])
  expect(diffLines("--- a\n+++ b\n@@ -1 +1 @@\n--- x\n+++ y\n")).toEqual(["@@ -1 +1 @@", "--- x", "+++ y"])
})

test("transcript keeps text and names tools", () => {
  const msgs = [
    { id: "a", role: "user", parts: [{ id: "p", type: "text", text: "Mention tests" }] },
    {
      id: "b",
      role: "assistant",
      parts: [
        { id: "q", type: "tool", tool: "propose", state: "completed" },
        { id: "r", type: "text", text: "Proposed." },
      ],
    },
  ] as unknown as Message[]
  expect(transcript(msgs)).toEqual([
    { role: "user", text: "Mention tests" },
    { role: "assistant", text: "[propose]" },
    { role: "assistant", text: "Proposed." },
  ])
})
