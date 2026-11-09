/** A person's profile, `memory/profile.md`, in the company clone as a yian MarkdownStore, versioned by git blob id. */
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type MarkdownStore, MarkdownVersionMismatch } from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { Handle } from "@opencorp/protocol"
import { errno } from "../company/flows.ts"
import { type CompanyGit, CompanyGitError, type LockedGit, oneLine, WHITESPACE } from "../company/git.ts"
import { profilePath } from "../company/loader.ts"

/** The git blob id of empty content. */
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The profile exists but can't be read or written as one: it isn't UTF-8, it or its memory folder is a symlink, or
 *  either isn't a regular file or folder. A RangeError, so yian's store contract (store_invalid, not retryable) and
 *  the worker RPC's mapping stay as they are; its message names only the profile's repo path. */
export class ProfileUnreadable extends RangeError {
  override name = "ProfileUnreadable"
}

/** The git blob id of `data`. */
export function blobId(data: Uint8Array): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")
}

/**
 * `profile(@<handle>): <source>`, with a `Commit-Id` trailer when `provenance` has one.
 *
 * `source` falls back to `from feedback on run <run_id>` (yian's provenance has a run id but no
 * source), then to `write`. Throws a RangeError for a commit id that isn't one token.
 */
export function commitMessage(handle: string, provenance: JsonObject | null | undefined): string {
  const commitId = commitIdOf(provenance)
  let source = provenance?.source
  const runId = provenance?.run_id
  if (!(typeof source === "string" && oneLine(source))) {
    source = typeof runId === "string" && runId ? `from feedback on run ${runId}` : "write"
  }
  // One line, whatever the caller sent, so neither part can add a trailer.
  const subject = `profile(@${oneLine(handle)}): ${oneLine(source)}`
  return commitId === null ? subject : `${subject}\n\nCommit-Id: ${commitId}`
}

/** `provenance.commit_id`, or null; a RangeError if it isn't one token git's argv can carry. */
function commitIdOf(provenance: JsonObject | null | undefined): string | null {
  const value = provenance?.commit_id
  if (value === undefined || value === null) return null
  // A NUL fails the spawn and a lone surrogate would be rewritten on its way to git.
  if (typeof value === "string" && value && !WHITESPACE.test(value) && !value.includes("\0") && value.isWellFormed()) {
    return value
  }
  // JSON.stringify throws on a bigint, and provenance from an RPC frame may hold one.
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value)
  throw new RangeError(`commit_id must be a string without whitespace, not ${shown}`)
}

/** A Node system error (code `EIO`) for storage that can't be reached, as yian's store contract asks. */
function systemError(message: string, syscall: "read" | "write", cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code: "EIO", syscall })
}

/**
 * `people/<handle>/memory/profile.md` in the company clone, as a yian `MarkdownStore`.
 *
 * Versions are git blob ids, and every version handed out is committed, so it stays readable.
 * Every write is a commit. The constructor does no I/O: the office builds one per request.
 */
export class GitProfileStore implements MarkdownStore {
  readonly git: CompanyGit
  readonly handle: string
  readonly path: string

  constructor(git: CompanyGit, handle: string) {
    if (!Handle.safeParse(handle).success) throw new RangeError(`not a handle: ${JSON.stringify(handle)}`)
    this.git = git
    this.handle = handle
    this.path = profilePath(handle)
  }

