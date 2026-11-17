/**
 * Who may do what without asking: a session's mode and rules decide each command an agent runs and each line it
 * types, before it acts, and hand what they don't cover in `auto` and `dontAsk` to Auto's check. It needs no
 * office: the host binds the mode, the rules, where the shell runs, the check and how a card holds the call.
 *
 * The reader (`commands.ts`) can promise that a command line runs without Auto's check or a card only when every
 * part of it is covered: by an allow rule; by a form it knows to be read-only (`auto`, `default`, `dontAsk`); by a
 * plain push of a feature branch (`auto`, `dontAsk`); or, inside the workspace sandbox, by a file operation on
 * paths inside the workspace (`auto`, `dontAsk`). A deny rule refuses what it matches wherever the reader sees it:
 * inside substitutions, `sh -c` strings, `sudo`, `find -exec` and ssh's remote command too. The reader reads no line
 * over 1000 bytes: a typed one is refused, and a command asks in every mode (`dontAsk` refuses it), as too long to
 * check; no rule covers it and Auto's check never judges it, since no deny rule could see into it.
 * The reader asks, in every mode, before a command that names a credential path anywhere in the line (an operand,
 * an option's value, an assignment, a `for` list, a here-string or a redirect), one the host marks
 * (`Where.credentials`), or a folder that holds them. Where credentials are reachable (the SSH-only profile, a
 * profile the host marks credentials on, an ssh remote command, and a line typed into ssh or mosh), it also asks
 * before a program that reads file contents is given a path through an expansion, whose value it can't see; in the
 * workspace sandbox, which keeps the home out, such a read follows the usual rules and the sandbox is the guard.
 * Auto's check never judges a push, `sudo` or a local command for ssh.
 * While the host says the session is blocked (`Permissions.blocked`, a rules file that doesn't load), every action
 * asks as a never-automated one does, and `dontAsk` refuses it; deny rules still refuse first.
 *
 * The reader can't know what a program does with its files, its config or its input: `git` runs hooks and programs
 * its config names (`core.fsmonitor`, `core.pager`, `diff.external`); a script does what it contains; a remote host
 * has its own rc files and `PATH`; `~/.ssh/config` can name a `ProxyCommand` for a host. In a persistent shell,
 * earlier lines can define functions, aliases or a `PATH` that change what a read-only line runs. No rule sees into
 * a variable's value or a script file, readable line or not. It can't stop a read-only program from reading what
 * the sandbox lets it read; the model then sees it.
 *
 * Auto's check can be wrong. It is a model reading text the agent wrote. It sees only the command, the shell's
 * profile, its folder and the ssh host, never the agent's reasoning, and its answer is typed, so a prompt
 * injection in the command can at most choose `run` or `ask` for that one command.
 *
 * So the sandbox is the guard for everything local. A wrong `run` inside the workspace sandbox, from the check or
 * from a file operation through a link, can do only what the sandbox allows. The reader and the check decide only
 * when the owner is asked.
 *
 * For a remote command (`ssh host cmd`, or a line typed into a remote shell), nothing sandboxes the far end. In
 * `auto` and `dontAsk` the check is the only check there, as in Claude Code; `default` and `ask` are the
 * conservative modes for remote work.
 */
import { ruleWords } from "@opencorp/protocol"
import {
  assignmentsOf, classify, credentialOf, EMPTY, fileOp, innerParts, logsIn, ownerOnly, programOf, pushOf,
  readCommand, remoteOf, type SimpleCommand, sshHosts, sshOf, type Where,
} from "./commands.ts"
export type { Where } from "./commands.ts"

/** A session's mode, in Shift+Tab's order; a session starts in `auto`. */
export type Mode = "auto" | "default" | "ask" | "dontAsk"
export const MODES: readonly Mode[] = ["auto", "default", "ask", "dontAsk"]
export type Effect = "allow" | "ask" | "deny"

/** What an agent wants to do: run a command, or type a line into a running one. `never`, set by the host, says
 *  why it is never automated. `partial`: typed text without Enter. `into`: for typed text, the command it is typed
 *  into, as it ran (its ssh destination is the host Auto's check is told). */
