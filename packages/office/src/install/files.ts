/** Writing service files: atomically, so a crash never leaves launchd or systemd half a file. */
import fs from "node:fs"
import path from "node:path"

/** Writes `data` to `file` unless it already holds exactly those bytes, and returns whether it changed. The
 *  write goes to a fresh temp file renamed over `file` atomically; a symlink planted at the temp path is refused
 *  (`EEXIST`), never followed. */
export function writeIfChanged(file: string, data: Uint8Array | string): boolean {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data
  try {
    if (fs.readFileSync(file).equals(bytes)) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
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
