/** Private files: the office secret store of asset credentials, and `writePrivate`/`readPrivate` for other secrets. */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { type FileLock, waitForLock } from "@ngocbh/yian/platform"

/** Valid secret names: lower-case letters, digits, `_`, `.`, `-`, not starting with `.` or `-`, at most 128
 *  characters; so `.lock` and temp files can never be names. */
export const NAME = /^[a-z0-9_][a-z0-9_.-]{0,127}$/

/** The shortest value accepted: results are scrubbed of every secret value, so a short one would mangle them. */
export const MIN_VALUE_CHARS = 8

// An operation holds the lock for microseconds, so a 30 s wait means a stuck holder; yian's
// sign-in store and DeepSeek Harness wait as long.
const LOCK_TIMEOUT_MS = 30_000

/** No secret has that name. */
export class SecretNotSetError extends Error {
  override name = "SecretNotSetError"
}

/** A bad secret name, or a value too short to set. */
export class InvalidSecretError extends Error {
  override name = "InvalidSecretError"
}

/** A folder or file isn't private to this user, or can't be used. */
export class PrivateFileError extends Error {
  override name = "PrivateFileError"
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** The number of characters in `value` without surrounding whitespace. */
function trimmedLength(value: string): number {
  return [...value.trim()].length
}

/** Throws `PrivateFileError` unless `dir` is a directory (not a symlink) of this user with mode 0700 or narrower;
 *  `ENOENT` propagates. */
function checkFolder(dir: string, label: string): void {
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch (error) {
    // A parent that is a file.
    if (errnoCode(error) !== "ENOTDIR") throw error
    throw new PrivateFileError(`${label} '${dir}' must be a directory, not a symlink`)
  }
  if (!st.isDirectory()) throw new PrivateFileError(`${label} '${dir}' must be a directory, not a symlink`)
  if (st.uid !== process.geteuid!()) throw new PrivateFileError(`${label} '${dir}' belongs to another user`)
  if (st.mode & 0o077) throw new PrivateFileError(`${label} '${dir}' must be mode 0700`)
}

/** Takes `<dir>/.lock`, waiting up to `LOCK_TIMEOUT_MS` for another holder. */
function lockFolder(dir: string): Promise<FileLock> {
  return waitForLock(path.join(dir, ".lock"), { private: true, timeoutMs: LOCK_TIMEOUT_MS })
}

/** Replaces `<dir>/<name>` with `data` as a 0600 file, atomically; a symlink there is replaced, not followed.
 *  The caller holds the folder's lock. */
function replaceFile(dir: string, name: string, data: string | Uint8Array): void {
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`)
  fs.rmSync(tmp, { force: true }) // left by a crashed run with the same pid; safe under the lock
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    fs.fchmodSync(fd, 0o600) // the umask may have narrowed it
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    const open = fd
    fd = undefined // so a failing close isn't closed again below, where an EBADF would hide its error
    fs.closeSync(open)
    fs.renameSync(tmp, path.join(dir, name))
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Secrets as files in `root` (mode 0700, owned by this user), each a regular file of mode 0600.
 *
 * A value is read from its file each time it is needed and never kept, logged, or put in an
 * environment or argv. A root or secret file that is a symlink, or that is not private to this
 * user, is refused with `PrivateFileError` rather than trusted. Every call checks the root and
 * holds its `.lock` while it reads or writes.
 */
export class SecretStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** The secret `name`. Rejects with `SecretNotSetError` when no secret has that name, `InvalidSecretError`
   *  for a bad name, and `PrivateFileError` when the root or the secret's file is not private to this user
   *  or the value is too short to scrub. Rejects with yian's `FileLockError` when the folder's lock can't be
   *  taken (a 30 s wait for another holder, or a `.lock` that isn't private). */
  async get(name: string): Promise<string> {
    checkName(name)
    this.openRoot(name)
    using _lock = await lockFolder(this.root)
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    let fd: number
    try {
      // O_NONBLOCK so a FIFO planted in place of a secret can't hang the open.
      fd = fs.openSync(path.join(this.root, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    } catch (error) {
      const code = errnoCode(error)
      if (code === "ENOENT") throw new SecretNotSetError(`secret '${name}' is not set`)
      // The final component of a symlink under O_NOFOLLOW fails with ELOOP (EMLINK on some BSDs).
      if (code === "ELOOP" || code === "EMLINK") throw new PrivateFileError(`secret '${name}' is a symlink`)
      if (code === "EACCES") throw new PrivateFileError(`secret '${name}' is not readable`)
      throw error
    }
    let value: string
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) throw new PrivateFileError(`secret '${name}' is not a regular file`)
      if (st.uid !== process.geteuid!()) throw new PrivateFileError(`secret '${name}' belongs to another user`)
      if ((st.mode & 0o7777) !== 0o600) throw new PrivateFileError(`secret '${name}' must be mode 0600`)
      // ignoreBOM keeps a leading BOM, as Python's decode does.
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd))
    } finally {
      fs.closeSync(fd)
    }
    if (trimmedLength(value) < MIN_VALUE_CHARS) {
      throw new PrivateFileError(`secret '${name}' is shorter than ${MIN_VALUE_CHARS} characters`)
    }
    return value
  }

  /** Sets the secret `name` to `value`, replacing any old value atomically; creates the root, mode 0700, if
   *  missing. Rejects with `InvalidSecretError` for a bad name or a value (without surrounding whitespace)
   *  shorter than `MIN_VALUE_CHARS`, and `PrivateFileError` when the root is not a private directory of
   *  this user. Rejects with yian's `FileLockError` when the folder's lock can't be taken (a 30 s wait for
   *  another holder, or a `.lock` that isn't private). */
  async set(name: string, value: string): Promise<void> {
    checkName(name)
    if (trimmedLength(value) < MIN_VALUE_CHARS) {
      throw new InvalidSecretError(`secret '${name}' must be at least ${MIN_VALUE_CHARS} characters`)
    }
    fs.mkdirSync(path.dirname(this.root), { recursive: true })
    try {
      fs.mkdirSync(this.root, { mode: 0o700 })
      fs.chmodSync(this.root, 0o700) // the umask may have narrowed it
    } catch (error) {
      // Another call may create it at the same time.
      if (errnoCode(error) !== "EEXIST") throw error
    }
    checkFolder(this.root, "secret store")
    using _lock = await lockFolder(this.root)
    replaceFile(this.root, name, value)
  }

  /** Removes the secret `name`. Rejects with `SecretNotSetError` when no secret has that name,
   *  `InvalidSecretError` for a bad name, and `PrivateFileError` when the root is not a private directory
   *  of this user. Rejects with yian's `FileLockError` when the folder's lock can't be taken (a 30 s wait
   *  for another holder, or a `.lock` that isn't private). */
  async delete(name: string): Promise<void> {
    checkName(name)
    this.openRoot(name)
    using _lock = await lockFolder(this.root)
    try {
      fs.unlinkSync(path.join(this.root, name))
    } catch (error) {
      if (errnoCode(error) === "ENOENT") throw new SecretNotSetError(`secret '${name}' is not set`)
      throw error
    }
  }

  /** Shows the root only, never a value. */
  toJSON(): { root: string } {
    return { root: this.root }
  }

  /** Shows the root only, never a value. */
  [inspect.custom](): string {
    return `SecretStore(${JSON.stringify(this.root)})`
  }

  /** Checks the root for a call on the secret `name`; a missing root means the secret is not set. */
  private openRoot(name: string): void {
    try {
      checkFolder(this.root, "secret store")
    } catch (error) {
      if (errnoCode(error) === "ENOENT") throw new SecretNotSetError(`secret '${name}' is not set`)
      throw error
    }
  }
}

function checkName(name: string): void {
  if (typeof name !== "string" || !NAME.test(name)) {
    // The name isn't echoed: a caller who swapped name and value would put the secret in the message.
    throw new InvalidSecretError(`secret name must match ${NAME.source}`)
  }
}
