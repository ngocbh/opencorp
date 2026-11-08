/** The office's clone of the company repo: pinned worktrees, the repo lock, commits. */
import { AsyncLocalStorage } from "node:async_hooks"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type CommitInfo, stamp } from "@opencorp/protocol"
import { selfSpawnEnv } from "../platform.ts"

const IDENTITY = ["-c", "user.name=OpenCorp office", "-c", "user.email=office@opencorp.local"]
// Repo-local config and hooks still apply after the env is cleaned; never sign, run hooks or an fsmonitor.
// With no global config git still reads ~/.config/git/attributes and ignore, so point both at nothing.
// A signed commit in the history would run the repo's gpg programs under log.showSignature, and a repo's
// encodings would re-encode the messages the office writes and reads, trailers included.
const LOCKDOWN = [
  "-c", "commit.gpgsign=false",
  "-c", "log.showSignature=false",
  "-c", `gpg.program=${os.devNull}`,
  "-c", `gpg.openpgp.program=${os.devNull}`,
  "-c", `gpg.ssh.program=${os.devNull}`,
  "-c", `gpg.x509.program=${os.devNull}`,
  "-c", "i18n.commitEncoding=UTF-8",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", `core.attributesFile=${os.devNull}`,
  "-c", `core.excludesFile=${os.devNull}`,
]
// The commands that read or write working files, where a repo's filter drivers would run.
const FILTERED = new Set(["add", "checkout-index", "commit", "reset", "rm", "status", "worktree"])
const PIN_MARKER = ".opencorp-pin"
const WRITE = 0o222
// Every file in a person's memory folder, people/<handle>/memory/, but none named `.yian` or in a `.yian/` folder,
// where yian keeps a memory's journal, lock and identity. `:(glob)` makes `*` match one path segment and `**/` any
// number of them.
const PROFILES = [
  ":(glob)people/*/memory/**",
  ":(glob,exclude)people/*/memory/**/.yian",
  ":(glob,exclude)people/*/memory/**/.yian/**",
]
const BLOB_ID = /^[0-9a-f]{40}$/
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** How long `prune` spares a pin after `pin` handed it out. It covers the gap until the store records the use:
 *  the session row of a new session, a worker's record, a connection check, or an HQ replay reading under it. */
export const PIN_GRACE_MS = 10 * 60_000
const KINDS: Record<string, TreeEntry["type"]> = {
  "040000": "folder",
  "100644": "file",
  "100755": "file",
  "120000": "symlink",
  "160000": "submodule",
}
// How long `#run` waits, in turn, before running again a command that found a git lock file taken.
const LOCK_WAITS = [50, 100, 200, 400, 800]
// Greedy, so a quote in the clone's path doesn't end the lock's path early.
const LOCK_TAKEN = /Unable to create '(.+\.lock)': File exists/
const INDEX_LOCKED = "the company repo is locked by .git/index.lock; if no git command is running there, remove it"
const LOCKED =
  "the company repo is locked by a stale git lock file; " +
  "if no git command is running there, remove the .lock file under .git"
// What git keeps under the git dir while a human's operation is in progress, and what each refusal says is.
const OPERATIONS: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or git am"],
  ["CHERRY_PICK_HEAD", "a cherry-pick or revert"],
  ["REVERT_HEAD", "a cherry-pick or revert"],
  ["sequencer", "a cherry-pick or revert"],
]
// The `status --porcelain` codes of a path with an unresolved conflict.
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])
// argv can't carry bytes that aren't UTF-8, so paths go to git on stdin, NUL-separated.
const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"]
// The whitespace Python's str.split() splits on, so a newline in a folder name can't start a trailer line.
export const WHITESPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/** `text` without NULs, with each run of `WHITESPACE` (line breaks included) as one space, and none at either end. */
export function oneLine(text: string): string {
  // A NUL in git's argv fails the spawn; drop it rather than read it as a space.
  return text.replaceAll("\0", "").split(WHITESPACE).filter(Boolean).join(" ")
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
// Bad bytes become U+FFFD, so text that wasn't UTF-8 can still go into JSON.
const UTF8_REPLACING = new TextDecoder("utf-8", { ignoreBOM: true })

/** One entry of a commit's tree: its repo path, kind, object id and blob size (null for a folder or
 *  submodule). `path` is surrogateescape-decoded, so a name that isn't UTF-8 holds lone surrogates. */
export interface TreeEntry {
  readonly path: string
  readonly type: "folder" | "file" | "symlink" | "submodule"
  readonly blob: string
  readonly size: number | null
}

/** Whether `value` is a full hex commit id (sha-1 or sha-256), as opposed to any other rev expression. */
export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && COMMIT_ID.test(value)
}

/** `commit` if it is a full hex commit id; a RangeError otherwise, so no rev expression reaches git. */
function fullId(commit: string): string {
  if (!isCommitId(commit)) throw new RangeError(`not a full commit id: ${JSON.stringify(commit)}`)
  return commit
}

/** The length of the UTF-8 sequence that `lead` starts, or 0 if no valid sequence starts with it. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

/** `bytes` as UTF-8 text, each byte that isn't part of a valid sequence as U+DC00 + the byte (Python's
 *  surrogateescape), so `encodePath` gives the same bytes back. */
function decodePath(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    let text = ""
    let at = 0
    while (at < bytes.length) {
      const length = sequenceLength(bytes[at]!)
      if (length && at + length <= bytes.length) {
        try {
          text += UTF8.decode(bytes.subarray(at, at + length))
          at += length
          continue
        } catch {}
      }
      text += String.fromCharCode(0xdc00 + bytes[at]!)
      at += 1
    }
    return text
  }
}

