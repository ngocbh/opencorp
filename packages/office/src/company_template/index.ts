/**
 * The files a new company repo starts from, and `writeCompany`, which lays them down.
 *
 * Every file under `template/` is a template file, at the same path in the repo. `company.yaml` and
 * `people/{owner}/person.yaml` are filled in with the company name and the owner; the rest (the shared
 * flows) are copied as they are.
 */
import fs from "node:fs"
import path from "node:path"
import { Company, type Device, Person } from "@opencorp/protocol"
import { readYaml } from "../company/flow_yaml.ts"
import { errno } from "../company/flows.ts"
import { CompanyGit, CompanyGitError } from "../company/git.ts"
import { parseFile, type RepoIssue } from "../company/issues.ts"
import { embedded } from "../platform.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import companyYaml from "./template/company.yaml" with { type: "file" }
import ownerYaml from "./template/people/{owner}/person.yaml" with { type: "file" }
import chatYaml from "./template/shared/flows/chat.yaml" with { type: "file" }
import compactHistoryYaml from "./template/shared/flows/compact_history.yaml" with { type: "file" }
import profileManagerYaml from "./template/shared/flows/profile_manager.yaml" with { type: "file" }
import sideChatYaml from "./template/shared/flows/side_chat.yaml" with { type: "file" }

const OWNER_DIR = "people/{owner}"
const FILLED = ["company.yaml", `${OWNER_DIR}/person.yaml`]

// Repo path -> embedded file path; a new file in template/ is added here too. `@types/bun` types every
// `.yaml` import as `any`, whatever its `type`, and a `declare module "*.yaml"` would clash with that, so
// the table's type is what says these are paths. The owner's file comes first, so a bad handle is reported
// against the owner's file rather than against company.yaml's `ceo`, which repeats it.
const TEMPLATE: ReadonlyMap<string, string> = new Map<string, string>([
  [`${OWNER_DIR}/person.yaml`, ownerYaml],
  ["company.yaml", companyYaml],
  ["shared/flows/chat.yaml", chatYaml],
  ["shared/flows/compact_history.yaml", compactHistoryYaml],
  ["shared/flows/profile_manager.yaml", profileManagerYaml],
  ["shared/flows/side_chat.yaml", sideChatYaml],
])

const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** The human who onboards: the company's CEO. */
export interface Owner {
  readonly handle: string
  readonly name: string
  /** The owner's title; "CEO" if not given. */
  readonly title?: string
  /** The devices the owner's first `person.yaml` lists. */
  readonly devices?: readonly Device[]
  /** The hash of the password the owner logs in new devices with. */
  readonly passwordHash?: string | null
}

/** `value` as a YAML double-quoted scalar: a JSON string with the C1 controls and DEL escaped, which YAML
 *  doesn't allow raw. */
function quote(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

/** `text` with each `${key}` replaced by `values[key]` in one pass (as Python's `Template.substitute`), so
 *  a value holding a placeholder stays literal; an unknown key throws. */
function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`the company template names an unknown value \${${key}}`)
    return values[key]!
  })
}

/**
 * Every file of a new company repo by repo path, with `company.yaml` and the owner's file filled in.
 *
 * @throws {RangeError} The company name or the owner doesn't make a valid `Company` or `Person`; the
 *   message names the template file and the fields, never a value.
 */
export function templateFiles(company: string, owner: Owner): Map<string, Buffer> {
  // JSON strings are YAML double-quoted scalars, so any name survives the substitution.
  const values = Object.fromEntries(
    Object.entries({
      company,
      ceo: owner.handle,
      handle: owner.handle,
      name: owner.name,
      title: owner.title ?? "CEO",
    }).map(([key, value]) => [key, quote(value)]),
  )
  const out = new Map<string, Buffer>()
  for (const [rel, file] of TEMPLATE) {
    let data = embedded(file)
    if (FILLED.includes(rel)) {
      let text = fill(data.toString("utf8"), values)
      const devices = owner.devices ?? []
      if (rel !== "company.yaml" && devices.length) {
        const items = devices.map(
          (d) => `- name: ${JSON.stringify(d.name)}\n  token_sha256: ${JSON.stringify(d.token_sha256)}\n`,
        )
        text += "devices:\n" + items.join("")
      }
      if (rel !== "company.yaml" && owner.passwordHash) text += `password_hash: ${JSON.stringify(owner.passwordHash)}\n`
      data = Buffer.from(text)
      const issues: RepoIssue[] = []
      if (parseFile(rel, data, rel === "company.yaml" ? Company : Person, issues) === null) {
        throw new RangeError(`${rel}: ${issues.map((issue) => issue.message).join("; ")}`)
      }
    }
    out.set(rel.replace(OWNER_DIR, `people/${owner.handle}`), data)
  }
  return out
}

