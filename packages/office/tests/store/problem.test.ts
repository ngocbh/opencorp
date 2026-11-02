/** Why the store can't be opened, as the daemon's start error and doctor's store check say it. */
import { expect, test } from "bun:test"
import { newerStore } from "../../src/store/migrate.ts"
import { storeProblem } from "../../src/store/problem.ts"
import { StoreError } from "../../src/store/store.ts"

const FILE = "/h/office/store.sqlite"

/** An error shaped like bun:sqlite's for `code` (`errno` is its number), with a message that must never show. */
function sqliteError(errno: number, code: string): Error {
  return Object.assign(new Error("secret value in the message"), { name: "SQLiteError", errno, code })
}

test("each store trouble names the file and the code, and advice fits the cause", () => {
  const cases: [Error, string][] = [
    [sqliteError(26, "SQLITE_NOTADB"), "isn't a SQLite database (SQLITE_NOTADB); move it aside"],
    [sqliteError(267, "SQLITE_CORRUPT_VTAB"), "is corrupt (SQLITE_CORRUPT_VTAB); move it aside"],
    [sqliteError(13, "SQLITE_FULL"), "the disk is full (SQLITE_FULL); free some space"],
    [sqliteError(522, "SQLITE_IOERR_SHORT_READ"), "hit a disk error (SQLITE_IOERR_SHORT_READ); check the disk"],
    [sqliteError(8, "SQLITE_READONLY"), "can't be opened (SQLITE_READONLY); check its permissions"],
    [sqliteError(3, "SQLITE_PERM"), "can't be opened (SQLITE_PERM); check its permissions"],
    [sqliteError(14, "SQLITE_CANTOPEN"), "can't be opened (SQLITE_CANTOPEN); check its permissions"],
    [sqliteError(5, "SQLITE_BUSY"), "is locked by another process (SQLITE_BUSY)"],
    [sqliteError(6, "SQLITE_LOCKED"), "is locked by another process (SQLITE_LOCKED)"],
  ]
  for (const [error, said] of cases) {
    const got = storeProblem(FILE, error)
    expect(got).toContain(`the store ${FILE} `)
    expect(got).toContain(said)
    expect(got).not.toContain("secret")
  }
  expect(storeProblem(FILE, sqliteError(26, "SQLITE_NOTADB"))).toContain("its records are lost")
  expect(storeProblem(FILE, sqliteError(13, "SQLITE_FULL"))).not.toContain("move it aside")
})

test("a store bug stays a crash", () => {
  expect(storeProblem(FILE, sqliteError(1, "SQLITE_ERROR"))).toBeNull()
  expect(storeProblem(FILE, sqliteError(19, "SQLITE_CONSTRAINT"))).toBeNull()
  expect(storeProblem(FILE, new TypeError("x"))).toBeNull()
  expect(storeProblem(FILE, new StoreError("the store is closed"))).toBeNull()
})

test("a path that isnt a file, a newer store and an os error are named", () => {
  expect(storeProblem(FILE, new StoreError(`store file ${FILE} is not a regular file`))).toStartWith(
    `store file ${FILE} is not a regular file; move it aside`,
  )
  expect(storeProblem(FILE, newerStore(9, 5))).toBe(
    `the store ${FILE}: store is at version 9, newer than this code (5); run a newer opencorp or restore a backup`,
  )
  const denied = Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: "EACCES", errno: -13 })
  expect(storeProblem(FILE, denied)).toBe(`can't open the store ${FILE}: Permission denied`)
})
