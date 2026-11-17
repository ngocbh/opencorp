/**
 * Rules for an agent's commands and typed input, kept in the company repo in one format: each agent's
 * `people/<handle>/rules.yaml`, which the office commits when the approver picks "always", and the company's
 * `rules.yaml` at the repo's root, for every agent, which only a hand edit committed to the repo changes.
 *
 * Both are read at HEAD, never from the working tree, so an edit in the clone that nobody committed adds no rule. A
 * file missing at HEAD holds no rules. One that exists but doesn't load is reported with lint's message: its sessions'
 * host then blocks them until a commit fixes it, since dropping it would drop its deny rules.
 */
import fs from "node:fs"
import path from "node:path"
import { Handle, now, Rule as RuleSchema, type RuleFileError, Timestamp, validationMessage } from "@opencorp/protocol"
import { z } from "zod"
import { actorLine } from "./access.ts"
import { readYaml, writeYaml } from "./flow_yaml.ts"
import type { CompanyGit, LockedGit } from "./git.ts"
import { parseFile, type RepoIssue, repoIssue } from "./issues.ts"

/** A rule with its source, who added it and when, as the protocol serves it. */
export type Rule = z.output<typeof RuleSchema>
/** A rule's effect, kind and pattern: what it decides. */
export type RuleText = Pick<Rule, "effect" | "kind" | "pattern">

/** The repo path of `handle`'s rules file. */
export const rulesPath = (handle: string) => `people/${handle}/rules.yaml`
/** The repo path of the company's rules file, for every agent. */
export const COMPANY_RULES = "rules.yaml"

/** Why a file at a rules path isn't read: it isn't a file, or git can't read it. */
const UNREADABLE = "can't be read as a file"
const COMPANY_ONLY = "company rules change only by editing rules.yaml in the company repo"

/** A time as a hand-written file often has it, without the milliseconds. */
const SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** One rule as a rules file holds it; `at` may leave out the milliseconds. */
const FileRule = z.strictObject({
  effect: RuleSchema.shape.effect,
  kind: RuleSchema.shape.kind,
  pattern: RuleSchema.shape.pattern,
  by: Handle.nullable().default(null),
  at: z
    .union([Timestamp, z.string().regex(SECONDS).transform((at) => `${at.slice(0, -1)}.000Z`)])
    .nullable()
    .default(null),
})
/** A rules file: its rules, checked one by one so a message names the rule. */
const RulesFile = z.strictObject({ rules: z.array(z.unknown()).nullable().default(null) })

/** Why the office won't change a rules file: `company_rule` for the company's, which only a hand edit changes;
 *  `refused` for an agent's that doesn't load, isn't a regular file, or has changes nobody committed. */
export class RulesRefused extends Error {
  override name = "RulesRefused"

  constructor(
    readonly code: "company_rule" | "refused",
    message: string,
  ) {
    super(message)
  }
}

/** What a rules file's bytes hold: its rules, each with `source`, or why it doesn't load (lint's issue). An empty file,
 *  one with only comments, and an empty list hold none. */
export function parseRules(
  file: string,
  data: Uint8Array,
  source: "agent" | "company",
): { rules: Rule[] } | { issue: RepoIssue } {
  if (isEmpty(data)) return { rules: [] }
  const issues: RepoIssue[] = []
  const read = parseFile(file, data, RulesFile, issues)
  if (read === null) return { issue: issues[0]! }
  const rules: Rule[] = []
  for (const [i, item] of (read.rules ?? []).entries()) {
    const rule = FileRule.safeParse(item)
    // Only validationMessage's field names and fixed phrases leave, never a value.
    if (!rule.success) {
      return { issue: repoIssue(file, "repo.schema", `rule ${i + 1}: ${validationMessage(FileRule, rule.error, item)}`) }
    }
    rules.push({ ...rule.data, source })
  }
  return { rules }
}

