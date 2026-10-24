/** Problems found while loading or linting a company repo, and company files read into them. */
import { RepoIssue as RepoIssueSchema, validationMessage } from "@opencorp/protocol"
import type { z } from "zod"
import { readYaml, YamlError } from "./flow_yaml.ts"

/** One problem in one repo file: the protocol RepoIssue, defaults filled. */
export type RepoIssue = Readonly<z.output<typeof RepoIssueSchema>>

/** A RepoIssue; severity defaults to "error". */
export function repoIssue(
  path: string,
  code: string,
  message: string,
  severity: "error" | "warning" = "error",
): RepoIssue {
  return { path, code, message, severity }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true })

const PROTO = "has a key named __proto__"
const BIG = "has an integer too large to read exactly"

/**
 * The phrase for the first `__proto__` key or bigint in `value`, depth-first in property order, or null.
 * The recursion is bounded: `readYaml` caps nesting and builds a fresh tree of at most its node cap.
 */
function firstProblem(value: unknown): string | null {
  if (typeof value === "bigint") return BIG
  if (typeof value !== "object" || value === null) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = firstProblem(item)
      if (problem !== null) return problem
    }
    return null
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = key === "__proto__" ? PROTO : firstProblem(item)
    if (problem !== null) return problem
  }
  return null
}

/**
 * `data`, a company file's bytes, read as YAML (`readYaml`) and validated by `schema`; a file that doesn't
 * parse is recorded in `issues` and gives null. Messages name fields only, never a value.
 *
 * A `__proto__` key or an integer outside the safe range (a bigint) anywhere is refused before the schema:
 * zod drops a `__proto__` record key and a number can't hold the integer, so a grant's `where` would
 * otherwise read looser than written and fail open.
 */
export function parseFile<S extends z.ZodObject>(
  path: string,
  data: Uint8Array,
  schema: S,
  issues: RepoIssue[],
): z.output<S> | null {
  let text: string
  try {
    text = UTF8.decode(data)
  } catch {
    issues.push(repoIssue(path, "repo.unreadable", "isn't valid UTF-8"))
    return null
  }
  let doc: unknown
  try {
    doc = readYaml(text)
  } catch (error) {
    if (!(error instanceof YamlError)) throw error
    // A YamlError's message is fixed text and a line number, never the file's text.
    issues.push(repoIssue(path, "repo.unreadable", error.message))
    return null
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    issues.push(repoIssue(path, "repo.schema", "file: isn't a mapping"))
    return null
  }
  for (const [key, value] of Object.entries(doc)) {
    const problem = key === "__proto__" ? PROTO : firstProblem(value)
    if (problem === null) continue
    const field = key === "__proto__" ? "file" : Object.hasOwn(schema.shape, key) ? key : "an extra field"
    issues.push(repoIssue(path, "repo.schema", `${field}: ${problem}`))
    return null
  }
  const result = schema.safeParse(doc)
  if (result.success) return result.data
  // The ZodError quotes unknown keys, so only validationMessage's field names and fixed phrases leave.
  issues.push(repoIssue(path, "repo.schema", validationMessage(schema, result.error, doc)))
  return null
}
