/** A scripted stand-in for Claude Code's CLI in tests, `claude --input-format stream-json --output-format
 *  stream-json`, run through a sh shim with the tests' Bun: a program, so it serves a driver that runs `claude` itself
 *  and the SDK's `pathToClaudeCodeExecutable` alike. It never touches a real `claude`, its config or the network: its
 *  state is the folder `installFakeClaude` is given.
 *
 *  Every line it writes has the keys of a line real Claude Code wrote (`tests/fixtures/claude/stream.jsonl`, from the
 *  upstream TUI's recordings, 2.1.301 to 2.1.309), except where "unrecorded" says no recording holds it. What it
 *  doesn't model at all it doesn't guess: it exits `FAKE_CLAUDE_UNMODELLED`, saying "not modelled: …" on stderr and
 *  in the log, so no test passes by relying on a guess.
 *
 *  What it guesses, from Claude Code's docs, to re-record in O5: the read-only commands (the docs' list; a real one
 *  has more, so a command the fake refuses may run unasked for real); the protected paths (`.git` and `.claude`);
 *  which Bash commands a `Read` or `Edit` rule reaches (redirects, `cat`, `head`, `tail`, `tee`, `sed` and the file
 *  operations); `permissions.additionalDirectories`, and a JSON `--settings`' `/` rules, anchored at the working
 *  folder; and the refusals' text and meta.
 *
 *  - **Start.** `--version` prints the version. Any other run needs `--input-format stream-json --output-format
 *    stream-json`, else it exits 2. It reads `--session-id`, `--resume`, `--permission-mode`,
 *    `--permission-prompt-tool`, `--model`, `--settings` (JSON, or a JSON file), `--setting-sources`,
 *    `--allowedTools`, `--disallowedTools`, `--add-dir` and `--append-system-prompt`, as `--flag v` or `--flag=v`, and
 *    the bare `--strict-mcp-config`, `--verbose` and `--dangerously-skip-permissions`; it ignores the rest. With the
 *    script's `sandbox_unavailable`, settings that enable the sandbox with `failIfUnavailable` stop the start: exit 1
 *    and a stderr line (its wording unrecorded); without `failIfUnavailable` it goes on unsandboxed, as Claude Code
 *    does.
 *  - **`initialize`** is answered with the version, models, `commands: []`, the permission mode, the pid and the
 *    account, `{tokenSource: "none", apiProvider: "firstParty"}` when the script is `signed_out`; `hooks_applied`
 *    when the request registers hooks, which may be `PreToolUse` and `PostToolUse` only.
 *  - **A turn.** A `user` line, when no turn runs, starts one: `session_state_changed` running, the line's
 *    `command_lifecycle` queued and started (a line with no `uuid` gets none), `system`/`init`, the script's next turn
 *    of steps, then `completed` for the lines that joined, the `result`, `completed` for the first line, and idle. A
 *    line with `priority: "next"` during a turn joins it at the next step (`started` then); any other waits for the
 *    turn to end (unrecorded), each `queued` at once. Steps:
 *    - `{"say": text}` writes an assistant text; the last is the result's `result`;
 *    - `{"tool": name, "input", "result"?, "is_error"?}` writes the `tool_use`, asks as below, runs it, gives each
 *      `PostToolUse` hook the host registered a `hook_callback` unless it failed (an answer other than `{}` isn't
 *      modelled), then writes the `tool_result`. A `Bash` with no `result` runs its `command` for real under
 *      `/bin/sh -c` in the fake's folder, not sandboxed, in a process group that ends with the step, so nothing it
 *      starts outlives it; its result is the output, stdout then stderr, with "Exit code N" first when it fails (the
 *      text and `tool_use_result`'s fields unrecorded). Another tool with no `result` returns "";
 *    - `{"sleep": seconds}`; `{"fail": text, "status"?}` ends the turn with an API error as recorded;
 *      `{"exit": code}` exits at once.
 *  - **How it asks before a tool,** in the order Claude Code's docs give (all unrecorded, from the docs; O5
 *    re-records it):
 *    1. each `PreToolUse` hook whose `matcher` takes the tool gets a `hook_callback`; a `deny` refuses, and an
 *       `allow` or `ask` still meets the rules;
 *    2. the deny rules, from `--disallowedTools` and the settings' `permissions.deny`: in every mode;
 *    3. the ask rules, `permissions.ask`, ask even in `bypassPermissions`; a bare `Bash` one gives way to the sandbox;
 *    4. the sandbox's auto-allow runs `Bash` in every mode: the sandbox enabled and up, `autoAllowBashIfSandboxed` on
 *       (unset, on before 2.1.325), and the call kept in the sandbox (not `excludedCommands`, not a
 *       `dangerouslyDisableSandbox` retry unless `allowUnsandboxedCommands` is false, not behind an assignment, `eval`
 *       or `make VAR=…`); `bypassPermissions` runs anything; `acceptEdits` runs edits, and `mkdir`, `touch`, `rm`,
 *       `rmdir`, `mv` and `cp`, on paths inside the working folders (the fake's, `--add-dir`'s and
 *       `permissions.additionalDirectories`), not `.git` or `.claude`, and not a `touch` with an option or a glob;
 *    5. the allow rules, from `--allowedTools` and `permissions.allow`, and what needs no approval: a read (`Read`,
 *       `Glob`, `Grep`, `LS`) inside the working folders, and the docs' read-only commands (`ls`, `cat`, `echo`, …,
 *       `git status`); a compound command runs when each of its commands does, and a redirect's file is checked as a
 *       write or a read;
 *    6. else, unless the mode is `dontAsk`, with `--permission-prompt-tool stdio` the host gets `can_use_tool` and
 *       answers `{behavior: "allow", updatedInput?}` or `{behavior: "deny", message}`; anything else is refused, as
 *       a headless Claude Code with no way to ask.
 *
 *    `blockReadsOutsideWorkingDirectories` and `blockWritesOutsideWorkingDirectories` refuse a file tool's path
 *    outside the working folders in every mode. Rules are `Tool`, `Tool(*)`, tool-name globs, `Bash(pattern)` with
 *    `*` and `:*`, and `Read(path)` and `Edit(path)` with the `//`, `~/`, `/` and relative anchors and `*`, `**` and
 *    `?`; a refusal is an error `tool_result` and a `permission_denials` entry (its text and meta unrecorded). Not
 *    modelled: the `plan` and `auto` modes, other rule forms, negated or bracketed paths, a hook's `defer`,
 *    `decision` or `continue`, a `can_use_tool` answer's `interrupt` or `updatedPermissions`, `sed` under
 *    `acceptEdits`, the removal of a critical path, a command behind a wrapper where a rule or the read-only set must
 *    judge it, and a command the fake can't parse (substitutions, subshells, groups, here-docs, control flow) where it
 *    must judge it.
 *  - **Interrupts.** Mid-turn, `interrupt` is answered `{still_queued}`, then `[Request interrupted by user]` and an
 *    `error_during_execution` result; while a tool waits on the host or runs, that tool's `tool_result` is rejected
 *    and `[Request interrupted by user for tool use]` follows. The turn's lines are `cancelled`. `still_queued` lists
 *    the uuids of the lines still waiting, which run next (unrecorded: the recordings had none). With no turn the
 *    answer comes at once. `set_permission_mode` gets a plain success (unrecorded; shaped as `apply_flag_settings`'
 *    recorded answer); any other control request gets an error (unrecorded).
 *  - **Sessions.** Each session's lines are kept in `<state>/sessions/<id>.jsonl`. `--resume <id>` goes on with the
 *    script's turn after the session's last; an unknown id exits 1 (its wording unrecorded).
 *  - **The log.** `<state>/log.jsonl` holds each run's start (argv, cwd, env, the flags read, settings whole) and
 *    every line in and out. Stdin's end exits 0 at once, and SIGTERM 143, each ending the running command's group.
 *    A SIGKILL can't be caught, so a fake killed that way leaves its running Bash group behind: stop it by closing
 *    stdin or with SIGTERM, never with SIGKILL first.
 *
 *  It writes no `status`, `rate_limit_event`, `stream_event` or `thinking_tokens` lines, which real Claude Code
 *  writes too; a driver ignores them. */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { CHECKOUT_FLAGS, selfCommand } from "../platform.ts"

