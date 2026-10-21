import { expect, test } from "bun:test"
import type { RunDivider, RunNode, RunNodePage } from "@opencorp/protocol"
import { dividerText, iterationOf, nodeStatus, staticPath, takeNewest, timeline, type Shown } from "../src/runs/timeline"

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

const page = (nodes: RunNode[], over: Partial<RunNodePage> = {}): RunNodePage =>
  ({ nodes, dividers: [], next_before: null, dropped: false, ...over })
const shown = (nodes: RunNode[], dividers: RunDivider[] = [], next: number | null = null, dropped = false): Shown =>
  ({ nodes, dividers, next, dropped })
const seqs = (s: Shown) => s.nodes.map((x) => `${x.seq}:${x.status}`)

test("the first newest page is taken whole, with its cursor", () => {
  const s = takeNewest(undefined, page([n(9, "a"), n(5, "b")], { next_before: 5, dividers: [{ seq: 7, retried: [] }] }))
  expect(seqs(s)).toEqual(["9:succeeded", "5:succeeded"])
  expect(s.dividers.map((d) => d.seq)).toEqual([7])
  expect(s.next).toBe(5)
})

test("a newest page that holds every node replaces what was shown", () => {
  const s = takeNewest(shown([n(9, "a", { status: "open" }), n(5, "b")], [], 5), page([n(9, "a"), n(5, "b"), n(1, "c")]))
  expect(seqs(s)).toEqual(["9:succeeded", "5:succeeded", "1:succeeded"])
  expect(s.next).toBeNull()
})

test("a newest page that doesn't reach the older pages read keeps them, and their cursor", () => {
  // Shown: 9 down to 3 (two pages), next 3. The newest page moved up: 12 down to 7.
  const old = shown([n(9, "a", { status: "open" }), n(7, "b"), n(5, "c"), n(3, "d")], [{ seq: 4, retried: [] }], 3, true)
  const s = takeNewest(old, page([n(12, "e"), n(9, "a"), n(7, "b")], { next_before: 7, dividers: [{ seq: 8, retried: [] }] }))
  expect(seqs(s)).toEqual(["12:succeeded", "9:succeeded", "7:succeeded", "5:succeeded", "3:succeeded"])
  expect(s.dividers.map((d) => d.seq)).toEqual([8, 4])
  expect(s.next).toBe(3)
  expect(s.dropped).toBe(true)
})