/** The issue for a rules path that holds no file the office can read. */
export function unreadableRules(file: string): RepoIssue {
  return repoIssue(file, "repo.unreadable", UNREADABLE)
}

/** `handle`'s rules and the company's, at HEAD, each with its source (the agent's first), and the files that exist
 *  but don't load. */
export async function readRules(git: CompanyGit, handle: string): Promise<{ rules: Rule[]; errors: RuleFileError[] }> {
  const rules: Rule[] = []
  const errors: RuleFileError[] = []
  for (const [file, source] of [[rulesPath(handle), "agent"], [COMPANY_RULES, "company"]] as const) {
    let read: { rules: Rule[] } | { issue: RepoIssue }
    try {
      const data = await atHead(git, file)
      read = data === null ? { rules: [] } : parseRules(file, data, source)
    } catch {
      // A file git can't read blocks as one that doesn't load: its deny rules may be in it.
      read = { issue: unreadableRules(file) }
    }
    if ("issue" in read) errors.push({ source, path: file, message: read.issue.message })
    else rules.push(...read.rules)
  }
  return { rules, errors }
}

/** Adds `rules` that `handle`'s file (never the company's) doesn't have, as `by`'s, and commits it naming `by`; nothing
 *  when it has them all. Refuses (`RulesRefused`) a file that doesn't load or that the clone has changes to. */
export async function addRules(git: CompanyGit, handle: string, rules: readonly RuleText[], by: string): Promise<void> {
  await git.locked(async (locked) => {
    const { rules: kept, before } = await current(git, handle)
    const added: Rule[] = []
    for (const rule of rules) {
      if ([...kept, ...added].some((r) => same(r, rule))) continue
      added.push({ effect: rule.effect, kind: rule.kind, pattern: rule.pattern, source: "agent", by, at: now() })
    }
    if (added.length === 0) return
    const subject = `Rules: ${listed(added)} for @${handle} (from @${by}'s approval)`
    await write(locked, git, handle, [...kept, ...added], subject + actorLine(by), before)
  })
}

/** Removes `rule` from `handle`'s file and commits it naming `by`; false when the file doesn't have it. A company rule
 *  is refused (`RulesRefused` `company_rule`), and so is a file that doesn't load or that the clone has changes to. */
export async function removeRule(
  git: CompanyGit,
  handle: string,
  rule: RuleText & { source: "agent" | "company" },
  by: string,
): Promise<boolean> {
  if (rule.source === "company") throw new RulesRefused("company_rule", COMPANY_ONLY)
  return git.locked(async (locked) => {
    const { rules, before } = await current(git, handle)
    const kept = rules.filter((r) => !same(r, rule))
    if (kept.length === rules.length) return false
    const subject = `Rules: remove ${listed([rule])} for @${handle} (by @${by})`
    await write(locked, git, handle, kept, subject + actorLine(by), before)
    return true
  })
}

/** Whether `data` is a YAML document with nothing in it: empty, or only comments. */
function isEmpty(data: Uint8Array): boolean {
  try {
    return readYaml(new TextDecoder("utf-8", { fatal: true }).decode(data)) === null
  } catch {
    // parseFile says why.
    return false
  }
}

/** `file`'s bytes at HEAD, or null when HEAD has no such path; throws when git can't read it as a file. */
async function atHead(git: CompanyGit, file: string): Promise<Buffer | null> {
  const blob = await git.blobId(file)
  if (blob === null) return null
  const data = await git.readBlob(blob)
  if (data === null) throw new RangeError(UNREADABLE)
  return data
}

function same(a: RuleText, b: RuleText): boolean {
  return a.effect === b.effect && a.kind === b.kind && a.pattern === b.pattern
}

/** `rules` for a commit subject: `allow "ls *", "make *"`, a typed input's as `allow typing "y"`. */
function listed(rules: readonly RuleText[]): string {
  const head = (r: RuleText) => (r.kind === "input" ? `${r.effect} typing` : r.effect)
  return rules
    .map((r, i) => (i > 0 && head(rules[i - 1]!) === head(r) ? "" : `${head(r)} `) + JSON.stringify(r.pattern))
    .join(", ")
}

