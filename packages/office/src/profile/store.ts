/** A person's profile folder, `people/<handle>/memory/`, as yian's FileMemory with `profile.md` as its index: chats
 *  bind it as their `profile` memory and only read it, and the office reads and writes the profile through it,
 *  committing each write to the company clone. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  type Applied,
  type Author,
  FileMemory,
  type FileMemoryOptions,
  MemoryBase,
  type MemoryContract,
  memoryErrorKind,
  type MemorySession,
} from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { Handle } from "@opencorp/protocol"
import { errno } from "../company/flows.ts"
import { type CompanyGit, oneLine } from "../company/git.ts"
import { profilePath } from "../company/loader.ts"

/** The profile's file in its memory folder: the FileMemory's index, whose text is a chat's recall. */
export const PROFILE_INDEX = "profile.md"

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The sha256 hex digest of `data`: FileMemory's hash of a file, which is a profile's version. */
export function profileHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** The version of a missing or empty profile: the hash of no bytes. */
export const EMPTY_VERSION = profileHash(new Uint8Array())

/** The characters a profile may hold: yian's default for all files of a FileMemory. */
export const PROFILE_MAX_CHARS = 1_000_000

/**
 * The settings of every profile memory, the same in every company and at every pin: a run records them and refuses an
 * advance whose settings differ. A file may hold as much as the whole memory, and the recall covers a whole file, so
 * a chat reads the whole profile. Each is given, so no `YIAN_FILE_MEMORY_*` or `YIAN_MEMORY_*` variable changes one;
 * the rest are yian's defaults.
 */
export const PROFILE_SETTINGS: Readonly<Omit<FileMemoryOptions, "root" | "id" | "index" | "scheduler">> =
  Object.freeze({
    maxFileChars: PROFILE_MAX_CHARS,
    maxRecallChars: PROFILE_MAX_CHARS,
    maxTotalChars: PROFILE_MAX_CHARS,
    maxHistoryChars: PROFILE_MAX_CHARS,
    maxFiles: 1_000,
    maxDepth: 4,
    maxReadChars: 20_000,
    maxResults: 100,
    maxUndo: 100,
    maxChangeIds: 10_000,
    lockTimeoutMs: 30_000,
  })

/** The profile or its folders can't be read or written as a profile: the profile isn't UTF-8, holds more than
 *  `PROFILE_MAX_CHARS` characters, or is a hard link; or it, its memory folder, its person's folder or `people` is a
 *  symlink or not a regular file or folder. Its message names only repo paths. */
export class ProfileUnreadable extends RangeError {
  override name = "ProfileUnreadable"
}

/** A write's base version is no longer the profile's version. */
export class ProfileConflict extends Error {
  override name = "ProfileConflict"

  constructor(
    readonly expected: string,
    readonly current: string,
  ) {
    super(`the profile is at version ${current}, not ${expected}`)
  }
}

/** The memory refused a write that passed one of its caps, with its reason; nothing was written. */
export class ProfileRefused extends Error {
  override name = "ProfileRefused"
}

/** `profile(@<handle>): <source>`, one line whatever the caller sent. */
export function commitMessage(handle: string, source: string): string {
  return `profile(@${oneLine(handle)}): ${oneLine(source)}`
}

/** The member a change that applied wrote: its result's `path`; null for one that didn't apply. */
function appliedPath(applied: Applied): string | null {
  return applied.ok && typeof applied.result.path === "string" ? applied.result.path : null
}

/** A signal that never aborts, for the office's own writes, which the memory's lock timeout bounds. */
const NEVER = new AbortController().signal

/**
 * `people/<handle>/memory/` in the company clone, as yian's FileMemory with `profile.md` as its index, the identity
 * `people/<handle>` and `PROFILE_SETTINGS`.
 *
 * Versions are FileMemory's file hashes. Each write is committed under the repo lock, after the hand edits pending
 * then; a crash between a write and its commit leaves a hand edit, which `commitHandEdits` commits. The constructor
 * does no I/O: the office builds one per request.
 */
export class GitProfileStore {
  readonly git: CompanyGit
  readonly handle: string
  /** The profile's repo path, `people/<handle>/memory/profile.md`. */
  readonly path: string
  /** The memory folder's repo path, `people/<handle>/memory`. */
  readonly folder: string

  constructor(git: CompanyGit, handle: string) {
    if (!Handle.safeParse(handle).success) throw new RangeError(`not a handle: ${JSON.stringify(handle)}`)
    this.git = git
    this.handle = handle
    this.path = profilePath(handle)
    this.folder = path.posix.dirname(this.path)
  }