/** A JSON object from a script or the wire: `any`, since its shape is whatever the script or the host sent. */
type Obj = Record<string, any>

export type FakeClaudeStep =
  | { say: string }
  | { tool: string; input?: Obj; result?: string; is_error?: boolean }
  | { sleep: number }
  | { fail: string; status?: number }
  | { exit: number }

export interface FakeClaudeScript {
  /** Each turn takes the next list of steps; a turn past the end writes only its result. */
  turns?: FakeClaudeStep[][]
  /** What `--version` and `initialize` report; 2.1.319 by default. */
  version?: string
  signed_out?: boolean
  /** `initialize`'s models; `--model` takes a `value` as an alias of its `resolvedModel`. */
  models?: Obj[]
  /** The sandbox can't start here: settings that enable it with `failIfUnavailable` stop the start. */
  sandbox_unavailable?: boolean
}

/** How the fake exits on what it doesn't model, having said what on stderr and in the log. */
export const FAKE_CLAUDE_UNMODELLED = 3

export interface FakeClaudeLogEntry {
  pid: number
  dir: "start" | "in" | "out" | "unmodelled"
  /** What it doesn't model, when it exits on it. */
  what?: string
  /** A start's argv, folder, environment, and the flags it read by name (`settings` parsed). */
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
  flags?: Obj
  /** A line read or written. */
  msg?: Obj
}

export interface FakeClaude {
  /** The folder holding `claude`, to put first on PATH. */
  readonly bin: string
  readonly claude: string
  /** script.json, log.jsonl, sessions/. */
  readonly state: string
  /** Replaces the script; each later run reads it. */
  set(script: FakeClaudeScript): void
  log(): FakeClaudeLogEntry[]
  /** Each session's kept lines, by id. */
  sessions(): Record<string, Obj[]>
}

const SELF = fileURLToPath(import.meta.url)
/** This Bun, as the office runs its own code in a checkout, where every test runs. */
const BUN = selfCommand()[0]
const NO_CACHE = "BUN_RUNTIME_TRANSPILER_CACHE_PATH"

/** Installs `<dir>/bin/claude`, with its state in `<dir>/state`. */
export function installFakeClaude(dir: string, script: FakeClaudeScript = {}): FakeClaude {
  const bin = path.join(dir, "bin")
  const state = path.join(dir, "state")
  const claude = path.join(bin, "claude")
  for (const p of [BUN, SELF, state]) if (p.includes("'")) throw new Error(`the fake claude's shim can't quote ${p}`)
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(state, "sessions"), { recursive: true })
  // Paths baked in: the host gives `claude` no test variables. No transpiler cache, which Bun keeps under HOME.
  const shim = `#!/bin/sh\n${NO_CACHE}=0 exec '${BUN}' ${CHECKOUT_FLAGS.join(" ")} '${SELF}' '${state}' "$@"\n`
  fs.writeFileSync(claude, shim, { mode: 0o700 })
  const set = (s: FakeClaudeScript) => fs.writeFileSync(path.join(state, "script.json"), JSON.stringify(s))
  set(script)
  const sessions = path.join(state, "sessions")
  return {
    bin,
    claude,
    state,
    set,
    log: () => readLines(path.join(state, "log.jsonl")) as FakeClaudeLogEntry[],
    sessions: () =>
      Object.fromEntries(
        fs
          .readdirSync(sessions)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => [name.slice(0, -".jsonl".length), readLines(path.join(sessions, name))]),
      ),
  }
}

function readLines(file: string): Obj[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Obj)
}

const VERSION = "2.1.319"
const VALUED = new Set([
  "session-id",
  "resume",
  "permission-mode",
  "permission-prompt-tool",
  "model",
  "settings",
  "setting-sources",
  "allowedTools",
  "disallowedTools",
  "add-dir",
  "append-system-prompt",
  "input-format",
  "output-format",
])
const BARE = new Set(["strict-mcp-config", "verbose", "dangerously-skip-permissions"])
const REPEATED = new Set(["allowedTools", "disallowedTools", "add-dir"])

/** The flags the fake reads, by name; `allowedTools`, `disallowedTools` and `add-dir` as lists of the values given. */
function parseFlags(argv: readonly string[]): Obj {
  const flags: Obj = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    const name = arg.slice(2, eq < 0 ? undefined : eq)
    if (BARE.has(name)) flags[name] = true
    if (!VALUED.has(name)) continue
    const value = eq < 0 ? (argv[++i] ?? "") : arg.slice(eq + 1)
    flags[name] = REPEATED.has(name) ? [...(flags[name] ?? []), value] : value
  }
  return flags
}

/** `--settings` as Claude Code takes it: a JSON object, or a JSON file's path; null when it's neither. */
function readSettings(value: string, cwd: string): Obj | null {
  try {
    const text = value.trimStart().startsWith("{") ? value : fs.readFileSync(path.resolve(cwd, value), "utf8")
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Obj) : null
  } catch {
    return null
  }
}

/** The models of a recorded `initialize`, shortened. */
const MODELS: Obj[] = [
  ["default", "claude-opus-5-5", "Default (recommended)", "Use the default model (currently Opus 5.5)"],
  ["opus", "claude-opus-5-5", "Opus", "Opus 5.5 · Best for everyday, complex tasks"],
  ["sonnet", "claude-sonnet-5-5", "Sonnet", "Sonnet 5.5 · Efficient for routine tasks"],
  ["haiku", "claude-haiku-5-5", "Haiku", "Haiku 5.5 · Fastest for quick answers"],
].map(([value, resolvedModel, displayName, description]) => ({
  value,
  resolvedModel,
  displayName,
  description,
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  supportsAdaptiveThinking: true,
  supportsAutoMode: true,
  supportsThinkingOff: false,
}))
const SIGNED_IN = {
  email: "user@example.com",
  organization: "Example Org",
  subscriptionType: "Claude Team",
  apiProvider: "firstParty",
}
const SIGNED_OUT = { tokenSource: "none", apiProvider: "firstParty" }
const TOOLS = ["Bash", "Edit", "Glob", "Grep", "Read", "Write"]
const READS = new Set(["Read", "Glob", "Grep", "LS"])
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse"])
const INIT_CAPABILITIES = ["interrupt_receipt_v1", "msg_lifecycle_v1", "ui_surface_v1"]
const MESSAGE_USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: 0,
  service_tier: "standard",
  inference_geo: "global",
  speed: "standard",
}
const ERROR_USAGE = {
  output_tokens_details: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: null,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: null,
  iterations: null,
  speed: null,
  fallback_credit: null,
}
const USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "global",
  iterations: [],
  speed: "standard",
  fallback_credit: null,
}
const SUBAGENT_STATS = {
  spawned: 0,
  requested: { background: 0, foreground: 0, unset: 0 },
  started_in_background: 0,
  max_depth: 0,
  spawned_by_subagents: 0,
  completed: 0,
  failed: 0,
  killed: { parent: 0, user: 0, system: 0 },
  refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
  by_type: {},
}
/** The recorded tool results' decision, for every tool the fake lets run; what a hook's, a prompt's or a mode's allow
 *  writes there is unrecorded. */
const ALLOWED = { permission_decision: { decision: "accept", source: "config", reason_type: "rule" } }
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the " +
  "new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const denied = (tool: string) => `Permission to use ${tool} has been denied.`
const now = () => new Date().toISOString()
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v)

/** A hook matcher as Claude Code reads one: none or `*` takes every tool, else a pattern of tool names. */
function matches(matcher: unknown, tool: string): boolean {
  if (typeof matcher !== "string" || matcher === "" || matcher === "*") return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool)
  } catch {
    return matcher === tool
  }
}

type Verdict = { allow: true; input: Obj } | { allow: false; message: string; source: string }

/** Thrown for what the fake doesn't model, so that it exits saying what rather than guess and let a test pass on
 *  the guess. */
