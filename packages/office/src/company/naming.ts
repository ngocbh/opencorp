/** Naming rules: person handles, the names of the MCP servers a person may use, and the names the model sees for host
 *  tools. */
import { Handle } from "@opencorp/protocol"

/** Why `handle` can't be a person's handle, or null if it can. */
export function handleProblem(handle: string): string | null {
  const result = Handle.safeParse(handle)
  if (result.success) return null
  // Only the schema's regex (a constant) leaves; a zod issue's message or the error could carry the input.
  const issue = result.error.issues[0]
  if (issue?.code === "invalid_format" && issue.pattern) return `should match pattern ${issue.pattern}`
  return "isn't a valid handle"
}

/** A name a person's `harness_policy.mcp_servers` allows a server by: letters, digits, `-` and `_`, the names Claude
 *  Code's `claude mcp add` takes, which its tool names (`mcp__<server>__<tool>`) keep as they are; and no `__`, which
 *  would make one server's tools read as another's. Any other allows nothing. */
export const MCP_SERVER_NAME = /^(?!.*__)[A-Za-z0-9_-]+$/

/** A name a model can call a tool by: yian refuses a run that would show a model any other. */
export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** The name a model sees, and yian records, for `tool` of the host tool group `group`: `<group>_<tool>`. */
export function groupToolName(group: string, tool: string): string {
  return `${group}_${tool}`
}

/**
 * The toolbox's name for `tool` on `assetId`: `cluster-a` + `submit_job` → `cluster_a__submit_job`. A model sees it
 * through the toolbox group, as `shownAssetToolName` says.
 *
 * Ids have no `_` (protocol `Id`), so the mapping is one-to-one and the first `__` always ends the asset part.
 */
export function assetToolName(assetId: string, tool: string): string {
  return `${assetId.replaceAll("-", "_")}__${tool}`
}

/** The name a model sees for `tool` on `assetId`, through the toolbox group: `toolbox_cluster_a__submit_job`. */
export function shownAssetToolName(assetId: string, tool: string): string {
  return groupToolName("toolbox", assetToolName(assetId, tool))
}