  /** yian's FileMemory on the memory folder. Throws `ProfileUnreadable` when `people`, the person's folder or the
   *  memory folder is a symlink or not a folder: FileMemory resolves its root, so it would follow one elsewhere. */
  fileMemory(): FileMemory {
    this.#checkFolders()
    return new FileMemory({
      root: path.join(this.git.root, this.folder),
      id: `people/${this.handle}`,
      index: PROFILE_INDEX,
      ...PROFILE_SETTINGS,
    })
  }

  /** The memory folder as a memory a run binds, its folders checked as each run opens it. A run only reads it: the
   *  worker's end of it changes nothing. */
  memory(): MemoryBase {
    return new ProfileFolder(this)
  }

  /**
   * The profile's text and version, after committing pending hand edits; a missing profile is `""` at
   * `EMPTY_VERSION`. Throws `ProfileUnreadable` for a profile that isn't one, and `CompanyGitError` when git fails.
   */
  async read(): Promise<{ text: string; version: string }> {
    return await this.git.locked(async (locked) => {
      // Before, so a symlink or folder isn't committed as a hand edit; after, for one swapped in meanwhile.
      this.#checkFile()
      await locked.commitHandEdits()
      const { text, version } = this.#current()
      return { text, version }
    })
  }

  /**
   * Writes `text` over the profile if `baseVersion` is its version, as change `changeId` by `author`, and commits it
   * as `source`; returns the new version and HEAD after the commit (HEAD as it was when the text didn't change, null
   * when the commit failed). A missing profile is created when `baseVersion` is `EMPTY_VERSION`; any other is
   * rewritten with `baseVersion` as `if_hash`. A change id the memory already applied returns that change's outcome
   * and writes nothing.
   *
   * Throws a TypeError for non-strings, a RangeError for a lone surrogate, `ProfileConflict` for a stale base,
   * `ProfileRefused` for text over a cap of the memory, `ProfileUnreadable` for a profile that isn't one, a 409
   * `CompanyRepoBusy` while a human's operation is in progress or the folder has a conflict, and `CompanyGitError`
   * when git fails.
   */
  async write(
    text: string,
    o: { baseVersion: string; changeId: string; author: Author; source: string },
  ): Promise<{ version: string; commit: string | null }> {
    const { baseVersion, changeId, author, source } = o
    if (typeof text !== "string" || typeof baseVersion !== "string") {
      throw new TypeError("text and baseVersion must be strings")
    }
    if (!text.isWellFormed()) throw new RangeError("text holds a lone surrogate, which has no UTF-8 encoding")
    const memory = this.fileMemory()
    // Before the hand edits are committed, as `read` does: a folder at profile.md fails git's commit.
    this.#checkFile()
    const { result: applied, commit } = await this.committed(
      async () => {
        const session = await memory.open({ create: true, itemType: null, signal: NEVER })
        try {
          // Read once the memory is open: its open settles a change a crash cut off.
          const { missing } = this.#current()
          return await writeProfile(session, { text, baseVersion, missing, changeId, author })
        } finally {
          await session.close()
        }
      },
      appliedPath,
      source,
    )
    if (applied.ok) return { version: applied.result.hash as string, commit }
    const current = applied.current?.hash
    const now = typeof current === "string" ? current : this.#current().version
    if (now !== baseVersion) throw new ProfileConflict(baseVersion, now)
    throw new ProfileRefused(applied.reason)
  }

  /**
   * Runs `change`, a write to the memory folder, under the repo lock once pending hand edits are committed, then
   * commits the member `changed(result)` names, if any, as `source`; returns the change's result and HEAD after the
   * commit (null when nothing was to be committed, or the commit failed). Refuses with a 409 `CompanyRepoBusy` before
   * the change runs while a human's operation is in progress or the folder has an unresolved conflict. A commit that
   * fails after the change leaves it on disk for `commitHandEdits`: the change happened, so the caller hears it did.
   */
  async committed<T>(
    change: () => Promise<T>,
    changed: (result: T) => string | null,
    source: string,
  ): Promise<{ result: T; commit: string | null }> {
    return await this.git.locked(async (locked) => {
      await locked.refuseBusy([this.folder])
      await locked.commitHandEdits()
      const result = await change()
      const member = changed(result)
      let commit: string | null = null
      if (member !== null) {
        try {
          commit = await locked.commit([`${this.folder}/${member}`], commitMessage(this.handle, source))
        } catch {
          // Committed later as a hand edit.
        }
      }
      return { result, commit }
    })
  }

