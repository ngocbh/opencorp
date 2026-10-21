import { expect, test } from "bun:test"
import type { RunSummary } from "@opencorp/protocol"
import { flowText, nodesText, shortId, took, where } from "../src/runs/format"

const run = (over: Partial<RunSummary>): RunSummary =>
  ({ run_id: "01JA1H0000000000000000A1B2", session_id: "S", flow: "chat", flow_path: "shared/flows/chat.yaml",
     person: "minh", driver: "ngocbh", participants: ["minh"], status: "running", current_nodes: [],
     launched_at: "2026-10-20T10:00:00.000Z", ...over }) as RunSummary

test("an id shows its last 8 characters", () => expect(shortId("01JA1H0000000000000000A1B2")).toBe("0000A1B2"))

test("took is launch to end, idle time included, and a dash without an end", () => {
  expect(took(run({ ended_at: "2026-10-20T10:00:42.000Z" }))).toBe("42s")
  expect(took(run({ ended_at: "2026-10-20T10:03:05.000Z" }))).toBe("3m 5s")
  expect(took(run({ ended_at: "2026-10-20T12:10:00.000Z" }))).toBe("2h 10m")
  expect(took(run({}))).toBe("—")
})

test("one node shows whole; several show the first one's name and how many more", () => {
  expect(nodesText(["chat#12/reply"])).toBe("chat#12/reply")
  expect(nodesText(["m#0/reply", "m#1/reply", "m#2/reply"])).toBe("reply +2")
  expect(nodesText([])).toBe("")
})

test("where / took by status", () => {
  expect(where(run({ status: "running" }))).toBe("starting")
  expect(where(run({ status: "running", current_nodes: ["chat#3/reply"] }))).toBe("chat#3/reply")
  expect(where(run({ status: "idle", current_nodes: ["chat#3/ask"] }))).toBe("chat#3/ask")
  expect(where(run({ status: "waiting", asking: true, current_nodes: ["chat#3/reply"] }))).toBe("asking · chat#3/reply")
  expect(where(run({ status: "waiting", held: true }))).toBe("cost cap")
  expect(where(run({ status: "finished", ended_at: "2026-10-20T10:00:09.000Z" }))).toBe("9s")
  expect(where(run({ status: "failed", failed_node: "chat#2/reply", reason: "AuthError" }))).toBe("chat#2/reply")
  expect(where(run({ status: "failed", reason: "couldn't start" }))).toBe("couldn't start")
  expect(where(run({ status: "interrupted", reason: "the office stopped" }))).toBe("the office stopped")
})

test("a Codex session's debrief says so under the flow", () => {
  expect(flowText(run({ flow: "debrief", codex: true }))).toBe("debrief of a Codex session")
  expect(flowText(run({ flow: "side_chat" }))).toBe("side_chat")
})
