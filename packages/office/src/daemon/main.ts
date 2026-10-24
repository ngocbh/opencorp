/** The daemon process: one daemon per home, held by a lock beside its pidfile. */
import fs from "node:fs"
import { type FileLock, FileLockError, waitForLock } from "@ngocbh/yian/platform"
import { OfficeStartError } from "./sockets.ts"

/** How long a start waits for the home's lock before it reports the office already running: a busy
 *  result can be momentary (a probe or a racing start). */
export const LOCK_WAIT_MS = 1000

/** Another daemon holds this home's lock. */
export class AlreadyRunning extends OfficeStartError {
  override name = "AlreadyRunning"

  constructor(readonly pid: number | null) {
    super(`office already running (pid ${pid ?? "unknown"})`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The pid the pidfile at `file` names, or null when it can't be read or holds no pid. */
function readPid(file: string): number | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let text: string
  try {
    const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    try {
      const buffer = Buffer.alloc(32)
      text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString().trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  return /^\d+$/.test(text) ? Number(text) : null
}

/** The home's single-daemon lock (yian's lock on `office/office.lock`, held for the daemon's life) and
 *  the pidfile beside it, which names the holder. */
export class PidFile {
  #lock: FileLock | undefined
  #fd: number | undefined

  constructor(
    readonly path: string,
    readonly lockPath: string,
  ) {}

  /** Takes the lock and writes our pid. `AlreadyRunning` (with the pid the pidfile names, or null) when
   *  another holder has the lock; `OfficeStartError` for a symlinked pidfile, a lock file that isn't
   *  private, or another open failure. Never follows a symlink and never truncates another file. */
  async acquire(): Promise<void> {
    let lock: FileLock
    try {
      lock = await waitForLock(this.lockPath, { timeoutMs: LOCK_WAIT_MS, private: true })
    } catch (error) {
      if (error instanceof FileLockError) {
        if (error.reason === "busy") throw new AlreadyRunning(readPid(this.path))
        throw new OfficeStartError(error.message)
      }
      throw new OfficeStartError(`can't lock ${this.lockPath}: ${messageOf(error)}`)
    }
    const { O_RDWR, O_CREAT, O_NOFOLLOW } = fs.constants
    let fd: number
    try {
      fd = fs.openSync(this.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    } catch (error) {
      lock.release()
      const code = (error as NodeJS.ErrnoException).code
      // Linux and macOS say ELOOP for a symlink under O_NOFOLLOW; FreeBSD says EMLINK.
      if (code === "ELOOP" || code === "EMLINK") throw new OfficeStartError(`the pidfile ${this.path} is a symlink`)
      throw new OfficeStartError(`can't open the pidfile ${this.path}: ${messageOf(error)}`)
    }
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, `${process.pid}\n`)
    this.#fd = fd
    this.#lock = lock
  }

  /** Removes the pidfile and releases the lock; harmless when not held. */
  release(): void {
    if (this.#lock === undefined) return
    fs.closeSync(this.#fd!)
    // Removed while the lock is still ours, so it can't remove a newer daemon's pidfile.
    fs.rmSync(this.path, { force: true })
    this.#lock.release()
    this.#lock = undefined
    this.#fd = undefined
  }
}
