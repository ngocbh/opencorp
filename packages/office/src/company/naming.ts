/** Naming rules: person handles, people's names and handles as Yian reads them, the names of the MCP servers a person
 *  may use, and the names the model sees for host tools. */
import { labelClashes, type LabelForm, labelRefusal } from "@ngocbh/yian/run"
import { Handle, OFFICE } from "@opencorp/protocol"

/** The names the office and Yian speak as, which no person may take, or their messages could pass for the office's:
 *  `office`, the author of the office's notes and the driver of the runs it starts; `opencorp`, the built-in agent
 *  and the driver of its shells; and `yian`, the author of Yian's own chat messages. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([OFFICE, "opencorp", "yian"])

/** Why a reserved handle can't be a person's. */
const RESERVED = "is reserved for the office itself"

/** Whether `handle`, in any case, is a name the office or Yian speaks as (`RESERVED_HANDLES`). */
export function reservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase())
}

/** The problem a person whose handle is reserved has, as the loader and a hire say it. */
export function reservedPerson(handle: string): string {
  return `@${handle} can't be a person: the handle ${RESERVED}`
}

/** Why `handle` can't be a person's handle, or null if it can: it isn't one, or it is reserved. */
export function handleProblem(handle: string): string | null {
  if (reservedHandle(handle)) return RESERVED
  const result = Handle.safeParse(handle)
  if (result.success) return null
  // Only the schema's regex (a constant) leaves; a zod issue's message or the error could carry the input.
  const issue = result.error.issues[0]
  if (issue?.code === "invalid_format" && issue.pattern) return `should match pattern ${issue.pattern}`
  return "isn't a valid handle"
}

/** How two labels Yian finds alike read alike (`LabelForm`), in words. */
const ALIKE: Readonly<Record<LabelForm, string>> = {
  folded: "ignoring case and width",
  skeleton: "by Unicode's confusables",
  folded_skeleton: "by Unicode's confusables, ignoring case",
  upper_skeleton: "by Unicode's confusables, ignoring case",
}

/** A problem Yian's label checks find with the name or handle of the person at `index`: one Yian refuses alone
 *  (`refused`), or one that reads as an earlier person's (`clash`). `message` names both people and Yian's reason. */
export interface LabelProblem {
  readonly index: number
  readonly field: "name" | "handle"
  readonly kind: "refused" | "clash"
  readonly message: string
}

/**
 * Each problem Yian's label checks find with `people`'s names and handles, by person, a name's before a handle's: a
 * name or handle Yian refuses alone (`labelRefusal`), or one that reads as an earlier person's (`labelClashes`), names
 * against names and handles against handles. Yian tells the people who speak in a run apart by these checks, so a
 * person is refused where they are added, never in a chat later. A handle that isn't one or is reserved
 * (`handleProblem`), and a handle taken twice, are left to the checks that say so.
 */
export function labelProblems(people: readonly { readonly handle: string; readonly name: string }[]): LabelProblem[] {
  const found = people.map((): LabelProblem[] => [])
  for (const field of ["name", "handle"] as const) {
    // The person at `i`'s label as a message names it: a name with whose it is, a handle as itself.
    const named = (i: number) => {
      const { handle, name } = people[i]!
      return field === "name" ? `@${handle}'s name ${JSON.stringify(name)}` : `@${handle}`
    }
    const checked: number[] = []
    people.forEach((person, i) => {
      if (field === "handle" && handleProblem(person.handle) !== null) return
      const refusal = labelRefusal(person[field])
      if (refusal === null) checked.push(i)
      else found[i]!.push({ index: i, field, kind: "refused", message: `@${person.handle}'s ${field} ${refusal.reason}` })
    })
    for (const clash of labelClashes(checked.map((i) => people[i]![field]))) {
      const [i, earlier] = [checked[clash.index]!, checked[clash.readsAs]!]
      if (field === "handle" && people[i]!.handle === people[earlier]!.handle) continue
      const message = `${named(i)} reads as ${named(earlier)} ${ALIKE[clash.form]}: Yian can't tell them apart`
      found[i]!.push({ index: i, field, kind: "clash", message })
    }
  }
  return found.flat()
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
