/** How the office names SQLite errors, and which of them mean the store can't be written. */
import { expect, test } from "bun:test"
import { DuplicateKey, StoreUnwritable, sqliteName, storeWriteFailure } from "../../src/store/store.ts"
import { openStore, workItem } from "./helpers.ts"

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
    const error = StoreUnwritable.from(sqliteError(errno))
    expect(error).toBeInstanceOf(StoreUnwritable)
    expect(storeWriteFailure(error)).toBe(name)
  }
  for (const errno of [19, 2067, 5]) {
    const error = sqliteError(errno)
    expect(StoreUnwritable.from(error)).toBe(error)
  }
  for (const other of [sqliteError(13), new Error("x"), "SQLITE_FULL"]) expect(storeWriteFailure(other)).toBeNull()
})

test("a store write that SQLite refuses as read-only throws StoreUnwritable, naming no file", () => {
  const store = openStore()
  store.db.exec("PRAGMA query_only = 1")
  let thrown: unknown
  try {
    store.createWorkItem(workItem())
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(StoreUnwritable)
  expect((thrown as StoreUnwritable).code).toBe("SQLITE_READONLY")
  expect((thrown as Error).message).toBe("the office can't write its store (SQLITE_READONLY)")
  store.db.exec("PRAGMA query_only = 0")
  expect(store.createWorkItem(workItem()).title).toBe("Fix the build")
})

test("a duplicate key is not StoreUnwritable", () => {
  const store = openStore()
  const item = store.createWorkItem(workItem())
  expect(() => store.createWorkItem({ ...item })).toThrow(DuplicateKey)
})
