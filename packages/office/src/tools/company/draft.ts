/** Tools for drafting a new company, which `opencorp init`'s flow does before the company exists; no office group
 *  has them. */
import { type FunctionTool, tool } from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { draftProblems } from "../../company/draft.ts"

/** `check_company`'s arguments; a missing field is checked as empty. */
export interface CheckCompanyArgs {
  readonly company?: string
  readonly owner?: { readonly name?: string; readonly handle?: string; readonly title?: string } | null
  readonly teammates?: readonly { readonly name?: string; readonly handle?: string; readonly title?: string }[] | null
}

/** Check a company before you return it: its name, the owner, and the first teammates. Returns "No problems." or
 *  the problems to fix with the owner. */
export function checkCompany(args: CheckCompanyArgs = {}): string {
  const owner = args.owner ?? {}
  const team = (args.teammates ?? []).map((t) => ({
    name: t.name ?? "",
    handle: t.handle ?? "",
    title: t.title ?? "",
    about: "",
  }))
  const problems = draftProblems({
    company: args.company ?? "",
    owner: { handle: owner.handle ?? "", name: owner.name ?? "", title: owner.title ?? "" },
    team,
  })
  if (problems.length === 0) return "No problems."
  return "Problems; ask the owner how to fix each, then check again:\n" + problems.map((p) => `- ${p}`).join("\n")
}

const DESCRIPTION =
  'Check a company before you return it: its name, the owner, and the first teammates.\n\nReturns "No problems." or ' +
  "the problems to fix with the owner."

// Python's schema for the tool, as its test read it, so the model sees the same schema. Every argument is optional
// because Yian fails the whole agent on a call that misses a required one; a gap is a problem for the model to fix
// instead.
const SCHEMA: JsonObject = {
  $defs: {
    CheckOwner: {
      description: "The owner, as ``check_company`` takes it; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string" },
      },
      title: "CheckOwner",
      type: "object",
    },
    CheckTeammate: {
      description: "A teammate, as ``check_company`` takes it; a missing field is checked as empty.",
      properties: {
        name: { title: "Name", type: "string" },
        handle: { title: "Handle", type: "string" },
        title: { title: "Title", type: "string" },
      },
      title: "CheckTeammate",
      type: "object",
    },
  },
  description: DESCRIPTION,
  properties: {
    company: { default: "", title: "Company", type: "string" },
    owner: { anyOf: [{ $ref: "#/$defs/CheckOwner" }, { type: "null" }], default: null },
    teammates: {
      anyOf: [{ items: { $ref: "#/$defs/CheckTeammate" }, type: "array" }, { type: "null" }],
      default: null,
      title: "Teammates",
    },
  },
  title: "check_company",
  type: "object",
}

/** `checkCompany` as the tool `check_company` the init flow's interview calls. */
export const checkCompanyTool: FunctionTool = tool({
  name: "check_company",
  description: DESCRIPTION,
  parameters: SCHEMA,
  execute: (args) => checkCompany(args as CheckCompanyArgs),
})