class Unmodelled extends Error {}
function unmodelled(what: string): never {
  throw new Unmodelled(what)
}

const MODES = new Set(["default", "acceptEdits", "bypassPermissions", "dontAsk"])
/** A permission mode, `manual` being `default`'s other name; `plan` and `auto` aren't modelled. */
function permissionMode(mode: unknown): string {
  const m = mode === "manual" ? "default" : mode
  if (typeof m !== "string" || !MODES.has(m)) unmodelled(`the permission mode ${String(mode)}`)
  return m
}

const below = (version: string, floor: string) => {
  const [a, b] = [version, floor].map((v) => v.split(".").map(Number)) as [number[], number[]]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** One command of a Bash call: its text as written, its words with quotes removed, the files it redirects output to
 *  and input from, and whether it has an unquoted glob. */
interface Simple {
  readonly text: string
  readonly words: string[]
  readonly outputs: string[]
  readonly inputs: string[]
  readonly glob: boolean
}

const CONTROL = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac"])

/** A Bash call split as Claude Code's docs say it splits one: at `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, with
 *  quotes honoured. Null for what the fake can't parse: substitutions, subshells, groups, here-docs, control flow, an
 *  operator with nothing after it, no command at all, and calls over 10,000 characters, which a real one always asks
 *  about. */
function parseCommand(command: string): Simple[] | null {
  if (command.length > 10_000) return null
  const subs: Simple[] = []
  let [words, outputs, inputs]: string[][] = [[], [], []]
  let [word, inWord, glob, dangling, start] = ["", false, false, false, 0]
  let target: "out" | "in" | null = null
  const endWord = () => {
    if (!inWord) return
    ;(target === "out" ? outputs : target === "in" ? inputs : words).push(word)
    ;[word, inWord, target] = ["", false, null]
  }
  // False when the command can't end here: a redirect with no file, or an operator with no command before it.
  const endCommand = (at: number, operator: boolean): boolean => {
    endWord()
    if (target !== null) return false
    if (words.length + outputs.length + inputs.length === 0) {
      if (operator) return false
    } else {
      if (CONTROL.has(words[0] ?? "") || words[0] === "function" || words[0] === "!") return false
      subs.push({ text: command.slice(start, at).trim(), words, outputs, inputs, glob })
      ;[words, outputs, inputs, glob] = [[], [], [], false]
      dangling = operator
    }
    return true
  }
  for (let i = 0; i < command.length; ) {
    const [c, next] = [command[i]!, command[i + 1]]
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close < 0) return null
      ;[word, inWord, i] = [word + command.slice(i + 1, close), true, close + 1]
    } else if (c === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!
        if (d === "`" || (d === "$" && "({".includes(command[j + 1] ?? "-"))) return null
        if (d === "\\" && '"\\$`'.includes(command[j + 1] ?? "-")) j++
        word += command[j]
      }
      if (j >= command.length) return null
      ;[inWord, i] = [true, j + 1]
    } else if (c === "\\") {
      if (next === undefined) return null
      if (next !== "\n") [word, inWord] = [word + next, true]
      i += 2
    } else if (c === "`" || "(){}".includes(c) || (c === "$" && "({".includes(next ?? "-"))) return null
    else if (c === " " || c === "\t") {
      endWord()
      i++
    } else if ((c === "&" && next === ">") || c === ">" || c === "<") {
      if (c === "<" && next === "<") return null
      // A descriptor's number before the operator, as in 2>, isn't a word.
      if (inWord && /^\d+$/.test(word)) [word, inWord] = ["", false]
      else endWord()
      let j = c === "&" ? i + 2 : i + 1
      if (command[j] === ">" || command[j] === "|" || (c === "<" && command[j] === ">")) j++
      if (command[j] === "&") {
        // A duplicated descriptor, as 2>&1 does, has no file behind it.
        for (j++; j < command.length && /[\d-]/.test(command[j]!); j++);
      } else target = c === "<" ? "in" : "out"
      i = j
    } else if ((c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&"))) {
      if (!endCommand(i, true)) return null
      i += 2
      start = i
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      if (!endCommand(i, c === "|")) return null
      start = ++i
    } else {
      if ("*?[".includes(c)) glob = true
      ;[word, inWord] = [word + c, true]
      i++
    }
  }
  return endCommand(command.length, false) && !dangling && subs.length > 0 ? subs : null
}

type RuleKind = "allow" | "ask" | "deny"
/** A permission rule, in the syntax Claude Code's docs give. */
interface Rule {
  readonly kind: RuleKind
  readonly text: string
  /** Whether it names the tool: a name, or a glob in a deny or ask rule. */
  readonly names: (tool: string) => boolean
  /** A `Bash(…)` rule's pattern over one command. */
  readonly bash?: RegExp
  /** A `Read(…)` or `Edit(…)` rule's pattern over absolute paths. */
  readonly path?: { readonly re: RegExp; readonly read: boolean }
  /** A path rule on a tool other than `Read` and `Edit`, which matches no call. */
  readonly inert?: true
}

/** The rules in a flag's value: separated by commas or spaces, parentheses kept whole. */
function splitRules(value: string): string[] {
  const rules: string[] = []
  let [rule, depth] = ["", 0]
  for (const c of value) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0
    if (depth === 0 && (c === "," || c === " ")) {
      if (rule.trim() !== "") rules.push(rule.trim())
      rule = ""
    } else rule += c
  }
  return rule.trim() === "" ? rules : [...rules, rule.trim()]
}

/** `Tool`, `Tool(*)`, `Bash(pattern)`, `Read(path)` or `Edit(path)`; a path rule anchors `/` at `anchor`. Other
 *  specifiers aren't modelled. */
function parseRule(text: string, kind: RuleKind, anchor: string, cwd: string, home: string | undefined): Rule {
  const m = /^([^()]+)(?:\(([\s\S]*)\))?$/.exec(text.trim())
  if (m === null) unmodelled(`the rule ${text}`)
  const [name, spec] = [m[1]!.trim(), m[2]]
  let names = (tool: string) => tool === name
  if (name.includes("*")) {
    // An allow rule takes a glob only after a literal mcp__<server>__, and approves nothing otherwise.
    const re = new RegExp(`^${name.split("*").map(escapeRe).join(".*")}$`)
    names = kind === "allow" && !/^mcp__[^*]+__/.test(name) ? () => false : (tool) => re.test(tool)
  }
  if (spec === undefined || spec === "*") return { kind, text, names }
  if (name === "Bash") return { kind, text, names, bash: bashPattern(spec) }
  if (name === "Read" || name === "Edit")
    return { kind, text, names, path: { re: pathPattern(spec, kind, anchor, cwd, home), read: name === "Read" } }
  if (["Write", "NotebookEdit", "MultiEdit", "Glob", "Grep"].includes(name)) return { kind, text, names, inert: true }
  return unmodelled(`the rule ${text}`)
}

/** A `Bash(…)` pattern: `*` is any text; a trailing ` *` or `:*`, the only `*`, also takes the bare command. */
function bashPattern(spec: string): RegExp {
  const s = spec.endsWith(":*") ? `${spec.slice(0, -2)} *` : spec
  const parts = s.split("*")
  if (parts.length === 2 && s.endsWith(" *")) return new RegExp(`^${escapeRe(s.slice(0, -2))}(?: [\\s\\S]*)?$`)
  return new RegExp(`^${parts.map(escapeRe).join("[\\s\\S]*")}$`)
}

/** A `Read(…)` or `Edit(…)` path over absolute paths: anchored at the root (`//`), the home (`~/`), the settings'
 *  folder (`/`) or the working folder; gitignore's `*`, `**` and `?`; a bare name at any depth, and so is a single
 *  folder's `name/**` in a deny or ask rule. Negations, brackets and braces aren't modelled. */
