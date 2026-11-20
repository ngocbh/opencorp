/** A scripted stand-in for Claude Code's CLI in tests, `claude --input-format stream-json --output-format
 *  stream-json`, run through a sh shim with the tests' Bun: a program, so it serves a driver that runs `claude` itself
 *  and the SDK's `pathToClaudeCodeExecutable` alike. It never touches a real `claude`, its config or the network: its
 *  state is the folder `installFakeClaude` is given.
 *
 *  Every line it writes has the keys of a line real Claude Code wrote (`tests/fixtures/claude/stream.jsonl`, from the
 *  upstream TUI's recordings, 2.1.301 to 2.1.309), except where "unrecorded" says no recording holds it.
 *
 *  - **Start.** `--version` prints the version. Any other run needs `--input-format stream-json --output-format
 *    stream-json`, else it exits 2. It reads `--session-id`, `--resume`, `--permission-mode`,
 *    `--permission-prompt-tool`, `--model`, `--settings` (JSON, or a JSON file), `--setting-sources`, `--allowedTools`
 *    and `--append-system-prompt`, as `--flag v` or `--flag=v`, and the bare `--strict-mcp-config` and `--verbose`; it
 *    ignores the rest. With the script's `sandbox_unavailable`, settings that enable the sandbox with
 *    `failIfUnavailable` stop the start: exit 1 and a stderr line (its wording unrecorded); without
 *    `failIfUnavailable` it goes on, as Claude Code goes on unsandboxed.
 *  - **`initialize`** is answered with the version, models, `commands: []`, the permission mode, the pid and the
 *    account, `{tokenSource: "none", apiProvider: "firstParty"}` when the script is `signed_out`; `hooks_applied`
 *    when the request registers hooks.
 *  - **A turn.** A `user` line, when no turn runs, starts one: `session_state_changed` running, the line's
 *    `command_lifecycle` queued and started (a line with no `uuid` gets none), `system`/`init`, the script's next turn
 *    of steps, a `result`, `completed` for each of its lines, then idle. A line with `priority: "next"` during a turn
 *    joins it at the next step (`started` then); any other waits for the turn to end (unrecorded), each `queued` at
 *    once. Steps:
 *    - `{"say": text}` writes an assistant text; the last is the result's `result`;
 *    - `{"tool": name, "input", "result"?, "is_error"?}` writes the `tool_use`, asks as below, then writes the
 *      `tool_result`. A `Bash` with no `result` runs its `command` for real under `/bin/sh -c` in the fake's folder
 *      (not sandboxed); its result is the output, stdout then stderr, with "Exit code N" first when it fails (the
 *      text and `tool_use_result`'s fields unrecorded). Another tool with no `result` returns "";
 *    - `{"sleep": seconds}`; `{"fail": text, "status"?}` ends the turn with an API error as recorded;
 *      `{"exit": code}` exits at once.
 *  - **How it asks before a tool.** First each `PreToolUse` hook the host registered whose `matcher` takes the tool
 *    gets a `hook_callback`; its answer's `hookSpecificOutput.permissionDecision` `allow` runs it, `deny` refuses it
 *    with `permissionDecisionReason`, and anything else goes on (the decision fields unrecorded). Then the mode:
 *    `bypassPermissions` runs it; a read (`Read`, `Glob`, `Grep`, `LS`) inside the folder runs in every mode
 *    (unrecorded); `acceptEdits` runs an edit (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) inside the folder, and
 *    `Bash` when the settings enable the sandbox with `autoAllowBashIfSandboxed`. Then, unless the mode is `dontAsk`,
 *    with `--permission-prompt-tool stdio` the host gets `can_use_tool` and answers `{behavior: "allow",
 *    updatedInput?}` or `{behavior: "deny", message}` (unrecorded). Anything else is refused, as a headless Claude
 *    Code with no way to ask (unrecorded). A refusal is an error `tool_result` and a `permission_denials` entry (its
 *    text and meta unrecorded).
 *  - **Interrupts.** Mid-turn, `interrupt` is answered `{still_queued}`, then `[Request interrupted by user]` and an
 *    `error_during_execution` result; while a tool waits on the host or runs, that tool's `tool_result` is rejected
 *    and `[Request interrupted by user for tool use]` follows. The turn's lines are `cancelled`. `still_queued` lists
 *    the uuids of the lines still waiting, which run next (unrecorded: the recordings had none). With no turn the
 *    answer comes at once. `set_permission_mode` gets a plain success (unrecorded; shaped as `apply_flag_settings`'
 *    recorded answer); any other control request gets an error (unrecorded).
 *  - **Sessions.** Each session's lines are kept in `<state>/sessions/<id>.jsonl`. `--resume <id>` goes on with the
 *    script's turn after the session's last; an unknown id exits 1 (its wording unrecorded).
 *  - **The log.** `<state>/log.jsonl` holds each run's start (argv, cwd, env, the flags read, settings whole) and
 *    every line in and out. Stdin's end exits 0 at once.
 *
 *  It writes no `status`, `rate_limit_event`, `stream_event` or `thinking_tokens` lines, which real Claude Code
 *  writes too; a driver ignores them. */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { selfCommand } from "../platform.ts"

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

export interface FakeClaudeLogEntry {
  pid: number
  dir: "start" | "in" | "out"
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
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
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
  const shim = `#!/bin/sh\n${NO_CACHE}=0 exec '${BUN}' ${BUN_FLAGS.join(" ")} '${SELF}' '${state}' "$@"\n`
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
  "append-system-prompt",
  "input-format",
  "output-format",
])
const BARE = new Set(["strict-mcp-config", "verbose"])