  /** The profile's text, version, and whether it is missing. Throws `ProfileUnreadable` for a profile that isn't
   *  one: not a regular file, a hard link, not UTF-8, or over the characters a file of the memory may hold. */
  #current(): { text: string; version: string; missing: boolean } {
    this.#checkFile()
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    let fd: number
    try {
      // No follow, so a symlink swapped in since the check isn't read; no block, so a FIFO isn't waited on.
      fd = fs.openSync(path.join(this.git.root, this.path), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    } catch (error) {
      if (errno(error) === "ENOENT") return { text: "", version: EMPTY_VERSION, missing: true }
      if (errno(error) === "ELOOP") throw new ProfileUnreadable(`${this.path} is a symlink, not a regular file`)
      throw error
    }
    let data: Buffer
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) throw new ProfileUnreadable(`${this.path} is not a regular file`)
      if (st.nlink > 1) throw new ProfileUnreadable(`${this.path} is a hard link; replace it with a copy`)
      // A UTF-8 character takes at most four bytes, so a bigger file is over the cap unread.
      if (st.size > 4 * PROFILE_MAX_CHARS) throw this.#tooLong(null)
      data = fs.readFileSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    let text: string
    try {
      text = UTF8.decode(data)
    } catch {
      throw new ProfileUnreadable(`${this.path} is not UTF-8`)
    }
    const chars = [...text].length
    if (chars > PROFILE_MAX_CHARS) throw this.#tooLong(chars)
    return { text, version: profileHash(data), missing: false }
  }

  /** Why a profile over the memory's file cap isn't one: chats leave it out, and the memory can't rewrite it. */
  #tooLong(chars: number | null): ProfileUnreadable {
    const holds = chars === null ? "holds" : `holds ${chars} characters,`
    return new ProfileUnreadable(
      `${this.path} ${holds} more than the ${PROFILE_MAX_CHARS} a profile may hold; ` +
        "chats leave it out until it is shortened by hand",
    )
  }

  /** `ProfileUnreadable` if a folder above the profile (`#checkFolders`) is wrong, or the profile is a symlink or
   *  not a regular file; a missing one is fine. */
  #checkFile(): void {
    this.#checkFolders()
    const st = lstatIfExists(path.join(this.git.root, this.path))
    if (st?.isSymbolicLink()) throw new ProfileUnreadable(`${this.path} is a symlink, not a regular file`)
    // Reading a folder fails with EISDIR, and a FIFO would block.
    if (st && !st.isFile()) throw new ProfileUnreadable(`${this.path} is not a regular file`)
  }

  /** `ProfileUnreadable` if `people`, the person's folder or the memory folder is a symlink or not a folder; the
   *  first missing one ends the check. */
  #checkFolders(): void {
    for (const rel of ["people", `people/${this.handle}`, this.folder]) {
      const st = lstatIfExists(path.join(this.git.root, rel))
      if (st === null) return
      if (st.isSymbolicLink()) throw new ProfileUnreadable(`${rel} is a symlink, not a folder`)
      if (!st.isDirectory()) throw new ProfileUnreadable(`${rel} is not a folder`)
    }
  }
}

/**
 * Writes the profile's `text` in `session` as change `changeId`: a `create` when the profile is `missing` and the
 * base is `EMPTY_VERSION`, else a `rewrite` with `baseVersion` as `if_hash`. A change id the memory knows for the
 * other of the two (the file was created or removed since that write) returns that write's stored outcome.
 */
async function writeProfile(
  session: MemorySession,
  o: { text: string; baseVersion: string; missing: boolean; changeId: string; author: Author },
): Promise<Applied> {
  const create: JsonObject = { op: "create", path: PROFILE_INDEX, text: o.text }
  const rewrite: JsonObject = { op: "rewrite", path: PROFILE_INDEX, text: o.text, if_hash: o.baseVersion }
  const first = o.missing && o.baseVersion === EMPTY_VERSION ? create : rewrite
  const apply = (change: JsonObject) => session.apply({ id: o.changeId, change, author: o.author, signal: NEVER })
  try {
    return await apply(first)
  } catch (error) {
    if (memoryErrorKind(error) !== "change_id_reused") throw error
    return await apply(first === create ? rewrite : create)
  }
}

/** A profile folder bound to a run: yian's FileMemory, opened once its folders are checked. The office never resets
 *  a profile; it writes one only through `GitProfileStore.write`. */
class ProfileFolder extends MemoryBase {
  static override readonly contract: MemoryContract = FileMemory.contract

  constructor(readonly store: GitProfileStore) {
    super()
  }

  override async open(o: {
    create: boolean
    itemType: JsonObject | null
    signal: AbortSignal
  }): Promise<MemorySession> {
    return await this.store.fileMemory().open(o)
  }

  override async reset(_o: { signal: AbortSignal }): Promise<void> {
    throw new Error("the office doesn't reset a profile")
  }
}

/** `fs.lstatSync(file)`, or null if it doesn't exist. */
function lstatIfExists(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") return null
    throw error
  }
}
