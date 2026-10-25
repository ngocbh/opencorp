/** The nodes a run is executing now, from its worker's event frames: what the list and run.updated show, with no
 *  log read; and node kinds from a flow's static nodes. */
import type { ComposedFlow } from "@ngocbh/yian"
import { staticNodes, staticPathOf } from "@ngocbh/yian/run"

// A woken node runs again, and a new worker advancing a waiting run emits NodeWoken, not NodeStarted.
export const STARTED: ReadonlySet<string> = new Set(["NodeStarted", "NodeWoken"])
/** Every frame that ends a node: a case ends routed, a loop or map spawner expanded (yian's events). */
export const ENDED: ReadonlySet<string> = new Set([
  "NodeSucceeded",
  "NodeRouted",
  "NodeSkipped",
  "NodeFailed",
  "NodeExpanded",
])
/** The most open nodes kept by default: a run's open nodes are bounded by its widest map. */
export const CAP = 64

/** Node ids started and not yet ended, in start order. */
export class OpenNodes {
  private readonly ids = new Set<string>()
  private readonly cap: number

  constructor({ cap = CAP }: { cap?: number } = {}) {
    this.cap = cap
  }

  /** Folds one event frame in; returns whether the open nodes changed. */
  apply(name: string, data: Record<string, unknown>): boolean {
    const failure = data.failure
    const failed = failure !== null && typeof failure === "object" && !Array.isArray(failure)
      ? (failure as Record<string, unknown>).node_id : undefined
    const nodeId = typeof data.node_id === "string" ? data.node_id : failed
    if (typeof nodeId !== "string") return false
    if (STARTED.has(name) && !this.ids.has(nodeId)) {
      this.ids.add(nodeId)
      while (this.ids.size > this.cap) this.ids.delete(this.ids.values().next().value!)
      return true
    }
    if (ENDED.has(name) && this.ids.has(nodeId)) {
      this.ids.delete(nodeId)
      return true
    }
    return false
  }

  /** Forgets every node: a new worker re-emits the starts of the nodes it re-runs. */
  clear(): void {
    this.ids.clear()
  }

  /** The open nodes, deepest only: an open node's ancestors are left out. `chat` is an ancestor of its
   *  iterations' nodes (`chat#12/reply`) and of its loop driver clones (`chat~12`). */
  current(): string[] {
    const ids = [...this.ids]
    return ids.filter((n) => !ids.some((o) => o !== n && [n + "/", n + "#", n + "~"].some((p) => o.startsWith(p))))
  }
}

/** Each of `flow`'s static node paths, with its node's kind. */
export function nodeKinds(flow: ComposedFlow): Map<string, string> {
  return new Map(staticNodes(flow).map(([path, node]) => [path, node.kind]))
}

/** The kind of the node `nodeId` (a run's id, with any `#i` or `~i` growth suffixes), or null when unknown. */
export function kindOf(kinds: ReadonlyMap<string, string> | null, nodeId: string): string | null {
  return kinds?.get(staticPathOf(nodeId)) ?? null
}