export interface Action {
  readonly kind: "command" | "input"
  readonly text: string
  readonly never?: string
  readonly partial?: boolean
  readonly into?: string
}
export interface Rule {
  readonly effect: Effect
  readonly kind: Action["kind"]
  readonly pattern: string
}
/** `allow` says `by` what: "an allow rule", "read-only", "a file operation in the workspace", "a push to a feature
 *  branch" or "a prompt's answer". `check`: hand the whole line to Auto's check; `rules` are what its card would
 *  offer. */
export type Decision =
  | { readonly verdict: "allow"; readonly by: string }
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string; readonly rules: readonly string[] }
  | { readonly verdict: "check"; readonly rules: readonly string[] }

/** What Auto's check is told: the command or typed line, the shell's profile, its folder, and the ssh host it
 *  runs on ("" for this machine). Never the agent's own reason. */
export interface CheckInput {
  readonly kind: Action["kind"]
  readonly command: string
  readonly profile: Where["profile"]
  readonly cwd: string
  readonly host: string
}
/** Auto's check's answer, with a one-line reason; `failed` when the check couldn't judge, and `reason` says why. */
export interface Verdict {
  readonly verdict: "run" | "ask"
  readonly reason: string
  readonly failed?: boolean
}

const BY_RULE = "an allow rule"
const READ_ONLY = "read-only"
const FILE_OP = "a file operation in the workspace"
const PUSH = "a push to a feature branch"
const ANSWER = "a prompt's answer"
/** What `allow` names when parts are covered in different ways: the widest. */
const WIDEST = [BY_RULE, FILE_OP, PUSH, READ_ONLY]
const DONT_ASK = "this session doesn't ask (dontAsk mode): "
/** The longest line the reader reads: a typed line past it is refused, and a command past it asks. */
const MAX_LINE_BYTES = 1000
/** Why a command past `MAX_LINE_BYTES` asks: nothing checked it, so the owner must read it whole. */
const TOO_LONG = `it is too long to check (over ${MAX_LINE_BYTES} bytes): read all of it before you say Yes`
/** A prompt's short answer: a menu choice, yes or no, quit, or Enter alone. */
const PROMPT_ANSWER = /^(\d{1,6}|y|n|yes|no|q|)$/
/** Programs whose second word names what they do; a suggested rule keeps it. */
const SUBCOMMANDS = new Set(
  "git docker kubectl npm bun cargo systemctl module conda pip uv opencorp scontrol".split(" "),
)
const MOVES = new Set(["cd", "pushd", "popd"])
const REASON_CHARS = 200

/** Whether `pattern` matches `words`: the protocol's `RulePattern` (words with no whitespace, one space between each),
 *  where only a final `*` is a wildcard, matching any further words (none included). A pattern of another form, which
 *  no rules file could hold, matches nothing, so no card offers it. */
export function matches(pattern: string, words: readonly string[]): boolean {
  const want = ruleWords(pattern)
  if (want === null) return false
  const wild = want.at(-1) === "*"
  const fixed = wild ? want.slice(0, -1) : want
  if (wild ? words.length < fixed.length : words.length !== fixed.length) return false
  return fixed.every((word, i) => word === words[i])
}

/** The rule a card offers for `part`: exact for typed input, a risky part, a program that runs code and a part that
 *  sets variables; otherwise its program, its subcommand if it has one, then `*` (over ssh, the remote's). */
export function suggest(part: SimpleCommand, kind: Action["kind"]): string {
  const exact = written(part).join(" ")
  if (kind === "input") return exact
  const { risk, runsCode } = classify(part)
  if (risk !== null || runsCode || assignmentsOf(part).length > 0) return exact
  const words = programOf(part)
  const ssh = sshOf(part)
  let head = prefix(words)
  if (ssh) {
    const remote = remoteOf(part)?.read
    const only = remote?.parts.length === 1 && remote.unreadable === null ? remote.parts[0]! : null
    const plain = only !== null && only.assignments.length === 0 && only.writes.length === 0 &&
      programOf(only).length === only.words.length && only.words.join("\0") === ssh.command!.join("\0")
    const tail = plain ? prefix(only.words) : null
    head = tail ? [...words.slice(0, words.length - only!.words.length), ...tail] : null
  }
  return head ? [...head, "*"].join(" ") : exact
}

