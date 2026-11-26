// Run Logs data for the fixture HQ: top-level runs, newest first, and the runs started from each, as GET /api/runs and
// GET /api/runs?parent= answer them; each run's page (its header, node and record pages) as GET /api/runs/{id} and its
// routes answer them; and agent nodes' model calls, as GET /api/runs/{id}/calls and its routes answer them.
import type {
  RunCall, RunCallEntry, RunCallMessage, RunDetail, RunDivider, RunEvent, RunNode, RunSummary,
} from "@opencorp/protocol"

/** A run id: "01JA1H" and `n`, 26 characters. */
export const rid = (n: number) => `01JA1H${String(n).padStart(20, "0")}`
// Two hours before the hour the fixture started in: recent, so the list's default query (the last 7 days) holds them.
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString()

export const run = (n: number, over: Partial<RunSummary> = {}): RunSummary => ({
  run_id: rid(n), session_id: `S${n}`, flow: "chat", flow_path: "shared/flows/chat.yaml", person: "kai",
  driver: "ngocbh", participants: ["kai"], parent_run_id: null, status: "finished", reason: null, failed_node: null,
  current_nodes: [], asking: false, held: false, codex: false, launched_at: at(n), ended_at: at(n + 1),
  replaces: null, replaced_by: null, children: [], children_total: 0, ...over,
})

/** The top-level runs (their `children` left empty, as a list page leaves them) and each one's children, newest first. */
export type Runs = { runs: RunSummary[]; children: Record<string, RunSummary[]> }

/** Run `id`'s summary as its page's header has it: the newest 200 runs started from it, and how many there are. */
export function summaryOf(data: Runs, id: string): RunSummary | undefined {
  const found = [...data.runs, ...Object.values(data.children).flat()].find((r) => r.run_id === id)
  const kids = data.children[id] ?? []
  return found && { ...found, children: kids.slice(0, 200), children_total: kids.length }
}

/**
 * Five top-level runs: @kai's chat (idle, a fresh run that replaces run 4, with Ann's side chat under it), the failed
 * run it replaced, @lead's waiting chat (a model question open), a debrief the office drove (no usage recorded), and
 * @minh's profile manager, interrupted when the office stopped.
 */
export function runLogs(): Runs {
  const side = run(6, { flow: "side_chat", flow_path: "shared/flows/side_chat.yaml", driver: "ann",
                        participants: ["kai"], parent_run_id: rid(5) })
  const runs = [
    run(5, { status: "idle", ended_at: null, current_nodes: ["chat#3/ask"], participants: ["kai", "ann"],
             replaces: rid(4), children_total: 1 }),
    run(4, { status: "failed", failed_node: "chat#2/reply", reason: "AuthError: 401 from the provider",
             replaced_by: rid(5) }),
    run(3, { person: "lead", participants: ["lead"], status: "waiting", ended_at: null, asking: true,
             current_nodes: ["chat#1/reply"] }),
    run(2, { flow: "debrief", flow_path: "shared/flows/debrief.yaml", person: "minh", driver: "office",
             participants: ["minh"] }),
    run(1, { flow: "profile_manager", flow_path: "shared/flows/profile_manager.yaml", person: "minh",
             participants: ["minh"], status: "interrupted", reason: "the office stopped", ended_at: null }),
  ]
  return { runs, children: { [rid(5)]: [side] } }
}

/** `n` plain top-level runs, newest first, each with `kids` side chats under it: for paging. */
export function many(n: number, kids = 1): Runs {
  const children: Record<string, RunSummary[]> = {}
  const runs = Array.from({ length: n }, (_, i) => {
    const k = 1000 + (kids + 1) * (n - i)
    children[rid(k)] = Array.from({ length: kids }, (_, j) =>
      run(k + kids - j, { flow: "side_chat", parent_run_id: rid(k), driver: "ann" }))
    return run(k, { children_total: kids })
  })
  return { runs, children }
}

