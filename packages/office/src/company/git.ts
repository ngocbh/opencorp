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
const LOCKDOWN = [
  "-c", "commit.gpgsign=false",
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "core.fsmonitor=false",
  "-c", `core.attributesFile=${os.devNull}`,
  "-c", `core.excludesFile=${os.devNull}`,
]
// The commands that read or write working files, where a repo's filter drivers would run.
const FILTERED = new Set(["add", "commit", "reset", "rm", "status", "worktree"])
const PIN_MARKER = ".opencorp-pin"
const WRITE = 0o222
// `:(glob)` makes `*` match one path segment, so only people/<handle>/profile.md matches.
const PROFILES = ":(glob)people/*/profile.md"
const BLOB_ID = /^[0-9a-f]{40}$/
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KINDS: Record<string, TreeEntry["type"]> = {
  "040000": "folder",
  "100644": "file",
  "100755": "file",
  "120000": "symlink",
  "160000": "submodule",
}
// argv can't carry bytes that aren't UTF-8, so paths go to git on stdin, NUL-separated.
const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"]
// Every line boundary `splitlines` knows, so a trailer matches as a whole line however the message breaks.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/
// The whitespace Python's str.split() splits on, so a newline in a folder name can't start a trailer line.
export const WHITESPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

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

/** The info fields and path of each entry of `git ls-tree -z` output (`<info>\t<path>`, NUL-terminated). */
function lsTreeEntries(out: Buffer): { info: string[]; path: string }[] {
  return decodePath(out)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t")
      return { info: entry.slice(0, tab).trim().split(/\s+/), path: entry.slice(tab + 1) }
    })
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

/** `base` without GIT_* variables, the system or user git config, or prompts. */
function gitEnv(base: Record<string, string | undefined>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("GIT_")))
  return { ...selfSpawnEnv(kept), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" }
}

const noop = () => {}
// Which instance's lock the current async context holds. `held` is cleared when the section ends,
// since timers and callbacks started inside it keep the context afterwards.
const holder = new AsyncLocalStorage<{ git: CompanyGit; held: boolean }>()

/** A git command on the company clone failed; the message includes git's stderr. */
export class CompanyGitError extends Error {
  override name = "CompanyGitError"
}

/** The writes that need the repo lock, given to a `locked` section, which already holds it. */
export interface LockedGit {
  /** Stages `paths` and commits them; returns the new HEAD, or HEAD unchanged if nothing changed. */
  commit(paths: string[], message: string): Promise<string>
  /** Commits each changed, new, or deleted `people/<handle>/profile.md` on its own; returns their paths. */
  commitHandEdits(): Promise<string[]>
}

