/** How the office names SQLite errors, and which of them mean the store can't be written. */
import { expect, test } from "bun:test"
import { sqliteName, storeWriteFailure } from "../../src/store/store.ts"

/** A bun:sqlite error with result code `errno`. */
function sqliteError(errno: number): Error {
  return Object.assign(new Error("database or disk is full"), { name: "SQLiteError", errno })
}

test("a SQLite error is named by its primary result code", () => {
  expect(sqliteName(sqliteError(13))).toBe("SQLITE_FULL")
  expect(sqliteName(sqliteError(778))).toBe("SQLITE_IOERR")
  expect(sqliteName(sqliteError(5))).toBe("SQLITE_BUSY")
  expect(sqliteName(sqliteError(2067))).toBe("SQLITE_CONSTRAINT")
  expect(sqliteName(sqliteError(1))).toBe("SQLITE_1")
  expect(sqliteName(new Error("x"))).toBeUndefined()
})

test("only a full disk, an I/O error, a read-only or unopenable store can't be written", () => {
  for (const [errno, name] of [
    [13, "SQLITE_FULL"],
    [778, "SQLITE_IOERR"],
    [8, "SQLITE_READONLY"],
    [1032, "SQLITE_READONLY"],
    [14, "SQLITE_CANTOPEN"],
  ] as const) {
    expect(storeWriteFailure(sqliteError(errno))).toBe(name)
  }
  for (const other of [sqliteError(19), sqliteError(2067), sqliteError(5), new Error("x"), "SQLITE_FULL"]) {
    expect(storeWriteFailure(other)).toBeNull()
  }
})
