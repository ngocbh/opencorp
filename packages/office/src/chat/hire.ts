/** Hiring: preview a new agent's files and lint them in a scratch copy, then commit them on confirm. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type HireRequest, type HireResponse, Person as PersonSchema } from "@opencorp/protocol"
import { z } from "zod"
import { errno, outsideRoot, resolvePath } from "../company/flows.ts"
import { writeYaml } from "../company/flow_yaml.ts"
import type { CompanyGit } from "../company/git.ts"
import { repoIssue, type RepoIssue } from "../company/issues.ts"
import { lint } from "../company/lint.ts"
import { loadRepo } from "../company/loader.ts"
import { strip } from "../perm/redact.ts"

/** What a hire from the short form gets besides its name, handle, title, and manager. */
export const NEW_AGENT = {
  kind: "agent",
  main: "../../shared/flows/chat.yaml",
  harnesses: ["composer"],
  harness_policy: { sandbox: "workspace-write", network: false },
} as const

type Person = z.output<typeof PersonSchema>
type Request = z.output<typeof HireRequest>
type HireForm = Pick<Request, "name" | "handle" | "title" | "manager">

/** A confirm that can't be committed; `code` is `lint_failed`. */
export class HireRefused extends Error {
  override name = "HireRefused"
  constructor(
    readonly code: "lint_failed",
    message: string,
  ) {
    super(message)
  }
}

/** What a hire answers. */
export type HireResult = z.output<typeof HireResponse>

/**
 * `POST /people`: a preview writes nothing; a confirm of an unchanged, clean preview commits.
 *
 * Previews are kept in memory by handle, so a confirm after an office restart must preview again. Only the
 * latest `maxPreviews` are kept; an older one must preview again too.
 */
export class Hiring {
  readonly #previews = new Map<string, string[]>() // oldest first

  constructor(
    readonly git: CompanyGit,
    readonly maxPreviews = 100,
  ) {}

  /** Preview `request`. */
  hire(request: Request): Promise<HireResult> {
    return this.preview(request)
  }

  /** The person, diff, and lint issues the hire would make; nothing is written. Only issues the hire brings
   *  are errors; ones the repo already had are warnings. */
  async preview(request: Request): Promise<HireResult> {
    // The scratch copy shouldn't catch a commit half done.
    const [person, files, issues] = await this.git.locked(() => this.#draft(request))
    this.#previews.delete(request.handle)
    this.#previews.set(request.handle, form(request))
    while (this.#previews.size > this.maxPreviews) this.#previews.delete(this.#previews.keys().next().value!)
    return { person, diff: diff(files), issues, commit: null }
  }

  async #draft(request: Request): Promise<[Person, Record<string, string>, RepoIssue[]]> {
    const [person, files] = agentFiles(request)
    const base = `people/${person.handle}`
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencorp-hire-")))
    try {
      const scratch = path.join(tmp, "company")
      await fs.promises.cp(this.git.root, scratch, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => path.basename(src) !== ".git",
      })
      const before = loadRepo(scratch)
      try {
        fs.lstatSync(path.join(scratch, base))
        const taken = `@${person.handle} is already taken`
        return [person, files, [repoIssue(`${base}/person.yaml`, "person.duplicate_handle", taken)]]
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error
      }
      const root = resolvePath(scratch)
      for (const [rel, text] of Object.entries(files)) {
        // A symlink in the repo (people/ itself, say) could point the write elsewhere.
        const target = resolvePath(path.join(scratch, rel))
        if (outsideRoot(root, target)) {
          const outside = `${rel} would be written outside the company repo`
          return [person, files, [repoIssue(rel, "person.outside_repo", outside)]]
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, text)
      }
      // An error the repo already had isn't this hire's to fix; it shows as a warning.
      const key = (i: RepoIssue) => JSON.stringify([i.path, i.code, i.message])
      const known = new Set((await lint(before)).map(key))
      const repo = fs.realpathSync(this.git.root)
      const issues = (await lint(loadRepo(scratch))).map((i) => ({
        ...i,
        severity: known.has(key(i)) && !i.path.startsWith(`${base}/`) ? ("warning" as const) : i.severity,
        // yian's CODE-root messages carry absolute paths; name the repo, not a deleted temp copy.
        message: i.message.replaceAll(scratch, repo),
      }))
      return [person, files, issues]
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

function form(request: Request): string[] {
  return [request.name, request.handle, request.title, request.manager]
}

/** Python's line breaks (`str.splitlines`), each piece keeping its end. */
const LINE = /[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/g

/** Each file as an added-file unified diff (difflib's output against nothing), concatenated. */
function diff(files: Record<string, string>): string {
  let out = ""
  for (const [rel, text] of Object.entries(files)) {
    const lines = (text.match(LINE) ?? []).filter((line) => line !== "")
    if (lines.length === 0) continue
    const range = lines.length === 1 ? "1" : `1,${lines.length}`
    out += `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +${range} @@\n` + lines.map((line) => `+${line}`).join("")
  }
  return out
}

/** The agent `request` hires and its files by repo path: person.yaml, and a profile.md headed with its name
 *  and title, followed by `about` if given. */
export function agentFiles(request: HireForm, about = ""): [Person, Record<string, string>] {
  const { name, handle, title, manager } = request
  const person = PersonSchema.parse({ name, handle, title, manager, ...NEW_AGENT })
  const base = `people/${person.handle}`
  const text = strip(about)
  const profile = `# ${person.name}, ${person.title}\n` + (text ? `\n${text}\n` : "")
  const body = withoutDefaults(PersonSchema, person)
  return [person, { [`${base}/person.yaml`]: writeYaml(body), [`${base}/profile.md`]: profile }]
}

/** `value`'s fields in `schema`'s order, each left out when equal to its default, nested objects too, as
 *  pydantic's `exclude_defaults`; objects inside lists aren't covered (a hire's object lists are empty). */
function withoutDefaults(schema: z.ZodObject, value: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    let item = value[key]
    if (field instanceof z.ZodDefault && isDeepStrictEqual(item, field.parse(undefined))) continue
    let inner: unknown = field
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) inner = inner.unwrap()
    if (inner instanceof z.ZodObject && item !== null && typeof item === "object") {
      item = withoutDefaults(inner, item as Record<string, unknown>)
    }
    body[key] = item
  }
  return body
}
