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
 * The terminal's `run` and `type` pass here: the terminal still decides its own commands with the command reader.
 * A flow's own steps that call a tool (a TOOL, `call`, `map` or `loop` node) never reach the gate: only agents' calls
 * are gated by the session's mode.
 */
import type { ToolSource } from "@ngocbh/yian/tools"
import type { Approval } from "@opencorp/protocol"
import { toolRuleMatches, toolWords } from "../../company/rules.ts"
import { type CheckInput, dontAskRefusal, type Mode, type Rule, type Verdict } from "./policy.ts"

/** A model's tool call as the gate decides it: the name the model sees, where the tool comes from, the model's
 *  arguments, and 1, or more for a call sent again after a crash. */
export interface ToolCall {
  readonly tool: string
  readonly source: ToolSource
  readonly arguments: Readonly<Record<string, unknown>>
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
const RESENT = "sent again after a crash; its first try was let run"
const UNNAMED = "its name can't be written in a rule, so no rule covers it"
const TOO_LONG = "its arguments are too long for Auto's check: read all of them before you say Yes"
/** The calls that only read, which ask nothing while a rules file doesn't load, by their words. */
const READS = new Set([
  "host workspace read_file", "host workspace list", "host workspace search", "host terminal read",
  "host codex history", "host claude history", "memory * read", "memory * list", "memory * search",
])

/** What the gate decides for `call` under `policy` (see the module's note). */
export function decideCall(call: ToolCall, policy: CallPolicy): CallDecision {
  const { source } = call
  if (source.kind === "host" && source.group === "terminal" && (source.tool === "run" || source.tool === "type")) {
    return { verdict: "run", note: null }
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
  // A call sent again may have run, so yian can't hold it: its first try was let run, so this one is too.
  if (call.attempt > 1) return { verdict: "run", note: RESENT }
  if (policy.blocked !== null && !isRead(words)) return asks(policy.blocked)
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

/** What Auto's check's `verdict` decides for a call it held, with `rules` for its card, in `mode` now: a run runs,
 *  noting the check's reason; anything else asks, or is refused once the session doesn't ask. */
export function afterCheck(verdict: Verdict, rules: readonly string[], mode: Mode): CallDecision {
  if (verdict.verdict === "run" && !verdict.failed) return { verdict: "run", note: `Auto's check: ${verdict.reason}` }
  const reason = verdict.failed
    ? `Auto asks: its check couldn't judge this: ${verdict.reason}`
    : `Auto's check: ${verdict.reason}`
  return mode === "dontAsk" ? { verdict: "refuse", reason: dontAskRefusal(reason) } : { verdict: "ask", reason, rules }
}

/** The approval card a call is held on: the call as the model made it (its name and its arguments as JSON), why it
 *  asks, and the rules "don't ask again" may add. A big integer argument shows as its digits. */
export function toolCard(call: ToolCall, asked: { reason: string; rules: readonly string[] }): Approval {
  const text = jsonText(call.arguments)
  return {
    kind: "tool",
    tool: call.tool,
    action: `${call.tool} ${text}`,
    args: JSON.parse(jsonText(call.arguments, true)) as Record<string, unknown>,
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
