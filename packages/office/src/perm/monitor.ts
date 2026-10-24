/** The reference monitor: asset tools checked against the company repo, run with office secrets, audited. */
import type { Asset as AssetSchema, Grant as GrantSchema } from "@opencorp/protocol"
import type { z } from "zod"
import { builtinKinds, type KindTool, type Kinds } from "../assets/registry.ts"
import { type CompanyRepo, loadRepo } from "../company/loader.ts"
import { assetToolName } from "../company/naming.ts"
import type { SecretStore } from "../secrets.ts"
import type { Store } from "../store/store.ts"

type Asset = z.output<typeof AssetSchema>
type Grant = z.output<typeof GrantSchema>

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

  /** Checks, runs, and audits one asset-tool call; returns its result. */
  async call(
    _person: string,
    _runId: string | null,
    _name: string,
    _args: Record<string, unknown>,
    _options: { sessionId?: string | null } = {},
  ): Promise<unknown> {
    throw new Error("not implemented")
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
