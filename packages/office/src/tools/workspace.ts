/** Workspace tools: read, write, edit, list, search, and shell, each one sandboxed call. */
import { startTime } from "../install/proc.ts"
import { pyJson, repr, strip } from "../perm/redact.ts"
import { SandboxPolicy } from "../sandbox/policy.ts"
import { fsHelper, type Result, run } from "../sandbox/run.ts"
import { newId, type Store } from "../store/store.ts"

export const TOOL_NAMES = ["read_file", "write_file", "edit_file", "list", "search", "shell"] as const
/** The workspace tools that only read: all a read-only run is offered. */
export const READ_TOOLS = ["read_file", "list", "search"] as const
export const MAX_SHELL_TIMEOUT = 600
// Capture cap for a file tool's reply, above the largest reply the helper can produce
// (every op's output is bounded: 200k read characters, 200 search matches, 5000 names,
// each at most 6 bytes a character as JSON), so a cut-off reply is reported as an error.
export const FILE_OUTPUT_CAP = 16 << 20
// Bytes of shell output the model sees; the rest of the capture is cut from the middle.
export const MAX_SHELL_OUTPUT = 64 * 1024
const BULK_ARGS = new Set(["content", "old", "new"])
const MAX_ARG_CHARS = 200

type ToolName = (typeof TOOL_NAMES)[number]

/** Each tool's parameters in order: a name alone is required, a pair is a name and its default. */
const SIGNATURES: Record<ToolName, readonly (readonly [string] | readonly [string, unknown])[]> = {
  read_file: [["path"], ["offset", 0], ["limit", null]],
  write_file: [["path"], ["content"]],
  edit_file: [["path"], ["old"], ["new"], ["replace_all", false]],
  list: [["path", "."]],
  search: [["pattern"], ["path", "."], ["glob", null]],
  shell: [["command"], ["timeout", null]],
}

/** What one workspace call did, for the audit log.
 *
 *  `exit` is the call's exit status, or `null` when it was killed (timeout or interrupt); `duration` is in
 *  seconds. */
export interface AuditRecord {
  tool: string
  argsSummary: string
  exit: number | null
  duration: number
}

/** A workspace call's model-visible output and its audit record. */
export interface ToolOutcome {
  output: string
  audit: AuditRecord
}

export interface WorkspaceOptions {
  /** The office home; the helper must not lie inside it (`fsHelper`). */
  officeHome: string
  /** Where each running call's `call:<id>` row goes, for the start-up reaper; required. */
  store: Store
  /** Seconds a file tool may run; default 30. */
  fileTimeout?: number
  /** Default seconds a shell call may run (the model may ask for up to `MAX_SHELL_TIMEOUT`); default 120. */
  shellTimeout?: number
  /** Bytes of a file tool's reply kept; default `FILE_OUTPUT_CAP`. */
  fileOutputCap?: number
}

/** One session's workspace tools; every call runs as its own sandboxed process: file ops as the fs helper
 *  under a policy with the helper, shell calls under a policy without it. */
export class WorkspaceTools {
  readonly #argv: string[]
  readonly #filePolicy: SandboxPolicy
  readonly #shellPolicy: SandboxPolicy
  readonly #store: Store
  readonly #fileTimeout: number
  readonly #shellTimeout: number
  readonly #fileOutputCap: number
  readonly #active = new Set<AbortController>()

  /** Throws `SandboxUnavailable` when the helper lies inside `options.officeHome`. */
  constructor(policy: SandboxPolicy, options: WorkspaceOptions) {
    const { argv, helper } = fsHelper(options.officeHome)
    this.#argv = argv
    this.#filePolicy = new SandboxPolicy({ ...policy, helper })
    this.#shellPolicy = policy.helper === undefined ? policy : new SandboxPolicy({ ...policy, helper: undefined })
    this.#store = options.store
    this.#fileTimeout = options.fileTimeout ?? 30
    this.#shellTimeout = options.shellTimeout ?? 120
    this.#fileOutputCap = options.fileOutputCap ?? FILE_OUTPUT_CAP
  }

