/** Reading and writing office files: reads never follow a link or block on a FIFO; writes are atomic, so a crash
 *  never leaves launchd or systemd half a file. */
import fs from "node:fs"
import path from "node:path"

/** The open errors that mean `file` isn't a regular file to read: missing, a link, or a FIFO or socket. */
const NOT_REGULAR = new Set(["ENOENT", "ELOOP", "EMLINK", "ENXIO", "EOPNOTSUPP"])

/** An fd and size for `file` if it is a regular file, else null; other errors throw. */
function openRegular(file: string): { fd: number; size: number } | null {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (NOT_REGULAR.has((error as NodeJS.ErrnoException).code ?? "")) return null
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (stat.isFile()) return { fd, size: stat.size }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  fs.closeSync(fd)
  return null
}

/** Up to `length` bytes of `fd` from `position`. */
function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

/** `file`'s bytes if it is a regular file of at most `maxBytes`, else null; other errors throw. */
export function readRegular(file: string, maxBytes: number): Buffer | null {
  const found = openRegular(file)
  if (found === null) return null
  try {
    return found.size > maxBytes ? null : readAt(found.fd, found.size, 0)
  } finally {
    fs.closeSync(found.fd)
  }
}

/** The last `maxBytes` of `file`, without the partial first line when it is cut; null when `file` isn't a regular
 *  file, and other errors throw. */
export function tailRegular(file: string, maxBytes: number): string | null {
  const found = openRegular(file)
  if (found === null) return null
  try {
    const start = Math.max(0, found.size - maxBytes)
    const text = readAt(found.fd, found.size - start, start).toString("utf8")
    if (start === 0) return text
    // A window that falls inside one long line holds only part of it.
    const nl = text.indexOf("\n")
    return nl < 0 ? "" : text.slice(nl + 1)
  } finally {
    fs.closeSync(found.fd)
  }
}

/** Writes `data` to `file` unless it already holds exactly those bytes, and returns whether it changed. The
 *  write goes to a fresh temp file renamed over `file` atomically; a symlink planted at the temp path is refused
 *  (`EEXIST`), never followed. A link, FIFO or other non-regular file at `file` counts as changed and is replaced. */
export function writeIfChanged(file: string, data: Uint8Array | string): boolean {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data
  if (readRegular(file, bytes.length)?.equals(bytes)) return false
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
  try {
    try {
      fs.writeFileSync(fd, bytes)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  return true
}
