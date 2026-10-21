// What the Run Logs list shows for a run: its short id, how long it took, where it is, and its status dot.
import type { RunSummary } from "@opencorp/protocol"

/** A run id as the list shows it: its last 8 characters (the full id is one copy away). */
export const shortId = (id: string) => id.slice(-8)

/** Launch to end, idle time included; "—" while open, and for a run an office stop interrupted. */
export function took(run: Pick<RunSummary, "launched_at" | "ended_at">): string {
  if (!run.ended_at) return "—"
  const s = Math.max(0, Math.round((Date.parse(run.ended_at) - Date.parse(run.launched_at)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The last segment of a node id without its occurrence: `m#2/reply` → `reply`. */
const nodeName = (id: string) => id.split("/").pop()!.replace(/[#~]\d+$/, "")

/** One node whole; several as the first one's name and how many more (`reply +2`). */
export const nodesText = (nodes: string[]) =>
  nodes.length <= 1 ? (nodes[0] ?? "") : `${nodeName(nodes[0]!)} +${nodes.length - 1}`

/** The Where / took column: the current nodes while open, how long it took once finished, else why it ended. */
export function where(run: RunSummary): string {
  const nodes = nodesText(run.current_nodes ?? [])
  switch (run.status) {
    case "running":
      return nodes || "starting"
    case "waiting":
      if (run.held) return "cost cap"
      return [run.asking ? "asking" : "", nodes].filter(Boolean).join(" · ")
    case "idle":
      return nodes
    case "finished":
      return took(run)
    case "failed":
      return run.failed_node ?? run.reason ?? "failed"
    case "interrupted":
      return run.reason ?? "interrupted"
  }
}

/** The flow column; a Codex session's debrief says what it debriefs, since the session itself isn't listed. */
export const flowText = (run: Pick<RunSummary, "flow" | "codex">) =>
  run.codex ? "debrief of a Codex session" : run.flow

/** Each status's dot, in the Org page's colors (company/person.tsx); waiting keeps its halo. */
export const STATUS_DOT: Record<RunSummary["status"], string> = {
  running: "bg-green-600 motion-safe:animate-pulse dark:bg-green-500",
  waiting: "bg-amber-600 ring-2 ring-amber-600/40 dark:bg-amber-500",
  idle: "bg-neutral-500",
  finished: "border border-neutral-500",
  failed: "bg-red-600 dark:bg-red-500",
  interrupted: "bg-neutral-300 dark:bg-neutral-600",
}
