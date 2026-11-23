/**
 * The gate's policy for each tool call an agent's model makes (yian's `beforeToolCall`): it runs, is refused, asks the
 * session's approver on a card, or, in `auto`, goes to Auto's check. It needs no office: the host binds the session's
 * mode, its rules and whether a rules file doesn't load, and acts on the decision.
 *
 * A call is named by its words (`toolWords`), which `tool` rules match: deny rules refuse first, in every mode; while
 * a rules file doesn't load, every call but a read asks, as a command does; then ask rules ask, then allow rules run;
 * then the call's row decides. Host tools run in every mode: the workspace's file tools are held to the workspace by
 * its sandbox, the company's and the toolbox's by their own checks, the harness instruments by the employee's
 * permission. Only starting a Codex or Claude Code session asks, and only in `ask` mode. Memory and flow tools run:
 * the calls a granted flow's agents make are gated on their own. A tool module's or an MCP server's tool, which no
 * reader can judge, goes to Auto's check in `auto`, asks in `default` and `ask`, and is refused in `dontAsk`.
 *
 * The terminal's `run` and `type` are decided by the command reader instead (`decideCommand`), on what the
 * terminal's plan reads from its shells: the same mode, rules, reader and Auto's check its own gate used.
 * A flow's own steps that call a tool (a TOOL, `call`, `map` or `loop` node) never reach the gate: only agents' calls
 * are gated by the session's mode.
 */
import type { ToolSource } from "@ngocbh/yian/tools"
import type { Approval } from "@opencorp/protocol"
import { toolRuleMatches, toolWords } from "../../company/rules.ts"
import {
  type Action, type CheckInput, checkInput, decide, dontAskRefusal, type Mode, type Rule, type Verdict, type Where,
} from "./policy.ts"

/** A model's tool call as the gate decides it: the name the model sees, where the tool comes from, the model's
 *  arguments (null when a restored hold recorded none), and 1, or more for a call sent again after a stop or crash
 *  (yian's count, never the model's). */
export interface ToolCall {
  readonly tool: string
  readonly source: ToolSource
  readonly arguments: Readonly<Record<string, unknown>> | null
  readonly attempt: number
}

/** What the gate decides by: the session's mode, its rules (the session's, the agent's and the company's; only `tool`
 *  rules decide a call), and why every call asks now (a rules file that doesn't load), or null. */
export interface CallPolicy {
  readonly mode: Mode
  readonly rules: readonly Rule[]
  readonly blocked: string | null
}

/** Run the call (`note` says why, for the run log), refuse it (the model reads `reason`), hold it on a card (`reason`
 *  says why; `rules` are what "don't ask again" may add), or hold it for Auto's check on `input`. */
export type CallDecision =
  | { readonly verdict: "run"; readonly note: string | null }
  | { readonly verdict: "refuse"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string; readonly rules: readonly string[] }
  | { readonly verdict: "check"; readonly input: CheckInput; readonly rules: readonly string[] }

/** The most UTF-8 bytes of a call Auto's check reads: its words and its arguments as JSON. A longer call asks. */
export const MAX_CHECK_BYTES = 8000

const READ_ONLY = "read-only"
const FILE_OP = "a file operation in the workspace"
const HARNESS = "a harness session in its profile"
const BY_RULE = "an allow rule"
const RELEASED = "released before a stop or crash cut it off"
const UNNAMED = "its name can't be written in a rule, so no rule covers it"
const UNREAD = "its arguments couldn't be read"
const UNREAD_COMMAND = "Not run: the command reader couldn't read what this terminal call would act on."
/** What the model reads for a call sent again that would ask, whose first try was never released: a stop or crash
 *  may have cut it off while the gate decided, so nobody approved it, and yian can't hold a call that may have run. */
export const CUT_OFF = "Not run: it was cut off before it was approved."
const TOO_LONG = "its arguments are too long for Auto's check: read all of them before you say Yes"
/** The calls that only read, which ask nothing while a rules file doesn't load, by their words. */
const READS = new Set([
  "host workspace read_file", "host workspace list", "host workspace search", "host terminal read",
  "host codex history", "host claude history", "memory * read", "memory * list", "memory * search",
])

/** What the gate decides for `call` under `policy` (see the module's note). */
export function decideCall(call: ToolCall, policy: CallPolicy): CallDecision {
  const { source } = call
  // The command reader decides these on what the terminal would act on (`decideCommand`): never their source.
  if (source.kind === "host" && source.group === "terminal" && (source.tool === "run" || source.tool === "type")) {
    return { verdict: "refuse", reason: UNREAD_COMMAND }
  }
  const asks = (reason: string, rules: readonly string[] = []): CallDecision =>
    policy.mode === "dontAsk"
      ? { verdict: "refuse", reason: dontAskRefusal(reason) }
      : { verdict: "ask", reason, rules }
  const words = toolWords(source)
  if (words === null) return asks(UNNAMED)
  const own = policy.rules.filter((r) => r.kind === "tool" && toolRuleMatches(r.pattern, words))
  const denied = own.find((r) => r.effect === "deny")
  if (denied) return { verdict: "refuse", reason: `Not run: a deny rule: ${denied.pattern}.` }
  if (policy.blocked !== null && !isRead(words)) return asks(policy.blocked)
  // Nothing can judge a call whose arguments are unknown, nor offer a rule for it.
  if (call.arguments === null) return asks(UNREAD)
  const asked = own.find((r) => r.effect === "ask")
  if (asked) return asks(`an ask rule: ${asked.pattern}`)
  if (own.some((r) => r.effect === "allow")) return { verdict: "run", note: BY_RULE }
  return row(call, words, policy.mode, asks)
}