function pathPattern(spec: string, kind: RuleKind, anchor: string, cwd: string, home: string | undefined): RegExp {
  if (spec.startsWith("!") || spec.startsWith("///") || /[[\]{}]/.test(spec)) unmodelled(`the path pattern ${spec}`)
  let [base, rest, relative] = [cwd, spec.startsWith("./") ? spec.slice(2) : spec, true]
  if (spec.startsWith("//")) [base, rest, relative] = ["", spec.slice(2), false]
  else if (spec.startsWith("~/")) {
    if (home === undefined) unmodelled(`the path pattern ${spec} with no HOME`)
    ;[base, rest, relative] = [home, spec.slice(2), false]
  } else if (spec.startsWith("/")) [base, rest, relative] = [anchor, spec.slice(1), false]
  if (rest.endsWith("/")) rest += "**"
  if (!rest.includes("/") || (relative && kind !== "allow" && /^[^/*?]+\/\*\*$/.test(rest))) rest = `**/${rest}`
  let re = ""
  for (let i = 0; i < rest.length; ) {
    if (rest.startsWith("**/", i)) [re, i] = [re + "(?:.*/)?", i + 3]
    else if (rest.startsWith("**", i)) [re, i] = [re + ".*", i + 2]
    else if (rest[i] === "*" || rest[i] === "?") [re, i] = [re + (rest[i] === "*" ? "[^/]*" : "[^/]"), i + 1]
    else [re, i] = [re + escapeRe(rest[i]!), i + 1]
  }
  return new RegExp(`^${escapeRe(base.replace(/\/+$/, ""))}/${re}$`)
}

const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "xargs"])
// The ones the docs name; a real one has more.
const READ_ONLY = new Set("ls cat echo pwd head tail grep find wc which diff stat du".split(" "))
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show"])
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from)$/
const FILE_OPS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp"])
const PROTECTED = new Set([".git", ".claude"])

/** Whether a tool runs without asking, as Claude Code's docs describe it (all unrecorded; O5 re-records it): the
 *  working folders, the rules of the flags and the settings, the sandbox's auto-allow, and the mode. */
class Policy {
  readonly dirs: string[]
  readonly rules: Rule[]
  readonly permissions: Obj
  readonly sandbox: Obj

  constructor(
    readonly cwd: string,
    flags: Obj,
    settings: Obj | null,
    settingsDir: string,
    readonly home: string | undefined,
    readonly version: string,
    readonly sandboxUp: boolean,
  ) {
    this.permissions = isObj(settings?.permissions) ? settings.permissions : {}
    this.sandbox = isObj(settings?.sandbox) ? settings.sandbox : {}
    const more = [...strings(flags["add-dir"]), ...strings(this.permissions.additionalDirectories)]
    this.dirs = [cwd, ...more.map((dir) => path.resolve(cwd, dir))]
    const rule = (kind: RuleKind, anchor: string) => (text: string) => parseRule(text, kind, anchor, cwd, home)
    this.rules = [
      ...strings(flags.allowedTools).flatMap(splitRules).map(rule("allow", cwd)),
      ...strings(flags.disallowedTools).flatMap(splitRules).map(rule("deny", cwd)),
      ...(["allow", "ask", "deny"] as const).flatMap((kind) =>
        strings(this.permissions[kind]).map(rule(kind, settingsDir)),
      ),
    ]
  }

  abs(p: string): string {
    return path.resolve(this.cwd, p)
  }

  inside(p: string): boolean {
    const abs = this.abs(p)
    return this.dirs.some((dir) => abs === dir || abs.startsWith(dir + path.sep))
  }

  /** Inside the working folders and outside the protected paths, `.git` and `.claude`. */
  editable(p: string): boolean {
    return this.inside(p) && !this.abs(p).split(path.sep).some((part) => PROTECTED.has(part))
  }

  /** The root, the home, a working folder or a folder above one: removing it isn't modelled. */
  critical(p: string): boolean {
    const abs = this.abs(p)
    return abs === "/" || abs === this.home || this.dirs.some((dir) => dir === abs || dir.startsWith(abs + path.sep))
  }

  /** After the hooks, as the docs order it: the deny rules, the ask rules, the sandbox's auto-allow and the mode,
   *  the allow rules and what needs no approval. The result is `allow`, `ask`, or a refusal's text. */
  decide(tool: string, input: Obj, mode: string, hook: "allow" | "ask" | null): "allow" | "ask" | { deny: string } {
    let parsed: Simple[] | null | undefined
    const subs = (): Simple[] => {
      parsed ??= parseCommand(String(input.command ?? ""))
      return parsed ?? unmodelled(`a Bash command it can't parse: ${String(input.command)}`)
    }
    const given = input.file_path ?? input.notebook_path ?? input.path
    const target = typeof given === "string" ? this.abs(given) : undefined
    const outside = target !== undefined && !this.inside(target)
    const noReads = this.permissions.blockReadsOutsideWorkingDirectories === true
    const noWrites = this.permissions.blockWritesOutsideWorkingDirectories === true
    if (outside && ((READS.has(tool) && noReads) || (EDITS.has(tool) && noWrites)))
      return { deny: denied(tool) }
    const sandboxed = tool === "Bash" && this.sandboxed(input, subs)
    const hit = (kind: RuleKind) =>
      this.rules.some(
        (rule) =>
          rule.kind === kind &&
          // A bare Bash ask rule gives way to the sandbox.
          !(kind === "ask" && sandboxed && rule.bash === undefined && rule.path === undefined && rule.names("Bash")) &&
          this.matches(rule, tool, target, subs),
      )
    if (hit("deny")) return { deny: denied(tool) }
    if (hook === "ask" || hit("ask")) return "ask"
    if (hook === "allow" || sandboxed || mode === "bypassPermissions") return "allow"
    if (tool === "Bash") return subs().every((sub, _, all) => this.approved(sub, all, mode)) ? "allow" : "ask"
    if (this.allowed(tool, target)) return "allow"
    if (READS.has(tool) && !outside) return "allow"
    if (mode === "acceptEdits" && EDITS.has(tool) && target !== undefined && this.editable(target)) return "allow"
    return "ask"
  }

  /** Whether a deny or ask rule covers the call: a Bash command, any of its commands; a path rule, the file a tool
   *  names, or the files a Bash command redirects to, reads or changes. */
  matches(rule: Rule, tool: string, target: string | undefined, subs: () => Simple[]): boolean {
    if (rule.inert) return false
    if (rule.path !== undefined) {
      const { re, read } = rule.path
      // A Read deny rule also stops writes to its paths.
      const writes = !read || rule.kind === "deny"
      let paths: string[] = []
      if (tool === "Bash")
        paths = [...(read ? subs().flatMap(readsOf) : []), ...(writes ? subs().flatMap(writesOf) : [])]
      else if (READS.has(tool) && read) paths = [target ?? this.cwd]
      else if (EDITS.has(tool) && writes && !(read && tool === "NotebookEdit") && target !== undefined) paths = [target]
      return paths.some((p) => re.test(this.abs(p)))
    }
    if (!rule.names(tool)) return false
    const bash = rule.bash
    return bash === undefined || (tool === "Bash" && subs().some((sub) => bash.test(this.text(sub, rule.kind))))
  }

  /** A command's text as a Bash rule matches it: past a leading assignment for a deny or ask rule. What wrappers
   *  and assignments do to an allow rule isn't modelled. */
  text(sub: Simple, kind: RuleKind): string {
    const at = sub.words.findIndex((w) => !ASSIGNMENT.test(w))
    if (WRAPPERS.has(sub.words[at] ?? "")) unmodelled(`a Bash rule over a command behind ${sub.words[at]}`)
    if (at === 0) return sub.text
    if (kind === "allow") unmodelled("an allow rule over a command behind an assignment")
    return sub.words.slice(at).join(" ")
  }

  /** An allow rule for a file tool, or for an `Edit` or `Read` of the path. */
  allowed(tool: string, target: string | undefined): boolean {
    return this.rules.some((rule) => {
      if (rule.kind !== "allow" || rule.inert || rule.bash !== undefined) return false
      if (rule.path === undefined) return rule.names(tool)
      const covers = rule.path.read ? READS.has(tool) : EDITS.has(tool)
      return covers && target !== undefined && rule.path.re.test(target)
    })
  }

  /** One command of a call that runs unasked: an allow rule's, a read-only one, or, with acceptEdits, a file
   *  operation inside the working folders; and each file it redirects to or from approved too. */
  approved(sub: Simple, all: Simple[], mode: string): boolean {
    const byRule = this.rules.some(
      (r) =>
        r.kind === "allow" &&
        r.path === undefined &&
        !r.inert &&
        r.names("Bash") &&
        (r.bash === undefined || r.bash.test(this.text(sub, "allow"))),
    )
    if (!byRule && !this.readOnly(sub, all) && !(mode === "acceptEdits" && this.fileOp(sub))) return false
    const written = (t: string) => this.allowed("Edit", this.abs(t)) || (mode === "acceptEdits" && this.editable(t))
    return (
      sub.outputs.every((t) => t === "/dev/null" || written(t)) &&
      sub.inputs.every((t) => this.inside(t) || this.allowed("Read", this.abs(t)))
    )
  }

  /** The docs' read-only commands, which run in every mode. */
  readOnly(sub: Simple, all: Simple[]): boolean {
    const [cmd = "", ...args] = sub.words
    if (ASSIGNMENT.test(cmd) || WRAPPERS.has(cmd)) {
      // Which prefixes a real one strips, and how it reads what follows them, isn't modelled.
      if (args.some((w) => READ_ONLY.has(w) || w === "git" || w === "cd"))
        unmodelled(`a read-only command behind ${cmd}`)
      return false
    }
    if (cmd === "cd") return args.length === 1 && this.inside(args[0]!) && !all.some((s) => s.words[0] === "git")
    if (cmd === "git") return READ_ONLY_GIT.has(args[0] ?? "") && !sub.glob && !all.some((s) => s.words[0] === "cd")
    if (!READ_ONLY.has(cmd)) return false
    if (cmd === "find" && (sub.glob || args.some((a) => FIND_ACTIONS.test(a)))) return false
    if (cmd === "which" && args.some((a) => a.startsWith("-") && a !== "-a")) return false
    const named = ["echo", "pwd", "which"].includes(cmd) ? [] : args.filter((a) => !a.startsWith("-"))
    if (this.permissions.blockReadsOutsideWorkingDirectories === true && named.some((a) => !this.inside(a)))
      unmodelled(`${cmd} with a path outside the working folders under blockReadsOutsideWorkingDirectories`)
    return true
  }

  /** With acceptEdits: mkdir, touch, rm, rmdir, mv or cp on paths inside the working folders, though not a touch
   *  with an option or a glob. sed, and a removal of a critical path, aren't modelled. */
  fileOp(sub: Simple): boolean {
    const [cmd = "", ...args] = sub.words
    if (ASSIGNMENT.test(cmd) || WRAPPERS.has(cmd)) {
      // The docs say only that a touch behind an assignment or a wrapper isn't approved.
      const op = args.find((w) => FILE_OPS.has(w) || w === "sed")
      if (op !== undefined && op !== "touch") unmodelled(`${op} behind ${cmd} with acceptEdits`)
      return false
    }
    if (cmd === "sed") unmodelled("sed with acceptEdits")
    if (!FILE_OPS.has(cmd)) return false
    if (cmd === "touch" && (sub.glob || args.some((a) => a.startsWith("-")))) return false
    const paths = args.filter((a) => !a.startsWith("-"))
    if ((cmd === "rm" || cmd === "rmdir") && paths.some((p) => this.critical(p)))
      unmodelled(`${sub.text}, a critical path`)
    return paths.length > 0 && paths.every((p) => this.editable(p))
  }

  /** Whether the sandbox's auto-allow takes the call: the sandbox enabled and up, auto-allow on (unset, on before
   *  2.1.325), and the call kept in the sandbox. A retry unsandboxed, an excluded call, and a command behind an
   *  assignment, `eval` or `make VAR=…` take the regular flow. */
  sandboxed(input: Obj, subs: () => Simple[]): boolean {
    const sb = this.sandbox
    if (sb.enabled !== true || !this.sandboxUp) return false
    const set = sb.autoAllowBashIfSandboxed
    const auto = typeof set === "boolean" ? set : below(this.version, "2.1.325")
    if (!auto || (input.dangerouslyDisableSandbox === true && sb.allowUnsandboxedCommands !== false)) return false
    const all = subs()
    const regular = (s: Simple) => {
      const [cmd = "", ...args] = s.words
      return ASSIGNMENT.test(cmd) || cmd === "eval" || (cmd === "make" && args.some((w) => ASSIGNMENT.test(w)))
    }
    if (all.some(regular)) return false
    for (const s of all) {
      const [cmd = "", ...args] = s.words
      if ((cmd === "rm" || cmd === "rmdir") && args.some((w) => !w.startsWith("-") && this.critical(w)))
        unmodelled(`${s.text}, a critical path`)
    }
    const excluded = strings(sb.excludedCommands).map(bashPattern)
    const stays = (s: Simple) =>
      ["sudo", "eval", "xargs"].includes(s.words[0] ?? "") ||
      ["cd", "pushd", "popd"].includes(s.words[0] ?? "") ||
      s.outputs.length + s.inputs.length > 0
    const out = excluded.length > 0 && all.every((s) => excluded.some((re) => re.test(s.text))) && !all.some(stays)
    return !out
  }
}

/** The files a command reads by name: its input redirects, and the files cat, head and tail print. */
function readsOf(sub: Simple): string[] {
  const [cmd = "", ...args] = sub.words
  return [...sub.inputs, ...(["cat", "head", "tail"].includes(cmd) ? args.filter((a) => !a.startsWith("-")) : [])]
}

/** The files a command writes by name: its output redirects, and what tee and the file operations name. */
function writesOf(sub: Simple): string[] {
  const [cmd = "", ...args] = sub.words
  const named = cmd === "tee" || cmd === "sed" || FILE_OPS.has(cmd) ? args.filter((a) => !a.startsWith("-")) : []
  return [...sub.outputs, ...named].filter((p) => p !== "/dev/null")
}
type End = "completed" | "aborted_streaming" | "aborted_tools" | { text: string; status: number | null }

/** One turn: the lines in it, and what an interrupt needs. */
interface Turn {
  readonly uuids: string[]
  /** Lines with `priority: "next"`, joining at the next step. */
  readonly joined: Obj[]
  readonly denials: Obj[]
  readonly promptId: string
  readonly started: number
  assistants: number
  requests: number
  text: string
  /** The tool use that waits on the host or runs, which an interrupt rejects. */
  tool: string | null
  /** The interrupt's request id, once one came. */
  interrupt: string | null
  /** Resolves when an interrupt comes. */
  readonly interrupted: Promise<null>
  readonly stop: () => void
}

/** One run of the fake. */
class Fake {
  readonly cwd = process.cwd()
  readonly version: string
  readonly model: string
  readonly sessionFile: string
  hooks: Obj = {}
  turn: Turn | null = null
  readonly queue: Obj[] = []
  /** The uuids whose `queued` is written already. */
  readonly announced = new Set<string>()
  readonly pending = new Map<string, (answer: Obj) => void>()
  turnsDone: number
  results = 0
  ids = 0
  child: ChildProcess | null = null
  ending = false

  constructor(
    readonly state: string,
    readonly script: FakeClaudeScript,
    readonly flags: Obj,
    readonly policy: Policy,
    public mode: string,
    readonly sessionId: string,
  ) {
    this.version = script.version ?? VERSION
    const models = script.models ?? MODELS
    const alias = models.find((m) => m.value === flags.model)?.resolvedModel
    this.model = alias ?? flags.model ?? models[0]?.resolvedModel ?? "claude-opus-5-5"
    this.sessionFile = path.join(state, "sessions", `${sessionId}.jsonl`)
    this.turnsDone = readLines(this.sessionFile).filter((m) => m.type === "system" && m.subtype === "init").length
  }

  log(entry: Obj): void {
    if (this.ending) return
    fs.appendFileSync(path.join(this.state, "log.jsonl"), JSON.stringify({ pid: process.pid, ...entry }) + "\n")
  }

  /** Writes `msg`, logs it, and keeps it in the session unless it's a control message. */
  write(msg: Obj): void {
    if (this.ending) return
    process.stdout.write(JSON.stringify(msg) + "\n")
    this.log({ dir: "out", msg })
    if (msg.type !== "control_request" && msg.type !== "control_response") this.keep(msg)
  }

  keep(msg: Obj): void {
    fs.appendFileSync(this.sessionFile, JSON.stringify(msg) + "\n")
  }

  /** Stops everything and exits with `code` once what was written, and `message` on stderr, is out. */
  end(code: number, message?: string): void {
    if (this.ending) return
    this.ending = true
    this.killCommand()
    const exit = () => process.stdout.write("", () => process.exit(code))
    if (message === undefined) exit()
    else process.stderr.write(message + "\n", exit)
  }

  /** Exits on what the fake doesn't model, saying what on stderr and in the log. */
  loud(error: Unmodelled): void {
    this.log({ dir: "unmodelled", what: error.message })
    this.end(FAKE_CLAUDE_UNMODELLED, `fake claude: not modelled: ${error.message}`)
  }

  /** Kills the running Bash step's whole process group: the shell and all it started. */
  killCommand(): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // The group is gone already.
    }
  }

  serve(): void {
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
    lines.on("line", (line) => {
      if (line.trim() === "" || this.ending) return
      let msg: Obj
      try {
        msg = JSON.parse(line) as Obj
      } catch {
        process.stderr.write(`fake claude: not JSON: ${line}\n`)
        return
      }
      this.log({ dir: "in", msg })
      this.handle(msg)
    })
    lines.on("close", () => this.end(0))
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const)
      process.on(signal, () => this.end(code))
  }

  handle(msg: Obj): void {
    if (msg.type === "control_request") {
      try {
        return this.control(msg)
      } catch (error) {
        if (error instanceof Unmodelled) return this.loud(error)
        throw error
      }
    }
    if (msg.type === "control_response") {
      const id = msg.response?.request_id
      const wake = this.pending.get(id)
      this.pending.delete(id)
      return wake?.(msg.response)
    }
    if (msg.type !== "user") return
    if (this.turn === null) return this.start(msg)
    if (typeof msg.uuid === "string") {
      this.announced.add(msg.uuid)
      this.write(this.lifecycle(msg.uuid, "queued"))
    }
    if (msg.priority === "next") this.turn.joined.push(msg)
    else this.queue.push(msg)
  }

  control(msg: Obj): void {
    const id = msg.request_id
    const subtype = msg.request?.subtype
    if (subtype === "initialize") {
      this.hooks = isObj(msg.request.hooks) ? msg.request.hooks : {}
      for (const event of Object.keys(this.hooks)) if (!HOOK_EVENTS.has(event)) unmodelled(`a ${event} hook`)
      return this.write(this.initializeAnswer(id))
    }
    if (subtype === "interrupt") {
      const turn = this.turn
      if (turn !== null && turn.interrupt === null) {
        turn.interrupt = id
        return turn.stop()
      }
      return this.write(answer(id, { still_queued: this.stillQueued() }))
    }
    if (subtype === "set_permission_mode") {
      this.mode = permissionMode(msg.request.mode)
      return this.write({ type: "control_response", response: { subtype: "success", request_id: id } })
    }
    const error = `Unsupported control request subtype: ${subtype}`
    this.write({ type: "control_response", response: { subtype: "error", request_id: id, error } })
  }

  stillQueued(): string[] {
    return this.queue.map((m) => m.uuid).filter((uuid): uuid is string => typeof uuid === "string")
  }

  start(msg: Obj): void {
    void this.run(msg).catch((error: unknown) => {
      if (error instanceof Unmodelled) return this.loud(error)
      this.end(1, `fake claude: ${error instanceof Error ? error.stack : String(error)}`)
    })
  }

  async run(first: Obj): Promise<void> {
    let stop!: () => void
    const interrupted = new Promise<null>((resolve) => (stop = () => resolve(null)))
    const turn: Turn = {
      uuids: [],
      joined: [],
      denials: [],
      promptId: randomUUID(),
      started: Date.now(),
      assistants: 0,
      requests: 1,
      text: "",
      tool: null,
      interrupt: null,
      interrupted,
      stop,
    }
    this.turn = turn
    this.write(this.stateChanged("running"))
    this.begin(turn, first)
    this.write(this.init(turn))
    const steps = this.script.turns?.[this.turnsDone] ?? []
    this.turnsDone++
    for (const step of steps) {
      this.join(turn)
      if ("say" in step) {
        turn.text = step.say
        this.write(this.assistant(turn, [{ type: "text", text: step.say }]))
      } else if ("tool" in step) await this.tool(turn, step)
      else if ("sleep" in step) await this.pause(turn, step.sleep)
      else if ("fail" in step) {
        this.write(this.apiError(turn, step.fail, step.status ?? null))
        this.write(this.result(turn, { text: step.fail, status: step.status ?? null }))
        return this.settle(turn, "cancelled")
      } else if ("exit" in step) return this.end(step.exit)
      if (turn.interrupt !== null) break
    }
    if (turn.interrupt !== null) return this.abort(turn, turn.interrupt)
    this.join(turn)
    // As recorded: the lines that joined complete before the result, the first one after it.
    for (const uuid of turn.uuids.slice(1)) this.write(this.lifecycle(uuid, "completed"))
    this.write(this.result(turn, "completed"))
    this.settle(turn, "completed", turn.uuids.slice(0, 1))
  }

  /** A line that starts or joins `turn`: kept, and its lifecycle written. */
  begin(turn: Turn, msg: Obj): void {
    this.keep(msg)
    if (typeof msg.uuid !== "string") return
    if (!this.announced.delete(msg.uuid)) this.write(this.lifecycle(msg.uuid, "queued"))
    this.write(this.lifecycle(msg.uuid, "started"))
    turn.uuids.push(msg.uuid)
  }

  join(turn: Turn): void {
    for (const msg of turn.joined.splice(0)) this.begin(turn, msg)
  }

  /** Ends the turn's lines (`uuids`) with `state`, goes idle, and starts the next waiting line. */
  settle(turn: Turn, state: "completed" | "cancelled", uuids: string[] = turn.uuids): void {
    for (const uuid of uuids) this.write(this.lifecycle(uuid, state))
    this.write(this.stateChanged("idle"))
    this.turn = null
    const next = this.queue.shift()
    if (next !== undefined && !this.ending) this.start(next)
  }

  /** Ends an interrupted turn as Claude Code does; lines that would have joined it wait first in line. */
  abort(turn: Turn, id: string): void {
    this.queue.unshift(...turn.joined.splice(0))
    this.write(answer(id, { still_queued: this.stillQueued() }))
    if (turn.tool !== null) {
      const meta = { non_execution_kind: "user-rejected" }
      this.write(this.toolResult(turn.tool, REJECTED, true, "User rejected tool use", meta))
      this.write(this.userText("[Request interrupted by user for tool use]"))
      this.write(this.result(turn, "aborted_tools"))
    } else {
      this.write(this.userText("[Request interrupted by user]"))
      this.write(this.result(turn, "aborted_streaming"))
    }
    this.settle(turn, "cancelled")
  }

  async pause(turn: Turn, seconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const slept = new Promise<void>((resolve) => (timer = setTimeout(resolve, seconds * 1000)))
    await Promise.race([slept, turn.interrupted])
    clearTimeout(timer)
  }

  async tool(turn: Turn, step: { tool: string; input?: Obj; result?: string; is_error?: boolean }): Promise<void> {
    const name = step.tool
    const input = step.input ?? {}
    const id = `toolu_fake_${++this.ids}`
    this.write(
      this.assistant(turn, [{ type: "tool_use", id, name, input, caller: { type: "direct" } }], {
        wire_tool_inputs: { [id]: input },
        // The recorded meta is an MCP tool's; a built-in tool's is unrecorded.
        tool_use_meta: [{ id, display_name: name, tool_name: name }],
      }),
    )
    turn.tool = id
    const started = Date.now()
    const verdict = await this.permit(turn, name, input, id)
    if (verdict === null) return
    turn.requests++
    if (!verdict.allow) {
      turn.tool = null
      turn.denials.push({ tool_name: name, tool_use_id: id, tool_input: input })
      // The decision's values are unrecorded.
      const meta = { permission_decision: { decision: "reject", source: verdict.source, reason_type: verdict.source } }
      return this.write(this.toolResult(id, verdict.message, true, `Error: ${verdict.message}`, meta))
    }
    let content = step.result ?? ""
    let isError = step.is_error === true
    let used: unknown = isError ? `Error: ${content}` : content
    if (step.result === undefined && name === "Bash") {
      const ran = await this.bash(turn, String(verdict.input.command ?? ""))
      if (ran === null) return
      const output = [ran.stdout.trimEnd(), ran.stderr.trimEnd()].filter((s) => s !== "").join("\n")
      isError = ran.code !== 0
      content = isError ? [`Exit code ${ran.code}`, output].filter((s) => s !== "").join("\n") : output
      const { stdout, stderr } = ran
      used = isError ? `Error: ${content}` : { stdout, stderr, interrupted: false, isImage: false }
    }
    // As recorded, a tool that failed gets no PostToolUse callback.
    if (!isError && !(await this.after(turn, name, verdict.input, id, used, started))) return
    turn.tool = null
    this.write(this.toolResult(id, content, isError, used, ALLOWED))
  }

  /** The callback ids of the host's hooks on `event` whose matcher takes `tool`. */
  callbacks(event: string, tool: string): string[] {
    const hooks: unknown = this.hooks[event]
    return (Array.isArray(hooks) ? hooks : [])
      .filter((hook) => isObj(hook) && matches(hook.matcher, tool))
      .flatMap((hook) => strings(hook.hookCallbackIds))
  }

  hookInput(turn: Turn, event: string): Obj {
    return {
      session_id: this.sessionId,
      transcript_path: this.sessionFile,
      cwd: this.cwd,
      prompt_id: turn.promptId,
      permission_mode: this.mode,
      effort: { level: "medium" },
      hook_event_name: event,
    }
  }

  /** The PostToolUse callbacks after a tool ran; false when an interrupt comes first. Their output isn't modelled. */
  async after(turn: Turn, name: string, input: Obj, id: string, response: unknown, started: number): Promise<boolean> {
    for (const callback of this.callbacks("PostToolUse", name)) {
      const answered = await this.ask(turn, {
        subtype: "hook_callback",
        callback_id: callback,
        input: {
          ...this.hookInput(turn, "PostToolUse"),
          tool_name: name,
          tool_input: input,
          tool_response: response,
          tool_use_id: id,
          duration_ms: Date.now() - started,
        },
        tool_use_id: id,
      })
      if (answered === null) return false
      if (!isObj(answered.response) || Object.keys(answered.response).length > 0)
        unmodelled("a PostToolUse hook's output")
    }
    return true
  }

  /** Whether a tool runs, null when an interrupt comes first: the host's PreToolUse hooks (a deny refuses; an allow
   *  still meets the deny and ask rules), then the policy, then, where it would ask, `can_use_tool` with
   *  `--permission-prompt-tool stdio` unless the mode is dontAsk, which refuses. The decision fields, `can_use_tool`
   *  and the refusals' text are unrecorded; a hook's `defer`, `decision` or `continue`, and a `can_use_tool` answer's
   *  `interrupt` or `updatedPermissions`, aren't modelled. */
  async permit(turn: Turn, name: string, input: Obj, id: string): Promise<Verdict | null> {
    let [hook, used]: ["allow" | "ask" | null, Obj] = [null, input]
    for (const callback of this.callbacks("PreToolUse", name)) {
      const answered = await this.ask(turn, {
        subtype: "hook_callback",
        callback_id: callback,
        input: { ...this.hookInput(turn, "PreToolUse"), tool_name: name, tool_input: used, tool_use_id: id },
        tool_use_id: id,
      })
      if (answered === null) return null
      const out = isObj(answered.response) ? answered.response : {}
      if ("decision" in out || "continue" in out) unmodelled("a PreToolUse hook's decision or continue")
      const specific = isObj(out.hookSpecificOutput) ? out.hookSpecificOutput : {}
      if (isObj(specific.updatedInput)) used = specific.updatedInput
      const decision = specific.permissionDecision
      if (decision === "defer") unmodelled("a PreToolUse hook's defer")
      if (decision === "deny") {
        const reason = specific.permissionDecisionReason
        return { allow: false, message: typeof reason === "string" ? reason : denied(name), source: "hook" }
      }
      if (decision === "ask" || (decision === "allow" && hook === null)) hook = decision
    }
    const decided = this.policy.decide(name, used, this.mode, hook)
    if (decided === "allow") return { allow: true, input: used }
    if (decided !== "ask") return { allow: false, message: decided.deny, source: "rule" }
    if (this.mode === "dontAsk" || this.flags["permission-prompt-tool"] !== "stdio")
      return { allow: false, message: denied(name), source: "mode" }
    const answered = await this.ask(turn, { subtype: "can_use_tool", tool_name: name, input: used, tool_use_id: id })
    if (answered === null) return null
    const r = isObj(answered.response) ? answered.response : {}
    if (r.updatedPermissions !== undefined) unmodelled("a can_use_tool answer's updatedPermissions")
    if (answered.subtype === "success" && r.behavior === "allow") {
      if (!isObj(r.updatedInput)) unmodelled("a can_use_tool allow without updatedInput")
      return { allow: true, input: r.updatedInput }
    }
    if (r.interrupt === true) unmodelled("a can_use_tool deny that interrupts")
    return { allow: false, message: typeof r.message === "string" ? r.message : denied(name), source: "user" }
  }

  /** Sends the host a control request and resolves to its answer, or null when an interrupt comes first. */
  async ask(turn: Turn, request: Obj): Promise<Obj | null> {
    const id = randomUUID()
    const answered = new Promise<Obj>((resolve) => this.pending.set(id, resolve))
    this.write({ type: "control_request", request_id: id, request })
    const got = await Promise.race([answered, turn.interrupted])
    this.pending.delete(id)
    return got
  }

  /** Runs `command` here; null when an interrupt comes first, which kills its group. */
  async bash(turn: Turn, command: string): Promise<{ stdout: string; stderr: string; code: number } | null> {
    const { [NO_CACHE]: _, ...env } = process.env
    // In a group of its own, which ends with the step.
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: this.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    this.child = child
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    const exited = new Promise<number>((resolve) => {
      child.on("error", () => resolve(127))
      child.on("exit", (code) => resolve(code ?? 1))
    })
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()))
    const code = await Promise.race([exited, turn.interrupted])
    // What it left running in the background goes with it, which also frees the pipes such a command holds.
    this.killCommand()
    this.child = null
    if (code === null) return null
    await closed
    return { stdout, stderr, code }
  }

  initializeAnswer(id: unknown): Obj {
    const hooked = Object.keys(this.hooks).length > 0
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          user_output_styles_dir: path.join(this.state, "output-styles"),
          models: this.script.models ?? MODELS,
          account: this.script.signed_out === true ? SIGNED_OUT : SIGNED_IN,
          pid: process.pid,
          claude_code_version: this.version,
          current_permission_mode: this.mode,
          ...(hooked ? { hooks_applied: true } : {}),
          feedback_mode: { kind: "bundle" },
          analytics_disabled: false,
          remote_control_auto_enable: false,
          remote_control_auto_connect_default: false,
          remote_control_available: false,
          remote_control_auto_on_by_default: false,
          ide_rc_auto_enable_gate: false,
          fast_mode_state: "off",
          fast_mode_disabled_reason: "sdk_opt_in_required",
          session_state: "idle",
          capabilities: ["ui_surface_v1"],
        },
        pending_permission_requests: [],
        pending_user_dialog_requests: [],
      },
    }
  }

  stateChanged(state: "running" | "idle"): Obj {
    const [uuid, session_id] = [randomUUID(), this.sessionId]
    return { type: "system", subtype: "session_state_changed", state, sdk_host_only: true, uuid, session_id }
  }

  lifecycle(uuid: string, state: string): Obj {
    return { type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: this.sessionId }
  }

  init(turn: Turn): Obj {
    return {
      type: "system",
      subtype: "init",
      cwd: this.cwd,
      session_id: this.sessionId,
      tools: TOOLS,
      mcp_servers: [],
      model: this.model,
      permissionMode: this.mode,
      slash_commands: [],
      terminal_slash_commands: [],
      apiKeySource: "none",
      claude_code_version: this.version,
      output_style: "default",
      agents: [],
      skills: [],
      plugins: [],
      capabilities: INIT_CAPABILITIES,
      analytics_disabled: false,
      product_feedback_disabled: false,
      uuid: randomUUID(),
      original_cwd: this.cwd,
      additional_directories: this.policy.dirs.slice(1),
      messaging_socket_path: path.join(this.state, "messaging.sock"),
      fast_mode_state: "off",
      fast_mode_disabled_reason: "sdk_opt_in_required",
      per_turn_effort_active: true,
      view_mode: "default",
      ...(turn.uuids.length > 0 ? { user_message_uuids: [...turn.uuids] } : {}),
    }
  }

  /** The turn's line uuids, which its first assistant message and its result carry. */
  userUuids(turn: Turn): Obj {
    return turn.uuids.length > 0 ? { user_message_uuid: turn.uuids[0], user_message_uuids: [...turn.uuids] } : {}
  }

  assistant(turn: Turn, content: Obj[], extra: Obj = {}): Obj {
    const first = turn.assistants++ === 0
    const n = ++this.ids
    return {
      type: "assistant",
      message: {
        model: this.model,
        id: `msg_fake_${n}`,
        type: "message",
        role: "assistant",
        content,
        container: null,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: MESSAGE_USAGE,
        input_transformations: [],
        diagnostics: null,
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
      timestamp: now(),
      request_id: `req_fake_${n}`,
      ...extra,
      ...(first ? this.userUuids(turn) : {}),
    }
  }

  apiError(turn: Turn, text: string, status: number | null): Obj {
    const first = turn.assistants++ === 0
    return {
      type: "assistant",
      message: {
        diagnostics: null,
        id: randomUUID(),
        container: null,
        model: "<synthetic>",
        role: "assistant",
        stop_details: null,
        stop_reason: "stop_sequence",
        stop_sequence: "",
        type: "message",
        usage: ERROR_USAGE,
        content: [{ type: "text", text }],
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
      timestamp: now(),
      error: "unknown",
      request_id: `req_fake_${++this.ids}`,
      is_api_error_message: true,
      api_error_status: status,
      ...(first ? this.userUuids(turn) : {}),
    }
  }

  toolResult(id: string, content: string, isError: boolean, used: unknown, meta: Obj): Obj {
    // Keys in the recorded order: an error's differ from a success's.
    const block = isError
      ? { type: "tool_result", content, is_error: true, tool_use_id: id }
      : { tool_use_id: id, type: "tool_result", content }
    return {
      type: "user",
      message: { role: "user", content: [block] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
      timestamp: now(),
      tool_use_result: used,
      tool_result_meta: [{ id, ...meta }],
    }
  }

  userText(text: string): Obj {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
      timestamp: now(),
    }
  }

  result(turn: Turn, end: End): Obj {
    const common = {
      duration_api_ms: 0,
      session_id: this.sessionId,
      total_cost_usd: 0,
      usage: USAGE,
      permission_denials: [...turn.denials],
      fast_mode_state: "off",
      fast_mode_disabled_reason: "sdk_opt_in_required",
      subagent_stats: SUBAGENT_STATS,
      safety_stops: 0,
      num_turns: turn.requests,
      type: "result",
      duration_ms: Date.now() - turn.started,
      uuid: randomUUID(),
      ...this.userUuids(turn),
      queued_turn_count: this.queue.length,
      result_index: this.results++,
    }
    const modelUsage = {
      [this.model]: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        thinkingTokens: 0,
        canonicalModel: this.model,
        provider: "firstParty",
        costBasis: "list",
      },
    }
    if (end === "completed")
      return {
        ...common,
        stop_reason: "end_turn",
        modelUsage,
        terminal_reason: "completed",
        is_error: false,
        subtype: "success",
        api_error_status: null,
        result: turn.text,
        ttft_ms: 0,
        ttft_stream_ms: 0,
        time_to_request_ms: 0,
        first_content_frame_ms: 0,
        request_sent_wall_ms: turn.started,
        first_request_input_tokens: 0,
      }
    if (typeof end === "object")
      return {
        ...common,
        stop_reason: "stop_sequence",
        modelUsage: {},
        terminal_reason: "api_error",
        is_error: true,
        subtype: "success",
        api_error_status: end.status,
        result: end.text,
      }
    const stop = end === "aborted_tools" ? "tool_use" : null
    return {
      ...common,
      stop_reason: stop,
      modelUsage,
      terminal_reason: end,
      is_error: true,
      subtype: "error_during_execution",
      errors: [`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${stop}`],
    }
  }
}

