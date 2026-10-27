/** The migration ladder applies numbered SQL files above PRAGMA user_version. */
import fs from "node:fs"
import { join } from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { openSqlite, sqliteErrorCode, type Sqlite } from "@ngocbh/yian/platform"
import { MIGRATIONS, MigrationError, migrate, userVersion, type MigrationFile } from "../../src/store/migrate.ts"
import { tempDir } from "../helpers.ts"
import { thrown } from "./helpers.ts"

function open(): Sqlite {
  const db = openSqlite(join(tempDir(), "db.sqlite"))
  onTestFinished(() => db.close())
  return db
}

function files(entries: Record<string, string>): MigrationFile[] {
  return Object.entries(entries).map(([name, sql]) => ({ name, sql }))
}

function tables(db: Sqlite): Set<string> {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)))
}

test("fresh db gets every file", () => {
  const db = open()
  expect(migrate(db, files({ "0001_a.sql": "CREATE TABLE a (x);", "0002_b.sql": "CREATE TABLE b (x);" }))).toBe(2)
  expect(tables(db)).toEqual(new Set(["a", "b"]))
  expect(userVersion(db)).toBe(2)
})

test("db at one gets only newer files", () => {
  const db = open()
  migrate(db, files({ "0001_a.sql": "CREATE TABLE a (x);" }))
  // Re-running 0001 would fail: table a already exists.
  migrate(db, files({ "0002_b.sql": "CREATE TABLE b (x);" }))
  expect(tables(db)).toEqual(new Set(["a", "b"]))
  expect(userVersion(db)).toBe(2)
})

test("gap applies in order", () => {
  const db = open()
  const ladder = files({
    "0003_c.sql": "INSERT INTO a VALUES (3);",
    "0001_a.sql": "CREATE TABLE a (x);\nINSERT INTO a VALUES (1);",
  })
  expect(migrate(db, ladder)).toBe(3)
  expect(db.prepare("SELECT x FROM a ORDER BY rowid").all().map((r) => r.x)).toEqual([1, 3])
})

test("failed file rolls back and keeps version", () => {
  const db = open()
  const ladder = files({ "0001_a.sql": "CREATE TABLE a (x);", "0002_bad.sql": "CREATE TABLE b (x);\nNOT SQL;" })
  expect(sqliteErrorCode(thrown(() => migrate(db, ladder)))).not.toBeUndefined()
  expect(tables(db)).toEqual(new Set(["a"]))
  expect(userVersion(db)).toBe(1)
})

test("db newer than code is refused", () => {
  const db = open()
  db.exec("PRAGMA user_version = 7")
  const e = thrown(() => migrate(db, files({ "0001_a.sql": "CREATE TABLE a (x);" })))
  expect(e).toBeInstanceOf(MigrationError)
  expect((e as Error).message).toMatch(/newer/)
})

test("bad names are refused", () => {
  for (const names of [["1_a.sql"], ["0001_A.sql"], ["0000_zero.sql"], ["0001_a.sql", "0001_b.sql"]]) {
    const db = open()
    const ladder = names.map((name) => ({ name, sql: "SELECT 1;" }))
    expect(() => migrate(db, ladder)).toThrow(MigrationError)
  }
})

test("a trigger body and a quoted semicolon apply whole", () => {
  const db = open()
  const sql = `
    -- a comment; with a semicolon
    CREATE TABLE a (x TEXT DEFAULT 'a;b');
    CREATE TRIGGER t AFTER INSERT ON a BEGIN
        UPDATE a SET x = 'y'; DELETE FROM a WHERE x = 'z';
    END;
    -- trailing comment
    `
  expect(migrate(db, files({ "0001_a.sql": sql }))).toBe(1)
  const objects = db.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all()
  expect(objects).toEqual([
    { type: "table", name: "a" },
    { type: "trigger", name: "t" },
  ])
  db.exec("INSERT INTO a DEFAULT VALUES")
  expect(db.prepare("SELECT x FROM a").all()).toEqual([{ x: "y" }])
})

test("an incomplete statement is refused", () => {
  const db = open()
  const e = thrown(() => migrate(db, files({ "0001_a.sql": "CREATE TABLE a (x" })))
  expect(sqliteErrorCode(e)).not.toBeUndefined()
  expect((e as Error).message).toMatch(/incomplete input/)
  expect(tables(db).has("a")).toBe(false)
  expect(userVersion(db)).toBe(0)
})

test("every migration file is in the ladder", () => {
  const dir = new URL("../../src/store/migrations/", import.meta.url)
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()
  expect(MIGRATIONS.map((m) => m.name)).toEqual(names)
  for (const m of MIGRATIONS) expect(m.sql).toBe(fs.readFileSync(new URL(m.name, dir), "utf8"))
})

test("the office migrations bring a fresh database to version 4", () => {
  const db = open()
  expect(migrate(db)).toBe(4)
  const questions = db.prepare("PRAGMA table_info(questions)").all()
  expect(questions.map((c) => c.name)).toContain("call_id")
  const turns = db.prepare("PRAGMA table_info(sessions)").all().find((c) => c.name === "turns")
  expect(turns?.dflt_value).toBe("0")
  const indexes = db.prepare("PRAGMA index_list(profile_proposals)").all()
  expect(indexes.map((i) => i.name)).toContain("profile_proposals_person")
  const runs = db.prepare("PRAGMA index_list(runs)").all().map((i) => i.name)
  expect(runs).toContain("runs_launched")
  const launched = db.prepare("PRAGMA index_info(runs_launched)").all()
  expect(launched.map((c) => c.name)).toEqual(["created_at"])
})
