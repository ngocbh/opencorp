/** The migration ladder applies numbered SQL files above PRAGMA user_version. */
import fs from "node:fs"
import { join } from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { openSqlite, sqliteErrorCode, type Sqlite } from "@ngocbh/yian/platform"
import { MIGRATIONS, MigrationError, migrate, userVersion, type MigrationFile } from "../../../src/runtime/store/migrate.ts"
import { Store, newId } from "../../../src/runtime/store/store.ts"
import { tempDir } from "../../helpers.ts"
import { COMMIT, session, thrown } from "./helpers.ts"

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
  const dir = new URL("../../../src/runtime/store/migrations/", import.meta.url)
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()
  expect(MIGRATIONS.map((m) => m.name)).toEqual(names)
  for (const m of MIGRATIONS) expect(m.sql).toBe(fs.readFileSync(new URL(m.name, dir), "utf8"))
})

test("the office migrations bring a fresh database to version 12", () => {
  const db = open()
  expect(migrate(db)).toBe(12)
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
  const sessions = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name)
  expect(sessions).toContain("harness_turn_id")
  const started = db.prepare("PRAGMA table_info(runs)").all().find((c) => c.name === "started_at")
  expect([started?.type, started?.dflt_value]).toEqual(["TEXT", null])
  expect(db.prepare("PRAGMA table_info(sessions)").all().find((c) => c.name === "mode")?.dflt_value).toBe("'auto'")
  const approval = db.prepare("PRAGMA table_info(questions)").all().find((c) => c.name === "approval")
  expect([approval?.type, approval?.dflt_value]).toEqual(["TEXT", null])
  const of = db.prepare("PRAGMA table_info(sessions)").all().find((c) => c.name === "instrument_of")
  expect([of?.type, of?.dflt_value]).toEqual(["TEXT", null])
  const subscription = db.prepare("PRAGMA table_info(usage)").all().find((c) => c.name === "subscription")
  expect([subscription?.type, subscription?.dflt_value, subscription?.notnull]).toEqual(["INTEGER", "0", 1])
  const part = db.prepare("PRAGMA table_info(sessions)").all().find((c) => c.name === "subscription_cost")
  expect([part?.type, part?.dflt_value, part?.notnull]).toEqual(["REAL", "0", 1])
})

test("a store at version 10 gets only the usage subscription migration, and its usage is billed", () => {
  const db = open()
  expect(migrate(db, MIGRATIONS.slice(0, 10))).toBe(10)
  db.prepare("INSERT INTO usage (at, session_id, run_id, model, usd) VALUES ('t', 's1', 'r1', 'm', 0.5)").run()
  expect(migrate(db)).toBe(12)
  expect(db.prepare("SELECT usd, subscription FROM usage").all()).toEqual([{ usd: 0.5, subscription: 0 }])
})

test("a store already at version 6 gets only the runs started_at migration", () => {
  const db = open()
  expect(migrate(db, MIGRATIONS.slice(0, 6))).toBe(6)
  expect(migrate(db)).toBe(12)
  const runs = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name)
  expect(runs).toContain("started_at")
  const sessions = db.prepare("PRAGMA table_info(hq_sessions)").all().map((c) => c.name)
  expect(sessions).toContain("issued_sha")
})

test("a store already at version 7 gets only the session mode migration, and its sessions are in auto", () => {
  const db = open()
  expect(migrate(db, MIGRATIONS.slice(0, 7))).toBe(7)
  const at = "2026-11-16T00:00:00.000Z"
  db.prepare(
    "INSERT INTO sessions (id, person, harness, office, cwd, repo_commit, status, kind, created_at, updated_at) " +
      "VALUES ('s1', 'minh', 'composer', 'mac', '/w', 'c0ffee', 'idle', 'main', ?, ?)",
  ).run(at, at)
  expect(migrate(db)).toBe(12)
  expect(db.prepare("SELECT id, mode FROM sessions").all()).toEqual([{ id: "s1", mode: "auto" }])
  const runs = db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name)
  expect(runs).toContain("started_at")
})

test("a store at version 8 gets only the approval migration", () => {
  const db = open()
  expect(migrate(db, MIGRATIONS.slice(0, 8))).toBe(8)
  const at = "2026-11-17T00:00:00.000Z"
  db.prepare(
    "INSERT INTO sessions (id, person, harness, office, cwd, repo_commit, status, kind, created_at, updated_at) " +
      "VALUES ('s1', 'minh', 'composer', 'mac', '/w', 'c0ffee', 'idle', 'main', ?, ?)",
  ).run(at, at)
  db.prepare(
    "INSERT INTO questions (id, session_id, run_id, source, asker, question, status, created_at, updated_at) " +
      "VALUES ('q1', 's1', 'run-1', 'ask_user', 'minh', 'Which db?', 'open', ?, ?)",
  ).run(at, at)
  expect(migrate(db)).toBe(12)
  expect(db.prepare("SELECT id, approval FROM questions").all()).toEqual([{ id: "q1", approval: null }])
  expect(db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name)).toContain("mode")
})

test("a store at version 9 gets only the instrument_of migration, and its sessions are no instrument", () => {
  const db = open()
  expect(migrate(db, MIGRATIONS.slice(0, 9))).toBe(9)
  const at = "2026-11-20T00:00:00.000Z"
  db.prepare(
    "INSERT INTO sessions (id, person, harness, office, cwd, repo_commit, status, kind, created_at, updated_at) " +
      "VALUES ('s1', 'minh', 'composer', 'mac', '/w', 'c0ffee', 'idle', 'main', ?, ?)",
  ).run(at, at)
  expect(migrate(db)).toBe(12)
  expect(db.prepare("SELECT id, instrument_of FROM sessions").all()).toEqual([{ id: "s1", instrument_of: null }])
})

test("a store at version 10 renames its composer sessions yian, and new sessions are yian", () => {
  const file = join(tempDir(), "store.sqlite")
  const db = openSqlite(file)
  expect(migrate(db, MIGRATIONS.slice(0, 10))).toBe(10)
  const at = "2026-11-22T00:00:00.000Z"
  const insert = db.prepare(
    "INSERT INTO sessions (id, person, harness, office, cwd, repo_commit, status, kind, created_at, updated_at) " +
      "VALUES (?, 'minh', ?, 'mac', '/w', ?, 'idle', 'main', ?, ?)",
  )
  const ids = { composer: newId(), codex: newId(), claude: newId() }
  for (const [harness, id] of Object.entries(ids)) insert.run(id, harness, COMMIT, at, at)
  db.close()
  const store = new Store(file)
  onTestFinished(() => store.close())
  expect(userVersion(store.db)).toBe(12)
  const harness = (id: string) => store.db.prepare("SELECT harness FROM sessions WHERE id = ?").get(id)?.harness
  expect([harness(ids.composer), harness(ids.codex), harness(ids.claude)]).toEqual(["yian", "codex", "claude"])
  expect(store.getSession(ids.composer)?.harness).toBe("yian")
  const fresh = store.createSession(session())
  expect([fresh.harness, harness(fresh.id)]).toEqual(["yian", "yian"])
})
