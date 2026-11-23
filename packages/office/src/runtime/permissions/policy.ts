/**
 * Who may do what without asking: a session's mode and rules decide each command an agent runs and each line it
 * types, before it acts, and hand what they don't cover in `auto` and `dontAsk` to Auto's check. It needs no
 * office: the host's gate (`gate.ts`) binds the mode, the rules, where the shell runs and the check, and holds what
 * asks.
 *
 * The reader (`commands.ts`) can promise that a command line runs without Auto's check or a card only when every
 * part of it is covered: by an allow rule; by a form it knows to be read-only (`auto`, `default`, `dontAsk`); by a
 * plain push of a feature branch (`auto`, `dontAsk`); or, inside the workspace sandbox, by a file operation on
 * paths inside the workspace (`auto`, `dontAsk`). A deny rule refuses what it matches wherever the reader sees it:
 * inside substitutions, `sh -c` strings, `sudo`, `find -exec` and ssh's remote command too. A literal `sh -c` or
 * `eval` string it reads whole is judged as the commands it holds, and a `for` or `case` list is data. A finished
 * typed line may be a command wherever it goes, so command deny rules refuse it as well as input ones. Where the reader
 * can't see, while any deny rule that applies to the line is in force (the company's `rules.yaml` or the agent's), a
 * line it can't fully read (a substitution, `eval` or `sh -c` of a variable, an unclosed quote, `[[`, or anything else
 * it marks unreadable) asks in every mode and `dontAsk` refuses it, saying so; Auto's check never judges it, since a
 * denied command could hide there. With no deny rule in force, such a line is decided as any uncovered one is. The
 * reader reads no line over 1000 bytes: a typed one is refused, and a command asks in every mode (`dontAsk` refuses
 * it), as too long to check, deny rules or not; no rule covers it and Auto's check never judges it.
 * The reader asks, in every mode, before a command that names a credential path anywhere in the line (an operand,
 * an option's value, an assignment, a `for` list, a here-string or a redirect), one the host marks
 * (`Where.credentials`), or a folder that holds them. Where credentials are reachable (the SSH-only profile, a
 * profile the host marks credentials on, an ssh remote command, and a line typed into ssh or mosh), it also asks
 * before a program that reads file contents is given a path through an expansion, whose value it can't see; in the
 * workspace sandbox, which keeps the home out, such a read follows the usual rules and the sandbox is the guard.
 * Auto's check never judges a push, `sudo` or a local command for ssh.
 * While the host says the session is blocked (`CallPolicy.blocked`, a rules file that doesn't load), every action
 * asks as a never-automated one does, and `dontAsk` refuses it; deny rules still refuse first.
 *
 * Relative paths start from the shell's folder, which the host gives (`Where.cwd`, null when it can't know it), and
 * from each folder an earlier `cd`, `pushd` or `popd` in the line may have moved to. Where credentials are reachable,
 * a content or recursive read of a relative path asks while that folder can't be known (`cd "$d"`, `cd -`).
 *
 * The reader can't know what a program does with its files, its config or its input: `git` runs hooks and programs
 * its config names (`core.fsmonitor`, `core.pager`, `diff.external`); a script does what it contains; a remote host
 * has its own rc files and `PATH`; `~/.ssh/config` can name a `ProxyCommand` for a host. In a persistent shell,
 * earlier lines can define functions, aliases, a `PATH` or a `CDPATH` that change what a read-only line runs or
 * where it runs. No rule sees into a variable's value or a script file, readable line or not, nor into what a
 * program it doesn't know runs from its arguments (`setsid`, `srun`, `flock`) or its code (`python -c`, `awk`): the
 * line reads as that program, so a deny rule doesn't match what it runs and the line isn't marked unreadable. It can't
 * stop a read-only program from reading what the sandbox lets it read; the model then sees it.
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
  assignmentsOf, classify, EMPTY, fileOp, innerParts, lineCredential, logsIn, ownerOnly, passesThrough, pathChange,
  programOf, pushOf, readCommand, remoteOf, type SimpleCommand, sshHosts, sshOf, type Where,
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
/** A rule on commands (`command`), typed lines (`input`) or tool calls (`tool`, by `toolWords`); `decide` reads
 *  only the first two. */