export function decide(action: Action, mode: Mode, rules: readonly Rule[], where: Where): Decision {
  const held = (reason: string, offers: readonly string[] = []): Decision =>
    mode === "dontAsk" ? { verdict: "deny", reason: DONT_ASK + reason } : { verdict: "ask", reason, rules: offers }
  if (new TextEncoder().encode(action.text).length > MAX_LINE_BYTES) {
    if (action.kind === "input") return { verdict: "deny", reason: `it is longer than ${MAX_LINE_BYTES} bytes` }
    // Unread, no deny or ask rule could see into it: no rule covers it and no check judges it, so it asks in every
    // mode.
    return held(TOO_LONG)
  }
  const read = readCommand(action.text)
  const parts = read.parts.length > 0 ? read.parts : [EMPTY]
  const own = rules.filter((r) => r.kind === action.kind)
  const everything = parts.flatMap(withInner)
  const first = (effect: Effect) =>
    own.find((r) => r.effect === effect && everything.some((p) => fits(r.pattern, p, false)))

  const denied = first("deny")
  if (denied) return { verdict: "deny", reason: `a deny rule: ${denied.pattern}` }
  if (action.never !== undefined) return held(action.never)
  // A typed line goes to a program that may be a shell anywhere, a remote one at its home most likely.
  const cwd = action.kind === "input" ? "~" : where.cwd
  // Outside the workspace sandbox, over ssh or mosh, or where the host marks credentials, they are reachable, so a
  // content read through an expansion asks; otherwise the sandbox keeps them out, and only a literal credential path
  // asks.
  const remote = action.kind === "input" && logsIn(readCommand(action.into ?? ""))
  const strict = where.profile === "ssh" || remote || (where.credentials ?? []).length > 0
  const credential = parts.map((p) => credentialOf(p, cwd, where.credentials, strict)).find((found) => found !== null)
  if (credential) return held(credential)
  const owner = parts.map((p) => ownerOnly(p, read.unreadable === null)).find((found) => found !== null)
  if (owner) return held(owner)
  const asked = first("ask")
  if (asked) return held(`an ask rule: ${asked.pattern}`)

  const allows = own.filter((r) => r.effect === "allow")
  const moves = parts.some((p) => MOVES.has(programOf(p)[0] ?? ""))
  const cover = (part: SimpleCommand): string | null => {
    const { readOnly, risk } = classify(part)
    if (allows.some((r) => (risk === null || !wild(r.pattern)) && fits(r.pattern, part, true))) return BY_RULE
    if (mode === "ask") return null
    if (readOnly) return READ_ONLY
    if (mode === "default") return null
    if (pushOf(part)?.asks === null) return PUSH
    return action.kind === "command" && !moves && fileOp(part, where) ? FILE_OP : null
  }
  const covers = read.unreadable === null ? parts.map(cover) : null
  if (covers?.every((by) => by === BY_RULE)) return { verdict: "allow", by: BY_RULE }
  if (action.kind === "input" && mode !== "ask" && PROMPT_ANSWER.test(action.text))
    return { verdict: "allow", by: ANSWER }
  if (covers?.every((by) => by !== null)) return { verdict: "allow", by: WIDEST.find((by) => covers.includes(by))! }

  const uncovered = covers ? parts.filter((_, i) => covers[i] === null) : []
  const offers = [...new Set(uncovered.flatMap((p) => {
    const offer = suggest(p, action.kind)
    return fits(offer, p, true) ? [offer] : []
  }))]
  if (mode === "ask") return { verdict: "ask", reason: "Ask mode", rules: offers }
  if (mode === "default") {
    const why = read.unreadable ?? uncovered.map((p) => classify(p).risk).find((risk) => risk !== null)
    const unknown = uncovered[0] ? (programOf(uncovered[0])[0] ?? written(uncovered[0]).join(" ")) : ""
    const reason = why ? `Default mode asks: ${why}` : `Default mode asks before what it doesn't know: ${unknown}`
    return { verdict: "ask", reason, rules: offers }
  }
  if (action.partial) return held("Auto asks: the line isn't finished", offers)
  return { verdict: "check", rules: offers }
}

