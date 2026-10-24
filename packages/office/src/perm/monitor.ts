/** The reference monitor: asset tools checked against the company repo, run with office secrets, audited. */
import type { Asset as AssetSchema, Grant as GrantSchema } from "@opencorp/protocol"
import type { z } from "zod"
import { builtinKinds, type KindTool, type Kinds } from "../assets/registry.ts"
import { type CompanyRepo, loadRepo } from "../company/loader.ts"
import { assetToolName } from "../company/naming.ts"
import { type SecretStore, SecretNotSetError } from "../secrets.ts"
import type { Store } from "../store/store.ts"
import type { ToolOutcome, WorkspaceCall, WorkspaceTools } from "../tools/workspace.ts"
import { auditArgs, DETAIL_CHARS, pyJson, redact, repr, splitLines, strip } from "./redact.ts"

type Asset = z.output<typeof AssetSchema>
type Grant = z.output<typeof GrantSchema>

/** Characters of a killed workspace call's reason kept in its audit row. */
export const REASON_CHARS = 200

/** A failure the monitor words itself, shown to the model as `error: <message>`. */
class MonitorError extends Error {
  override name = "MonitorError"
}

/** An asset tool as the office serves it: what `groupSpecs` reads, and `call` to run it. */
export interface ToolboxTool {
  readonly description: string
  readonly parameters: Record<string, unknown>
  call(args: Record<string, unknown>): Promise<unknown>
}

/**
 * The only holder of asset credentials: every asset-tool call is checked, run, and audited here.
 *
 * Grants are read from the company repo at `root` on every call, so a revocation applies to the next call.
 * `kinds` maps `Asset.kind` to its tools (default: the built-in kinds).
 */
export class Monitor {
  readonly root: string
  readonly store: Store
  readonly secrets: SecretStore
  readonly kinds: Kinds

  constructor(root: string, store: Store, secrets: SecretStore, kinds: Kinds = builtinKinds()) {
    this.root = root
    this.store = store
    this.secrets = secrets
    this.kinds = kinds
  }

  /** The asset tools `person` holds grants for, as `{name: tool}`: the `toolbox` group. Pass it to `groupSpecs`
   *  for `Job.groups`. Each tool's `call` calls `call` with `runId` and `sessionId`. Gated tools and tools of
   *  unknown kinds are never listed. */
  tools(
    person: string,
    { runId = null, sessionId = null }: { runId?: string | null; sessionId?: string | null } = {},
  ): Record<string, ToolboxTool> {
    const repo = loadRepo(this.root)
    const covering = subjects(repo, person)
    const found: Record<string, ToolboxTool> = {}
    for (const aid of [...repo.assets.keys()].sort()) {
      const asset = repo.assets.get(aid)!
      for (const [tool, spec] of Object.entries(asset.tools)) {
        const impl = kindTool(this.kinds, asset.kind, tool)
        if (impl === undefined || spec.risk === "gated" || grants(asset, tool, covering).length === 0) continue
        const name = assetToolName(aid, tool)
        const description = impl.description || name
        // The description joins the schema, as langchain's tool_call_schema does for a dict schema.
        const parameters = { ...(impl.parameters ?? { type: "object", properties: {} }), description }
        found[name] = { description, parameters, call: (args) => this.call(person, runId, name, args, { sessionId }) }
      }
    }
    return found
  }

  /**
   * Checks, runs, and audits one asset-tool call; returns its result.
   *
   * A denial is the result `permission denied: <reason>` and a failure is `error: <reason>`, so the model sees them
   * and the run goes on. An `AbortError` is audited, then thrown again as a fresh `AbortError` holding only the
   * redacted reason. Secret values are redacted from the result, the audit row and every reason, and so are
   * arguments named after the asset's secrets.
   */
  async call(
    person: string,
    runId: string | null,
    name: string,
    args: Record<string, unknown>,
    options: { sessionId?: string | null } = {},
  ): Promise<unknown> {
    args = { ...args }
    const repo = loadRepo(this.root)
    const [asset, tool] = find(repo, name)
    const keys = new Set(asset?.secrets ?? [])
    const values: string[] = []

    const audit = (outcome: string, detail: string) => {
      this.store.recordAudit({
        person,
        kind: "asset",
        tool: name,
        args: storable(auditArgs(toJson(args) as Record<string, unknown>, keys, values)) as Record<string, unknown>,
        outcome,
        sessionId: options.sessionId ?? null,
        runId,
        detail: redact(detail, keys, values).slice(0, DETAIL_CHARS),
      })
    }

    const denied = denial(repo, person, asset, tool, name, args)
    if (denied !== null) {
      audit("denied", denied)
      return `permission denied: ${denied}`
    }
    let result: unknown
    let detail: string
    try {
      // A null denial means a grant on this asset allows this tool.
      const impl = kindTool(this.kinds, asset!.kind, tool!)
      if (impl === undefined) throw new MonitorError(`asset kind ${repr(asset!.kind)} has no tool ${repr(tool!)}`)
      const secrets = new Map<string, string>()
      for (const key of asset!.secrets) {
        const value = await this.#secret(key)
        secrets.set(key, value)
        if (value) values.push(value)
      }
      // Plain JSON first, so a set, bytes, or an object's text is scrubbed too.
      result = redact(toJson(await impl.run(asset!, args, secrets)), keys, values)
      detail = typeof result === "string" ? result : pyJson(result)
    } catch (error) {
      const reason = redact(reasonOf(error), keys, values)
      audit("error", reason)
      // The kind's own error, whose message may hold a secret, never leaves.
      if (isAbort(error)) throw new DOMException(reason, "AbortError")
      return `error: ${reason}`
    }
    audit("ok", detail)
    return result
  }

