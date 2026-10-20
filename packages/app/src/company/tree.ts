import type { Company, Person } from "@opencorp/protocol"

export type TreeNode = { person: Person; children: TreeNode[] }

export type Tree = {
  /** The CEO first, then everyone else whose manager is null, by name. */
  roots: TreeNode[]
  /** People whose chain of managers never reaches a root: an unknown manager or a cycle (`opencorp doctor` names both). */
  unplaced: Person[]
  /** `company.ceo_has_manager`: the CEO stays a root and the edge up isn't drawn. */
  ceoHasManager: boolean
  /** Each placed person's node, by handle; unplaced people have none. */
  nodes: Map<string, TreeNode>
}

/** Orders people by name, then handle. */
export const byName = (a: Person, b: Person) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle)

/** The company as a tree by manager. */
export function buildTree(people: Person[], company: Company | null): Tree {
  const byHandle = new Map(people.map((p) => [p.handle, p]))
  const ceo = company ? byHandle.get(company.ceo) : undefined
  const up = (p: Person) => (p === ceo ? null : p.manager)
  // Whether each person's chain reaches a root, remembered for every handle a walk passes.
  const placed = new Map<string, boolean>()
  const reaches = (start: Person) => {
    const path: string[] = []
    const onPath = new Set<string>()
    let at: Person | undefined = start
    let ok = false
    while (at) {
      const known = placed.get(at.handle)
      if (known !== undefined) {
        ok = known
        break
      }
      if (onPath.has(at.handle)) break // a cycle
      path.push(at.handle)
      onPath.add(at.handle)
      const manager = up(at)
      if (manager === null) {
        ok = true
        break
      }
      at = byHandle.get(manager) // undefined: an unknown manager
    }
    for (const handle of path) placed.set(handle, ok)
    return ok
  }
  const nodes = new Map<string, TreeNode>(people.map((p) => [p.handle, { person: p, children: [] }]))
  const roots: TreeNode[] = []
  const unplaced: Person[] = []
  for (const p of [...people].sort(byName)) {
    const node = nodes.get(p.handle)!
    const manager = up(p)
    if (!reaches(p)) {
      unplaced.push(p)
      nodes.delete(p.handle)
    } else if (manager === null) roots.push(node)
    else nodes.get(manager)!.children.push(node)
  }
  const i = roots.findIndex((n) => n.person === ceo)
  if (i > 0) roots.unshift(...roots.splice(i, 1))
  return { roots, unplaced, ceoHasManager: !!ceo?.manager, nodes }
}