/** What an approval card holds: the action as it would run, the tool and arguments that run it, the agent's own
 *  reason (untrusted), why policy asks, and the allow rules "don't ask again" may add (none: it may add none).
 *  `partial` and `into` are the action's, so the card alone can be decided again, after a new rule or a restart. */
export interface ApprovalCard {
  readonly kind: Action["kind"]
  readonly tool: string
  readonly action: string
  readonly args: Readonly<Record<string, unknown>>
  readonly why: string
  readonly reason: string
  readonly rules: readonly string[]
  readonly partial: boolean
  readonly into: string | null
}

/** A session's permissions as its host binds them; the model sets none of them. */
export interface Permissions {
  mode(): Mode
  /** The session's rules, the agent's and the company's, in any order: deny wins, then ask, then allow. */
  rules(): readonly Rule[]
  /** Where the gated tool's shell runs. */
  where(): Where
  /** Holds yian call `callId` on an approval card for the session's approver and returns what the call returns
   *  now: yian's `pending()` while the card is open. The host runs the action itself once the approver says Yes
   *  and completes the call with its result; No completes it with the approver's words. */
  hold(card: ApprovalCard, callId: string): unknown
  /** Auto's check, as the host binds it; absent, what it would judge asks. Rejects when `signal` aborts, or when the
   *  check can't record its verdict; the gate then asks. */
  check?(input: CheckInput, signal: AbortSignal): Promise<Verdict>
  /** Why every action asks now, as a never-automated one does (a rules file that doesn't load), or null. */
  blocked?(): string | null
}

/** What a gated tool does before it acts: run now, saying `by` what (for its record), or return `result` as the
 *  call's result (a refusal, or what the card `held` on returns: its `pending()`). */
export type Gate =
  | { readonly run: true; readonly by: string }
  | { readonly run: false; readonly result: unknown; readonly held?: ApprovalCard }

/** What a call returns when it would ask in a session that doesn't (`dontAsk`), for `reason`. */
export function dontAskRefusal(reason: string): string {
  return `Not run: ${DONT_ASK}${reason}.`
}

export async function gate(
  perms: Permissions,
  action: Action,
  call: {
    tool: string
    why: string
    args: Readonly<Record<string, unknown>>
    callId: string | undefined
    signal: AbortSignal
  },
): Promise<Gate> {
  const mode = perms.mode()
  const where = perms.where()
  const never = action.never ?? perms.blocked?.() ?? undefined
  const decision = decide(never === undefined ? action : { ...action, never }, mode, perms.rules(), where)
  if (decision.verdict === "allow") return { run: true, by: decision.by }
  if (decision.verdict === "deny") return { run: false, result: `Not run: ${decision.reason}.` }
  let asked: { reason: string; rules: readonly string[] } =
    decision.verdict === "ask" ? decision : { reason: "", rules: decision.rules }
  if (decision.verdict === "check") {
    const verdict = await judged(perms, checkInput(action, where), call.signal)
    if (call.signal.aborted) return { run: false, result: "Not run: stopped before Auto's check finished." }
    if (verdict.verdict === "run" && !verdict.failed) return { run: true, by: `Auto's check: ${verdict.reason}` }
    const reason = verdict.failed
      ? `Auto asks: its check couldn't judge this: ${verdict.reason}`
      : `Auto's check: ${verdict.reason}`
    asked = { reason, rules: decision.rules }
  }
  // Read again: the session may have switched to dontAsk while the check ran, and nobody would answer its card.
  if (perms.mode() === "dontAsk") return { run: false, result: dontAskRefusal(asked.reason) }
  if (call.callId === undefined)
    return { run: false, result: "Not run: this call can't wait for the owner's approval." }
  const card: ApprovalCard = {
    kind: action.kind, tool: call.tool, action: action.text, args: call.args, why: call.why, reason: asked.reason,
    rules: asked.rules, partial: action.partial ?? false, into: action.into ?? null,
  }
  return { run: false, result: perms.hold(card, call.callId), held: card }
}