/** Whether anything, even a dangling symlink, is at `file` (as Python's `os.path.lexists`). */
function lexists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

/** Whether `file` is a symlink (lstat); any error means it isn't (as Python's `Path.is_symlink`). */
function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** The template files an existing company repo at `root` lacks, sorted: what `writeCompany` would add. */
export function missingFiles(root: string): string[] {
  return [...TEMPLATE.keys()].filter((rel) => !FILLED.includes(rel) && !lexists(path.join(root, rel))).sort()
}

/** What is wrong with a company folder that can't be used; the fix is the caller's to word. */
export type Damage = "not-a-directory" | "unreadable" | "no-git" | "bad-git" | "no-company-yaml" | "company-yaml-deleted"

/**
 * What is at a company folder: nothing yet (`absent`), a repo with no commit (`unfinished`, a first write that
 * stopped), a company (`ok`), or something to fix by hand (`damaged`), whose `detail` names only paths.
 */
export type CompanyState =
  | { kind: "absent" }
  | { kind: "unfinished" }
  | { kind: "ok" }
  | { kind: "damaged"; reason: Damage; detail: string }

/** `error` (an OS error) as the damage `unreadable`; anything else is rethrown. */
function unreadable(file: string, error: unknown): CompanyState {
  const text = strerror(error)
  if (text === undefined) throw error
  return { kind: "damaged", reason: "unreadable", detail: `can't read ${file}: ${text}` }
}

/** The state of the company folder at `root` (see `CompanyState`). */
export async function companyState(root: string): Promise<CompanyState> {
  try {
    fs.lstatSync(root)
  } catch (error) {
    // Nothing can be there; the home's own checks say what's wrong with the path above it.
    if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") return { kind: "absent" }
    return unreadable(root, error)
  }
  let st: fs.Stats | undefined
  try {
    st = fs.statSync(root, { throwIfNoEntry: false })
  } catch (error) {
    if (errno(error) !== "ENOTDIR") return unreadable(root, error)
  }
  // A dangling symlink has no stat at all.
  if (!st?.isDirectory()) return { kind: "damaged", reason: "not-a-directory", detail: `${root} is not a directory` }
  try {
    fs.lstatSync(path.join(root, ".git"))
  } catch (error) {
    if (errno(error) !== "ENOENT") return unreadable(root, error)
    let entries: string[]
    try {
      entries = fs.readdirSync(root)
    } catch (readError) {
      return unreadable(root, readError)
    }
    if (entries.length === 0) return { kind: "absent" }
    // `writeCompany` makes the repo before it writes a file, so these aren't from a first write that stopped.
    return { kind: "damaged", reason: "no-git", detail: `${root} holds files but no git repo` }
  }
  const git = new CompanyGit(root, root)
  try {
    if ((await git.repoState()) === "unborn") return { kind: "unfinished" }
    if ((await git.blobId("company.yaml")) === null) {
      return { kind: "damaged", reason: "no-company-yaml", detail: `the last commit of ${root} has no company.yaml` }
    }
  } catch (error) {
    if (error instanceof CompanyGitError) {
      return { kind: "damaged", reason: "bad-git", detail: `git can't read the repo at ${root}: ${error.message}` }
    }
    return unreadable(root, error)
  }
  try {
    fs.lstatSync(path.join(root, "company.yaml"))
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return { kind: "damaged", reason: "company-yaml-deleted", detail: `company.yaml was deleted from ${root}` }
    }
    return unreadable(root, error)
  }
  return { kind: "ok" }
}