/** `text` as UTF-8, each lone U+DC80–U+DCFF as the byte it escapes (see `decodePath`). */
function encodePath(text: string): Buffer {
  const parts: Buffer[] = []
  let start = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code >= 0xdc80 && code <= 0xdcff) {
      const before = at > 0 ? text.charCodeAt(at - 1) : 0
      if (before >= 0xd800 && before <= 0xdbff) continue // the low half of a surrogate pair
      parts.push(Buffer.from(text.slice(start, at)), Buffer.of(code - 0xdc00))
      start = at + 1
    }
  }
  parts.push(Buffer.from(text.slice(start)))
  return Buffer.concat(parts)
}

/** The info fields and path of each entry of `git ls-tree -z` or `git ls-files -s -z` output (`<info>\t<path>`,
 *  NUL-terminated). */
function lsTreeEntries(out: Buffer): { info: string[]; path: string }[] {
  return decodePath(out)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t")
      return { info: entry.slice(0, tab).trim().split(/\s+/), path: entry.slice(tab + 1) }
    })
}

/** The paths of `git status --porcelain -z` output, sorted: `paths`, the changed ones with a rename's or copy's
 *  original path included, and `conflicted`, those with an unresolved merge conflict. */
function statusPaths(out: Buffer): { paths: string[]; conflicted: string[] } {
  const fields = decodePath(out).split("\0")
  const found = new Set<string>()
  const conflicted: string[] = []
  // `--porcelain -z` entries are `XY path`. A rename or copy, staged (X) or in the worktree (Y, after
  // `git add -N`), is followed by a second field, its original path; a rename's original counts too (as a
  // deletion).
  for (let i = 0; i < fields.length; ) {
    const entry = fields[i++]!
    if (!entry) continue
    const xy = entry.slice(0, 2)
    if (UNMERGED.has(xy)) {
      conflicted.push(entry.slice(3))
      continue
    }
    found.add(entry.slice(3))
    if (xy.includes("R") || xy.includes("C")) {
      if (xy.includes("R")) found.add(fields[i]!)
      i++
    }
  }
  return { paths: [...found].sort(), conflicted: conflicted.sort() }
}

/** A RangeError unless every path is relative and holds no NUL. */
function checkPaths(paths: string[]): void {
  // A NUL would end its `:(literal)` entry on stdin and start an unprefixed pathspec.
  if (paths.some((p) => p.includes("\0") || p.startsWith("/"))) {
    throw new RangeError("a commit path must be relative and hold no NUL")
  }
}

/** Pathspecs that match `paths` exactly, with no glob expansion, as NUL-terminated entries for `FROM_STDIN`. */
function literal(paths: string[]): Buffer {
  return Buffer.concat(paths.flatMap((p) => [Buffer.from(":(literal)"), encodePath(p), Buffer.of(0)]))
}

/** `paths` as git lists them with `-z`, to compare with its output: as latin1 (one char per byte, so
 *  `normalize` sees no lone surrogates to replace), normalized, without a trailing slash. */
function asListed(paths: string[]): string[] {
  return paths.map((p) => path.posix.normalize(encodePath(p).toString("latin1")).replace(/\/+$/, ""))
}

/** Whether `listed`, a path from git's `-z` output read as latin1, is one of `wanted` (from `asListed`) or
 *  under one. */
function matchesAny(listed: string, wanted: string[]): boolean {
  return wanted.some((w) => w === "." || listed === w || listed.startsWith(`${w}/`))
}

/** `base` without GIT_* variables, the system or user git config, or prompts, in the C locale. */
function gitEnv(base: Record<string, string | undefined>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("GIT_")))
  // A taken lock is found in git's stderr, which a locale would translate; LANGUAGE is dropped for the same
  // reason. Every path is read as `-z` bytes, so the locale changes nothing else.
  const { LANGUAGE: _, ...env } = selfSpawnEnv(kept)
  return { ...env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" }
}