export interface CompanyGitOptions {
  /** The git executable (default `git`). */
  git?: string
  /** The env git runs in, before cleaning (default `process.env`). */
  env?: Record<string, string | undefined>
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
  #queue: Promise<unknown> = Promise.resolve()
  readonly #writer: LockedGit = {
    commit: (paths, message) => this.#commit(paths, message),
    commitHandEdits: () => this.#commitHandEdits(),
  }

  constructor(root: string, worktrees: string, options: CompanyGitOptions = {}) {
    this.root = root
    this.worktrees = worktrees
    this.#git = options.git ?? "git"
    this.#env = gitEnv(options.env ?? process.env)
  }

  /** Runs git in the clone with stdin `input` (else none); with `check`, a non-zero exit rejects with
   *  `CompanyGitError`. A command that touches working files runs with the repo's filter drivers off. */
  async #run(args: string[], options: { check?: boolean; input?: Uint8Array } = {}): Promise<GitResult> {
    const env = FILTERED.has(args[0]!) ? { ...this.#env, ...(await this.#noFilters()) } : this.#env
    return this.#spawn(args, env, options)
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
      if (last > "filter.".length) drivers.add(name.slice("filter.".length, last))
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
      const child = spawn(this.#git, ["-C", this.root, ...IDENTITY, ...LOCKDOWN, ...args], {
        env,
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
        if (check && result.code !== 0) {
          reject(new CompanyGitError(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.toString().trim()}`))
        } else resolve(result)
      })
      if (input) {
        child.stdin!.on("error", noop) // git may exit before reading all of it
        child.stdin!.end(input)
      }
    })
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
    const current = holder.getStore()
    if (current?.git === this && current.held) {
      return Promise.reject(new Error("CompanyGit's lock is not reentrant; use the LockedGit that locked() passes"))
    }
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

  /** Creates the repo at root (git init, branch main). */
  async init(): Promise<void> {
    await this.#run(["init", "-q", "-b", "main"])
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

  /** The newest commit on HEAD that touches `relpath` and has `line` as a whole message line. */
  async findCommit(relpath: string, line: string): Promise<string | null> {
    const grep = ["log", "--fixed-strings", `--grep=${line}`, "--format=%H%x00%B%x1e"]
    const out = (await this.#run([...grep, "HEAD", "--", `:(literal)${relpath}`])).stdout.toString()
    for (const record of out.split("\x1e")) {
      const trimmed = record.replace(/^\n+|\n+$/g, "")
      const nul = trimmed.indexOf("\0")
      if (nul < 0) continue
      const lines = trimmed.slice(nul + 1).split(LINE_BREAK)
      if (lines.at(-1) === "") lines.pop() // as `splitlines`, a final break ends the last line
      // --grep matches substrings; a trailer must match whole
      if (lines.includes(line)) return trimmed.slice(0, nul)
    }
    return null
  }

  /** Stages `paths` and commits them; returns the new HEAD, or HEAD unchanged if nothing changed. */
  commit(paths: string[], message: string): Promise<string> {
    if (!paths.length) return this.head()
    return this.locked((git) => git.commit(paths, message))
  }

  /** `commit` with the lock held. */
  async #commit(paths: string[], message: string): Promise<string> {
    // `git commit` with no pathspec would commit the whole index
    if (!paths.length) return this.head()
    checkPaths(paths)
    const present = new Set<string>()
    for (const p of paths) {
      // lstat: a tracked symlink whose target is gone is still present.
      // Not `path.join`: the runtime's path functions turn a lone surrogate into U+FFFD.
      const stat = await fs.promises.lstat(encodePath(`${this.root}/${p}`)).catch(() => null)
      if (stat) present.add(p)
    }
    if (present.size) await this.#run(["add", ...FROM_STDIN], { input: literal([...present]) })
    const gone = paths.filter((p) => !present.has(p)) // a deletion, maybe already staged
    if (gone.length) {
      // `git add` fails on a path gone from both disk and index.
      await this.#run(["rm", "-q", "--cached", "--ignore-unmatch", ...FROM_STDIN], { input: literal(gone) })
    }
    // `git commit` exits 1 on an empty commit; callers rely on a no-op write succeeding. `git diff` takes
    // no pathspecs on stdin, so the staged paths are matched here.
    const out = await this.#run(["diff", "--cached", "--name-only", "-z", "--no-renames"])
    // Compared as latin1, one char per byte, so `normalize` sees no lone surrogates to replace.
    const staged = out.stdout.toString("latin1").split("\0").filter(Boolean)
    const wanted = paths.map((p) => path.posix.normalize(encodePath(p).toString("latin1")).replace(/\/+$/, ""))
    const touched = staged.some((s) => wanted.some((w) => w === "." || s === w || s.startsWith(`${w}/`)))
    if (!touched) return this.head()
    await this.#run(["commit", "-q", "-m", message, ...FROM_STDIN], { input: literal(paths) })
    return this.head()
  }

  /** Resets `paths` in the index to HEAD, leaving the working files alone. */
  async unstage(paths: string[]): Promise<void> {
    checkPaths(paths)
    // `git reset` with no pathspec would reset the whole index
    if (paths.length) await this.#run(["reset", "-q", ...FROM_STDIN], { input: literal(paths) })
  }

  /**
   * A read-only worktree for `commit`, keyed by full sha, created if needed; a RangeError if `commit` is
   * unknown.
   *
   * The marker file is written last, so a dir without it (a crash mid-setup, or a half-deleted dir) is
   * rebuilt from scratch. Only files are made read-only, so `git worktree remove --force` and a
   * recursive `rm` still work on a pin.
   */
  async pin(commit: string): Promise<string> {
    const sha = await this.resolve(commit)
    const dir = path.join(this.worktrees, sha)
    await this.locked(() => this.#pin(sha, dir))
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

  /** Commits each changed, new, or deleted `people/<handle>/profile.md` on its own; returns their paths. */
  commitHandEdits(): Promise<string[]> {
    return this.locked((git) => git.commitHandEdits())
  }

  /** `commitHandEdits` with the lock held. */
  async #commitHandEdits(): Promise<string[]> {
    // --untracked-files=all lists a new profile inside a wholly untracked people/<new>/.
    const out = await this.#run(["status", "--porcelain", "-z", "--untracked-files=all", "--", PROFILES])
    const fields = decodePath(out.stdout).split("\0")
    const found = new Set<string>()
    // `--porcelain -z` entries are `XY path`. A rename or copy, staged (X) or in the worktree (Y, after
    // `git add -N`), is followed by a second field, its original path; a rename's original is committed
    // too (as a deletion).
    for (let i = 0; i < fields.length; ) {
      const entry = fields[i++]!
      if (!entry) continue
      found.add(entry.slice(3))
      const xy = entry.slice(0, 2)
      if (xy.includes("R") || xy.includes("C")) {
        if (xy.includes("R")) found.add(fields[i]!)
        i++
      }
    }
    const paths = [...found].sort()
    for (const rel of paths) {
      // The directory is the handle; one line, so a hand-made name can't add a trailer.
      const handle = path.posix.basename(path.posix.dirname(rel)).split(WHITESPACE).filter(Boolean).join(" ")
      await this.#commit([rel], `profile(@${handle}): hand edit`)
    }
    return paths
  }
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
