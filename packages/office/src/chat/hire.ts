/** Hiring: preview a new agent's files and lint them in a scratch copy, then commit them on confirm. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { type HireRequest, type HireResponse, Person as PersonSchema } from "@opencorp/protocol"
import { z } from "zod"
import { errno, outsideRoot, resolvePath } from "../company/flows.ts"
import { writeYaml } from "../company/flow_yaml.ts"
import { type CompanyGit, CompanyGitError } from "../company/git.ts"
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

  /** Preview `request`, or with `confirm` commit its preview; throw `HireRefused` if a confirm can't. */
  hire(request: Request): Promise<HireResult> {
    return request.confirm ? this.confirm(request) : this.preview(request)
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

  /** Write and commit the previewed hire, unless its fields changed or it brings a lint error. */
  async confirm(request: Request): Promise<HireResult> {
    const previewed = this.#previews.get(request.handle)
    if (!previewed || !isDeepStrictEqual(previewed, form(request))) {
      const changed = "the hire changed since its preview (or was never previewed); preview it again"
      throw new HireRefused("lint_failed", changed)
    }
    const [person, files, issues, commit] = await this.git.locked(async (locked) => {
      await locked.commitHandEdits()
      const [person, files, issues] = await this.#draft(request)
      const error = issues.find((issue) => issue.severity === "error")
      if (error) throw new HireRefused("lint_failed", error.message)
      const head = await this.git.head()
      const people = path.join(this.git.root, "people")
      fs.mkdirSync(people, { recursive: true })
      // A link swapped in since the draft would send the write outside the repo.
      if (fs.realpathSync(people) !== path.join(fs.realpathSync(this.git.root), "people")) {
        const outside = `people/${person.handle}/person.yaml would be written outside the company repo`
        throw new HireRefused("lint_failed", outside)
      }
      // Not recursive: it fails on anything already there, a link included, so the undo only removes a
      // folder this hire made.
      fs.mkdirSync(path.join(people, person.handle))
      try {
        for (const [rel, text] of Object.entries(files)) {
          const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
          const fd = fs.openSync(path.join(this.git.root, rel), flags, 0o644)
          try {
            fs.writeFileSync(fd, text)
          } finally {
            fs.closeSync(fd)
          }
        }
        const commit = await locked.commit(Object.keys(files), subject(person))
        return [person, files, issues, commit] as const
      } catch (failure) {
        // Left on disk, the profile would be committed later as a hand edit.
        await this.#undo(request.handle, Object.keys(files), head)
        throw failure
      }
    })
    this.#previews.delete(request.handle)
    return { person, diff: diff(files), issues, commit }
  }

  /** Remove the files a failed hire commit left, and unstage them; best effort. */
  async #undo(handle: string, paths: string[], head: string): Promise<void> {
    try {
      if ((await this.git.head()) !== head) return // the commit landed before the failure; keep it
      try {
        fs.rmSync(path.join(this.git.root, "people", handle), { recursive: true, force: true })
      } catch (error) {
        if (errno(error) === undefined) throw error
      }
      await this.git.unstage(paths)
    } catch (error) {
      // The caller needs the commit's error, not this one.
      if (!(error instanceof CompanyGitError) && errno(error) === undefined) throw error
    }
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
        if (outsideRoot(root, target) || danglingLink(scratch, path.dirname(rel))) {
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

/**
 * Whether a folder on `rel`'s path under `root` is a symlink that doesn't resolve. A link out of the repo by a
 * relative path (`people -> ../shared-people`) dangles in the scratch copy, and `resolvePath` doesn't follow a
 * dangling link, so it would look inside the repo.
 */
function danglingLink(root: string, rel: string): boolean {
  let dir = root
  for (const part of rel.split("/")) {
    dir = path.join(dir, part)
    try {
      if (!fs.lstatSync(dir).isSymbolicLink()) continue
    } catch (error) {
      if (errno(error) === undefined) throw error
      return false // nothing there, so no link further down either
    }
    try {
      fs.realpathSync(dir)
    } catch (error) {
      if (errno(error) === undefined) throw error
      return true
    }
  }
  return false
}

/** Python's `str.split()` whitespace. */
const SPACES = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

function subject(person: Person): string {
  // One line: a newline in the name or title could forge a Commit-Id trailer.
  return `hire(@${person.handle}): ${person.name}, ${person.title}`.split(SPACES).filter(Boolean).join(" ")
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
