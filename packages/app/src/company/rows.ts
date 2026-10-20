// The company as rows: the tree by manager (or "By team") as items, flattened to the rows a viewer sees, with what
// each WAI-ARIA tree key does on them. Pure, so the list and its keys are tested without a browser.
import type { Group, Person } from "@opencorp/protocol"
import type { TreeNode } from "./tree"

/** A row's subject: a person, or a team header in "By team" (`group` null: "No team"). */
export type Item =
  | { kind: "person"; id: string; person: Person; muted: boolean; children: Item[] }
  | { kind: "team"; id: string; group: Group | null; children: Item[] }

export type Row = { item: Item; level: number; parent: string | null; open: boolean; setsize: number; posinset: number }

/** Items for the tree by manager; an item's id is its person's handle. */
export function fromTree(roots: TreeNode[]): Item[] {
  return roots.map((n): Item => ({ kind: "person", id: n.person.handle, person: n.person, muted: false, children: fromTree(n.children) }))
}

export const personOf = (item: Item) => (item.kind === "person" ? item.person : undefined)
export const isMuted = (item: Item) => item.kind === "person" && item.muted
export const teamName = (item: Item) => (item.kind === "team" ? (item.group?.name ?? "No team") : undefined)
/** A row's accessible name: "Name, title" for a person, the group's name for a team. */
export const label = (item: Item) => (item.kind === "person" ? `${item.person.name}, ${item.person.title}` : teamName(item)!)

/** The rows a viewer sees: every root, and the children of open items. `level` starts at 1, as aria-level does. */
export function visibleRows(items: Item[], isOpen: (item: Item, depth: number) => boolean): Row[] {
  const rows: Row[] = []
  const walk = (list: Item[], level: number, parent: string | null) =>
    list.forEach((item, i) => {
      const open = item.children.length > 0 && isOpen(item, level - 1)
      rows.push({ item, level, parent, open, setsize: list.length, posinset: i + 1 })
      if (open) walk(item.children, level + 1, item.id)
    })
  walk(items, 1, null)
  return rows
}
