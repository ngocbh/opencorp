// Run Logs data for the fixture HQ: top-level runs as GET /api/runs answers them, newest first, children attached.
import type { RunSummary } from "@opencorp/protocol"

/** A run id: "01JA1H" and `n`, 26 characters. */
export const rid = (n: number) => `01JA1H${String(n).padStart(20, "0")}`
const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString()

export const run = (n: number, over: Partial<RunSummary> = {}): RunSummary => ({
  run_id: rid(n), session_id: `S${n}`, flow: "chat", flow_path: "shared/flows/chat.yaml", person: "kai",
  driver: "ngocbh", participants: ["kai"], parent_run_id: null, status: "finished", reason: null, failed_node: null,
  current_nodes: [], asking: false, held: false, codex: false, launched_at: at(n), ended_at: at(n + 1),
  replaces: null, replaced_by: null, children: [], children_total: 0, ...over,
})

export type Runs = { runs: RunSummary[]; children: Record<string, RunSummary[]> }

/**
 * Five top-level runs: @kai's chat (idle, a fresh run that replaces run 4, with Ann's side chat under it), the failed
 * run it replaced, @lead's waiting chat (a model question open), a Codex session's debrief, and @minh's profile
 * manager, interrupted when the office stopped.
 */
export function runLogs(): Runs {
  const side = run(6, { flow: "side_chat", flow_path: "shared/flows/side_chat.yaml", driver: "ann",
                        participants: ["kai"], parent_run_id: rid(5) })
  const runs = [
    run(5, { status: "idle", ended_at: null, current_nodes: ["chat#3/ask"], participants: ["kai", "ann"],
             replaces: rid(4), children: [side], children_total: 1 }),
    run(4, { status: "failed", failed_node: "chat#2/reply", reason: "AuthError: 401 from the provider",
             replaced_by: rid(5) }),
    run(3, { person: "lead", participants: ["lead"], status: "waiting", ended_at: null, asking: true,
             current_nodes: ["chat#1/reply"] }),
    run(2, { flow: "debrief", flow_path: "shared/flows/debrief.yaml", person: "minh", driver: "office",
             participants: ["minh"], codex: true }),
    run(1, { flow: "profile_manager", flow_path: "shared/flows/profile_manager.yaml", person: "minh",
             participants: ["minh"], status: "interrupted", reason: "the office stopped", ended_at: null }),
  ]
  return { runs, children: { [rid(5)]: [side] } }
}

/** `n` plain top-level runs, newest first, each with one side chat under it: for paging. */
export function many(n: number): Runs {
  const runs = Array.from({ length: n }, (_, i) => {
    const k = 1000 + 2 * (n - i)
    const kid = run(k + 1, { flow: "side_chat", parent_run_id: rid(k), driver: "ann" })
    return run(k, { children: [kid], children_total: 1 })
  })
  return { runs, children: Object.fromEntries(runs.map((r) => [r.run_id, r.children ?? []])) }
}

/** One run with `total` side chats under it, of which the list holds the newest 200. */
export function crowded(total: number): Runs {
  const kids = Array.from({ length: total }, (_, i) =>
    run(5000 + total - i, { flow: "side_chat", parent_run_id: rid(4000), driver: "ann" }))
  return { runs: [run(4000, { children: kids.slice(0, 200), children_total: total })], children: { [rid(4000)]: kids } }
}
