/**
 * Rules for an agent's commands, typed input and tool calls, kept in the company repo in one format: each agent's
 * `people/<handle>/rules.yaml`, which the office commits when the approver picks "always", and the company's
 * `rules.yaml` at the repo's root, for every agent, which only a hand edit committed to the repo changes.
 *
 * Both are read at HEAD, never from the working tree, so an edit in the clone that nobody committed adds no rule. A
 * file missing at HEAD holds no rules. One that exists but doesn't load is reported with lint's message: its sessions'
 * host then blocks them until a commit fixes it, since dropping it would drop its deny rules. Not loading includes a
 * link, a folder, a file over `MAX_RULES_BYTES`, YAML that doesn't parse, and a rule that isn't allow, ask or deny on
 * command, input or tool with a pattern of words one space apart. Lint reads a tree's files the same way: a file under
 * a linked folder is none, as git keeps only the link.
 *
 * A `tool` rule matches a tool call by its words (`toolWords`): its source's kind, then the names its source gives
 * it, so `host codex start`, `mcp github *` or `module crm quote`. Lint warns of one that no call's words can match.
 */
import fs from "node:fs"
import path from "node:path"
import type { ToolSource } from "@ngocbh/yian/tools"
import {
  Handle, now, Rule as RuleSchema, type RuleFileError, RulePattern, Timestamp, validationMessage,
} from "@opencorp/protocol"
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

/** The most bytes a rules file may hold; one over it doesn't load. */
export const MAX_RULES_BYTES = 65_536

/** Why a rules path's entry doesn't load before its text is read. */
const LINK = "is a symbolic link; a rules file must be a regular file"
const FOLDER = "is a folder; a rules file must be a regular file"
const NOT_A_FILE = "isn't a regular file; a rules file must be one"
const TOO_BIG = `is over ${MAX_RULES_BYTES} bytes, the most a rules file may hold`
const UNREADABLE = "can't be read"
/** Why a rule's pattern doesn't load: `matches` could never match it. */
const PATTERN_FORM = "pattern: must be words with one space between each"
/** Lint's warning for a `*` that is part of a word, or a word before the last. */
const LITERAL_STAR = "pattern: a * matches further words only as the last word on its own; this one matches a literal *"
/** Lint's warning for a tool rule no call's words (`toolWords`) can match. */
const TOOL_PATTERN =
  "pattern: a tool rule names a call by its source: host [group] tool, mcp server tool, module alias export, " +
  "memory input tool, or flow [library] flow, each part a word or a last *; this one matches no tool call"
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

/** What a rules path holds: nothing (null), a regular file's bytes, or why it can't be one (an issue). */
export type Found = Uint8Array | RepoIssue | null

/** What a rules file holds: its rules, each with `source`, and lint's warnings on them; or why it doesn't load (lint's
 *  issue). Nothing at the path holds no rules, and so does an empty file, one with only comments, or an empty list. */
export function loadRules(
  file: string,
  found: Found,
  source: "agent" | "company",
): { rules: Rule[]; warnings: RepoIssue[] } | { issue: RepoIssue } {
  if (found === null || (found instanceof Uint8Array && isEmpty(found))) return { rules: [], warnings: [] }
  if (!(found instanceof Uint8Array)) return { issue: found }
  const issues: RepoIssue[] = []
  const read = parseFile(file, found, RulesFile, issues)
  if (read === null) return { issue: issues[0]! }
  const rules: Rule[] = []
  const warnings: RepoIssue[] = []
  for (const [i, item] of (read.rules ?? []).entries()) {
    const at = `rule ${i + 1}: `
    const pattern = (item as { pattern?: unknown } | null)?.pattern
    if (typeof pattern === "string" && pattern !== "" && !RulePattern.safeParse(pattern).success) {
      return { issue: repoIssue(file, "repo.schema", at + PATTERN_FORM) }
    }
    const rule = FileRule.safeParse(item)
    // Only validationMessage's field names and fixed phrases leave, never a value.
    if (!rule.success) {
      return { issue: repoIssue(file, "repo.schema", at + validationMessage(FileRule, rule.error, item)) }
    }
    rules.push({ ...rule.data, source, note: null })
    const words = rule.data.pattern.split(" ")
    if (words.some((word, j) => word.includes("*") && !(word === "*" && j === words.length - 1))) {
      warnings.push(repoIssue(file, "rules.literal_star", at + LITERAL_STAR, "warning"))
    }
    if (rule.data.kind === "tool" && !fitsSomeCall(words)) {
      warnings.push(repoIssue(file, "rules.tool_pattern", at + TOOL_PATTERN, "warning"))
    }
  }
  return { rules, warnings }
}

