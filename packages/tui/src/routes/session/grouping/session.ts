import { groupEntries, type GroupNode } from "./tree"

/** A part of an assistant message. */
export type PartRef = {
  messageID: string
  partID: string
}

export type SessionEntry = { type: "part"; ref: PartRef }

export type GroupKind = "activity" | "exploration"
export type SessionNode = GroupNode<SessionEntry, GroupKind>
export type SessionGroup = {
  type: "group"
  kind: GroupKind
  children: readonly GroupNode<SessionEntry, GroupKind>[]
  size: number
  completed: boolean
  /** The calls waiting on an approval card, which show below the group rather than in it. */
  pending: PartRef[]
}

/** How much of a reply's tool activity the transcript shows. */
export type Verbosity = "low" | "medium" | "high"
export const defaultVerbosity: Verbosity = "low"
export const verbosities: readonly Verbosity[] = ["low", "medium", "high"]

export type SessionRow = SessionEntry | SessionGroup

/** A part as grouping reads it: a tool call by the upstream tool it stands for, or a part that is no call. */
export type AppendPart = { type: "text" | "file" | "error" } | { type: "tool"; name: string }

export type ProjectionEntry = {
  entry: SessionEntry
  part?: AppendPart
  path?: readonly GroupKind[]
  closesPrevious?: boolean
}

/** Groups a message's entries in one pass. */
export function projectEntries(entries: ProjectionEntry[]): SessionRow[] {
  const nodes = groupEntries(entries, (item) => item.path ?? [])
  return nodes.map((node, index) => {
    if (node.type === "entry") return node.entry.entry
    const next = nodes[index + 1]
    const completed = next !== undefined && (next.type === "group" || next.entry.closesPrevious !== false)
    return sessionGroup({ ...node, children: node.children.map(unwrap) }, completed)
  })
}

function sessionGroup(node: Extract<SessionNode, { type: "group" }>, completed: boolean): SessionGroup {
  return { ...node, kind: node.kind, pending: [], completed }
}

function unwrap(node: GroupNode<ProjectionEntry, GroupKind>): GroupNode<SessionEntry, GroupKind> {
  if (node.type === "entry") return { ...node, entry: node.entry.entry }
  return { ...node, children: node.children.map(unwrap) }
}

const explorationTools = new Set(["read", "list", "search"])

/**
 * Grouping path for an assistant part. Adjacent reads, lists and searches group. Low wraps every run of tools in one
 * activity summary. Questions always stand alone.
 */
export function partPath(part: AppendPart, verbosity: Verbosity): readonly GroupKind[] {
  if (part.type === "tool" && part.name.toLowerCase() === "question") return []
  const activity: GroupKind[] = verbosity === "low" && part.type === "tool" ? ["activity"] : []
  if (part.type === "tool" && explorationTools.has(part.name.toLowerCase())) return [...activity, "exploration"]
  return activity
}

/** Part references for an existing subgroup, not a flat timeline. */
export function groupRefs(row: SessionGroup, includePending = false): PartRef[] {
  const pending = includePending ? [] : row.pending
  const visit = (nodes: readonly GroupNode<SessionEntry, GroupKind>[]): PartRef[] =>
    nodes.flatMap((node) => {
      if (node.type === "group") return visit(node.children)
      const ref = node.entry.ref
      if (pending.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)) return []
      return [ref]
    })
  return visit(row.children)
}

export function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group") return
    // The exploration rule creates direct part children. Preserve the stable partition order when approvals are
    // asked or answered. Activity groups render blocked tools outside the summary without reordering.
    if (row.kind === "exploration") {
      const blocked = (node: GroupNode<SessionEntry, GroupKind>) =>
        node.type === "entry" && pending.has(node.entry.ref.partID)
      row.children = [...row.children.filter((node) => !blocked(node)), ...row.children.filter(blocked)]
    }
    row.pending = groupRefs(row, true).filter((ref) => pending.has(ref.partID))
  })
}

/** Calls `visit` on each entry under `nodes`, depth first. */
export function visitEntries(nodes: readonly SessionNode[], visit: (entry: SessionEntry) => void) {
  nodes.forEach((node) => {
    if (node.type === "entry") visit(node.entry)
    if (node.type === "group") visitEntries(node.children, visit)
  })
}

/** A group's id, from its first part, its kind and its depth: what its expansion is kept under. */
export function groupID(node: Extract<SessionNode, { type: "group" }>, level: number) {
  const ref = firstRef(node.children)
  return ref && JSON.stringify([ref.messageID, ref.partID, node.kind, level])
}

function firstRef(nodes: readonly SessionNode[]): PartRef | undefined {
  for (const node of nodes) {
    const ref = node.type === "entry" ? node.entry.ref : firstRef(node.children)
    if (ref) return ref
  }
}
