// The Timeline's rows: node attempts newest first, consecutive ones of one loop or map iteration grouped, and the
// run_resumed dividers where their seq falls.
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

/** A node's status as the Timeline shows it; a routed case names the handle it took. */
export const nodeStatus = (node: RunNode) =>
  node.status === "routed" && node.handle ? `routed → ${node.handle}` : node.status