/** A tool call's words, which a `tool` rule's pattern matches: its source's kind, then the names its source gives
 *  it. A host tool's group comes before its name, and a top-level one has none (`host codex start`, `host
 *  propose_company`); an MCP tool's server before its name; a module's tool is its `uses:` alias and its export, not
 *  the ref the alias names; a memory's tool its memory input and its name; a granted flow its name, after its
 *  library's alias when it is a library's def. */
export function toolWords(source: ToolSource): string[] {
  switch (source.kind) {
    case "host":
      return source.group === null ? ["host", source.tool] : ["host", source.group, source.tool]
    case "mcp":
      return ["mcp", source.server, source.tool]
    case "module":
      return ["module", source.alias, source.export]
    case "memory":
      return ["memory", source.input, source.tool]
    case "flow":
      return source.library === null ? ["flow", source.flow] : ["flow", source.library, source.flow]
  }
}

/** How many names follow each source kind in a call's words (`toolWords`): the fewest and the most. */
const TOOL_NAMES: Readonly<Record<ToolSource["kind"], readonly [number, number]>> = {
  host: [1, 2],
  mcp: [2, 2],
  module: [2, 2],
  memory: [2, 2],
  flow: [1, 2],
}

/** Whether a tool rule's pattern `words` can match some call's words: `*` alone, or a source kind followed by as many
 *  names as that kind has, where a last `*` stands for any further ones (none included). */
function fitsSomeCall(words: readonly string[]): boolean {
  const wild = words.at(-1) === "*"
  const fixed = wild ? words.slice(0, -1) : words
  if (fixed.length === 0) return true
  const kind = fixed[0]!
  if (!Object.hasOwn(TOOL_NAMES, kind)) return false
  const [fewest, most] = TOOL_NAMES[kind as ToolSource["kind"]]
  const names = fixed.length - 1
  return names <= most && (wild || names >= fewest)
}

/** What `rel` holds under `root`, a tree of the company repo, read as the office reads it at a commit: nothing under a
 *  linked or missing folder (git keeps only the link), and a link, a folder or a file over `MAX_RULES_BYTES` as why
 *  it doesn't load. */
export function inTree(root: string, rel: string): Found {
  const parts = rel.split("/")
  for (let i = 1; i < parts.length; i++) {
    const stat = fs.lstatSync(path.join(root, ...parts.slice(0, i)), { throwIfNoEntry: false })
    if (stat === undefined || !stat.isDirectory()) return null
  }
  const file = path.join(root, rel)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat === undefined) return null
  if (stat.isSymbolicLink()) return repoIssue(rel, "repo.unreadable", LINK)
  if (stat.isDirectory()) return repoIssue(rel, "repo.unreadable", FOLDER)
  if (!stat.isFile()) return repoIssue(rel, "repo.unreadable", NOT_A_FILE)
  if (stat.size > MAX_RULES_BYTES) return repoIssue(rel, "repo.unreadable", TOO_BIG)
  let fd: number
  try {
    // No follow, so a link swapped in since isn't read; no block, so a FIFO isn't waited on.
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return repoIssue(rel, "repo.unreadable", UNREADABLE)
  }
  try {
    const data = fs.readFileSync(fd)
    return data.length > MAX_RULES_BYTES ? repoIssue(rel, "repo.unreadable", TOO_BIG) : data
  } catch {
    return repoIssue(rel, "repo.unreadable", UNREADABLE)
  } finally {
    fs.closeSync(fd)
  }
}

