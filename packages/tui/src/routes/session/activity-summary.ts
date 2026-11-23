import type { ToolPart } from "@opencorp/protocol"
import { visitEntries, type PartRef, type SessionEntry, type SessionNode } from "./grouping/session"

/** A tool call as its group's summary reads it: the upstream tool it stands for, and its state. */
export type ActivityItem = { name: string; state: ToolPart["state"] }

/**
 * Summary for an activity group's subtree; permission-blocked tools are left out.
 * Until something finishes, the label is the first running item's status, e.g. "Running command…".
 */
export function summarizeActivity(
  node: Extract<SessionNode, { type: "group" }>,
  item: (ref: PartRef) => ActivityItem | undefined,
  pending: readonly PartRef[],
) {
  const entries: SessionEntry[] = []
  visitEntries(node.children, (entry) => entries.push(entry))
  const items = entries.flatMap((entry) => {
    if (pending.some((ref) => ref.messageID === entry.ref.messageID && ref.partID === entry.ref.partID)) return []
    const found = item(entry.ref)
    return found ? [found] : []
  })
  const summary = activitySummary(items)
  const current = items.find(isActive)
  return { ...summary, label: summary.label || (current ? busyLabel(current) : "") }
}

/** Status for a running item, independent of its details, so it doesn't flicker as they arrive. */
export function busyLabel(item: ActivityItem) {
  const noun = item.name === "shell" ? "command" : item.name
  return `${item.state === "pending" ? "Preparing" : "Running"} ${noun}…`
}

/**
 * Low verbosity's activity summary, e.g. "3 commands, 1 edit, 4 reads".
 * The label counts only finished work, failed and interrupted calls included; running items are reported through
 * `active`.
 */
export function activitySummary(items: readonly ActivityItem[]) {
  const counts = { command: 0, edit: 0, read: 0, tool: 0 }
  items.forEach((item) => {
    if (isActive(item)) return
    if (item.name === "shell") counts.command++
    else if (item.name === "read") counts.read++
    else if (item.name === "edit" || item.name === "write" || item.name === "patch") counts.edit++
    else counts.tool++
  })
  return {
    label: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
      .join(", "),
    active: items.some(isActive),
  }
}

function isActive(item: ActivityItem) {
  return item.state === "pending" || item.state === "running"
}