/** The CEO in a new repo's `company.yaml` (an earlier, interrupted write's owner), or null if it doesn't say. */
function stoppedOwner(root: string): string | null {
  try {
    const ceo = (readYaml(UTF8.decode(fs.readFileSync(path.join(root, "company.yaml")))) as { ceo?: unknown }).ceo
    // The handle pattern allows no '/' or '.', so the handle names a directory directly under people/.
    const parsed = Company.safeParse({ name: "-", ceo })
    return parsed.success ? parsed.data.ceo : null
  } catch {
    return null
  }
}

/**
 * Creates or tops up the company repo at `root`; returns the repo paths written, sorted.
 *
 * A new repo (see `companyState`) is created (`git init`) from the template, and every template path in it is
 * committed, so a first write that stopped part way is finished; `company.yaml` and the owner's file are
 * always rewritten from the answers given, and the owner file of the CEO the old `company.yaml` names, if it
 * is someone else, is removed. An existing one gets only the template files it lacks, such as flows added to
 * the template after it was made: nothing is overwritten, so the owner's edits stay. Only what was written
 * is committed. `company` and `owner` are needed only for a new repo, and `extra` (more files by repo path,
 * such as the first teammates') is written only to one.
 *
 * @throws {RangeError} The folder is damaged (see `companyState`), or the repo is new and `company` or `owner`
 *   is not given or not valid. Nothing is written.
 * @throws {CompanyGitError} Git failed.
 */
export async function writeCompany(
  root: string,
  worktrees: string,
  options: { company?: string; owner?: Owner; extra?: Readonly<Record<string, Uint8Array>> } = {},
): Promise<string[]> {
  const { company, owner, extra = {} } = options
  const state = await companyState(root)
  if (state.kind === "damaged") throw new RangeError(state.detail)
  const fresh = state.kind !== "ok"
  let wanted: Map<string, Uint8Array>
  let filled = new Set<string>()
  let stale: string | null = null
  if (!fresh) {
    wanted = new Map([...TEMPLATE].filter(([rel]) => !FILLED.includes(rel)).map(([rel, file]) => [rel, embedded(file)]))
  } else if (company === undefined || owner === undefined) {
    throw new RangeError(`${root} has no company yet; a new company needs a name and an owner`)
  } else {
    wanted = new Map<string, Uint8Array>([...templateFiles(company, owner), ...Object.entries(extra)])
    // Nothing is committed yet, so an earlier, interrupted write's filled files are stale or partial.
    filled = new Set([...FILLED.map((rel) => rel.replace(OWNER_DIR, `people/${owner.handle}`)), ...Object.keys(extra)])
    stale = stoppedOwner(root)
    if (stale === owner.handle) stale = null
  }
  const missing = [...wanted.keys()].filter((rel) => filled.has(rel) || !lexists(path.join(root, rel))).sort()
  const git = new CompanyGit(root, worktrees)
  if (!fs.existsSync(path.join(root, ".git"))) {
    fs.mkdirSync(root, { recursive: true })
    await git.init()
  }
  for (const rel of missing) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, wanted.get(rel)!)
  }
  // The interrupted write's owner file, under a handle since changed; nothing else there is ours, and a
  // symlinked directory isn't one onboard made.
  if (stale !== null && ![path.join(root, "people"), path.join(root, "people", stale)].some(isSymlink)) {
    try {
      fs.unlinkSync(path.join(root, "people", stale, "person.yaml"))
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error
    }
    try {
      fs.rmdirSync(path.join(root, "people", stale))
    } catch {
      // gone, or holds something onboard didn't write
    }
  }
  // A new repo commits everything present: files an earlier, interrupted write left uncommitted too.
  const commit = fresh ? [...wanted.keys()].filter((rel) => lexists(path.join(root, rel))).sort() : missing
  await git.commit(commit, fresh ? "init: create the company" : "onboard: add template files")
  return missing
}