/** A session's own rules, kept in memory for as long as the session's host runs. */
export class RuleBook {
  private readonly rules: Rule[] = []

  list(): readonly Rule[] {
    return [...this.rules]
  }

  add(rule: Rule): void {
    if (this.index(rule) < 0) this.rules.push({ effect: rule.effect, kind: rule.kind, pattern: rule.pattern })
  }

  remove(rule: Rule): boolean {
    const i = this.index(rule)
    if (i < 0) return false
    this.rules.splice(i, 1)
    return true
  }

  private index(rule: Rule): number {
    return this.rules.findIndex((r) => r.effect === rule.effect && r.kind === rule.kind && r.pattern === rule.pattern)
  }
}

/** A part's words as written: its assignments, its words, then `>file` for each file it writes. */
function written(part: SimpleCommand): string[] {
  return [...part.assignments, ...part.words, ...part.writes.map((w) => `>${w}`)]
}

/** Whether a rule's pattern matches `part`: as written, or as its program past wrappers when it sets no variables.
 *  An allow rule (`strict`) must match the files it writes too; a deny or ask rule may match without them, and
 *  matches a program named by its path by the path's last name too (`/bin/rm` as `rm`). */
function fits(pattern: string, part: SimpleCommand, strict: boolean): boolean {
  const program = [...programOf(part)]
  const writes = part.writes.map((w) => `>${w}`)
  const shapes = [written(part)]
  if (assignmentsOf(part).length === 0) shapes.push([...program, ...writes])
  if (!strict) {
    const [prog = "", ...args] = program
    shapes.push([...part.assignments, ...part.words], program, [prog.slice(prog.lastIndexOf("/") + 1), ...args])
  }
  return shapes.some((words) => matches(pattern, words))
}

function wild(pattern: string): boolean {
  return pattern === "*" || pattern.endsWith(" *")
}

/** The program and its subcommand, when it has one; null when a subcommand program names none plainly. */
function prefix(words: readonly string[]): string[] | null {
  const [program, sub] = words
  if (program === undefined) return null
  if (!SUBCOMMANDS.has(program)) return [program]
  return sub !== undefined && !sub.startsWith("-") ? [program, sub] : null
}

/** A part and the commands it runs that the reader doesn't list (under `sudo`, `find -exec` or ssh), so deny and
 *  ask rules see them. */
function withInner(part: SimpleCommand): SimpleCommand[] {
  return [part, ...innerParts(part).flatMap(withInner)]
}

function checkInput(action: Action, where: Where): CheckInput {
  const on = action.kind === "input" ? (action.into ?? "") : action.text
  return {
    kind: action.kind, command: action.text, profile: where.profile, cwd: where.cwd,
    host: sshHosts(readCommand(on)).join(", "),
  }
}

/** The gate's half of the fail-safe: Auto's check's answer, or an `ask` saying why it couldn't judge. Never
 *  rejects. */
async function judged(perms: Permissions, input: CheckInput, signal: AbortSignal): Promise<Verdict> {
  if (!perms.check) return { verdict: "ask", reason: "no check is bound here", failed: true }
  let answer: unknown
  try {
    answer = await perms.check(input, signal)
  } catch {
    return { verdict: "ask", reason: "it failed", failed: true }
  }
  const shaped = typeof answer === "object" && answer !== null &&
    ((answer as Verdict).verdict === "run" || (answer as Verdict).verdict === "ask") &&
    typeof (answer as Verdict).reason === "string"
  if (!shaped) return { verdict: "ask", reason: "it gave no verdict", failed: true }
  const verdict = answer as Verdict
  const failed = verdict.failed === true ? { failed: true } : {}
  return { verdict: verdict.verdict, reason: oneLine(verdict.reason), ...failed }
}

/** `text` as one line: control characters and line breaks become spaces, runs of spaces one, cut to
 *  `REASON_CHARS` with `…`. */
function oneLine(text: string): string {
  const flat = text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").replace(/ +/g, " ").trim()
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat
}