/** The call's row: what its source does in `mode` once no rule decided it. */
function row(
  call: ToolCall,
  words: readonly string[],
  mode: Mode,
  asks: (reason: string, rules?: readonly string[]) => CallDecision,
): CallDecision {
  const { source } = call
  const exact = [words.join(" ")]
  if (source.kind === "host") {
    if (source.group === "workspace") {
      return { verdict: "run", note: ["read_file", "list", "search"].includes(source.tool) ? READ_ONLY : FILE_OP }
    }
    if ((source.group === "codex" || source.group === "claude") && source.tool === "start") {
      return mode === "ask" ? asks("Ask mode", exact) : { verdict: "run", note: HARNESS }
    }
    return { verdict: "run", note: null }
  }
  if (source.kind === "memory" || source.kind === "flow") return { verdict: "run", note: null }
  const what = source.kind === "mcp" ? "an MCP tool" : "a tool module's tool"
  if (mode === "ask") return asks("Ask mode", exact)
  if (mode !== "auto") return asks(`Default mode asks before ${what}`, exact)
  const command = `${exact[0]} ${jsonText(call.arguments)}`
  if (new TextEncoder().encode(command).length > MAX_CHECK_BYTES) return asks(TOO_LONG, exact)
  return { verdict: "check", input: { kind: "tool", command, profile: "none", cwd: "", host: "" }, rules: exact }
}

/** What the gate decides for a terminal command or typed line (`action`, run `where`), by the command reader
 *  (`decide`), as the terminal's own gate did: while a rules file doesn't load, the action is one never automated. A
 *  run notes what allows it; a refusal reads `Not run: <why>.`; one Auto's check judges is told the action and where
 *  it runs. */
export function decideCommand(plan: { action: Action; where: Where }, policy: CallPolicy): CallDecision {
  const { where } = plan
  const action = policy.blocked === null || plan.action.never !== undefined
    ? plan.action
    : { ...plan.action, never: policy.blocked }
  const decision = decide(action, policy.mode, policy.rules, where)
  switch (decision.verdict) {
    case "allow":
      return { verdict: "run", note: decision.by }
    case "deny":
      return { verdict: "refuse", reason: `Not run: ${decision.reason}.` }
    case "ask":
      return { verdict: "ask", reason: decision.reason, rules: decision.rules }
    case "check":
      return { verdict: "check", input: checkInput(plan.action, where), rules: decision.rules }
  }
}

/** What `decision` becomes for a call yian sent again after a stop or crash (`attempt` over 1), which yian can't hold
 *  since it may have run: a run or a refusal stands; one that would ask, or go to Auto's check, runs only when the
 *  run released the call before (`released`), else it is refused (`CUT_OFF`). */
export function resent(decision: CallDecision, released: boolean): CallDecision {
  if (decision.verdict === "run" || decision.verdict === "refuse") return decision
  return released ? { verdict: "run", note: RELEASED } : { verdict: "refuse", reason: CUT_OFF }
}

/** What Auto's check's `verdict` decides for a call it held, with `rules` for its card, in `mode` now: a run runs,
 *  noting the check's reason; anything else asks, or is refused once the session doesn't ask. Each cites the run
 *  whose log holds the verdict (`(run <id>)`), when it names one. */
export function afterCheck(verdict: Verdict, rules: readonly string[], mode: Mode): CallDecision {
  const run = verdict.run === undefined ? "" : ` (run ${verdict.run})`
  if (verdict.verdict === "run" && !verdict.failed) return { verdict: "run", note: `Auto's check: ${verdict.reason}${run}` }
  const reason = verdict.failed
    ? `Auto asks: its check couldn't judge this: ${verdict.reason}${run}`
    : `Auto's check: ${verdict.reason}${run}`
  return mode === "dontAsk" ? { verdict: "refuse", reason: dontAskRefusal(reason) } : { verdict: "ask", reason, rules }
}

/** The approval card a call is held on: the call as the model made it (its name and its arguments as JSON, or its
 *  name alone when they couldn't be read), why it asks, and the rules "don't ask again" may add. A big integer
 *  argument shows as its digits. */
export function toolCard(call: ToolCall, asked: { reason: string; rules: readonly string[] }): Approval {
  const args = call.arguments
  return {
    kind: "tool",
    tool: call.tool,
    action: args === null ? call.tool : `${call.tool} ${jsonText(args)}`,
    args: args === null ? {} : (JSON.parse(jsonText(args, true)) as Record<string, unknown>),
    why: "",
    reason: asked.reason,
    rules: [...asked.rules],
    partial: false,
    into: null,
  }
}

/** Whether a call of `words` only reads (`READS`, where `*` stands for any one word). */
function isRead(words: readonly string[]): boolean {
  return [...READS].some((read) => {
    const want = read.split(" ")
    return want.length === words.length && want.every((word, i) => word === "*" || word === words[i])
  })
}

/** `value` as JSON, a big integer as its digits: bare, or as a string when `quoted`. */
function jsonText(value: unknown, quoted = false): string {
  const marks = new Map<string, string>()
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== "bigint") return v
    if (quoted) return v.toString()
    const mark = `\u0000bigint${marks.size}\u0000`
    marks.set(mark, v.toString())
    return mark
  })
  let out = text ?? "null"
  for (const [mark, digits] of marks) out = out.replace(JSON.stringify(mark), digits)
  return out
}
