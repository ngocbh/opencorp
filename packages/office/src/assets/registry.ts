/** The asset-kind registry: for each `Asset.kind`, the tools it implements. */
import type { Asset as AssetSchema } from "@opencorp/protocol"
import type { z } from "zod"
import { TOOLS as FAKE } from "./fake.ts"

type Asset = z.output<typeof AssetSchema>

/** One tool of an asset kind. `run(asset, args, secrets)` executes a call in the office and returns JSON data
 *  (or a Promise of it); `secrets` maps each of `asset.secrets` to its value. What `run` throws becomes an
 *  `error:` result, except an `AbortError`, which interrupts the call (it is audited and rethrown): a kind that
 *  aborts its own work, a fetch on a timeout say, rethrows that as a plain `Error`. */
export interface KindTool {
  readonly run: (asset: Asset, args: Record<string, unknown>, secrets: ReadonlyMap<string, string>) => unknown
  /** Shown to the model; empty means the tool's name. */
  readonly description?: string
  /** The JSON Schema of the arguments; default `{type: "object", properties: {}}`. */
  readonly parameters?: Record<string, unknown>
}

/** `{asset kind: {tool name: KindTool}}`. */
export type Kinds = Readonly<Record<string, Readonly<Record<string, KindTool>>>>

/** The asset kinds that ship with the office. */
export function builtinKinds(): Kinds {
  return { fake: FAKE }
}