/** One run with `total` side chats under it, of which its page's header holds the newest 200. */
export function crowded(total: number): Runs {
  const kids = Array.from({ length: total }, (_, i) =>
    run(5000 + total - i, { flow: "side_chat", parent_run_id: rid(4000), driver: "ann" }))
  return { runs: [run(4000, { children_total: total })], children: { [rid(4000)]: kids } }
}

/** One run's page as the fixture serves it; `fail` is an error code its record reads answer with. */
export type RunFixturePage = { detail: RunDetail; nodes: RunNode[]; dividers: RunDivider[]; events: RunEvent[];
                               fail?: string | null }
export type RunPages = Record<string, RunFixturePage>

/** A node attempt as the office sends it: succeeded, ended at the next seq, no kind (its flow didn't load). */
export const node = (seq: number, node_id: string, over: Partial<RunNode> = {}): RunNode =>
  ({ seq, end_seq: seq + 1, node_id, kind: null, status: "succeeded", handle: null, error: null, ...over })

/** Run 5's page: three turns of @kai's chat, the second resumed once, the third waiting at its turn; and simple pages
 * for the others (run 6, a side chat; run 1, a log this office can't read; run 4, no log). */
export function runPages(data: Runs): RunPages {
  const detail = (id: string, over: Partial<RunDetail> = {}): RunDetail => ({
    run: summaryOf(data, id)!, parent: null, repo_commit: "a".repeat(40), flow_fingerprint: "b".repeat(64),
    models: { "chat/reply": "gpt-5" }, usage: { input_tokens: 1200, output_tokens: 300, usd: 0.0123 },
    log_state: "ok", log_message: null, ...over })
  const turn = (k: number, base: number): RunNode[] => [
    node(base + 5, `chat#${k}/reply`),
    node(base + 3, `chat#${k}/route`, { status: "routed", handle: "reply" }),
    node(base + 1, `chat#${k}/ask`),
    node(base, `chat~${k}`, { status: "expanded" }),
  ]
  const nodes5 = [
    node(41, "chat#3/ask", { status: "open", end_seq: null }),
    ...turn(3, 34).slice(3),
    node(31, "chat#2/reply", { kind: "agent" }),
    node(25, "chat#2/reply", { status: "restarted", end_seq: null }),
    ...turn(2, 20).slice(1),
    node(15, "chat#1/reply", { status: "failed", error: "AuthError: 401 invalid key" }),
    ...turn(1, 10).slice(1),
    node(1, "chat", { status: "expanded" }),
  ]
  // Records as a page shows them: a cut traceback and one too large to preview.
  const events5: RunEvent[] = [
    { seq: 0, kind: "run_started", node_id: null, payload: { flow_fingerprint: "b".repeat(64) },
      cut: [], withheld: null, size: null },
    { seq: 14, kind: "node_succeeded", node_id: null, payload: null, cut: [], withheld: null, size: 3145728 },
    { seq: 16, kind: "node_failed", node_id: "chat#1/reply", payload: { failure: { message: "AuthError: 401 invalid key",
      traceback: "Traceback (most recent call last): …" } }, cut: ["/failure/traceback"],
      withheld: null, size: null },
    { seq: 17, kind: "node_started", node_id: "chat#2/ask", payload: { node_id: "chat#2/ask" }, cut: [],
      withheld: null, size: null },
    { seq: 30, kind: "run_resumed", node_id: null, payload: { retry_node_ids: ["chat#2/reply"], num_workers: 0 },
      cut: [], withheld: null, size: null },
    { seq: 32, kind: "node_succeeded", node_id: "chat#2/reply", payload: { value: { output: "Done." } },
      cut: [], withheld: null, size: null },
  ]
  return {
    [rid(5)]: { detail: detail(rid(5)), nodes: nodes5, dividers: [{ seq: 30, retried: ["chat#2/reply"] }], events: events5 },
    [rid(3)]: { detail: detail(rid(3)), nodes: [], dividers: [], events: [] },
    [rid(6)]: { detail: detail(rid(6), { usage: { input_tokens: 10, output_tokens: 2, usd: 0 } }),
                nodes: [node(3, "chat#0/reply", { kind: "agent" })], dividers: [], events: [{ seq: 4, kind: "node_succeeded",
                node_id: "chat#0/reply", payload: { value: { output: "Quota." } }, cut: [],
                withheld: null, size: null }] },
    [rid(4)]: { detail: detail(rid(4), { log_state: "not_started", log_message: "no run log: the run didn't start",
                                         flow_fingerprint: null, models: {} }), nodes: [], dividers: [], events: [] },
    [rid(2)]: { detail: detail(rid(2), { usage: null }), nodes: [node(1, "debrief")], dividers: [], events: [] },
    [rid(1)]: { detail: detail(rid(1), { log_state: "unsupported_schema", log_message:
                "This log uses run-log schema 8, which is older than this office supports" }), nodes: [], dividers: [], events: [] },
  }
}

