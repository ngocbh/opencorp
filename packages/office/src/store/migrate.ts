/** Numbered SQL migrations, applied in order above `PRAGMA user_version`. */
import { type Sqlite } from "@ngocbh/yian/platform"
import { embedded } from "../platform.ts"
import initial from "./migrations/0001_initial.sql" with { type: "file" }

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/

/** A migration file is misnamed, or the database is newer than the code. */
export class MigrationError extends Error {
  override name = "MigrationError"
}

/** One migration: its file name (`NNNN_<name>.sql`) and its SQL. */
export interface MigrationFile {
  name: string
  sql: string
}

/** The office's migrations, in order; a new `.sql` file in `migrations/` is added here too. */
export const MIGRATIONS: MigrationFile[] = [{ name: "0001_initial.sql", sql: embedded(initial).toString("utf8") }]

/** The database's `PRAGMA user_version`: the last migration applied. */
export function userVersion(db: Sqlite): number {
  return db.prepare("PRAGMA user_version").get()!.user_version as number
}

/** `files` as `[number, file]` pairs, in order; throws `MigrationError` on a bad name or a repeated number. */
export function ladder(files: MigrationFile[]): [number, MigrationFile][] {
  const found = new Map<number, MigrationFile>()
  for (const file of files) {
    const match = NAME.exec(file.name)
    if (!match || Number(match[1]) === 0) throw new MigrationError(`bad migration file name: ${file.name}`)
    const number = Number(match[1])
    const other = found.get(number)
    if (other) throw new MigrationError(`two migrations numbered ${match[1]}: ${other.name}, ${file.name}`)
    found.set(number, file)
  }
  return [...found].sort(([a], [b]) => a - b)
}

/** Applies each migration numbered above `user_version`, in order, one transaction each. Gaps in the
 *  numbering are allowed. Returns the new `user_version`. */
export function migrate(db: Sqlite, files = MIGRATIONS): number {
  const steps = ladder(files)
  const latest = steps.at(-1)?.[0] ?? 0
  const current = userVersion(db)
  if (current > latest) throw new MigrationError(`store is at version ${current}, newer than this code (${latest})`)
  for (const [number, file] of steps) {
    if (number <= current) continue
    db.exec("BEGIN IMMEDIATE")
    try {
      // Another process may have applied it while this one waited for the write lock.
      if (userVersion(db) >= number) {
        db.exec("ROLLBACK")
        continue
      }
      // SQLite runs the whole script as it parses it, so trigger bodies and quoted `;` stay whole.
      db.exec(file.sql)
      db.exec(`PRAGMA user_version = ${number}`)
      db.exec("COMMIT")
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // SQLite may already have ended the transaction; the original error is the one to report.
      }
      throw error
    }
  }
  return userVersion(db)
}