/** The `CompanyGitError` for git `args` that exited non-zero with `result`. */
function exited(args: string[], result: GitResult): CompanyGitError {
  return new CompanyGitError(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.toString().trim()}`)
}

const noop = () => {}
// Which instance's lock the current async context holds. `held` is cleared when the section ends,
// since timers and callbacks started inside it keep the context afterwards.
const holder = new AsyncLocalStorage<{ git: CompanyGit; held: boolean }>()
const NOT_REENTRANT = "CompanyGit's lock is not reentrant; use the LockedGit that locked() passes"

/** A git command on the company clone failed; the message includes git's stderr. */
export class CompanyGitError extends Error {
  override name = "CompanyGitError"
}

/**
 * The company repo can't take an office commit now: a human's merge, rebase, cherry-pick or revert is in
 * progress, or a path to commit has an unresolved conflict (409); or a git lock file stayed taken (503).
 *
 * The message says what to do and names no absolute path, since an HQ client may be on another machine.
 */
export class CompanyRepoBusy extends CompanyGitError {
  override name = "CompanyRepoBusy"
  readonly code = "company_repo_busy" as const

  constructor(
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** `error` if it is a `CompanyRepoBusy`, else its `cause` if that is one (a store's wrapped error), else null. */
export function repoBusy(error: unknown): CompanyRepoBusy | null {
  if (error instanceof CompanyRepoBusy) return error
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof CompanyRepoBusy ? cause : null
}

/** The writes that need the repo lock, given to a `locked` section, which already holds it. */
export interface LockedGit {
  /** Stages `paths` and commits them; returns the new HEAD, or HEAD unchanged if nothing changed. Rejects with
   *  `CompanyRepoBusy` while the repo is mid-operation, a path is conflicted, or a lock stays taken. */
  commit(paths: string[], message: string): Promise<string>
  /** Commits each changed, new, or deleted file in a `people/<handle>/memory/` folder (none in a `.yian/` folder) on
   *  its own; returns their paths. Commits nothing while the repo is mid-operation, and skips a conflicted file, one
   *  under a symlinked folder, and a nested git repo. */
  commitHandEdits(): Promise<string[]>
  /** Rejects with the 409 `CompanyRepoBusy` a `commit` of `paths` would refuse with now: a human's operation is in
   *  progress, or a path in `paths` (or under one) has an unresolved conflict. */
  refuseBusy(paths: string[]): Promise<void>
}

export interface CompanyGitOptions {
  /** The git executable (default `git`). */
  git?: string
  /** The env git runs in, before cleaning (default `process.env`). */
  env?: Record<string, string | undefined>
  /** Where to report what the office left uncommitted, and a reset that failed (default: nowhere). */
  log?: (line: string) => void
  /** Monotonic ms for the pin window (default `performance.now`). */
  clock?: () => number
}

interface GitResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

/**
 * Git operations on one company clone. Run any write sequence inside `locked`.
 *
 * The lock covers this instance only, not other instances or processes, so the daemon must be the
 * only opener of the clone.
 */
export class CompanyGit {
  readonly root: string
  readonly worktrees: string
  readonly #git: string
  readonly #env: Record<string, string>
  readonly #log: (line: string) => void
  readonly #clock: () => number
  /** When `pin` last handed out each sha's dir, by `#clock`. */
  readonly #lastPinned = new Map<string, number>()
  /** The shas whose pins `prune` is removing right now; `pin` takes the locked path for them. */
  readonly #removing = new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()
  #ceiling: string | undefined
  // What `commitHandEdits` last reported waiting for, and the paths it last skipped for each reason, so each is
  // logged once.
  #waiting = ""
  readonly #skipped = new Map<string, string>()
  readonly #writer: LockedGit = {
    commit: (paths, message) => this.#commit(paths, message),
    commitHandEdits: () => this.#commitHandEdits(),
    refuseBusy: (paths) => this.#refuseBusy(paths),
  }

  constructor(root: string, worktrees: string, options: CompanyGitOptions = {}) {
    this.root = root
    this.worktrees = worktrees
    this.#git = options.git ?? "git"
    this.#env = gitEnv(options.env ?? process.env)
    this.#log = options.log ?? noop
    this.#clock = options.clock ?? (() => performance.now())
  }

  /**
   * Runs git in the clone with stdin `input` (else none) and `env` added to its environment; with `check`, a non-zero
   * exit rejects with `CompanyGitError`. A command that touches working files runs with the repo's filter drivers off.
   *
   * A command that finds a git lock file taken runs again after each of `LOCK_WAITS`, then rejects with a
   * 503 `CompanyRepoBusy`. The lock is never removed: another git may hold it.
   */
  async #run(
    args: string[],
    { env: extra = {}, ...options }: { check?: boolean; input?: Uint8Array; env?: Record<string, string> } = {},
  ): Promise<GitResult> {
    const filters = FILTERED.has(args[0]!) ? await this.#noFilters() : {}
    const env = { ...this.#env, ...filters, ...extra }
    for (let attempt = 0; ; attempt++) {
      const result = await this.#spawn(args, env, { input: options.input, check: false })
      // git rolls its lock files back when a command fails on one, so running it again is safe.
      const lock = result.code === 0 ? null : LOCK_TAKEN.exec(result.stderr.toString())
      if (lock === null) {
        if ((options.check ?? true) && result.code !== 0) throw exited(args, result)
        return result
      }
      if (attempt === LOCK_WAITS.length) {
        this.#log(`git ${args[0]} gave up on ${JSON.stringify(lock[1])}, which stayed taken`)
        throw new CompanyRepoBusy(503, lock[1]!.endsWith("/index.lock") ? INDEX_LOCKED : LOCKED)
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAITS[attempt]))
    }
  }

  /**
   * Config, as `GIT_CONFIG_*` variables, that turns off every filter driver the repo's config defines.
   *
   * A driver is attached to paths through `.gitattributes`, so it can't be refused per path; its clean,
   * smudge and process commands are blanked instead, and `required` is cleared so a blanked driver
   * isn't a failure. Variables rather than `-c`, which splits at the first `=` a driver name may hold.
   */
  async #noFilters(): Promise<Record<string, string>> {
    const out = await this.#spawn(["config", "-z", "--name-only", "--get-regexp", "^filter\\."], this.#env, {
      check: false,
    })
    // `--get-regexp` exits 1 when nothing matches.
    if (out.code !== 0 && !(out.code === 1 && !out.stdout.length)) {
      throw new CompanyGitError(`git config --get-regexp exited ${out.code}: ${out.stderr.toString().trim()}`)
    }
    let names: string
    try {
      names = UTF8.decode(out.stdout)
    } catch {
      // An env value can't carry bytes that aren't UTF-8, so such a driver couldn't be turned off.
      throw new CompanyGitError("the company repo's config names a filter driver that isn't UTF-8")
    }
    const drivers = new Set<string>()
    for (const name of names.split("\0")) {
      const last = name.lastIndexOf(".")
      // `>=`: git runs a driver whose name is empty (`filter..clean`); a bare `filter.<key>` has no driver.
      if (last >= "filter.".length) drivers.add(name.slice("filter.".length, last))
    }
    const pairs = [...drivers].flatMap((driver) => [
      [`filter.${driver}.clean`, ""],
      [`filter.${driver}.smudge`, ""],
      [`filter.${driver}.process`, ""],
      [`filter.${driver}.required`, "false"],
    ])
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
    pairs.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key!
      env[`GIT_CONFIG_VALUE_${i}`] = value!
    })
    return env
  }

  /** Runs git in the clone in `env`, as `#run` does. */
  #spawn(
    args: string[],
    env: Record<string, string>,
    { check = true, input }: { check?: boolean; input?: Uint8Array },
  ): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      // The work tree is pinned to the root, since a repo's core.worktree would move it; `-c core.worktree`
      // can't, as the repo's value wins. Not for `init`, which would write the option into the config.
      const init = args[0] === "init"
      const workTree = init ? [] : ["--work-tree=."]
      const child = spawn(this.#git, ["-C", this.root, ...workTree, ...IDENTITY, ...LOCKDOWN, ...args], {
        env: init ? env : { ...env, ...this.#noDiscovery() },
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
      // A spawn error may be followed by `close`; the first one settles.
      let settled = false
      child.on("error", (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.on("close", (status) => {
        if (settled) return
        settled = true
        const result = { code: status ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
        if (check && result.code !== 0) reject(exited(args, result))
        else resolve(result)
      })
      if (input) {
        child.stdin!.on("error", noop) // git may exit before reading all of it
        child.stdin!.end(input)
      }
    })
  }

  /**
   * The env that stops git looking for a repo above the root, where a root that lost its `.git` would
   * otherwise stage and commit into an enclosing repo.
   *
   * A ceiling rather than `--git-dir=.git`: an explicit git dir skips repo discovery, and may skip git's
   * `safe.directory` ownership check with it; a ceiling keeps both. The root is resolved first, since git
   * walks up from the real path and would pass a ceiling set above a symlink. A root that doesn't exist yet
   * gets nothing; `-C` fails on it.
   */
  #noDiscovery(): Record<string, string> {
    if (this.#ceiling === undefined) {
      try {
        this.#ceiling = path.dirname(fs.realpathSync(this.root))
      } catch {
        return {}
      }
    }
    return { GIT_CEILING_DIRECTORIES: this.#ceiling }
  }

  /**
   * Runs `fn` holding the repo lock; sections run one at a time, in call order.
   *
   * The lock isn't reentrant: a locking method called inside a section (`commit`, `locked`) rejects
   * instead of waiting for a lock its own caller holds. Write through the `LockedGit` passed to `fn`;
   * it is valid only while `fn`'s promise is pending, and its calls must be awaited one at a time. A
   * write started without `await` inside a section also rejects if it runs before the section ends.
   */
  locked<T>(fn: (git: LockedGit) => Promise<T>): Promise<T> {
    if (this.#holding()) return Promise.reject(new Error(NOT_REENTRANT))
    const run = this.#queue.then(() => {
      const token = { git: this, held: true }
      return holder.run(token, async () => {
        try {
          return await fn(this.#writer)
        } finally {
          token.held = false
        }
      })
    })
    this.#queue = run.then(noop, noop) // a failed section must not wedge the lock
    return run
  }

  /** Whether the current async context is inside one of this clone's `locked` sections. */
  #holding(): boolean {
    const current = holder.getStore()
    return current?.git === this && current.held
  }

  /** Creates the repo at root (git init, branch main). */
  async init(): Promise<void> {
    await this.#run(["init", "-q", "-b", "main"])
  }

  /**
   * Whether the repo at root has no commit yet (`unborn`) or has one at HEAD (`committed`). `CompanyGitError` when
   * git can't read it, or HEAD names no commit in a repo that once had one.
   *
   * `unborn` needs HEAD to be a branch that doesn't exist, no ref at all, and no HEAD reflog.
   */
  async repoState(): Promise<"unborn" | "committed"> {
    // Fails with git's own words when root isn't a repo git can read; git never looks above root.
    await this.#run(["rev-parse", "--git-dir"])
    try {
      await this.head()
      return "committed"
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
    const symbolic = await this.#run(["symbolic-ref", "-q", "HEAD"], { check: false })
    if (symbolic.code !== 0) throw new CompanyGitError("HEAD names no commit and no branch")
    // Git skips a ref it can't read with a warning on stderr, so a corrupt branch would look like no ref at all.
    const refs = await this.#run(["for-each-ref", "--count=1"])
    const warning = refs.stderr.toString().trim()
    if (refs.stdout.length || warning) {
      throw new CompanyGitError(`HEAD names no commit, but the repo has refs${warning ? `: ${warning}` : ""}`)
    }
    // A branch ref deleted by hand leaves HEAD's reflog behind; a repo with no commit yet has none.
    const reflog = await this.#run(["reflog", "exists", "HEAD"], { check: false })
    if (reflog.code === 0) throw new CompanyGitError("HEAD names no commit, but its reflog shows it had one")
    return "unborn"
  }

  /** The commit id at HEAD. */
  head(): Promise<string> {
    return this.resolve("HEAD")
  }

  /** The commit id at HEAD read straight from the ref files, falling back to `head`.
   *
   *  It costs two small file reads instead of a git process, for checks made on every request. */
  async readHead(): Promise<string> {
    const gitdir = path.join(this.root, ".git")
    try {
      let head = (await fs.promises.readFile(path.join(gitdir, "HEAD"), "utf8")).trim()
      if (head.startsWith("ref: ")) {
        const ref = head.slice("ref: ".length)
        const loose = path.join(gitdir, ref)
        if ((await fs.promises.stat(loose).catch(() => null))?.isFile()) {
          head = (await fs.promises.readFile(loose, "utf8")).trim()
        } else {
          // `git gc` moves refs into packed-refs
          const packed = (await fs.promises.readFile(path.join(gitdir, "packed-refs"), "utf8")).split("\n")
          head = packed.find((line) => line.endsWith(` ${ref}`))?.split(/\s+/)[0] ?? ""
        }
      }
      if (COMMIT_ID.test(head)) return head
    } catch {}
    return this.head()
  }

  /** The full sha of `commit` (a sha, branch, or `HEAD`); a RangeError if unknown. */
  async resolve(commit: string): Promise<string> {
    const out = await this.#run(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { check: false })
    if (out.code !== 0) throw new RangeError(`unknown commit ${JSON.stringify(commit)}`)
    return out.stdout.toString().trim()
  }

  /** The git blob id of `relpath` at `commit`, or null if it is absent; `CompanyGitError` if git fails, so
   *  a failed read is never taken for a missing file. */
  async blobId(relpath: string, commit = "HEAD"): Promise<string | null> {
    const args = ["rev-parse", "--verify", "--quiet", `${commit}:${relpath}`]
    const out = await this.#run(args, { check: false })
    const stderr = out.stderr.toString().trim()
    // --quiet makes "no such object" exit 1 silently; an object git couldn't read exits 1 with an error.
    if (out.code === 1 && !stderr) return null
    const id = out.stdout.toString().trim()
    if (out.code !== 0 || !id) throw new CompanyGitError(`git ${args.join(" ")} exited ${out.code}: ${stderr}`)
    return id
  }

  /**
   * Whether `relpath` may hold a different file at commit `to` than at commit `from`: true when the clone doesn't
   * have `from`, when no common ancestor of the two holds the file, or when a commit on either side since their common
   * ancestors deletes it or changes its type (a merge compared with each parent); false when `from === to`. A
   * RangeError for anything but full commit ids and a relative path; `CompanyGitError` when git fails, so a failed
   * read is neither answer.
   */
  async goneSince(relpath: string, from: string, to: string): Promise<boolean> {
    fullId(from)
    fullId(to)
    checkPaths([relpath])
    if (from === to) return false
    const known = ["rev-parse", "--verify", "--quiet", `${from}^{commit}`]
    const found = await this.#run(known, { check: false })
    // --quiet makes a missing commit exit 1 silently; an object git couldn't read exits 1 with an error.
    if (found.code === 1 && !found.stderr.length) return true
    if (found.code !== 0 || found.stdout.toString().trim() !== from) throw exited(known, found)
    const merged = ["merge-base", "--all", from, to]
    const bases = await this.#run(merged, { check: false })
    // Exit 1 with no output: unrelated histories.
    if (bases.code === 1 && !bases.stdout.length && !bases.stderr.length) return true
    const ids = bases.stdout.toString().split("\n").filter(Boolean)
    if (bases.code !== 0 || !ids.length || !ids.every(isCommitId)) throw exited(merged, bases)
    // A history rewritten to before the file was added, then added again, deletes nothing in between.
    const held = await Promise.all(ids.map((base) => this.blobId(relpath, base)))
    if (held.every((blob) => blob === null)) return true
    // The range is symmetric so a reset back to before a deletion counts too; each repo setting that would change
    // which commits or changes the log shows is pinned. `-m` with log.diffMerges set rather than `--diff-merges`,
    // which git before 2.31 refuses; there `-m` always compares a merge with each parent and the setting is unknown.
    const log = ["-c", "log.follow=false", "-c", "log.diffMerges=separate", "log", "-n", "1", "--full-history", "-m"]
    log.push("--no-patch", "--no-renames", "--no-show-signature", "--no-ext-diff", "--diff-filter=DT", "--format=%H")
    log.push(`${from}...${to}`, "--", `:(literal)${relpath}`)
    return (await this.#run(log)).stdout.toString().trim() !== ""
  }

  /** The blob id of every file under `folder` at `commit`, by repo path. */
  async files(folder: string, commit = "HEAD"): Promise<Map<string, string>> {
    const out = await this.#run(["ls-tree", "-r", "-z", "--full-tree", commit, "--", `:(literal)${folder}`])
    const found = new Map<string, string>()
    for (const entry of lsTreeEntries(out.stdout)) {
      const [, type, blob] = entry.info
      if (type === "blob") found.set(entry.path, blob!)
    }
    return found
  }

  /** Every entry of the tree at `commit` (a full hex id), folders included; modes other than a folder, a
   *  file, a symlink or a submodule are left out. */
  async listTree(commit: string): Promise<TreeEntry[]> {
    const out = await this.#run(["ls-tree", "-r", "-t", "-z", "-l", "--full-tree", fullId(commit)])
    const found: TreeEntry[] = []
    for (const entry of lsTreeEntries(out.stdout)) {
      const [mode, , blob, size] = entry.info
      const type = KINDS[mode!]
      if (type) found.push({ path: entry.path, type, blob: blob!, size: /^\d+$/.test(size!) ? Number(size) : null })
    }
    return found
  }

  /** The subject, author name (never the email) and commit time of `commit` (a full hex id). */
  async commitInfo(commit: string): Promise<CommitInfo> {
    // --no-show-signature: a repo's log.showSignature would put gpg's output before the format.
    const format = ["log", "-1", "--no-show-signature", "--format=%H%x00%s%x00%an%x00%ct"]
    const out = await this.#run([...format, fullId(commit)])
    const [id, subject, author, ct] = UTF8_REPLACING.decode(out.stdout).split("\0")
    return { id: id!, subject: subject!, author: author!, time: stamp(new Date(Number(ct) * 1000)) }
  }

  /** The bytes of blob `blobId` (40 lowercase hex), or null if the clone has no such blob. */
  async readBlob(blobId: string): Promise<Buffer | null> {
    if (!BLOB_ID.test(blobId)) return null // keep rev expressions such as HEAD:<path> away from git
    const out = await this.#run(["cat-file", "blob", blobId], { check: false })
    return out.code === 0 ? out.stdout : null
  }

  /** The bytes of each blob in `blobIds` that the clone has, by id, read in one git call; rejects with
   *  `CompanyGitError` when git stops before it has answered every id. */
  async readBlobs(blobIds: string[]): Promise<Map<string, Buffer>> {
    const ids = [...new Set(blobIds)].filter((id) => BLOB_ID.test(id))
    const found = new Map<string, Buffer>()
    if (!ids.length) return found
    const input = Buffer.from(ids.map((id) => `${id}\n`).join(""))
    // The exit code is ignored: a complete answer for every id is enough.
    const { code, stdout: out, stderr } = await this.#run(["cat-file", "--batch"], { check: false, input })
    // Output that ends early (a broken or locked clone) is an error, not a missing blob.
    const stopped = () => new CompanyGitError(`git cat-file --batch exited ${code}: ${stderr.toString().trim()}`)
    let at = 0
    for (const id of ids) {
      const end = out.indexOf(0x0a, at)
      if (end < 0) throw stopped()
      const header = out.subarray(at, end).toString().split(" ")
      at = end + 1
      if (header.length < 3) continue // "<id> missing"
      if (!/^\d+$/.test(header[2]!)) throw stopped()
      const size = Number(header[2])
      if (at + size > out.length) throw stopped()
      if (header[1] === "blob") found.set(id, out.subarray(at, at + size))
      at += size + 1
    }
    return found
  }

  /** Stages `paths` and commits them; returns the new HEAD, or HEAD unchanged if nothing changed. Rejects with
   *  `CompanyRepoBusy` while the repo is mid-operation, a path is conflicted, or a lock stays taken. */
  commit(paths: string[], message: string): Promise<string> {
    if (!paths.length) return this.head()
    return this.locked((git) => git.commit(paths, message))
  }

  /** `commit` with the lock held. A 409 `CompanyRepoBusy` while a human's operation is in progress or a
   *  path has an unresolved conflict; a commit that fails after staging unstages its paths again. */
  async #commit(paths: string[], message: string): Promise<string> {
    // `git commit` with no pathspec would commit the whole index
    if (!paths.length) return this.head()
    checkPaths(paths)
    // Refused before anything is staged, so the reset below never touches an operation's or a conflict's
    // index entries.
    await this.#refuseBusy(paths)
    const present = new Set<string>()
    for (const p of paths) {
      // lstat: a tracked symlink whose target is gone is still present.
      // Not `path.join`: the runtime's path functions turn a lone surrogate into U+FFFD.
      const stat = await fs.promises.lstat(encodePath(`${this.root}/${p}`)).catch(() => null)
      if (stat) present.add(p)
    }
    let staged = false
    try {
      if (present.size) {
        await this.#run(["add", ...FROM_STDIN], { input: literal([...present]) })
        staged = true
      }
      const gone = paths.filter((p) => !present.has(p)) // a deletion, maybe already staged
      if (gone.length) {
        // `git add` fails on a path gone from both disk and index.
        await this.#run(["rm", "-q", "--cached", "--ignore-unmatch", ...FROM_STDIN], { input: literal(gone) })
        staged = true
      }
      // `git commit` exits 1 on an empty commit; callers rely on a no-op write succeeding. `git diff` takes
      // no pathspecs on stdin, so the staged paths are matched here.
      const out = await this.#run(["diff", "--cached", "--name-only", "-z", "--no-renames"])
      const wanted = asListed(paths)
      const touched = out.stdout.toString("latin1").split("\0").some((s) => s && matchesAny(s, wanted))
      if (!touched) return await this.head()
      // git's default cleanup for -m, pinned so a repo's commit.cleanup can't strip a trailer as a comment.
      const commit = ["commit", "-q", "--cleanup=whitespace", "-m", message, ...FROM_STDIN]
      await this.#run(commit, { input: literal(paths) })
      return await this.head()
    } catch (error) {
      // Left staged, a refused write would be committed with the next commit of any other path.
      if (staged) await this.#resetBestEffort(paths)
      throw error
    }
  }

  /** Resets `paths` in the index to HEAD after a failed commit, leaving the working files alone; a reset that
   *  fails too (a lock that stays taken) is logged, not thrown, so the commit's error is the one reported. */
  async #resetBestEffort(paths: string[]): Promise<void> {
    try {
      await this.#run(["reset", "-q", ...FROM_STDIN], { input: literal(paths) })
    } catch {
      this.#log(`paths ${JSON.stringify(paths)} stayed staged after a failed commit`)
    }
  }

  /** A 409 `CompanyRepoBusy` if a human's operation is in progress, or a path in `paths` (or under one) has an
   *  unresolved conflict, since staging it would mark the conflict resolved. */
  async #refuseBusy(paths: string[]): Promise<void> {
    const operation = await this.#operation()
    if (operation !== null) throw operation
    // `ls-files` takes no pathspecs on stdin, so the paths are matched here. Entries are `<info>\t<path>`, one
    // per conflict stage.
    const out = await this.#run(["ls-files", "-u", "-z"])
    const wanted = asListed(paths)
    for (const entry of out.stdout.toString("latin1").split("\0")) {
      const listed = entry.slice(entry.indexOf("\t") + 1)
      if (!entry || !matchesAny(listed, wanted)) continue
      const shown = JSON.stringify(decodePath(Buffer.from(listed, "latin1")))
      const message = `${shown} has an unresolved merge conflict in the company repo; resolve it and commit`
      throw new CompanyRepoBusy(409, message)
    }
  }

  /** A 409 `CompanyRepoBusy` naming the human's operation in progress in the clone, or null if there is none. */
  async #operation(): Promise<CompanyRepoBusy | null> {
    // `--git-path`, as the git dir of a linked worktree is elsewhere and per-worktree state lives in it.
    const args = ["rev-parse", ...OPERATIONS.flatMap(([name]) => ["--git-path", name])]
    const lines = decodePath((await this.#run(args)).stdout).split("\n")
    if (lines.at(-1) === "") lines.pop()
    // Fails closed: output that doesn't line up could hide an operation.
    if (lines.length !== OPERATIONS.length) throw new CompanyGitError(`git rev-parse printed ${lines.length} git paths`)
    for (const [i, [, what]] of OPERATIONS.entries()) {
      // Relative to the root, unless git printed it absolute (a linked worktree's git dir).
      const file = encodePath(lines[i]!.startsWith("/") ? lines[i]! : `${this.root}/${lines[i]}`)
      const found = await fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
        throw error
      })
      if (found === null) continue
      return new CompanyRepoBusy(409, `the company repo has ${what} in progress; finish or abort it`)
    }
    return null
  }

  /**
   * A read-only worktree for `commit`, keyed by full sha, created if needed; a RangeError if `commit` is
   * unknown.
   *
   * The marker file is written last, so a dir without it (a crash mid-setup, or a half-deleted dir) is
   * rebuilt from scratch. Only files are made read-only, so `git worktree remove --force` and a
   * recursive `rm` still work on a pin. Each call, cached or not, restarts the window in which `prune`
   * spares the pin.
   *
   * A full lowercase sha that is already pinned comes back without git or the lock, even if the clone has
   * since lost that commit. Called inside a `locked` section it rejects, pinned or not, as `locked` does.
   */
  async pin(commit: string): Promise<string> {
    if (this.#holding()) throw new Error(NOT_REENTRANT)
    // Stamped before the lockless check, in the same synchronous step as it: either prune sees the stamp and
    // spares the pin, or this sees prune's removal and waits for the lock to rebuild, or the marker is gone.
    if (COMMIT_ID.test(commit)) {
      this.#lastPinned.set(commit, this.#clock())
      const dir = path.join(this.worktrees, commit)
      // The marker is written last and a pin never changes, so a marked dir is complete.
      const removing = this.#removing.has(commit)
      if (!removing && (await fs.promises.stat(path.join(dir, PIN_MARKER)).catch(() => null))?.isFile()) return dir
    }
    const sha = await this.resolve(commit)
    const dir = path.join(this.worktrees, sha)
    await this.locked(async () => {
      await this.#pin(sha, dir)
      this.#lastPinned.set(sha, this.#clock())
    })
    return dir
  }

  /** `pin` with the lock held. */
  async #pin(sha: string, dir: string): Promise<void> {
    const marker = path.join(dir, PIN_MARKER)
    if ((await fs.promises.stat(marker).catch(() => null))?.isFile()) return
    await fs.promises.rm(dir, { recursive: true, force: true })
    await this.#run(["worktree", "prune"]) // drop the registration of a removed dir
    await fs.promises.mkdir(this.worktrees, { recursive: true })
    await this.#run(["worktree", "add", "--detach", dir, sha])
    await readOnly(Buffer.from(dir))
    await fs.promises.writeFile(marker, sha + "\n")
  }

  /**
   * Removes the pins under `worktrees` that nobody needs: a sha-named entry goes unless it is in `keep()`, is
   * HEAD, or was handed out by `pin` within `graceMs`. Each removal holds the lock on its own, and `keep` is
   * called under it. A symlink is unlinked, never followed; other non-dirs and names that aren't a full sha are
   * left alone. Stops before the next entry once `signal` aborts. Returns the removed shas and, when a pin was
   * spared only by the window, the ms until the first such window ends (else null).
   */
  async prune(
    keep: () => Iterable<string>,
    { graceMs = PIN_GRACE_MS, signal }: { graceMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ removed: string[]; retryInMs: number | null }> {
    const removed: string[] = []
    let retryInMs: number | null = null
    let names: string[]
    try {
      names = await fs.promises.readdir(this.worktrees)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed, retryInMs }
      throw error
    }
    try {
      for (const sha of names.filter((name) => COMMIT_ID.test(name)).sort()) {
        if (signal?.aborted) break
        await this.locked(async () => {
          // Read under the lock: a `pin` queued before this section has stamped its sha by now.
          if (new Set(keep()).has(sha) || sha === (await this.readHead())) return
          // From the stamp check to marking the sha as removing, no await: a cached `pin` stamps synchronously
          // before checking `#removing`, so the two can't miss each other.
          const stamp = this.#lastPinned.get(sha)
          const age = stamp === undefined ? Infinity : this.#clock() - stamp
          if (age < graceMs) {
            retryInMs = Math.min(retryInMs ?? Infinity, graceMs - age)
            return
          }
          this.#removing.add(sha)
          try {
            const dir = path.join(this.worktrees, sha)
            const st = await fs.promises.lstat(dir).catch(() => null)
            if (st?.isSymbolicLink()) await fs.promises.unlink(dir)
            else if (st?.isDirectory()) {
              // The marker goes first, so an rm that fails partway leaves a dir `pin` rebuilds, not hands out.
              await fs.promises.rm(path.join(dir, PIN_MARKER), { force: true })
              await fs.promises.rm(dir, { recursive: true, force: true })
            } else return
            removed.push(sha)
            this.#lastPinned.delete(sha)
          } finally {
            this.#removing.delete(sha)
          }
        })
      }
    } finally {
      // Drops the registrations of the removed dirs, even when a later entry failed.
      if (removed.length) await this.locked(() => this.#run(["worktree", "prune"]))
      const at = this.#clock()
      for (const [sha, stamp] of this.#lastPinned) if (at - stamp >= graceMs) this.#lastPinned.delete(sha)
    }
    return { removed, retryInMs }
  }

  /** Commits each changed, new, or deleted file in a `people/<handle>/memory/` folder (none in a `.yian/` folder) on
   *  its own; returns their paths. Commits nothing while the repo is mid-operation, and skips a conflicted file, one
   *  under a symlinked folder, and a nested git repo. */
  commitHandEdits(): Promise<string[]> {
    return this.locked((git) => git.commitHandEdits())
  }

  /**
   * `commitHandEdits` with the lock held.
   *
   * While a human's operation is in progress it commits nothing: HEAD is still a whole company, so chats keep
   * starting from it, and a commit now would land inside their merge or rebase. A profile with an unresolved
   * conflict is skipped, since committing it would mark it resolved with the markers in it. So are the paths
   * `#sortHandEdits` finds git can't or shouldn't commit, so one person's folder never stops another's edits.
   */
  async #commitHandEdits(): Promise<string[]> {
    const operation = await this.#operation()
    const waiting = operation?.message ?? ""
    if (waiting && waiting !== this.#waiting) this.#log(`hand edits wait: ${waiting}`)
    this.#waiting = waiting
    if (operation !== null) return []
    // --untracked-files=all lists a new memory file inside a wholly untracked people/<new>/.
    const out = await this.#run(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...PROFILES])
    const { paths, conflicted } = statusPaths(out.stdout)
    const { ready, linked, nested } = await this.#sortHandEdits(paths)
    this.#skip(conflicted, "an unresolved merge conflict; resolve it and commit")
    this.#skip(linked, "a folder on its path is a symlink, which git won't commit through; make it a real folder")
    this.#skip(nested, "a nested git repo; only files are committed")
    for (const rel of ready) {
      // The folder under people/ is the handle; one line, so a hand-made name can't add a trailer.
      const handle = rel.split("/")[1]!.split(WHITESPACE).filter(Boolean).join(" ")
      await this.#commit([rel], `profile(@${handle}): hand edit`)
    }
    return ready
  }

  /** Logs that hand edits skip `paths` for `why`, unless they are the paths last skipped for it. */
  #skip(paths: string[], why: string): void {
    const shown = JSON.stringify(paths)
    if (paths.length && shown !== this.#skipped.get(why)) this.#log(`hand edits skip ${shown}: ${why}`)
    this.#skipped.set(why, shown)
  }

  /**
   * The memory paths `git status` listed, sorted: `ready` to commit; `linked`, under a folder that is a symlink, which
   * `git add` refuses to go through; and `nested`, a nested git repo or a gitlink, which holds no memory file.
   */
  async #sortHandEdits(
    paths: string[],
    env?: Record<string, string>,
  ): Promise<{ ready: string[]; linked: string[]; nested: string[] }> {
    const sorted = { ready: [] as string[], linked: [] as string[], nested: [] as string[] }
    if (!paths.length) return sorted
    // A gitlink is listed by its own path, changed or deleted; an untracked nested repo by its folder, with a slash.
    const index = lsTreeEntries((await this.#run(["ls-files", "-s", "-z", "--", ...PROFILES], { env })).stdout)
    const gitlinks = new Set(index.filter((e) => e.info[0] === "160000").map((e) => e.path))
    for (const rel of paths) {
      if (rel.endsWith("/") || gitlinks.has(rel)) sorted.nested.push(rel)
      // A path through a file fails the walk; git stages that deletion fine.
      else if (await underSymlink(this.root, rel).catch(() => false)) sorted.linked.push(rel)
      else sorted.ready.push(rel)
    }
    return sorted
  }

  /**
   * The working tree's uncommitted paths, untracked files included and ignored ones not: `handEdits`, the
   * memory files `commitHandEdits` would commit, and `uncommitted`, every other one. Read-only;
   * it never writes the index, so it takes no lock and can run beside the daemon.
   */
  async pending(): Promise<{ handEdits: string[]; uncommitted: string[] }> {
    // Without it `git status` may refresh the index under index.lock, which would fail the daemon's own git add.
    const env = { GIT_OPTIONAL_LOCKS: "0" }
    const status = ["status", "--porcelain", "-z", "--untracked-files=all"]
    // As `commitHandEdits` does: nothing while a human's operation is in progress, and no path it skips.
    const busy = (await this.#operation()) !== null
    const listed = busy ? [] : statusPaths((await this.#run([...status, "--", ...PROFILES], { env })).stdout).paths
    const handEdits = (await this.#sortHandEdits(listed, env)).ready
    const { paths, conflicted } = statusPaths((await this.#run(status, { env })).stdout)
    const edits = new Set(handEdits)
    return { handEdits, uncommitted: [...paths, ...conflicted].sort().filter((p) => !edits.has(p)) }
  }

  /**
   * Writes the files of `commit` (a sha, branch, or `HEAD`) under `dir`, as a pin would hold them, with each of
   * `overlay` (repo paths) taken from the working tree instead: copied when there, removed when not. A RangeError if
   * `commit` is unknown. It writes nothing in the clone (not its index, worktrees or refs) and takes no lock, so it can
   * run beside the daemon.
   */
  async exportTree(commit: string, dir: string, overlay: readonly string[] = []): Promise<void> {
    const sha = await this.resolve(commit)
    // A private index, so the clone's own index is never read or written.
    const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencorp-index-"))
    try {
      const env = { GIT_INDEX_FILE: path.join(scratch, "index") }
      await this.#run(["read-tree", sha], { env })
      await this.#run(["checkout-index", "-a", "-f", `--prefix=${dir}/`], { env })
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true })
    }
    for (const rel of overlay) {
      // A folder the commit holds as a symlink would carry the write outside `dir`; that path stays as committed.
      if (await underSymlink(dir, rel)) continue
      // Not `path.join`: the runtime's path functions turn a lone surrogate into U+FFFD.
      const from = encodePath(`${this.root}/${rel}`)
      const to = encodePath(`${dir}/${rel}`)
      const stat = await fs.promises.lstat(from).catch(() => null)
      await fs.promises.rm(to, { recursive: true, force: true })
      if (stat?.isFile() || stat?.isSymbolicLink()) {
        const slash = rel.lastIndexOf("/")
        if (slash > 0) await fs.promises.mkdir(encodePath(`${dir}/${rel.slice(0, slash)}`), { recursive: true })
        if (stat.isFile()) await fs.promises.copyFile(from, to)
        else await fs.promises.symlink(await fs.promises.readlink(from, { encoding: "buffer" }), to)
      }
    }
  }
}

/** Whether a parent folder of repo path `rel` under `dir` is a symlink. It asks the filesystem, not the names, so a
 *  case-insensitive volume's other-case symlink counts. */
async function underSymlink(dir: string, rel: string): Promise<boolean> {
  const segments = rel.split("/").slice(0, -1)
  let prefix = dir
  for (const segment of segments) {
    prefix = `${prefix}/${segment}`
    const stat = await fs.promises.lstat(encodePath(prefix)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    // Nothing further down exists, so `mkdir` makes real folders.
    if (stat === null) return false
    if (stat.isSymbolicLink()) return true
  }
  return false
}

/** Clears the write bits of every regular file under `dir` except a `.git` file. It never follows a symlink,
 *  so nothing outside the pin is changed. */
async function readOnly(dir: Buffer): Promise<void> {
  // Buffer names keep bytes that aren't UTF-8. Not `withFileTypes`: the runtime's dirents for Buffer
  // names have no name.
  for (const name of await fs.promises.readdir(dir, { encoding: "buffer" })) {
    const p = Buffer.concat([dir, Buffer.from("/"), name])
    const st = await fs.promises.lstat(p)
    if (st.isDirectory()) await readOnly(p)
    else if (st.isFile() && name.toString() !== ".git") await fs.promises.chmod(p, st.mode & 0o7777 & ~WRITE)
  }
}
