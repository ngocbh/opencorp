/** Private files: folders of mode 0700 and files of mode 0600 owned by this user, written atomically and read under
 *  their folder's lock, never through a symlink. */
import fs from "node:fs"
import path from "node:path"
import { type FileLock, waitForLock } from "@ngocbh/yian/platform"

// An operation holds the lock for microseconds, so a 30 s wait means a stuck holder; yian's
// sign-in store and DeepSeek Harness wait as long.
const LOCK_TIMEOUT_MS = 30_000

/** A folder or file isn't private to this user, or can't be used. */
export class PrivateFileError extends Error {
  override name = "PrivateFileError"
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** Throws `PrivateFileError` unless `dir` is a directory (not a symlink) of this user with mode 0700 or narrower;
 *  `ENOENT` propagates. */
export function checkFolder(dir: string, label: string): void {
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

/** Creates `dir`, mode 0700, and its missing parents; an existing `dir` is left as is. */
export function makePrivateFolder(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.chmodSync(dir, 0o700) // the umask may have narrowed it
  } catch (error) {
    // Another call may create it at the same time.
    if (errnoCode(error) !== "EEXIST") throw error
  }
}

/** Takes `<dir>/.lock`, waiting up to `LOCK_TIMEOUT_MS` for another holder. */
export function lockFolder(dir: string): Promise<FileLock> {
  return waitForLock(path.join(dir, ".lock"), { private: true, timeoutMs: LOCK_TIMEOUT_MS })
}

/** Throws `PrivateFileError` when `file` is its folder's lock file, `.lock`. */
function refuseLockFile(file: string): void {
  // Reading the lock file would open, then close, a descriptor on the lock's inode, which drops the
  // POSIX lock this call holds (see yian's note inside `lockFile`); writing it would rename a new inode over
  // the lock. macOS's default file system ignores case, so `.LOCK` (or `.loc` + KELVIN SIGN, which
  // lowercases to `k`) names the same file.
  if (path.basename(file).toLowerCase() === ".lock") throw new PrivateFileError(`'${file}' is the folder's lock file`)
}

/** Replaces `<dir>/<name>` with `data` as a 0600 file, atomically; a symlink there is replaced, not followed.
 *  The caller holds the folder's lock, or is the folder's only writer. */
export function replaceFile(dir: string, name: string, data: string | Uint8Array): void {
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`)
  fs.rmSync(tmp, { force: true }) // left by a crashed run with the same pid; safe with no other writer
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

/** Replaces `file` with `data` as a 0600 file, atomically, under its folder's lock; a symlink at `file` is
 *  replaced, not followed. The name `.lock` is reserved for the folder's lock. Rejects with `PrivateFileError`
 *  when `file` is named `.lock` or the folder is not a private directory of this user, the `ENOENT` error
 *  when the folder is missing, and yian's `FileLockError` when the folder's lock can't be taken (a 30 s wait
 *  for another holder, or a `.lock` that isn't private). */
export async function writePrivate(file: string, data: string | Uint8Array): Promise<void> {
  // Resolved so a `/.` tail can't make lstat follow a symlinked folder.
  file = path.resolve(file)
  refuseLockFile(file)
  const dir = path.dirname(file)
  checkFolder(dir, "folder")
  using _lock = await lockFolder(dir)
  replaceFile(dir, path.basename(file), data)
}

/** The contents of `file`, read under its folder's lock; the file must be a regular file of this user that
 *  others can't read or write. The name `.lock` is reserved for the folder's lock. Rejects with the `ENOENT`
 *  error when the file or its folder is missing, `PrivateFileError` when `file` is named `.lock`, the folder
 *  is not a private directory of this user, or the file is a symlink, not a regular file, another user's,
 *  open to others, or can't be opened, and yian's `FileLockError` when the folder's lock can't be taken (a
 *  30 s wait for another holder, or a `.lock` that isn't private). */
export async function readPrivate(file: string): Promise<Buffer> {
  // Resolved so a `/.` tail can't make lstat follow a symlinked folder.
  file = path.resolve(file)
  refuseLockFile(file)
  const dir = path.dirname(file)
  checkFolder(dir, "folder")
  using _lock = await lockFolder(dir)
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NONBLOCK so a FIFO planted in its place can't hang the open; fstat then refuses it.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") throw error
    // The final component of a symlink under O_NOFOLLOW fails with ELOOP (EMLINK on some BSDs).
    if (code === "ELOOP" || code === "EMLINK") throw new PrivateFileError(`'${file}' is a symlink, not a regular file`)
    throw new PrivateFileError(`can't open '${file}': ${code}`)
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.uid !== process.geteuid!() || st.mode & 0o077) {
      throw new PrivateFileError(`'${file}' must be a regular file private to its owner (mode 0600)`)
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
