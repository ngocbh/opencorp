// The company as rows: the tree by manager (or "By team") as items, flattened to the rows a viewer sees, with what
// each WAI-ARIA tree key does on them. Pure, so the list and its keys are tested without a browser.
import type { Group, Person } from "@opencorp/protocol"
import type { Team } from "./teams"
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

export type Move = { focus: string } | { open: string; to: boolean }

/** What `key` does on the row `at` (the WAI-ARIA tree pattern); null for keys the tree doesn't use. */
export function moveFocus(rows: Row[], at: string, key: string): Move | null {
  const i = rows.findIndex((r) => r.item.id === at)
  if (i < 0) return rows.length ? { focus: rows[0].item.id } : null
  const row = rows[i]
  const branch = row.item.children.length > 0
  switch (key) {
    case "ArrowDown":
      return i + 1 < rows.length ? { focus: rows[i + 1].item.id } : null
    case "ArrowUp":
      return i > 0 ? { focus: rows[i - 1].item.id } : null
    case "Home":
      return { focus: rows[0].item.id }
    case "End":
      return { focus: rows[rows.length - 1].item.id }
    case "ArrowRight":
      // An open branch's first child is the next visible row.
      if (branch) return row.open ? { focus: rows[i + 1].item.id } : { open: at, to: true }
      return null
    case "ArrowLeft":
      if (branch && row.open) return { open: at, to: false }
      return row.parent ? { focus: row.parent } : null
  }
  return null
}

/** `items` cut down to the people matching `query` (name, handle or title) and the items above them. */
export function keep(items: Item[], query: string): Item[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  const hit = (p: Person) => [p.name, p.handle, p.title].some((text) => text.toLowerCase().includes(q))
  return items.flatMap((item): Item[] => {
    const children = keep(item.children, query)
    const self = item.kind === "person" && hit(item.person)
    return self || children.length ? [{ ...item, children } as Item] : []
  })
}

/** Whether anyone under `item` (not `item` itself) has a card for the viewer: such branches start open. */
export function holds(item: Item, needs: Map<string, number>): boolean {
  return item.children.some((c) => (c.kind === "person" && (needs.get(c.person.handle) ?? 0) > 0) || holds(c, needs))
}

/**
 * Items for "By team": each team holds its sub-teams, then its members (muted after their first group); "No team"
 * last. Ids carry the team, since a person in two groups appears twice. They can't collide: group ids and handles
 * never hold "/" or ":" (the protocol's Id and Handle patterns), so "team:<group>" is a header, "team:<group>/<handle>"
 * a member, and a bare handle a row of the tree by manager.
 */
export function fromTeams(teams: Team[], noTeam: Person[]): Item[] {
  const member = (team: string, p: Person, muted: boolean): Item =>
    ({ kind: "person", id: `team:${team}/${p.handle}`, person: p, muted, children: [] })
  const team = (t: Team): Item => ({
    kind: "team",
    id: `team:${t.group.id}`,
    group: t.group,
    children: [...t.children.map(team), ...t.members.map((m) => member(t.group.id, m.person, m.muted))],
  })
  const none: Item[] = noTeam.length
    ? [{ kind: "team", id: "team:", group: null, children: noTeam.map((p) => member("", p, false)) }]
    : []
  return [...teams.map(team), ...none]
}