/** `handle`'s rules and the company's at `commit` (HEAD by default), each with its source (the agent's first), and
 *  the files that exist but don't load. */
export async function readRules(
  git: CompanyGit,
  handle: string,
  commit = "HEAD",
): Promise<{ rules: Rule[]; errors: RuleFileError[] }> {
  const rules: Rule[] = []
  const errors: RuleFileError[] = []
  for (const [file, source] of [[rulesPath(handle), "agent"], [COMPANY_RULES, "company"]] as const) {
    let found: Found
    try {
      found = await atCommit(git, file, commit)
    } catch {
      // A file git can't read blocks as one that doesn't load: its deny rules may be in it.
      found = repoIssue(file, "repo.unreadable", UNREADABLE)
    }
    const read = loadRules(file, found, source)
    if ("issue" in read) errors.push({ source, path: file, message: read.issue.message })
    else rules.push(...read.rules)
  }
  return { rules, errors }
}

/** Adds `rules` that `handle`'s file (never the company's) doesn't have, as `by`'s, and commits it naming `by`; nothing
 *  when it has them all. Refuses (`RulesRefused`) a file that doesn't load or that the clone has changes to. */
export async function addRules(git: CompanyGit, handle: string, rules: readonly RuleText[], by: string): Promise<void> {
  // Written, a pattern of another form would make the file not load, and block every session of the agent.
  if (rules.some((rule) => !RulePattern.safeParse(rule.pattern).success)) {
    throw new RulesRefused("refused", "a rule's pattern must be words with one space between each")
  }
  await git.locked(async (locked) => {
    const { rules: kept, before } = await current(git, handle)
    const added: Rule[] = []
    for (const rule of rules) {
      if ([...kept, ...added].some((r) => same(r, rule))) continue
      const { effect, kind, pattern } = rule
      added.push({ effect, kind, pattern, source: "agent", by, at: now(), note: null })
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

/** What `file` is at `commit`: nothing (no such path, or one under a linked folder), its bytes, or why it doesn't
 *  load (a link, a folder, too big, a blob the clone lacks). Throws `CompanyGitError` when git fails. */
async function atCommit(git: CompanyGit, file: string, commit: string): Promise<Found> {
  const entry = await git.entry(file, commit)
  if (entry === null) return null
  if (entry.type === "symlink") return repoIssue(file, "repo.unreadable", LINK)
  if (entry.type === "folder") return repoIssue(file, "repo.unreadable", FOLDER)
  if (entry.type !== "file") return repoIssue(file, "repo.unreadable", NOT_A_FILE)
  if (entry.size !== null && entry.size > MAX_RULES_BYTES) return repoIssue(file, "repo.unreadable", TOO_BIG)
  const data = await git.readBlob(entry.blob)
  if (data === null) return repoIssue(file, "repo.unreadable", UNREADABLE)
  return data.length > MAX_RULES_BYTES ? repoIssue(file, "repo.unreadable", TOO_BIG) : data
}

function same(a: RuleText, b: RuleText): boolean {
  return a.effect === b.effect && a.kind === b.kind && a.pattern === b.pattern
}

/** `rules` for a commit subject: `allow "ls *", "make *"`, a typed input's as `allow typing "y"`, a tool call's as
 *  `allow tool "host codex start"`. */
function listed(rules: readonly RuleText[]): string {
  const head = (r: RuleText) =>
    r.kind === "input" ? `${r.effect} typing` : r.kind === "tool" ? `${r.effect} tool` : r.effect
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
  let head: Found
  try {
    head = await atCommit(git, rel, "HEAD")
  } catch {
    throw fix
  }
  const read = loadRules(rel, head, "agent")
  if ("issue" in read) throw fix
  const before = cloneFile(git.root, handle)
  const changed = head === null ? before !== null : before === null || !Buffer.from(head as Uint8Array).equals(before)
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
    `# @${handle}'s rules for commands, typed input and tool calls: allow, ask or deny. A deny wins, then an ask,\n` +
    `# then an allow, whichever file a rule comes from: the session's, @${handle}'s, or the company's rules.yaml.\n`
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
