import { expect, test } from "bun:test"
import type { RunNode } from "@opencorp/protocol"
import { dividerText, iterationOf, nodeStatus, staticPath, timeline } from "../src/runs/timeline"

const n = (seq: number, node_id: string, over: Partial<RunNode> = {}) => ({ seq, node_id, status: "succeeded", ...over }) as RunNode

test("a node's iteration is its first segment with an occurrence; a loop driver clone joins its iteration", () => {
  expect(["chat#12/reply", "chat~12", "chat", "m#0/a/b"].map(iterationOf)).toEqual(["chat#12", "chat#12", null, "m#0"])
  expect(["chat~3", "chat#3/reply", "m#0/a~2/b"].map(staticPath)).toEqual(["chat", "chat/reply", "m/a/b"])
})

test("consecutive nodes of one iteration group, newest first, with dividers where their seq falls", () => {
  const rows = timeline(
    [n(22, "chat#3/ask", { status: "open" }), n(20, "chat#2/reply"), n(18, "chat#2/reply", { status: "restarted" }),
     n(17, "chat#2/route", { status: "routed", handle: "reply" }), n(16, "chat~2", { status: "expanded" }), n(1, "chat")],
    [{ seq: 19, retried: ["chat#2/reply"] }],
  )
  expect(rows.map((r) => (r.type === "group" ? `${r.group.key}:${r.group.nodes.length}` : r.type))).toEqual([
    "chat#3:1", "chat#2:1", "divider", "chat#2:3", "node"])
})

test("statuses and dividers read as the Timeline shows them", () => {
  expect(nodeStatus(n(1, "r", { status: "routed", handle: "reply" }))).toBe("routed → reply")
  expect(nodeStatus(n(1, "r", { status: "restarted" }))).toBe("restarted")
  expect(dividerText({ seq: 1, retried: ["chat#2/reply"] })).toBe("resumed; retried reply")
  expect(dividerText({ seq: 1, retried: [] })).toBe("resumed")
})