  /** Runs the tool `name` with `args` (the office side of a `tool_call`); `signal` stops the call as an
   *  interrupt does.
   *
   *  Missing, unexpected or (for `shell`) mistyped arguments come back as an `error:` outcome that never
   *  ran. Rejects with a `RangeError` when `name` is not a workspace tool. */
  async call(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolOutcome> {
    if (!Object.hasOwn(SIGNATURES, name)) throw new RangeError(`unknown workspace tool ${repr(name)}`)
    const tool = name as ToolName
    const bound = bind(tool, args)
    if (typeof bound === "string") return unrun(name, args, bound)
    let shell: { command: string; limit: number } | undefined
    if (tool === "shell") {
      const { command, timeout } = bound
      if (typeof command !== "string") return unrun(name, args, "argument 'command' must be a string")
      let limit = this.#shellTimeout
      if (timeout != null) {
        // NaN would make run() reject; infinities clamp as in Python.
        if (typeof timeout !== "bigint" && (typeof timeout !== "number" || Number.isNaN(timeout))) {
          return unrun(name, args, "argument 'timeout' must be a number")
        }
        limit = Math.min(Math.max(Number(timeout), 1), MAX_SHELL_TIMEOUT)
      }
      shell = { command, limit }
    }
    const own = new AbortController()
    const signal = options.signal ? AbortSignal.any([own.signal, options.signal]) : own.signal
    const track = (pid: number) => {
      const key = "call:" + newId()
      // A 0 start time never matches a process, so the reaper never signals such a row.
      this.#store.recordWorker(key, { pid, pgid: pid, startTime: startTime(pid) ?? 0 })
      return () => this.#store.removeWorker(key, pid)
    }
    this.#active.add(own)
    try {
      let output: string
      let result: Result
      if (shell) {
        result = await run(this.#shellPolicy, ["/bin/sh", "-c", shell.command], {
          timeout: shell.limit,
          signal,
          track,
        })
        output = shellOutput(result, shell.limit)
      } else {
        result = await run(this.#filePolicy, this.#argv, {
          stdin: pyJson({ op: tool, ...bound }, true),
          timeout: this.#fileTimeout,
          maxOutput: this.#fileOutputCap,
          signal,
          track,
        })
        if (result.timedOut) output = `error: ${tool} timed out after ${g(this.#fileTimeout)}s`
        else if (result.interrupted) output = "[interrupted]"
        else if (result.truncated) {
          output =
            `error: ${tool} output too large (over ${this.#fileOutputCap} bytes); ` +
            "ask for less (offset and limit, a narrower path, or a glob)"
        } else output = fileOutput(tool, result)
      }
      return { output, audit: { tool, argsSummary: summarize(bound), exit: result.exit, duration: result.duration } }
    } finally {
      this.#active.delete(own)
    }
  }

  /** Kills every call running now; they return `[interrupted]`. */
  interrupt(): void {
    for (const controller of this.#active) controller.abort()
  }
}

/** `args` bound to `tool`'s parameters in signature order with defaults filled, as Python's
 *  `inspect.signature(...).bind`; or its error message: a missing required argument first, then the first
 *  unexpected one. */
function bind(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> | string {
  const params = SIGNATURES[tool]
  for (const [key, ...rest] of params) {
    if (rest.length === 0 && !Object.hasOwn(args, key)) return `missing a required argument: ${repr(key)}`
  }
  const known = new Set(params.map(([key]) => key))
  for (const key of Object.keys(args)) {
    if (!known.has(key)) return `got an unexpected keyword argument ${repr(key)}`
  }
  const bound: Record<string, unknown> = {}
  for (const [key, ...rest] of params) bound[key] = Object.hasOwn(args, key) ? args[key] : rest[0]
  return bound
}

/** The outcome of a call refused before it ran. */
function unrun(tool: string, args: Record<string, unknown>, message: string): ToolOutcome {
  return {
    output: `error: ${tool}: ${message}`,
    audit: { tool, argsSummary: summarize(args), exit: null, duration: 0 },
  }
}

/** Python's `f"{x:g}"` for the timeouts used here. */
function g(x: number): string {
  return Number(x.toPrecision(6)).toString()
}

function fileOutput(tool: string, result: Result): string {
  // The helper's stdout is untrusted: anything but a well-formed reply is a failure.
  let reply: unknown
  try {
    reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout))
  } catch {
    reply = undefined
  }
  if (typeof reply === "object" && reply !== null && !Array.isArray(reply)) {
    const r = reply as Record<string, unknown>
    if (r.ok === true && typeof r.output === "string") return r.output
    if (typeof r.error === "string") return `error: ${r.error}`
  }
  const stderr = [...strip(result.stderr.toString("utf8"))].slice(-500).join("")
  return `error: ${tool} failed (exit ${result.exit}): ${stderr}`
}

/** `text` followed by a newline unless it is empty or already ends with one. */
function lineEnd(text: string): string {
  return text === "" || text.endsWith("\n") ? "" : "\n"
}

function shellOutput(result: Result, limit: number): string {
  let data = result.stdout
  if (result.stderr.length > 0) {
    const sep = data.length === 0 || data.at(-1) === 0x0a ? "" : "\n"
    data = Buffer.concat([data, Buffer.from(sep + "[stderr]\n"), result.stderr])
  }
  let text = headAndTail(data, MAX_SHELL_OUTPUT)
  if (result.truncated) text += lineEnd(text) + "[output truncated]"
  const status = result.timedOut
    ? `[timed out after ${g(limit)}s]`
    : result.interrupted
      ? "[interrupted]"
      : `[exit ${result.exit}]`
  return text + lineEnd(text) + status
}

/** `data` decoded; past `limit` bytes, only its first and last `limit / 2` bytes are kept. */
function headAndTail(data: Buffer, limit: number): string {
  if (data.length <= limit) return data.toString("utf8")
  const half = Math.floor(limit / 2)
  const head = data.subarray(0, half).toString("utf8")
  const tail = data.subarray(data.length - half).toString("utf8")
  return `${head}\n[${data.length - 2 * half} bytes of output cut]\n${tail}`
}

/** Summarizes arguments for the audit log; bulk text is recorded by length only. */
function summarize(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value == null || (key === "offset" && value === 0) || (key === "replace_all" && value === false)) continue
    if (BULK_ARGS.has(key) && typeof value === "string") {
      parts.push(`${key}=<${[...value].length} chars>`)
      continue
    }
    let text =
      typeof value === "string"
        ? repr(value)
        : typeof value === "boolean"
          ? (value ? "True" : "False")
          : typeof value === "number" || typeof value === "bigint"
            ? String(value)
            : pyJson(value)
    const chars = [...text]
    if (chars.length > MAX_ARG_CHARS) text = chars.slice(0, MAX_ARG_CHARS - 3).join("") + "..."
    parts.push(`${key}=${text}`)
  }
  return parts.join(" ")
}