/** The whole record a node opens to, by run id and seq: run 5's reply and its failed reply, run 6's reply, and run 2's
 * debrief (a node whose static path has no model). */
export const wholeEvents = (): Record<string, Record<number, RunEvent>> => ({
  [rid(5)]: {
    32: { seq: 32, kind: "node_succeeded", node_id: "chat#2/reply", payload: { value: { output: "Done." } }, cut: [],
      withheld: null, size: null },
    16: { seq: 16, kind: "node_failed", node_id: "chat#1/reply", payload: { failure: { message: "AuthError: 401 invalid key",
      traceback: "Traceback (most recent call last): …whole…" } }, cut: [],
      withheld: null, size: null },
  },
  [rid(6)]: { 4: { seq: 4, kind: "node_succeeded", node_id: "chat#0/reply", payload: { value: { output: "Quota." } },
    cut: [], withheld: null, size: null } },
  [rid(2)]: { 2: { seq: 2, kind: "node_succeeded", node_id: "debrief", payload: { value: { output: { lessons: [] } } },
    cut: [], withheld: null, size: null } },
})

/** A node's model calls: GET /api/runs/{id}/calls?node= lists `list`, and GET /api/runs/{id}/calls/{node}/{n} answers
 * the call one of whose attempts is `n`. */
export type NodeCalls = { list: RunCallEntry[]; calls: RunCall[] }
/** Model calls by run id and node id. */
export type RunCalls = Record<string, Record<string, NodeCalls>>

/** HTML a model wrote: shown as text, it never becomes an element or runs. */
export const HTML = '<img src=x onerror="window.__pwned=1">'

/** A file listing of 30 lines: long enough to fold. */
export const LISTING = Array.from({ length: 30 }, (_, i) => `notes-${String(i).padStart(2, "0")}.md`).join("\n")

/**
 * Run 5's `chat#2/reply`: call 2, its first attempt cut short and retried, thinks, then saves the notes (held, then
 * released by @ngocbh) and lists the folder (allowed as read-only, its long listing folded); call 5 reasons without
 * sharing it, says "Done." and writes HTML, its system prompt cut by the office. And
 * run 6's `chat#0/reply`: call 1, which an interrupt cut, its reasoning not shared and no usage reported.
 */