  /**
   * Returns `[text, version]`. Reading the current version commits pending hand edits first.
   *
   * Throws a RangeError for an unknown version, `ProfileUnreadable` for text that isn't UTF-8 or a
   * profile or memory folder that is a symlink or not a regular file or folder, and a Node system error when git
   * fails.
   */
  async read(version: string | null = null): Promise<readonly [string, string]> {
    if (version !== null) {
      const data = await this.#blob(version)
      if (data === null) throw new RangeError(`unknown profile version ${JSON.stringify(version)}`)
      return [this.#decode(data), version]
    }
    let found: { current: string; data: Uint8Array | null }
    try {
      found = await this.git.locked(async (locked) => {
        // Before, so a symlink or folder isn't committed as a hand edit; after, for one swapped in meanwhile.
        this.#checkFile()
        await locked.commitHandEdits()
        this.#checkFile()
        const head = await this.#current()
        return { current: head, data: await this.#blob(head) }
      })
    } catch (error) {
      if (error instanceof CompanyGitError) throw systemError(error.message, "read", error)
      throw error
    }
    const { current, data } = found
    if (data === null) throw systemError(`blob ${current} of ${this.path} is missing from the clone`, "read")
    return [this.#decode(data), current]
  }

  /**
   * Replaces the profile and commits it if `baseVersion` is current; returns the new version.
   *
   * If a write with the same `provenance.commit_id` was already committed for this profile,
   * returns its version and writes nothing (a retried write). Throws a TypeError for non-strings,
   * `MarkdownVersionMismatch` for a stale base, a RangeError for a bad commit id or a lone surrogate,
   * `ProfileUnreadable` for a profile path through a symlink or a profile that isn't a regular
   * file, and a Node system error when git fails.
   */
  async write(
    text: string,
    { baseVersion, provenance = null }: { baseVersion: string; provenance?: JsonObject | null },
  ): Promise<string> {
    if (typeof text !== "string" || typeof baseVersion !== "string") {
      throw new TypeError("text and baseVersion must be strings")
    }
    const commitId = commitIdOf(provenance)
    if (!text.isWellFormed()) throw new RangeError("text holds a lone surrogate, which has no UTF-8 encoding")
    const data = Buffer.from(text, "utf8")
    try {
      return await this.git.locked((locked) => this.#write(locked, data, baseVersion, provenance, commitId))
    } catch (error) {
      if (error instanceof CompanyGitError) throw systemError(error.message, "write", error)
      throw error
    }
  }

  async #write(
    locked: LockedGit,
    data: Buffer,
    baseVersion: string,
    provenance: JsonObject | null,
    commitId: string | null,
  ): Promise<string> {
    if (commitId !== null) {
      const done = await this.#committed(commitId)
      if (done !== null) return done
    }
    this.#checkFile()
    await locked.commitHandEdits() // a pending hand edit is the current version
    const current = await this.#current()
    if (current !== baseVersion) throw new MarkdownVersionMismatch(baseVersion, current)
    const message = commitMessage(this.handle, provenance)
    const target = this.target()
    const previous = readIfExists(target)
    if ((previous === null ? EMPTY_BLOB : blobId(previous)) !== current) {
      // A hand edit since commitHandEdits(), or bytes git normalizes (.gitattributes): let git decide which.
      await locked.commitHandEdits()
      const now = await this.#current()
      if (now !== current) throw new MarkdownVersionMismatch(baseVersion, now)
    }
    this.#put(target, data)
    try {
      await locked.commit([this.path], message)
    } catch (error) {
      // Left on disk, the text would be committed later as a hand edit without its Commit-Id, and a
      // retry of this write would get a mismatch.
      await this.#restore(target, previous, current)
      throw error
    }
    return await this.#current()
  }

  /**
   * The version a write with `commitId` committed for this profile, or null if none did.
   *
   * Throws a TypeError for a non-string, a RangeError for a commit id that isn't one token, and a
   * Node system error when git fails.
   */
  async committed(commitId: string): Promise<string | null> {
    if (typeof commitId !== "string") throw new TypeError("commit_id must be a string")
    commitIdOf({ commit_id: commitId }) // it reaches git's argv
    try {
      return await this.#committed(commitId)
    } catch (error) {
      if (error instanceof CompanyGitError) throw systemError(error.message, "read", error)
      throw error
    }
  }

  /** The profile's blob id in the newest commit with a `Commit-Id: <commitId>` line, or null. */
  async #committed(commitId: string): Promise<string | null> {
    const sha = await this.git.findCommit(this.path, `Commit-Id: ${commitId}`)
    return sha === null ? null : ((await this.git.blobId(this.path, sha)) ?? EMPTY_BLOB)
  }

  /** The profile's path in the clone, its memory folder made if missing; `ProfileUnreadable` if it leaves the
   *  person's directory or it or its folder isn't a regular file or folder. */
  // Protected, not #private, so a test can make a hand edit just before the replace.
  protected target(): string {
    const target = path.join(this.git.root, this.path)
    const memory = path.dirname(target)
    const person = path.join(fs.realpathSync(this.git.root), "people", this.handle)
    if (fs.realpathSync(path.dirname(memory)) !== person) {
      throw new ProfileUnreadable(`${this.path} goes through a symlink`)
    }
    // Git drops the folder with its last file, so a new profile may need it again.
    try {
      fs.mkdirSync(memory)
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error
    }
    this.#checkFile()
    return target
  }

  /** `ProfileUnreadable` if the profile or its memory folder in the working tree is a symlink or not a regular file
   *  or folder; absent is fine. */
  #checkFile(): void {
    const folder = path.dirname(this.path)
    const memory = lstatIfExists(path.join(this.git.root, folder))
    if (memory?.isSymbolicLink()) throw new ProfileUnreadable(`${folder} is a symlink, not a folder`)
    if (memory && !memory.isDirectory()) throw new ProfileUnreadable(`${folder} is not a folder`)
    const st = lstatIfExists(path.join(this.git.root, this.path))
    if (st?.isSymbolicLink()) throw new ProfileUnreadable(`${this.path} is a symlink, not a regular file`)
    // Reading a folder fails with EISDIR, and a FIFO would block.
    if (st && !st.isFile()) throw new ProfileUnreadable(`${this.path} is not a regular file`)
  }

  /** Replaces `target` with `data` through a temporary file in the person's folder. */
  #put(target: string, data: Uint8Array): void {
    // The temp file is made 0600; keep the profile's mode, or git's default for a new file.
    const existing = lstatIfExists(target)
    const mode = existing ? existing.mode & 0o777 : 0o644
    // Beside the memory folder, not in it, so one a crash leaves is never committed as a hand edit.
    const person = path.dirname(path.dirname(target))
    const temporary = path.join(person, `.profile.md.${randomBytes(6).toString("hex")}`)
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    let open = true
    try {
      fs.fchmodSync(fd, mode) // umask-proof
      fs.writeFileSync(fd, data)
      open = false
      fs.closeSync(fd)
      fs.renameSync(temporary, target)
    } catch (error) {
      // Best effort, each on its own: the write's error is the one to report.
      if (open) ignoreErrors(() => fs.closeSync(fd))
      ignoreErrors(() => fs.unlinkSync(temporary))
      throw error
    }
  }