export interface Rule {
  readonly effect: Effect
  readonly kind: Action["kind"] | "tool"
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

/** What Auto's check is told: the command or typed line, the shell's profile, its folder ("" when unknown), and the
 *  ssh host it runs on ("" for this machine); or, for a tool call (`kind: "tool"`, `profile: "none"`, no folder or
 *  host), its words and its arguments as JSON. Never the agent's own reason. */
export interface CheckInput {
  readonly kind: Action["kind"] | "tool"
  readonly command: string
  readonly profile: Where["profile"] | "none"
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
/** Why a line the reader can't read asks while a deny rule of its kind is in force, before why it can't read it. */
const UNCHECKED = "deny rules are in force and it can't be read to check them: "
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
  const into = action.kind === "input" ? readCommand(action.into ?? "") : null
  // A finished typed line may run as a command wherever it goes (a shell, a login, a launcher the reader doesn't
  // know), so command deny rules refuse it too.
  const finished = action.kind === "input" && !action.partial
  const own = rules.filter((r) => r.kind === action.kind || (finished && r.effect === "deny" && r.kind === "command"))
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
  const remote = into !== null && logsIn(into)
  const strict = where.profile === "ssh" || remote || (where.credentials ?? []).length > 0
  const credential = lineCredential(parts, cwd, where.credentials, strict)
  if (credential) return held(credential)
  const owner = parts.map((p) => ownerOnly(p, read.unreadable === null)).find((found) => found !== null)
  if (owner) return held(owner)
  // Where an ssh wrapper comes first on PATH (the SSH-only profile, and shells with no sandbox), a PATH change could
  // skip it for this line or the shell's later ones.
  const path = where.profile === "ssh" ? parts.map(pathChange).find((found) => found !== null) : undefined
  if (path) return held(path)
  const asked = first("ask")
  if (asked) return held(`an ask rule: ${asked.pattern}`)
  // A deny rule can't be matched against the commands the reader couldn't see, so no check may judge such a line.
  if (read.unreadable !== null && own.some((r) => r.effect === "deny")) return held(UNCHECKED + read.unreadable)

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
  // A part another part's commands stand for (an `sh -c` read through, a `for` list) isn't judged on its own.
  const judged = parts.filter((p) => !passesThrough(p))
  if (judged.length === 0) judged.push(EMPTY)
  const covers = read.unreadable === null ? judged.map(cover) : null
  if (covers?.every((by) => by === BY_RULE)) return { verdict: "allow", by: BY_RULE }
  if (action.kind === "input" && mode !== "ask" && PROMPT_ANSWER.test(action.text))
    return { verdict: "allow", by: ANSWER }
  if (covers?.every((by) => by !== null)) return { verdict: "allow", by: WIDEST.find((by) => covers.includes(by))! }

  const uncovered = covers ? judged.filter((_, i) => covers[i] === null) : []
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

/** The state a command or typed line was decided on, which the call checks again before it acts: the shell's folder
 *  for a command, the line and the command it is typed into for typed text. */
export type Basis = { readonly cwd: string | null } | { readonly line: string; readonly into: string | null }

/** What the session's gate decided for a terminal call before it started (yian's `beforeToolCall`): what lets it run,
 *  for its audit row (`by read-only`, `approved by @<who>`), the state it was decided on, whether its approver said
 *  Yes on a card, and what it decided: the tool, the command or whole typed line, whether that line ends without
 *  Enter, and the shell it runs in (null for a new one). The call acts only if it is exactly that. */
export interface Decided {
  readonly why: string
  readonly basis: Basis
  readonly approved: boolean
  readonly tool: "terminal_run" | "terminal_type"
  readonly text: string
  readonly partial: boolean
  readonly shell: string | null
}

/** A session's permissions as its host binds them; the model sets none of them. Its gate (yian's `beforeToolCall`)
 *  decides each terminal call before it starts, and the call acts only on what it decided. */
export interface Permissions {
  mode(): Mode
  /** The session's rules, the agent's and the company's, in any order: deny wins, then ask, then allow. */
  rules(): readonly Rule[]
  /** Where the gated tool's shell runs. */
  where(): Where
  /** What the session's gate decided for call `callId`, taken once by the call that acts on it, or null when it
   *  decided nothing. */
  decided(callId: string | undefined): Decided | null
}

/** What a call returns when it would ask in a session that doesn't (`dontAsk`), for `reason`. */
export function dontAskRefusal(reason: string): string {
  return `Not run: ${DONT_ASK}${reason}.`
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

/** What Auto's check is told of `action`, run `where`. */
export function checkInput(action: Action, where: Where): CheckInput {
  const on = action.kind === "input" ? (action.into ?? "") : action.text
  return {
    kind: action.kind, command: action.text, profile: where.profile, cwd: where.cwd ?? "",
    host: sshHosts(readCommand(on)).join(", "),
  }
}

/** The gate's half of the fail-safe: Auto's check's answer on `input`, or an `ask` saying why it couldn't judge (no
 *  `check`, one that throws, or an answer out of shape), its reason one line. Never rejects. */
export async function judged(
  check: ((input: CheckInput, signal: AbortSignal) => Promise<Verdict>) | undefined,
  input: CheckInput,
  signal: AbortSignal,
): Promise<Verdict> {
  if (!check) return { verdict: "ask", reason: "no check is bound here", failed: true }
  let answer: unknown
  try {
    answer = await check(input, signal)
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