function answer(id: unknown, response: Obj): Obj {
  return { type: "control_response", response: { subtype: "success", request_id: id, response } }
}

function main(state: string, argv: string[]): void {
  const script = JSON.parse(fs.readFileSync(path.join(state, "script.json"), "utf8")) as FakeClaudeScript
  const flags = parseFlags(argv)
  const cwd = process.cwd()
  const settings = flags.settings === undefined ? null : readSettings(flags.settings, cwd)
  const { [NO_CACHE]: _, ...env } = process.env
  const logged = { ...flags, ...(settings === null ? {} : { settings }) }
  const start = { pid: process.pid, dir: "start", argv, cwd, env, flags: logged }
  fs.appendFileSync(path.join(state, "log.jsonl"), JSON.stringify(start) + "\n")
  const quit = (code: number, message: string): void => {
    process.stderr.write(message + "\n", () => process.exit(code))
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${script.version ?? VERSION} (Claude Code)\n`, () => process.exit(0))
    return
  }
  if (flags["input-format"] !== "stream-json" || flags["output-format"] !== "stream-json")
    return quit(2, "fake claude: runs only with --input-format stream-json --output-format stream-json")
  if (flags.settings !== undefined && settings === null)
    return quit(1, `fake claude: --settings is neither JSON nor a JSON file: ${flags.settings}`)
  const sandbox = settings?.sandbox
  if (script.sandbox_unavailable === true && sandbox?.enabled === true && sandbox.failIfUnavailable === true)
    return quit(1, "Error: the sandbox is enabled with failIfUnavailable, but it can't start on this machine.")
  const sandboxUp = script.sandbox_unavailable !== true
  // A rule's `/` anchors at a settings file's folder, else at the working folder.
  const file = flags.settings !== undefined && !flags.settings.trimStart().startsWith("{")
  const settingsDir = file ? path.dirname(path.resolve(cwd, flags.settings)) : cwd
  const named = flags["dangerously-skip-permissions"] === true ? "bypassPermissions" : flags["permission-mode"]
  let [policy, mode]: [Policy | undefined, string] = [undefined, "default"]
  try {
    policy = new Policy(cwd, flags, settings, settingsDir, process.env.HOME, script.version ?? VERSION, sandboxUp)
    mode = permissionMode(named ?? settings?.permissions?.defaultMode ?? "default")
  } catch (error) {
    if (!(error instanceof Unmodelled)) throw error
    const entry = { pid: process.pid, dir: "unmodelled", what: error.message }
    fs.appendFileSync(path.join(state, "log.jsonl"), JSON.stringify(entry) + "\n")
    return quit(FAKE_CLAUDE_UNMODELLED, `fake claude: not modelled: ${error.message}`)
  }
  const id: string = flags.resume ?? flags["session-id"] ?? randomUUID()
  if (id === "" || id.includes("/") || id === "." || id === "..") return quit(1, `fake claude: bad session id: ${id}`)
  if (flags.resume !== undefined && !fs.existsSync(path.join(state, "sessions", `${id}.jsonl`)))
    return quit(1, `No conversation found with session ID: ${id}`)
  new Fake(state, script, flags, policy, mode, id).serve()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  main(args[0]!, args.slice(1))
}