  /**
   * A `call(name, args)` for `workspaceToolFunctions` that audits each workspace call.
   *
   * The row's outcome is `ok` for exit 0 and `error` otherwise. A call with no exit status (timed out,
   * interrupted, or bad arguments) has the reason from its output in the detail. A call that rejects is recorded
   * as `error` and its error thrown again.
   */
  workspace(
    tools: Pick<WorkspaceTools, "call">,
    person: string,
    runId: string | null,
    { sessionId = null }: { sessionId?: string | null } = {},
  ): WorkspaceCall {
    return async (name, args, options) => {
      let outcome: ToolOutcome
      try {
        outcome = await tools.call(name, args, options)
      } catch (error) {
        this.store.recordAudit({
          person,
          kind: "workspace",
          tool: name,
          args: {},
          outcome: "error",
          sessionId,
          runId,
          detail: reasonOf(error).slice(0, DETAIL_CHARS),
        })
        throw error
      }
      const audit = outcome.audit
      let detail = `exit=${audit.exit ?? "None"} duration=${audit.duration.toFixed(3)}s`
      if (audit.exit === null) detail += `: ${[...lastLine(outcome.output)].slice(0, REASON_CHARS).join("")}`
      this.store.recordAudit({
        person,
        kind: "workspace",
        tool: audit.tool,
        args: { summary: audit.argsSummary },
        outcome: audit.exit === 0 ? "ok" : "error",
        sessionId,
        runId,
        detail,
      })
      return outcome.output
    }
  }

  async #secret(name: string): Promise<string> {
    try {
      return await this.secrets.get(name)
    } catch (error) {
      if (error instanceof SecretNotSetError) throw new MonitorError(error.message)
      throw error
    }
  }
}

/** The grantee names that cover `person`: the handle, and `group:<id>` for each group the person is in, directly
 *  or through a child group. */
export function subjects(repo: CompanyRepo, person: string): Set<string> {
  const found = repo.people.get(person)
  if (found === undefined) return new Set()
  const covering = new Set([person])
  const todo = [...found.groups]
  while (todo.length > 0) {
    const gid = todo.pop()!
    if (covering.has(`group:${gid}`)) continue // also stops a parent cycle, which lint reports
    covering.add(`group:${gid}`)
    const parent = repo.groups.get(gid)?.parent
    if (parent != null) todo.push(parent)
  }
  return covering
}

/** The grants on `asset` that allow `tool` (by name or `admin`) to any of the grantee names `covering`. */
export function grants(asset: Asset, tool: string, covering: ReadonlySet<string>): Grant[] {
  return asset.grants.filter((g) => covering.has(g.who) && (g.can.includes(tool) || g.can.includes("admin")))
}

/** The kind tool `tool` of asset kind `kind`, or undefined; own keys only, so `constructor` names no tool. */
function kindTool(kinds: Kinds, kind: string, tool: string): KindTool | undefined {
  if (!Object.hasOwn(kinds, kind)) return undefined
  const tools = kinds[kind]!
  return Object.hasOwn(tools, tool) ? tools[tool] : undefined
}

/** The asset and tool that `name` calls, or `[null, null]`. */
function find(repo: CompanyRepo, name: string): [Asset | null, string | null] {
  for (const [aid, asset] of repo.assets) {
    for (const tool of Object.keys(asset.tools)) if (assetToolName(aid, tool) === name) return [asset, tool]
  }
  return [null, null]
}

/** Whether `value` is an object of the plain kind JSON makes (prototype `Object.prototype` or null); arrays are
 *  not. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Equal in value and type, all the way down, so `true` and `"1"` are not `1`. JSON numbers are one type: `1`
 *  equals `1.0`, and a bigint equals the same number. */