  /** Puts back the profile a failed commit left on disk; best effort, never throws. The commit has already
   *  unstaged what it staged, and a refused commit staged nothing, so an unresolved conflict stays one. */
  async #restore(target: string, previous: Uint8Array | null, current: string): Promise<void> {
    try {
      if ((await this.#current()) !== current) return // the commit landed before the failure; keep it
      if (previous === null) fs.rmSync(target, { force: true })
      else this.#put(target, previous)
    } catch {
      // the caller needs the commit's error, not this one
    }
  }

  /** The blob id of the profile at HEAD; a missing profile is the empty blob. */
  async #current(): Promise<string> {
    return (await this.git.blobId(this.path)) ?? EMPTY_BLOB
  }

  async #blob(version: string): Promise<Uint8Array | null> {
    // The empty blob is only in the object store once some empty file was committed.
    return version === EMPTY_BLOB ? new Uint8Array() : await this.git.readBlob(version)
  }

  /** `data` as UTF-8 text, a leading byte order mark kept; `ProfileUnreadable` if it isn't UTF-8. */
  #decode(data: Uint8Array): string {
    try {
      return UTF8.decode(data)
    } catch (error) {
      if (error instanceof TypeError) throw new ProfileUnreadable(`${this.path} is not UTF-8`)
      throw error
    }
  }
}

/** `fs.lstatSync(file)`, or null if it doesn't exist. */
function lstatIfExists(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** The bytes of `file`, or null if it doesn't exist. */
function readIfExists(file: string): Buffer | null {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Runs `fn`, ignoring any error it throws. */
function ignoreErrors(fn: () => void): void {
  try {
    fn()
  } catch {
    // the caller has a better error to report
  }
}