/** The rules HEAD holds in `handle`'s file, and the clone's bytes of it (null when absent), to write back changed.
 *  Refuses a file that doesn't load, and one the clone has changes to that nobody committed, which a write would lose
 *  or commit unseen. */
async function current(git: CompanyGit, handle: string): Promise<{ rules: Rule[]; before: Buffer | null }> {
  const rel = rulesPath(handle)
  const fix = new RulesRefused("refused", `fix ${rel} first`)
  let head: Buffer | null
  try {
    head = await atHead(git, rel)
  } catch {
    throw fix
  }
  const read = head === null ? { rules: [] } : parseRules(rel, head, "agent")
  if ("issue" in read) throw fix
  const before = cloneFile(git.root, handle)
  const changed = head === null ? before !== null : before === null || !head.equals(before)
  if (changed) throw new RulesRefused("refused", `${rel} has changes nobody committed; commit or discard them first`)
  return { rules: read.rules, before }
}

/** The bytes of `handle`'s rules file in the clone, or null when it has none. Refuses a folder or file that is a link
 *  or isn't a regular file, since a write through one would change a file outside the repo. */
function cloneFile(root: string, handle: string): Buffer | null {
  const rel = rulesPath(handle)
  const folder = path.join(root, "people", handle)
  let real: string
  try {
    real = fs.realpathSync(folder)
  } catch {
    throw new RulesRefused("refused", `@${handle} has no folder in the company repo`)
  }
  if (real !== path.join(fs.realpathSync(root), "people", handle)) {
    throw new RulesRefused("refused", `people/${handle} must be a folder in the company repo`)
  }
  const stat = fs.lstatSync(path.join(folder, "rules.yaml"), { throwIfNoEntry: false })
  if (stat === undefined) return null
  if (!stat.isFile()) throw new RulesRefused("refused", `${rel} must be a regular file`)
  return fs.readFileSync(path.join(folder, "rules.yaml"))
}

/** Writes `rules` as `handle`'s file and commits it through `locked` with `message`; the clone's file is put back as
 *  it was (`before`, null for none) if that fails, unless the commit is known to have landed. */
async function write(
  locked: LockedGit,
  git: CompanyGit,
  handle: string,
  rules: readonly Rule[],
  message: string,
  before: Buffer | null,
): Promise<void> {
  const rel = rulesPath(handle)
  const file = path.join(git.root, rel)
  const text = header(handle) + writeYaml({ rules: rules.map(stored) })
  const head = await git.head()
  try {
    overwrite(file, text)
    await locked.commit([rel], message)
  } catch (error) {
    // Put back over a commit that landed, the old file would be read, and committed, by the next change.
    const landed = await git.head().catch(() => null)
    if (landed === null || landed === head) {
      if (before === null) fs.rmSync(file, { force: true })
      else overwrite(file, before)
    }
    throw error
  }
}

/** A rule as its file holds it: no source, and no `by` or `at` it lacks. */
function stored(rule: Rule): Record<string, string> {
  const { effect, kind, pattern, by, at } = rule
  return { effect, kind, pattern, ...(by === null ? {} : { by }), ...(at === null ? {} : { at }) }
}

/** The comment an agent's rules file starts with. */
function header(handle: string): string {
  return (
    `# @${handle}'s rules for commands and typed input: allow, ask or deny. A deny wins, then an ask, then an allow,\n` +
    `# whichever file a rule comes from: the session's, @${handle}'s, or the company's rules.yaml.\n`
  )
}

/** Writes `data` to `file`, creating it, never through a symlink. */
function overwrite(file: string, data: string | Buffer): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644)
  try {
    fs.writeFileSync(fd, data)
  } finally {
    fs.closeSync(fd)
  }
}
