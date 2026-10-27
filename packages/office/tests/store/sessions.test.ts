/** Sessions, their runs, recent sessions, and worked folders. */
import { expect, test } from "bun:test"
import { now } from "@opencorp/protocol"
import { DuplicateKey, NotFound, StoreError, newId, type SessionRecord, type Store } from "../../src/store/store.ts"
import { openStore, proposal, recordEvents, session, thrown } from "./helpers.ts"

const NO_SESSION = "01K6A0000000000000000000ZZ"

/** How many sessions the store holds. */
function sessionCount(store: Store): unknown {
  return store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n
}

test("session round trips with runs", () => {
  const store = openStore()
  const events = recordEvents(store)
  const s = session({ run_ids: ["run-1", "run-2"], seed: "ctx", cost_cap_usd: 2.5, kind: "side", question_id: null })
  const got = store.createSession(s)
  expect(got).toEqual(s)
  expect(store.getSession(s.id)).toEqual(s)
  expect(events.at(-1)!.type).toBe("session.created")
})

test("add session run appends and emits", () => {
  const store = openStore()
  const events = recordEvents(store)
  const s = store.createSession(session())
  store.addSessionRun(s.id, "run-1")
  const got = store.addSessionRun(s.id, "run-2")
  expect(got.run_ids).toEqual(["run-1", "run-2"])
  expect(store.sessionForRun("run-2")!.id).toBe(s.id)
  expect(store.sessionForRun("nope")).toBeUndefined()
  const event = events.at(-1)!
  expect([event.type, event.data.run_ids]).toEqual(["session.updated", ["run-1", "run-2"]])
  // The event a listener keeps shares nothing with the record the caller got.
  got.run_ids.push("run-3")
  expect(event.data.run_ids).toEqual(["run-1", "run-2"])
})

test("a run belongs to one session", () => {
  const store = openStore()
  const a = store.createSession(session())
  const b = store.createSession(session())
  expect(thrown(() => store.createSession(b))).toBeInstanceOf(DuplicateKey)
  store.addSessionRun(a.id, "run-1")
  expect(thrown(() => store.addSessionRun(b.id, "run-1"))).toBeInstanceOf(DuplicateKey)
  expect(thrown(() => store.addSessionRun(NO_SESSION, "run-9"))).toBeInstanceOf(NotFound)
  // A clash on a later run id undoes the whole create, the session row and its earlier runs too.
  const c = session({ run_ids: ["run-new", "run-1"] })
  expect(thrown(() => store.createSession(c))).toBeInstanceOf(DuplicateKey)
  expect(store.getSession(c.id)).toBeUndefined()
  expect(store.sessionForRun("run-new")).toBeUndefined()
})

test("sessions filter by folder and kind", () => {
  const store = openStore()
  const here = store.createSession(session({ cwd: "/w/app" }))
  store.createSession(session({ cwd: "/w/app", kind: "side" }))
  store.createSession(session({ cwd: "/w/other" }))
  expect(store.listSessions({ kind: "main", cwd: "/w/app" }).map((s) => s.id)).toEqual([here.id])
})

test("update session", () => {
  const store = openStore()
  const events = recordEvents(store)
  const s = store.createSession(session())
  const got = store.updateSession(s.id, { status: "busy", cost: 0.25, model: "gpt-4o-mini" })
  expect([got.status, got.cost]).toEqual(["busy", 0.25])
  expect(got.updated_at >= s.updated_at).toBe(true)
  // An explicit undefined changes nothing; it never resets a field to its default.
  const kept = store.updateSession(s.id, {
    cost: undefined,
    model: undefined,
    updated_at: undefined,
  } as Partial<SessionRecord>)
  expect([kept.cost, kept.model]).toEqual([0.25, "gpt-4o-mini"])
  expect(kept.updated_at >= got.updated_at).toBe(true)
  expect(thrown(() => store.updateSession(s.id, { run_ids: ["x"] }))).toBeInstanceOf(StoreError)
  expect(events.at(-1)!.data.status).toBe("busy")
})

test("recent sessions per person", () => {
  const store = openStore()
  const old = store.createSession(session({ updated_at: "2026-09-29T10:00:00.000Z" }))
  const fresh = store.createSession(session({ updated_at: "2026-09-29T11:00:00.000Z" }))
  store.createSession(session({ person: "lan" }))
  const ids = (sessions: SessionRecord[]) => sessions.map((s) => s.id)
  expect(ids(store.listSessions({ person: "minh" }))).toEqual([fresh.id, old.id])
  store.updateSession(old.id, { status: "busy" })
  expect(ids(store.listSessions({ person: "minh" }))).toEqual([old.id, fresh.id])
  expect(ids(store.listSessions({ person: "minh", limit: 1 }))).toEqual([old.id])
  expect(ids(store.listSessions({ status: ["busy"] }))).toEqual([old.id])
})

test("a status list of any length compiles one statement", () => {
  const store = openStore()
  const busy = store.createSession(session({ status: "busy" }))
  store.createSession(session())
  const db = store.db
  const prepare = db.prepare.bind(db)
  const texts = new Set<string>()
  db.prepare = (sql: string) => {
    if (sql.startsWith("SELECT * FROM sessions")) texts.add(sql)
    return prepare(sql)
  }
  for (const status of [["busy"], ["busy", "busy"], ["closed", "busy", "busy"]]) {
    expect(store.listSessions({ status }).map((s) => s.id)).toEqual([busy.id])
  }
  // The statement cache never evicts, so a SQL text per list length would grow it without bound.
  expect(texts.size).toBe(1)
})