/** The flags the fake reads, by name; `allowedTools` as a list of the values given. */
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
    flags[name] = name === "allowedTools" ? [...(flags[name] ?? []), value] : value
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
  mode: string
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
    readonly settings: Obj | null,
    readonly sessionId: string,
  ) {
    this.version = script.version ?? VERSION
    const models = script.models ?? MODELS
    const alias = models.find((m) => m.value === flags.model)?.resolvedModel
    this.model = alias ?? flags.model ?? models[0]?.resolvedModel ?? "claude-opus-5-5"
    this.mode = flags["permission-mode"] ?? "default"
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

  /** Stops everything and exits with `code` once what was written reaches stdout. */
  end(code: number): void {
    if (this.ending) return
    this.ending = true
    this.child?.kill("SIGKILL")
    process.stdout.write("", () => process.exit(code))
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
  }

  handle(msg: Obj): void {
    if (msg.type === "control_request") return this.control(msg)
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
      this.mode = String(msg.request.mode)
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
      process.stderr.write(`fake claude: ${error instanceof Error ? error.stack : String(error)}\n`)
      this.end(1)
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
    this.write(this.result(turn, "completed"))
    this.settle(turn, "completed")
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

  /** Ends the turn's lines with `state`, goes idle, and starts the next waiting line. */
  settle(turn: Turn, state: "completed" | "cancelled"): void {
    for (const uuid of turn.uuids) this.write(this.lifecycle(uuid, state))
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
      content = isError ? `Exit code ${ran.code}\n${output}` : output
      const { stdout, stderr } = ran
      used = isError ? `Error: ${content}` : { stdout, stderr, interrupted: false, isImage: false }
    }
    turn.tool = null
    this.write(this.toolResult(id, content, isError, used, ALLOWED))
  }

  /** Whether a tool runs: a hook, the mode, the host's answer, in that order; null when interrupted first. */
  async permit(turn: Turn, name: string, input: Obj, id: string): Promise<Verdict | null> {
    const allow: Verdict = { allow: true, input }
    const hooks: unknown = this.hooks.PreToolUse
    for (const hook of Array.isArray(hooks) ? hooks : []) {
      if (!isObj(hook) || !matches(hook.matcher, name)) continue
      for (const callback of Array.isArray(hook.hookCallbackIds) ? hook.hookCallbackIds : []) {
        const answered = await this.ask(turn, {
          subtype: "hook_callback",
          callback_id: callback,
          input: {
            session_id: this.sessionId,
            transcript_path: this.sessionFile,
            cwd: this.cwd,
            prompt_id: turn.promptId,
            permission_mode: this.mode,
            effort: { level: "medium" },
            hook_event_name: "PreToolUse",
            tool_name: name,
            tool_input: input,
            tool_use_id: id,
          },
          tool_use_id: id,
        })
        if (answered === null) return null
        const out = answered.response?.hookSpecificOutput
        if (out?.permissionDecision === "allow") return allow
        if (out?.permissionDecision === "deny") {
          const reason = out.permissionDecisionReason
          return { allow: false, message: typeof reason === "string" ? reason : denied(name), source: "hook" }
        }
      }
    }
    if (this.mode === "bypassPermissions") return allow
    const target = input.file_path ?? input.notebook_path ?? input.path
    if (READS.has(name) && (target === undefined || this.inside(target))) return allow
    if (this.mode === "acceptEdits") {
      if (EDITS.has(name) && typeof target === "string" && this.inside(target)) return allow
      const sandbox = this.settings?.sandbox
      if (name === "Bash" && sandbox?.enabled === true && sandbox.autoAllowBashIfSandboxed === true) return allow
    }
    if (this.mode !== "dontAsk" && this.flags["permission-prompt-tool"] === "stdio") {
      const answered = await this.ask(turn, { subtype: "can_use_tool", tool_name: name, input, tool_use_id: id })
      if (answered === null) return null
      const r = answered.response
      if (answered.subtype === "success" && r?.behavior === "allow")
        return { allow: true, input: isObj(r.updatedInput) ? r.updatedInput : input }
      return { allow: false, message: typeof r?.message === "string" ? r.message : denied(name), source: "user" }
    }
    return { allow: false, message: denied(name), source: "mode" }
  }

  inside(target: unknown): boolean {
    if (typeof target !== "string") return false
    const abs = path.resolve(this.cwd, target)
    return abs === this.cwd || abs.startsWith(this.cwd + path.sep)
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

  /** Runs `command` here; null when an interrupt comes first, which kills it. */
  async bash(turn: Turn, command: string): Promise<{ stdout: string; stderr: string; code: number } | null> {
    const { [NO_CACHE]: _, ...env } = process.env
    const child = spawn("/bin/sh", ["-c", command], { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    this.child = child
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    const done = new Promise<number>((resolve) => {
      child.on("error", () => resolve(127))
      child.on("close", (code) => resolve(code ?? 1))
    })
    const code = await Promise.race([done, turn.interrupted])
    this.child = null
    if (code === null) {
      child.kill("SIGKILL")
      return null
    }
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
      additional_directories: [],
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
  const id: string = flags.resume ?? flags["session-id"] ?? randomUUID()
  if (id === "" || id.includes("/") || id === "." || id === "..") return quit(1, `fake claude: bad session id: ${id}`)
  if (flags.resume !== undefined && !fs.existsSync(path.join(state, "sessions", `${id}.jsonl`)))
    return quit(1, `No conversation found with session ID: ${id}`)
  new Fake(state, script, flags, settings, id).serve()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  main(args[0]!, args.slice(1))
}
