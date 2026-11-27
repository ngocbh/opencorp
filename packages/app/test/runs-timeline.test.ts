import { expect, test } from "bun:test"
import type { RunDivider, RunNode, RunNodePage } from "@opencorp/protocol"
import {
  dividerText,
  handleText,
  isBoundary,
  iterationOf,
  linkedView,
  nodeStatus,
  overview,
  pathTo,
  staticPath,
  takeNewest,
  timeline,
  timelineTree,
  type Shown,
  type TreeItem,
  type TreeRow,
} from "../src/runs/timeline"

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
  // Yian's handle for a case's else route, taken too when no when: matches.
  expect(nodeStatus(n(1, "r", { status: "routed", handle: "#else" }))).toBe("routed → else (no case matched)")
  expect([handleText("#else"), handleText("reply"), handleText("else")]).toEqual(["else (no case matched)", "reply", "else"])
  expect(dividerText({ seq: 1, retried: ["chat#2/reply"] })).toBe("resumed; retried reply")
  expect(dividerText({ seq: 1, retried: [] })).toBe("resumed")
})

test("a flow's __start__ and __end__ nodes are boundaries, at any depth", () => {
  expect(["__start__", "__end__", "chat#2/__end__", "m#0/a/__start__"].map(isBoundary)).toEqual([true, true, true, true])
  expect(["chat", "__start__x", "chat/__end__/reply", "start"].map(isBoundary)).toEqual([false, false, false, false])
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

/** One finished turn of a chat, newest first: its START, the take, the route, a flow call to `context` that calls
 *  `compacted`, the reply and its END; the loop's driver and the loop itself before it. */
const turn = (over: Record<string, Partial<RunNode>> = {}): RunNode[] =>
  ([
    [30, "chat#5/__end__"], [25, "chat#5/reply"], [22, "chat#5/context/__end__"], [21, "chat#5/context/compacted/__end__"],
    [19, "chat#5/context/compacted/over", { status: "routed", handle: "done" }], [18, "chat#5/context/compacted/__start__"],
    [17, "chat#5/context/compacted", { status: "expanded" }], [16, "chat#5/context/__start__"],
    [15, "chat#5/context", { status: "expanded" }], [14, "chat#5/route", { status: "routed", handle: "context" }],
    [12, "chat#5/heard"], [11, "chat#5/__start__"], [10, "chat~5", { status: "expanded" }], [1, "chat", { status: "expanded" }],
  ] as [number, string, Partial<RunNode>?][]).map(([seq, id, o]) => n(seq, id, { ...o, ...over[id] }))

/** Each item as `name status (count)` and its children indented, as the tree reads. */
function outline(rows: TreeRow[]): string[] {
  const out: string[] = []
  const walk = (item: TreeItem, depth: number) => {
    const count = item.kind === "node" ? "" : ` (${item.children.length} ${item.noun}s)`
    out.push(`${"  ".repeat(depth)}${item.name} ${nodeStatus(item.status)}${count}`)
    for (const child of item.children) walk(child, depth + 1)
  }
  for (const row of rows) row.type === "item" ? walk(row.item, 0) : out.push(`-- ${dividerText(row.divider)}`)
  return out
}

test("Overview hides starts, ends and expansions, folding their status into the turn and each flow call's row", () => {
  expect(outline(overview(turn(), []))).toEqual([
    "chat#5 succeeded (4 nodes)",
    "  reply succeeded",
    "  context succeeded (1 steps)",
    "    compacted succeeded (1 steps)",
    "      over routed → done",
    "  route routed → context",
    "  heard succeeded",
  ])
  // A flow call's row opens its node; an iteration's opens none.
  const group = (overview(turn(), [])[0] as Extract<TreeRow, { type: "item" }>).item
  expect([group.kind, group.node, group.key]).toEqual(["group", null, "g:chat#5:10"])
  expect(group.children.map((c) => [c.kind, c.key])).toEqual([["node", "n:25"], ["call", "n:15"], ["node", "n:14"], ["node", "n:12"]])
})

test("a flow call still running is open, one that failed inside failed, and so is its turn", () => {
  const open = { "chat#5/context/compacted/over": { status: "open" as const }, "chat#5/__end__": { status: "open" as const } }
  expect(outline(overview(turn(open).slice(1), [])).slice(0, 4)).toEqual([
    "chat#5 open (4 nodes)",
    "  reply succeeded",
    "  context open (1 steps)",
    "    compacted open (1 steps)",
  ])
  const failed = turn({ "chat#5/context/compacted/over": { status: "failed", error: "boom" } })
    .filter((x) => !x.node_id.endsWith("__end__"))
  expect(outline(overview(failed, [])).slice(0, 4)).toEqual([
    "chat#5 failed (4 nodes)",
    "  reply succeeded",
    "  context failed (1 steps)",
    "    compacted failed (1 steps)",
  ])
})

test("Timeline shows every node as it is, a turn's nodes flat under it", () => {
  const rows = timelineTree(turn(), [])
  expect(outline(rows)[0]).toBe("chat#5 succeeded (13 nodes)")
  expect(outline(rows).slice(1, 4)).toEqual(["  chat#5/__end__ succeeded", "  chat#5/reply succeeded",
                                            "  chat#5/context/__end__ succeeded"])
  expect(outline(rows).at(-1)).toBe("chat expanded")
})

test("Overview keeps dividers, a node outside any turn, and a turn whose nodes haven't started", () => {
  const nodes = [n(40, "chat~6", { status: "expanded" }), ...turn(), n(0, "__start__")]
  expect(outline(overview(nodes, [{ seq: 35, retried: [] }])).map((l) => l.split(" (")[0])).toEqual([
    "chat#6 expanded", "-- resumed", "chat#5 succeeded", "  reply succeeded", "  context succeeded",
    "    compacted succeeded", "      over routed → done", "  route routed → context", "  heard succeeded",
  ])
  const loop = [n(9, "l~2"), n(8, "l#1/a"), n(6, "l~1", { status: "expanded" }), n(4, "l#0/a"), n(2, "l", { status: "expanded" }),
                n(1, "c/prep"), n(0, "c", { status: "expanded" })]
  expect(outline(overview(loop, []))).toEqual([
    "l#2 succeeded (1 nodes)", "  l~2 succeeded", "l#1 succeeded (1 nodes)", "  a succeeded",
    "l#0 succeeded (1 nodes)", "  a succeeded",
    // A call with no END yet shows its expansion's status.
    "c expanded (1 steps)", "  prep succeeded",
  ])
})

test("where a node is in a tree: the items to open to show it, none when the tree hides it", () => {
  const rows = overview(turn(), [])
  expect(pathTo(rows, 19)).toEqual(["g:chat#5:10", "n:15", "n:17"])
  expect(pathTo(rows, 25)).toEqual(["g:chat#5:10"])
  for (const hidden of [30, 22, 17 - 1, 10, 1]) expect([hidden, pathTo(rows, hidden)]).toEqual([hidden, null])
  // A flow call is its own row.
  expect(pathTo(rows, 15)).toEqual(["g:chat#5:10"])
  expect(pathTo(timelineTree(turn(), []), 30)).toEqual(["g:chat#5:10"])
})

test("a link to a node opens Overview, unless Overview hides it: a turn's END opens the Timeline", () => {
  const nodes = turn()
  expect(linkedView(nodes, [], 30)).toBe("timeline") // chat#5/__end__
  expect(linkedView(nodes, [], 10)).toBe("timeline") // chat~5, an expansion
  expect(linkedView(nodes, [], 19)).toBe("overview") // in a folded flow call, which opens
  expect(linkedView(nodes, [], 25)).toBe("overview")
})

test("a loop inside a turn is one row, its turns' nodes and drivers under it, and it came to its last driver's", () => {
  const nodes = [
    n(30, "chat#5/__end__"), n(28, "chat#5/l~2"), n(26, "chat#5/l#1/a"), n(24, "chat#5/l~1", { status: "expanded" }),
    n(22, "chat#5/l#0/a"), n(20, "chat#5/l", { status: "expanded" }), n(10, "chat~5", { status: "expanded" }),
  ]
  expect(outline(overview(nodes, []))).toEqual([
    "chat#5 succeeded (1 nodes)",
    "  l succeeded (3 steps)",
    "    l~2 succeeded",
    "    l#1/a succeeded",
    "    l#0/a succeeded",
  ])
  // Still on its first turn: open.
  const running = [n(22, "chat#5/l#0/a", { status: "open" }), n(20, "chat#5/l", { status: "expanded" })]
  expect(outline(overview(running, []))[1]).toBe("  l open (1 steps)")
})