test("worked folders order for the picker", () => {
  const store = openStore()
  const events = recordEvents(store)
  store.touchWorkedFolder("minh", "/a", "2026-09-29T10:00:00.000Z")
  store.touchWorkedFolder("minh", "/b", "2026-09-29T11:00:00.000Z")
  store.touchWorkedFolder("minh", "/c", "2026-09-29T09:00:00.000Z")
  store.touchWorkedFolder("lan", "/z")
  expect(store.workedFolders("minh").map((f) => f.cwd)).toEqual(["/b", "/a", "/c"])
  store.touchWorkedFolder("minh", "/c", "2026-09-29T12:00:00.000Z")
  expect(store.workedFolders("minh", 2).map((f) => f.cwd)).toEqual(["/c", "/b"])
  expect(events).toEqual([])
})

const OWNED_WRITES: Record<string, (store: Store) => unknown> = {
  // Stands in for add_question until the store has questions.
  question: (store) => {
    const t = now()
    store.transaction((tx) =>
      tx.insert("questions", {
        id: newId(),
        session_id: NO_SESSION,
        run_id: "run-1",
        source: "ask_user",
        asker: "minh",
        question: "Which db?",
        status: "open",
        created_at: t,
        updated_at: t,
      }),
    )
  },
  proposal: (store) => store.addProfileProposal(proposal(NO_SESSION)),
  run: (store) => store.addSessionRun(NO_SESSION, "run-9"),
}

test.each(["question", "proposal", "run"])("session owned rows need their session [%s]", (write) => {
  const store = openStore()
  const events = recordEvents(store)
  expect(thrown(() => OWNED_WRITES[write]!(store))).toBeInstanceOf(NotFound)
  expect(events).toEqual([])
})

test("opened by round trips", () => {
  const store = openStore()
  const s = store.createSession(session({ opened_by: "ngocbh" }))
  expect(store.getSession(s.id)).toEqual(s)
  expect(s.opened_by).toBe("ngocbh")
})

test("a session keeps its connection model and note", () => {
  const store = openStore()
  const s = store.createSession(session({ connection: "azure-2", model: "gpt-4o-mini", model_note: "n" }))
  const got = store.getSession(s.id)!
  expect(got).toEqual(s)
  expect([got.connection, got.model, got.model_note]).toEqual(["azure-2", "gpt-4o-mini", "n"])
})

test("a codex session keeps its model usage and parent", () => {
  const store = openStore()
  const first = store.createSession(session({ harness: "codex", harness_session_id: "thr_1" }))
  const usage = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }
  const s = store.createSession(
    session({
      harness: "codex",
      harness_session_id: "thr_1",
      harness_model: "gpt-5.5-codex",
      harness_usage: usage,
      parent_session_id: first.id,
    }),
  )
  const got = store.getSession(s.id)!
  expect(got).toEqual(s)
  expect([got.harness_usage!.output_tokens, got.parent_session_id]).toEqual([2, first.id])
  const more = { input_tokens: 11, cached_input_tokens: 4, output_tokens: 3 }
  expect(store.updateSession(s.id, { harness_usage: more }).harness_usage!.input_tokens).toBe(11)
  expect(store.updateSession(s.id, { harness_usage: null }).harness_usage).toBeNull()
  expect(store.getSession(s.id)!.harness_usage).toBeNull()
})

test("a session keeps who it waits on and whether its cap holds it", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "waiting", waiting_on: ["ngocbh", "lan"], capped: true }))
  const got = store.getSession(s.id)!
  expect(got).toEqual(s)
  expect([got.waiting_on, got.capped]).toEqual([["ngocbh", "lan"], true])
  const changed = store.updateSession(s.id, { status: "idle", waiting_on: [], capped: false })
  expect([changed.waiting_on, changed.capped]).toEqual([[], false])
  // A corrupt JSON column is refused without quoting its text.
  store.db.prepare("UPDATE sessions SET waiting_on = 'sk-not-json' WHERE id = ?").run(s.id)
  const error = thrown(() => store.getSession(s.id))
  expect(error).toBeInstanceOf(StoreError)
  expect((error as Error).message).not.toContain("sk")
})

test("a field with no column needs a store migration", () => {
  const store = openStore()
  const error = thrown(() => store.createSession({ ...session(), extra: 1 } as SessionRecord))
  expect(error).toBeInstanceOf(StoreError)
  expect((error as Error).message).toMatch(/needs a store migration/)
  expect(sessionCount(store)).toBe(0)
  expect(thrown(() => store.createSession({ ...session(), cost: -1 }))).toBeInstanceOf(StoreError)
  expect(sessionCount(store)).toBe(0)
})

test("a session counts its turns from zero", () => {
  const store = openStore()
  const s = store.createSession(session())
  expect(store.getSession(s.id)!.turns).toBe(0)
  store.updateSession(s.id, { turns: 3 })
  expect(store.getSession(s.id)!.turns).toBe(3)
})
