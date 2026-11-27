// The rows of a run's node attempts: the Timeline's, every attempt newest first, consecutive ones of one loop or map
// iteration grouped, with the run_resumed dividers where their seq falls; and Overview's, the same without the
// trivial ones (starts, ends, expansions), each flow call's nodes under its row.
import type { RunDivider, RunNode, RunNodePage } from "@opencorp/protocol"

export type Group = { key: string; nodes: RunNode[] }
export type Row = { type: "node"; node: RunNode } | { type: "group"; group: Group } | { type: "divider"; divider: RunDivider }

/** The iteration `nodeId` runs in: its first segment when that has a `#k` (`chat#12/reply` → `chat#12`); a loop
 * driver clone `chat~12` joins iteration 12; null for a node outside any iteration. */
export function iterationOf(nodeId: string): string | null {
  const first = nodeId.split("/")[0]!
  const clone = /^(.*)~(\d+)$/.exec(first)
  if (clone) return `${clone[1]}#${clone[2]}`
  return first.includes("#") ? first : null
}

/** A node id without each segment's occurrence (`#k` or `~k`): the key of `RunDetail.models`. */
export const staticPath = (nodeId: string) => nodeId.split("/").map((s) => s.replace(/[#~]\d+$/, "")).join("/")

/** Rows for `nodes` (newest start first) and `dividers`. */
export function timeline(nodes: RunNode[], dividers: RunDivider[]): Row[] {
  const rows: Row[] = []
  const pending = [...dividers].sort((a, b) => b.seq - a.seq)
  for (const node of nodes) {
    while (pending.length && pending[0]!.seq > node.seq) rows.push({ type: "divider", divider: pending.shift()! })
    const key = iterationOf(node.node_id)
    const last = rows[rows.length - 1]
    if (key && last?.type === "group" && last.group.key === key) last.group.nodes.push(node)
    else if (key) rows.push({ type: "group", group: { key, nodes: [node] } })
    else rows.push({ type: "node", node })
  }
  for (const divider of pending) rows.push({ type: "divider", divider })
  return rows
}

/** The node attempts the Timeline shows: the newest page and the older pages read, and the cursor of the next one. */
export type Shown = { nodes: RunNode[]; dividers: RunDivider[]; next: number | null; dropped: boolean }

/**
 * What the Timeline shows once the newest node page is read again: the page replaces the nodes it covers, and the
 * older nodes already read (below its lowest seq) stay, with their cursor. A page that holds every node, or the first
 * one read (`shown` undefined), is taken whole.
 */
export function takeNewest(shown: Shown | undefined, page: RunNodePage): Shown {
  const dividers = page.dividers ?? []
  if (!shown || page.next_before == null)
    return { nodes: page.nodes, dividers, next: page.next_before ?? null, dropped: !!page.dropped }
  const low = Math.min(...page.nodes.map((n) => n.seq))
  return {
    nodes: [...page.nodes, ...shown.nodes.filter((n) => n.seq < low)],
    dividers: [...dividers, ...shown.dividers.filter((d) => d.seq < low)],
    next: shown.next,
    dropped: shown.dropped,
  }
}

/** A divider's text: "resumed; retried reply". */
export const dividerText = (d: RunDivider) =>
  d.retried.length ? `resumed; retried ${d.retried.map((id) => id.split("/").pop()).join(", ")}` : "resumed"

/** Yian's handle for a case's `else:` route, which it also takes when no `when:` matches. */
const ELSE_HANDLE = "#else"

/** A route's handle as a reader sees it: the else route says what it means; any other handle as it is. */
export const handleText = (handle: string) => (handle === ELSE_HANDLE ? "else (no case matched)" : handle)

/** A node's status as the Timeline shows it; a routed case names the handle it took. */
export const nodeStatus = (node: Pick<RunNode, "status" | "handle">) =>
  node.status === "routed" && node.handle ? `routed → ${handleText(node.handle)}` : node.status

/** Whether `nodeId` is a flow's `__start__` or `__end__` node, which the Timeline shows a little dimmer. */
export const isBoundary = (nodeId: string) => /(^|\/)__(start|end)__$/.test(nodeId)

/** An item of a tree of node attempts: a node; a flow call with its nodes under it; or a loop or map iteration. */
export type TreeItem = {
  /** Stable across refetches, for focus and folds: `n:<seq>` for a node or a flow call; `g:<iteration>:<its oldest
   *  seq>` for an iteration. */
  key: string
  kind: "node" | "call" | "group"
  /** The attempt it opens; null for an iteration. */
  node: RunNode | null
  /** What it shows: its id, or in Overview its id after the row it's under. */
  name: string
  /** The status it shows: a node's own; an iteration's or a flow call's folded from what ran in it. */
  status: Pick<RunNode, "status" | "handle">
  /** What's under it when it's open. */
  children: TreeItem[]
  /** The seqs its fold is kept by: an iteration's every attempt, so the fold holds as it gains nodes. */
  seqs: number[]
  /** What its count counts: an iteration's nodes, a flow call's steps. */
  noun: "node" | "step"
}
export type TreeRow = { type: "item"; item: TreeItem } | { type: "divider"; divider: RunDivider }

/** A group of the Timeline's rows' key: its iteration and its oldest node. */
const groupKey = (group: Group) => `g:${group.key}:${group.nodes[group.nodes.length - 1]!.seq}`

/** A node's item, with nothing under it. */
const leaf = (node: RunNode, name = node.node_id): TreeItem =>
  ({ key: `n:${node.seq}`, kind: "node", node, name, status: node, children: [], seqs: [node.seq], noun: "step" })

/** The Timeline as a tree: every node attempt as it is, an iteration's nodes flat under it. */
export function timelineTree(nodes: RunNode[], dividers: RunDivider[]): TreeRow[] {
  return timeline(nodes, dividers).map((row): TreeRow => {
    if (row.type === "divider") return row
    if (row.type === "node") return { type: "item", item: leaf(row.node) }
    const { group } = row
    return { type: "item", item: { key: groupKey(group), kind: "group", node: null, name: group.key,
      status: group.nodes[0]!, children: group.nodes.map((node) => leaf(node)), seqs: group.nodes.map((n) => n.seq),
      noun: "node" } }
  })
}

/** `id` under `parent` (a node's id or an iteration's key): what follows it, else what follows its own flow's path,
 *  else all of it. */
function nameUnder(id: string, parent: string | null): string {
  if (parent === null) return id
  if (id.startsWith(`${parent}/`)) return id.slice(parent.length + 1)
  const flow = parent.slice(0, parent.lastIndexOf("/") + 1)
  return flow && id.startsWith(flow) ? id.slice(flow.length) : id
}

/** The loop `id` drives (`l` for `chat#5/l~2`), when it's a driver inside a flow; null otherwise. A top-level
 *  driver joins its iteration instead. */
function loopOf(id: string): string | null {
  const driver = /^(.+\/[^/]+)~[0-9]+$/.exec(id)
  return driver ? driver[1]! : null
}

/**
 * The node whose flow call `id` runs in, among `ids`: a driver's loop; else the longest of its prefixes that is a
 * node's id, a prefix's occurrence (`l#0`) read as its loop or map (`l`); none for a node of a top-level iteration's
 * own flow, which the iteration holds.
 */
function callOf(id: string, ids: ReadonlySet<string>): string | null {
  const loop = loopOf(id)
  if (loop !== null && ids.has(loop)) return loop
  const segments = id.split("/")
  for (let k = segments.length - 1; k >= 1; k--) {
    const last = segments[k - 1]!
    if (k === 1 && /[#~]\d+$/.test(last)) return null
    const parent = [...segments.slice(0, k - 1), last.replace(/#\d+$/, "")].join("/")
    if (ids.has(parent)) return parent
  }
  return null
}

/**
 * The status `nodes` (an iteration's or a flow call's, every attempt, newest first) fold into, as the office's node
 * detail says what a call came to: open while any is, succeeded once what returns its value did (its END, `<id>/__end__`,
 * or a loop's last turn's driver, the newest that did more than expand), failed once any did, else `otherwise`'s.
 */
function folded(nodes: RunNode[], id: string, otherwise: Pick<RunNode, "status" | "handle">) {
  const ender = nodes.find((n) => n.node_id === `${id}/__end__` || (loopOf(n.node_id) === id && n.status !== "expanded"))
  if (nodes.some((n) => n.status === "open")) return { status: "open" as const, handle: null }
  if (ender?.status === "succeeded") return { status: "succeeded" as const, handle: null }
  if (nodes.some((n) => n.status === "failed")) return { status: "failed" as const, handle: null }
  return otherwise
}

/**
 * Overview: the Timeline without a flow's `__start__` and `__end__` nodes or its expansions (a loop's or a call's own
 * row). An iteration's status, and a flow call's, fold in what ran in it. A flow call's nodes (and a node that made
 * flow calls, an agent's) are under its row, by the same rules; an older attempt of it holds none.
 */
export function overview(nodes: RunNode[], dividers: RunDivider[]): TreeRow[] {
  const ids = new Set(nodes.map((n) => n.node_id))
  const latest = new Map<string, number>()
  for (const n of nodes) if (!latest.has(n.node_id)) latest.set(n.node_id, n.seq)
  const under = new Map<string, RunNode[]>()
  const top: RunNode[] = []
  for (const n of nodes) {
    const call = callOf(n.node_id, ids)
    if (call === null) top.push(n)
    else if (under.has(call)) under.get(call)!.push(n)
    else under.set(call, [n])
  }
  /** Every attempt under `id`'s calls, at any depth, each node's own only once however often it ran. */
  const within = (id: string, seen = new Set<string>()): RunNode[] =>
    (under.get(id) ?? []).flatMap((n) => {
      if (seen.has(n.node_id)) return [n]
      seen.add(n.node_id)
      return [n, ...within(n.node_id, seen)]
    })
  /** `n`'s item under `parent`, or null when Overview hides it. */
  const item = (n: RunNode, parent: string | null): TreeItem | null => {
    const name = nameUnder(n.node_id, parent)
    const below = latest.get(n.node_id) === n.seq ? (under.get(n.node_id) ?? []) : []
    if (below.length) {
      const children = below.flatMap((c) => item(c, n.node_id) ?? [])
      const status = n.status === "expanded" ? folded(within(n.node_id), n.node_id, n) : n
      return { ...leaf(n, name), kind: "call", status, children }
    }
    return isBoundary(n.node_id) || n.status === "expanded" ? null : leaf(n, name)
  }
  return timeline(top, dividers).flatMap((row): TreeRow[] => {
    if (row.type === "divider") return [row]
    if (row.type === "node") {
      const it = item(row.node, null)
      return it ? [{ type: "item", item: it }] : []
    }
    const { group } = row
    const seen = new Set<string>()
    const all = group.nodes.flatMap((n) => [n, ...within(n.node_id, seen)])
    return [{ type: "item", item: { key: groupKey(group), kind: "group", node: null, name: group.key,
      status: folded(all, group.key, group.nodes[0]!), children: group.nodes.flatMap((n) => item(n, group.key) ?? []),
      seqs: group.nodes.map((n) => n.seq), noun: "node" } }]
  })
}

/** The keys of the items to open to show node attempt `seq` in `rows`, outermost first; null when they don't hold it. */
export function pathTo(rows: TreeRow[], seq: number): string[] | null {
  const find = (items: TreeItem[], path: string[]): string[] | null => {
    for (const it of items) {
      if (it.node?.seq === seq) return path
      const found = find(it.children, [...path, it.key])
      if (found) return found
    }
    return null
  }
  return find(rows.flatMap((r) => (r.type === "item" ? [r.item] : [])), [])
}

/** The tree a link to node attempt `seq` opens it in: Overview, unless Overview hides it. */
export const linkedView = (nodes: RunNode[], dividers: RunDivider[], seq: number): "overview" | "timeline" =>
  pathTo(overview(nodes, dividers), seq) === null ? "timeline" : "overview"
