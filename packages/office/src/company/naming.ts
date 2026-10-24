/** Naming rules: person handles, and the names the model sees for asset tools. */
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

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * The model-visible name of `tool` on `assetId`: `cluster-a` + `submit_job` → `cluster_a__submit_job`.
 *
 * Ids have no `_` (protocol `Id`), so the mapping is one-to-one and the first `__` always ends the asset part.
 */
export function assetToolName(assetId: string, tool: string): string {
  return `${assetId.replaceAll("-", "_")}__${tool}`
}
