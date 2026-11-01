/** A proposed company, as the owner's interview drafts it, and what's wrong with it. */
import { HireRequest, validationMessage } from "@opencorp/protocol"
import { type Owner, templateFiles } from "../company_template/index.ts"
import { strip } from "../perm/redact.ts"
import { handleProblem } from "./naming.ts"

/** A first teammate: an agent reporting to the CEO, with a sentence that seeds their profile. */
export interface Teammate {
  readonly name: string
  readonly handle: string
  readonly title: string
  readonly about: string
}

/** A proposed company: its name, its CEO and its first teammates. */
export interface Draft {
  readonly company: string
  readonly owner: Owner
  readonly team: readonly Teammate[]
}

/** The init flow's output, as `draftFromOutput` reads it. */
export interface InitOutput {
  readonly company: string
  readonly owner: { readonly name: string; readonly handle: string; readonly title: string }
  readonly teammates: readonly {
    readonly name: string
    readonly handle: string
    readonly title: string
    readonly about: string
  }[]
  readonly password_hash?: string | null
}

/** The draft in the init flow's output, with its `company`, `owner` and `teammates`, and the CEO's
 *  `password_hash` when it has one. */
export function draftFromOutput(output: InitOutput): Draft {
  const { owner } = output
  return {
    company: output.company,
    owner: { handle: owner.handle, name: owner.name, title: owner.title, passwordHash: output.password_hash ?? null },
    team: output.teammates.map((t) => ({ name: t.name, handle: t.handle, title: t.title, about: t.about })),
  }
}

/** A problem after the field it is about, or null when it is about the whole draft. */
export type FieldProblem = readonly [field: string | null, message: string]

/** What's wrong with teammate `t`'s `field` as a hire checks it, or null; the text never repeats the value. */
function teammateProblem(t: Teammate, field: "name" | "title"): string | null {
  const result = HireRequest.shape[field].safeParse(t[field])
  if (result.success) return null
  const issue = result.error.issues[0]!
  if (issue.code === "too_small") return `the teammate @${t.handle} needs a ${field}`
  if (issue.code === "too_big") {
    return `the teammate @${t.handle}'s ${field} is too long (at most ${issue.maximum} characters)`
  }
  return `the teammate @${t.handle}'s ${field} can't hold line breaks or control characters`
}

/** Each problem with `draft`, after the field it is about (company, owner.name, owner.handle, teammate.name,
 *  teammate.title or teammate.handle), or null when it is about the whole. */
export function fieldProblems(draft: Draft): FieldProblem[] {
  const { owner } = draft
  const found: FieldProblem[] = []
  if (strip(draft.company) === "") found.push(["company", "the company needs a name"])
  if (strip(owner.name) === "") found.push(["owner.name", "the owner needs a name"])
  const ownerWhy = handleProblem(owner.handle)
  if (ownerWhy) found.push(["owner.handle", `@${owner.handle} can't be a handle: ${ownerWhy}`])
  // This catch and the whole-hire check below can't fail once the checks before them pass; they are kept as
  // a guard and have no test.
  if (found.length === 0) {
    try {
      templateFiles(draft.company, owner) // validates without writing
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      found.push([null, `that company doesn't work: ${error.message}`])
    }
  }
  const taken = new Set([owner.handle])
  for (const t of draft.team) {
    const mine: FieldProblem[] = []
    for (const field of ["name", "title"] as const) {
      const why = teammateProblem(t, field)
      if (why) mine.push([`teammate.${field}`, why])
    }
    const why = handleProblem(t.handle)
    if (why) mine.push(["teammate.handle", `@${t.handle} can't be a handle: ${why}`])
    else if (taken.has(t.handle)) mine.push(["teammate.handle", `@${t.handle} is taken`])
    taken.add(t.handle)
    if (mine.length === 0 && !ownerWhy) {
      const input = { name: t.name, handle: t.handle, title: t.title, manager: owner.handle }
      const hire = HireRequest.safeParse(input)
      if (!hire.success) {
        mine.push([null, `@${t.handle} can't be hired: ${validationMessage(HireRequest, hire.error, input)}`])
      }
    }
    found.push(...mine)
  }
  return found
}

/** What's wrong with `draft`, one problem each; empty when the company can be made from it. */
export function draftProblems(draft: Draft): string[] {
  return fieldProblems(draft).map(([, why]) => why)
}
