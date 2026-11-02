/** Why the office store can't be opened, in words that name the file and SQLite's code but never a value from the
 *  error's message, for the daemon's start error and doctor's store check. */
import { sqliteErrorCode } from "@ngocbh/yian/platform"
import { strerror } from "../sandbox/fs_helper.ts"
import { MigrationError } from "./migrate.ts"
import { StoreError } from "./store.ts"

/** SQLite's primary result codes that say something about the store file, by number. */
const CODES: Record<number, string> = {
  3: "SQLITE_PERM",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  8: "SQLITE_READONLY",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  26: "SQLITE_NOTADB",
}

/** What moving a broken store aside costs, so the advice never hides it. */
const MOVE_ASIDE =
  "move it aside (the office then starts with an empty store and its records are lost) or restore it from a backup"

/** The code SQLite gave `error` (its extended code's name when it has one), and the primary code's name; undefined
 *  for an error that isn't SQLite's. */
function sqliteCode(error: unknown): { shown: string; primary: string } | undefined {
  const number = sqliteErrorCode(error)
  if (number === undefined) return undefined
  const primary = CODES[number & 0xff]
  if (primary === undefined) return undefined
  const code = (error as { code?: unknown }).code
  return { shown: typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? code : primary, primary }
}

/**
 * Why opening the store at `file` threw `error`, or null when the error isn't about the file (a bug, which stays a
 * crash): a path that isn't a regular file, a store newer than this code, an OS error, or a SQLite code that names
 * the file's trouble (not a database, corrupt, the disk full or failing, permissions, another process's lock).
 * Only the path, SQLite's code and schema versions are shown.
 */
export function storeProblem(file: string, error: unknown): string | null {
  if (error instanceof StoreError && error.message.endsWith(" is not a regular file")) {
    return `${error.message}; ${MOVE_ASIDE}`
  }
  if (error instanceof MigrationError && error.message.includes(", newer than this code (")) {
    return `the store ${file}: ${error.message}; run a newer opencorp or restore a backup`
  }
  const sqlite = sqliteCode(error)
  if (sqlite !== undefined) {
    const { shown, primary } = sqlite
    switch (primary) {
      case "SQLITE_NOTADB":
        return `the store ${file} isn't a SQLite database (${shown}); ${MOVE_ASIDE}`
      case "SQLITE_CORRUPT":
        return `the store ${file} is corrupt (${shown}); ${MOVE_ASIDE}`
      case "SQLITE_FULL":
        return `the store ${file} can't be written: the disk is full (${shown}); free some space`
      case "SQLITE_IOERR":
        return `the store ${file} hit a disk error (${shown}); check the disk`
      case "SQLITE_BUSY":
      case "SQLITE_LOCKED":
        return `the store ${file} is locked by another process (${shown}); try again once it lets go`
      default:
        return `the store ${file} can't be opened (${shown}); check its permissions`
    }
  }
  const os = strerror(error)
  return os === undefined ? null : `can't open the store ${file}: ${os}`
}