export function runCalls(): RunCalls {
  const at = (second: number) => new Date(BASE + 30 * 60_000 + second * 1000).toISOString()
  const usage = { input_tokens: 1200, output_tokens: 80, cache_read_tokens: 800, cache_creation_tokens: null,
                  reasoning_tokens: 40 }
  const tools = [
    { name: "workspace_save", description: "Save a file in the workspace.", strict: null,
      parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } } },
    { name: "terminal_run", description: "Run a command in a shell.", strict: null,
      parameters: { type: "object", properties: { command: { type: "string" } } } },
  ]
  const save = { path: "notes.md", text: "Ship on Friday." }
  const asked = [
    { role: "user", author: "ngocbh", parts: [{ type: "text" as const, text: "Hi Kai." }] },
    { role: "assistant", author: null, parts: [{ type: "text" as const, text: "Hello." }] },
    { role: "user", author: "ngocbh", parts: [{ type: "text" as const, text: "Save the notes, then list the folder." }] },
  ]
  const reply2 = { role: "assistant", author: null, parts: [
    { type: "reasoning" as const, text: "The notes are short: save them, then list." },
    { type: "text" as const, text: "Saving the notes, then listing the folder." },
    { type: "tool_call" as const, id: "c1", name: "workspace_save", arguments: save, raw_arguments: null },
    { type: "tool_call" as const, id: "c2", name: "terminal_run", arguments: { command: "ls" }, raw_arguments: null },
  ] }
  const request = (messages: RunCallMessage[]) => ({
    model: "gpt-5", params: { provider: "openai", model: "gpt-5", reasoning: { effort: "medium" } },
    system: "You are Kai (@kai), Engineer at Acme. Speak as yourself, in the first person.", messages, tools,
    tool_choice: null, parallel_tool_calls: null, output_format: null,
  })
  const call2: RunCall = {
    node_id: "chat#2/reply", n: 2, purpose: "chat", request: request(asked), digest_mismatch: false,
    attempts: [
      { n: 1, started_at: at(0), first_token_at: at(1), finished_at: at(1), retry_in: 0.4, usage: null,
        error: { kind: "incomplete", message: "the stream ended before its finish event" } },
      { n: 2, started_at: at(2), first_token_at: at(3), finished_at: at(4), error: null, retry_in: null, usage },
    ],
    reply: reply2,
    tool_results: [
      { call_id: "c1", name: "workspace_save", arguments: save, output: "saved notes.md", is_error: false, closed: null,
        started_at: at(9), note: null, held: true, release_note: "approved by @ngocbh" },
      { call_id: "c2", name: "terminal_run", arguments: { command: "ls" }, output: LISTING, is_error: false,
        closed: null, started_at: at(10), note: "read-only", held: false, release_note: null },
    ],
    usage, finish: "tool_calls", interrupted: false, cut: [],
  }
  const results = { role: "tool", author: null, parts: [
    { type: "tool_result" as const, call_id: "c1", name: "workspace_save", content: "saved notes.md", is_error: false },
    { type: "tool_result" as const, call_id: "c2", name: "terminal_run", content: LISTING, is_error: false },
  ] }
  const call5: RunCall = {
    node_id: "chat#2/reply", n: 5, purpose: "chat", request: request([...asked, reply2, results]),
    digest_mismatch: false,
    attempts: [{ n: 5, started_at: at(11), first_token_at: at(12), finished_at: at(12), error: null, retry_in: null,
                 usage }],
    // A thought the provider didn't share: its text is empty, its tokens in the usage.
    reply: { role: "assistant", author: null, parts: [{ type: "reasoning", text: "" }, { type: "text", text: "Done." },
                                                       { type: "text", text: HTML }] },
    // As if its system prompt had been too long to send whole.
    tool_results: [], usage, finish: "stop", interrupted: false, cut: ["/request/system"],
  }
  const cutShort: RunCall = {
    node_id: "chat#0/reply", n: 1, purpose: "chat", digest_mismatch: false,
    request: request([{ role: "user", author: "ann", parts: [{ type: "text", text: "What's our quota?" }] }]),
    attempts: [{ n: 1, started_at: at(0), first_token_at: at(1), finished_at: at(2), error: null, retry_in: null,
                 usage: null }],
    reply: { role: "assistant", author: null, parts: [{ type: "reasoning", text: "" }, { type: "text", text: "Let me" }] },
    tool_results: [], usage: null, finish: "interrupted", interrupted: true, cut: [],
  }
  const entry = (call: RunCall, model = "gpt-5"): RunCallEntry => ({
    node_id: call.node_id, n: call.n, purpose: call.purpose, model, started_at: call.attempts[0]!.started_at,
    attempts: call.attempts.length, finish: call.finish ?? null,
  })
  return {
    [rid(5)]: { "chat#2/reply": { list: [entry(call2), entry(call5)], calls: [call2, call5] } },
    [rid(6)]: { "chat#0/reply": { list: [entry(cutShort)], calls: [cutShort] } },
  }
}
