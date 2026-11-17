/** The nodes a run is executing now, from its worker's event frames: what the list and run.updated show, with no
 *  log read; and node kinds from a flow's static nodes, or from the flow a run log recorded. */
import type { ComposedFlow } from "@ngocbh/yian"
import { loadRecordedFlow, staticNodes, staticPathOf } from "@ngocbh/yian/run"

// A woken node runs again, and a new worker advancing a waiting run emits NodeWoken, not NodeStarted.
export const STARTED: ReadonlySet<string> = new Set(["NodeStarted", "NodeWoken"])
/** Every frame that ends a node: a case ends routed, a loop or map spawner expanded (yian's events). An agent's flow
 *  call expands too, and a failure inside it fails only the call: see `growsFlowCall` and `endedScopes`. */
export const ENDED: ReadonlySet<string> = new Set([
  "NodeSucceeded",
  "NodeRouted",
  "NodeSkipped",
  "NodeFailed",
  "NodeExpanded",
])
/** The most open nodes kept by default: a run's open nodes are bounded by its widest map. */
export const CAP = 64

/** Whether event frame `name` with `data` is an agent's flow call growing the called flow under its scope, while the
 *  agent keeps running: a `NodeExpanded` that names the call. */
export function growsFlowCall(name: string, data: Record<string, unknown>): boolean {
  return name === "NodeExpanded" && typeof data.call_id === "string"
}

/** The flow call scopes (`<agent>/<flow>#<k>`) event frame `name` with `data` ends, whose unfinished nodes leave the
 *  run with no event of their own: a failure inside an agent's flow call ends that call's scope, and an interrupt
 *  ends its agents' open flow calls. Empty for every other frame, and for a failure that fails the run. */
export function endedScopes(name: string, data: Record<string, unknown>): string[] {
  if (name === "NodeFailed") return typeof data.scope === "string" ? [data.scope] : []
  if (name !== "Interrupted" || !Array.isArray(data.scopes)) return []
  return data.scopes.filter((scope): scope is string => typeof scope === "string")
}

/** Whether node `nodeId` runs inside one of `scopes`, a nested flow call's nodes included. The agent that made a call
 *  is outside it, so a failure that names the agent (its scope couldn't grow) leaves it running. */
export function inScopes(nodeId: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => nodeId.startsWith(`${scope}/`))
}

/** Node ids started and not yet ended, in start order. */
export class OpenNodes {
  private readonly ids = new Set<string>()
  private readonly cap: number

  constructor({ cap = CAP }: { cap?: number } = {}) {
    this.cap = cap
  }

  /** Folds one event frame in; returns whether the open nodes changed. */
  apply(name: string, data: Record<string, unknown>): boolean {
    if (growsFlowCall(name, data)) return false
    const scopes = endedScopes(name, data)
    if (scopes.length > 0) {
      const ended = [...this.ids].filter((id) => inScopes(id, scopes))
      for (const id of ended) this.ids.delete(id)
      return ended.length > 0
    }
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

/**
 * Each static node path of the flow the run log `log` recorded, with its node's kind, for display only: the flow is
 * compiled as yian resumes it, under `env`'s `YIAN_*` values, its CODE references kept inside `codeRoot`. An empty map
 * for a flow built in code; null when the recorded flow doesn't load (kinds unknown).
 */
export async function recordedKinds(
  log: string,
  options: { env: (name: string) => string | undefined; codeRoot: string },
): Promise<Map<string, string> | null> {
  try {
    const flow = await loadRecordedFlow(log, options)
    return flow === null ? new Map() : nodeKinds(flow)
  } catch {
    return null
  }
}

/** The kind of the node `nodeId` (a run's id, with any `#i` or `~i` growth suffixes), or null when unknown. */
export function kindOf(kinds: ReadonlyMap<string, string> | null, nodeId: string): string | null {
  return kinds?.get(staticPathOf(nodeId)) ?? null
}
