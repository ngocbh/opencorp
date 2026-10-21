// Run Logs data for the fixture HQ: top-level runs as GET /api/runs answers them, newest first, children attached;
// and each run's page (its header, node and record pages) as GET /api/runs/{id} and its routes answer them.
import type { RunDetail, RunDivider, RunEvent, RunNode, RunSummary } from "@opencorp/protocol"

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

/** One run's page as the fixture serves it; `indexing` makes its node and record pages answer "indexing", and
 * `fail` is an error code its record reads answer with. */
export type RunFixturePage = { detail: RunDetail; nodes: RunNode[]; dividers: RunDivider[]; events: RunEvent[];
                               indexing?: boolean; fail?: string | null }
export type RunPages = Record<string, RunFixturePage>

/** A node attempt as the office sends it: succeeded, ended at the next seq, no kind (until yian#943). */
export const node = (seq: number, node_id: string, over: Partial<RunNode> = {}): RunNode =>
  ({ seq, end_seq: seq + 1, node_id, kind: null, status: "succeeded", handle: null, error: null, ...over })

/** Run 5's page: three turns of @kai's chat, the second resumed once, the third waiting at its turn; and simple pages
 * for the others (run 6, a side chat that keeps no evidence; run 1, a log this office can't read; run 4, no log). */
export function runPages(runs: RunSummary[]): RunPages {
  const byId = Object.fromEntries(runs.flatMap((r) => [r, ...(r.children ?? [])]).map((r) => [r.run_id, r]))
  const detail = (id: string, over: Partial<RunDetail> = {}): RunDetail => ({
    run: byId[id]!, parent: null, repo_commit: "a".repeat(40), flow_fingerprint: "b".repeat(64), learnable: true,
    models: { "chat/reply": "gpt-5" }, usage: { input_tokens: 1200, output_tokens: 300, usd: 0.0123 },
    log_state: "ok", log_message: null, bytes_done: null, bytes_total: null, ...over })
  const turn = (k: number, base: number): RunNode[] => [
    node(base + 5, `chat#${k}/reply`),
    node(base + 3, `chat#${k}/route`, { status: "routed", handle: "reply" }),
    node(base + 1, `chat#${k}/ask`),
    node(base, `chat~${k}`, { status: "expanded" }),
  ]
  const nodes5 = [
    node(41, "chat#3/ask", { status: "open", end_seq: null }),
    ...turn(3, 34).slice(3),
    node(31, "chat#2/reply"),
    node(25, "chat#2/reply", { status: "restarted", end_seq: null }),
    ...turn(2, 20).slice(1),
    node(15, "chat#1/reply", { status: "failed", error: "AuthError: 401 key (hidden)" }),
    ...turn(1, 10).slice(1),
    node(1, "chat", { status: "expanded" }),
  ]
  // Records as a page shows them: a cut traceback, evidence left out, one too large to preview and one withheld.
  const events5: RunEvent[] = [
    { seq: 0, kind: "run_started", node_id: null, payload: { flow_fingerprint: "b".repeat(64), learnable: true },
      cut: [], evidence_left_out: false, withheld: null, size: null },
    { seq: 14, kind: "node_succeeded", node_id: null, payload: null, cut: [], evidence_left_out: false, withheld: null,
      size: 3145728 },
    { seq: 16, kind: "node_failed", node_id: "chat#1/reply", payload: { failure: { message: "AuthError: 401 key (hidden)",
      traceback: "Traceback (most recent call last): …" }, evidence: null }, cut: ["/failure/traceback"],
      evidence_left_out: true, withheld: null, size: null },
    { seq: 17, kind: "node_started", node_id: "chat#2/ask", payload: null, cut: [], evidence_left_out: false,
      withheld: "a secret couldn't be removed", size: null },
    { seq: 30, kind: "run_resumed", node_id: null, payload: { retry_node_ids: ["chat#2/reply"], num_workers: 0 },
      cut: [], evidence_left_out: false, withheld: null, size: null },
    { seq: 32, kind: "node_succeeded", node_id: "chat#2/reply", payload: { value: { output: "Done." }, evidence: null },
      cut: [], evidence_left_out: true, withheld: null, size: null },
  ]
  return {
    [rid(5)]: { detail: detail(rid(5)), nodes: nodes5, dividers: [{ seq: 30, retried: ["chat#2/reply"] }], events: events5 },
    [rid(3)]: { detail: detail(rid(3)), nodes: [], dividers: [], events: [] },
    [rid(6)]: { detail: detail(rid(6), { learnable: false, usage: { input_tokens: 10, output_tokens: 2, usd: 0 } }),
                nodes: [node(3, "chat#0/reply")], dividers: [], events: [{ seq: 4, kind: "node_succeeded",
                node_id: "chat#0/reply", payload: { value: { output: "Quota." }, evidence: null }, cut: [],
                evidence_left_out: false, withheld: null, size: null }] },
    [rid(4)]: { detail: detail(rid(4), { log_state: "not_started", log_message: "no run log: the run didn't start",
                                         flow_fingerprint: null, learnable: null, models: {} }), nodes: [], dividers: [], events: [] },
    [rid(2)]: { detail: detail(rid(2), { usage: null }), nodes: [node(1, "debrief")], dividers: [], events: [] },
    [rid(1)]: { detail: detail(rid(1), { log_state: "unsupported_schema", log_message:
                "This log uses run-log schema 8, which is older than this office supports" }), nodes: [], dividers: [], events: [] },
  }
}

/** The whole record a node opens to, by run id and seq: run 5's reply with its evidence and its failed reply, run 6's
 * reply, and run 2's debrief (a node whose static path has no model). */
export const wholeEvents = (): Record<string, Record<number, RunEvent>> => ({
  [rid(5)]: {
    32: { seq: 32, kind: "node_succeeded", node_id: "chat#2/reply", payload: { value: { output: "Done." }, evidence: {
      prompt: "Fix the build", base_system_prompt: "You are Kai…", bound_inputs: { message: "Fix the build" },
      memory_sections: [], interactions: [{ kind: "tool_call", name: "workspace.read", args: { path: "README.md" } }] } },
      cut: [], evidence_left_out: false, withheld: null, size: null },
    16: { seq: 16, kind: "node_failed", node_id: "chat#1/reply", payload: { failure: { message: "AuthError: 401 key (hidden)",
      traceback: "Traceback (most recent call last): …whole…" }, evidence: null }, cut: [], evidence_left_out: false,
      withheld: null, size: null },
  },
  [rid(6)]: { 4: { seq: 4, kind: "node_succeeded", node_id: "chat#0/reply", payload: { value: { output: "Quota." },
    evidence: null }, cut: [], evidence_left_out: false, withheld: null, size: null } },
  [rid(2)]: { 2: { seq: 2, kind: "node_succeeded", node_id: "debrief", payload: { value: { output: { lessons: [] } },
    evidence: null }, cut: [], evidence_left_out: false, withheld: null, size: null } },
})