function same(value: unknown, allowed: unknown): boolean {
  const numeric = (v: unknown) => typeof v === "number" || typeof v === "bigint"
  // Loose equality compares a number and a bigint by value.
  if (numeric(value) && numeric(allowed)) return (value as number) == (allowed as number)
  if (typeof value !== typeof allowed || value === null || allowed === null) return value === allowed
  if (Array.isArray(value) || Array.isArray(allowed)) {
    if (!Array.isArray(value) || !Array.isArray(allowed) || value.length !== allowed.length) return false
    for (let i = 0; i < value.length; i++) if (!same(value[i], allowed[i])) return false
    return true
  }
  if (isPlain(value) && isPlain(allowed)) {
    const keys = Object.keys(value)
    return keys.length === Object.keys(allowed).length
      && keys.every((k) => Object.hasOwn(allowed, k) && same(value[k], allowed[k]))
  }
  return value === allowed
}

/** Why `person` may not make this call, or null if a grant allows it. */
function denial(
  repo: CompanyRepo,
  person: string,
  asset: Asset | null,
  tool: string | null,
  name: string,
  args: Record<string, unknown>,
): string | null {
  const allowing = asset && tool ? grants(asset, tool, subjects(repo, person)) : []
  if (allowing.length === 0) return `no grant for ${name}`
  if (asset!.tools[tool!]!.risk === "gated") return `${name} is gated`
  const reasons: string[] = []
  for (const grant of allowing) {
    const where = grant.where ?? {}
    const failed = Object.keys(where).filter(
      (key) => !Object.hasOwn(args, key) || !where[key]!.some((a) => same(args[key], a)),
    )
    if (failed.length === 0) return null
    const key = failed[0]!
    reasons.push(`${key} must be one of ${pyJson(where[key])}`)
  }
  return `${name}: ${reasons[0]}`
}

/** A value (a kind tool's result, or a call's args for the audit) as JSON data, as Python's
 *  `json.dumps(value, default=str)` reads back: `undefined` is null, a set an array, a map an object, bytes their
 *  UTF-8 text, a function `"[function]"`, anything else its text.
 *  Throws `TypeError` on a cycle. */
function toJson(value: unknown, path: Set<object> = new Set()): unknown {
  if (value === undefined) return null
  const t = typeof value
  if (value === null || t === "string" || t === "boolean" || t === "number" || t === "bigint") return value
  // Python's str gives `<function …>`, never the source.
  if (typeof value === "function") return "[function]"
  if (typeof value !== "object") return String(value)
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value)
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (path.has(value)) throw new TypeError("Circular reference detected")
  path.add(value)
  try {
    if (Array.isArray(value)) {
      // An index loop, so a hole becomes null; map would keep it.
      const out: unknown[] = []
      for (let i = 0; i < value.length; i++) out.push(toJson(value[i], path))
      return out
    }
    if (value instanceof Set) return [...value].map((v) => toJson(v, path))
    // fromEntries defines own properties, so a `__proto__` key stays a key.
    if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toJson(v, path)]))
    if (isPlain(value)) return Object.fromEntries(Object.keys(value).map((k) => [k, toJson(value[k], path)]))
    return String(value)
  } finally {
    path.delete(value)
  }
}

/** The last line of `text` that isn't blank, stripped, or "". */
export function lastLine(text: string): string {
  // A killed shell call ends its output with "[timed out after Ns]" or "[interrupted]";
  // a file tool's or a bad-arguments reply is one line.
  for (const line of splitLines(text).reverse()) if (strip(line)) return strip(line)
  return ""
}

/** Audit args the store can write as JSON: a bigint (a frame's int) is a number when it is a safe integer, else
 *  its digits. */
function storable(value: unknown): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) out.push(storable(value[i]))
    return out
  }
  if (isPlain(value)) return Object.fromEntries(Object.keys(value).map((k) => [k, storable(value[k])]))
  return value
}

/** Why a call failed. The monitor's own failures read as plain sentences; anything else, a kind's own error
 *  included, is named by its type. Never throws. */
function reasonOf(error: unknown): string {
  try {
    if (error instanceof MonitorError) return error.message
    if (error instanceof Error) return error.message ? `${error.name}: ${error.message}` : error.name
    // Named by its type, as Python names an exception; its text could print bytes as numbers.
    return typeof error
  } catch {
    return "Error" // a name or message getter that throws
  }
}

/** Whether `error` interrupts the call: the `AbortError` an abort signal or fetch throws. */
function isAbort(error: unknown): boolean {
  try {
    return error instanceof Error && error.name === "AbortError"
  } catch {
    // A `name` getter that throws: not an abort, and the call's error path must not throw.
    return false
  }
}
