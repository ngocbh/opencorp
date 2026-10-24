/** A session's run state, and the status writes that must not race the steps that finish a session. */
import { expect, test } from "bun:test"
import { HarnessError, LIVE, SETTLED, guardedUpdate, notWaiting, runState, writeState } from "../../src/chat/state.ts"
import type { SessionRecord } from "../../src/store/store.ts"
import { openStore, recordEvents, session } from "../store/helpers.ts"

test("a guarded update writes only from the given statuses", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  expect(guardedUpdate(store, s.id, ["idle"], { status: "busy" })?.status).toBe("busy")
  expect(guardedUpdate(store, s.id, ["idle"], { status: "ending" })).toBeUndefined()
  expect(store.getSession(s.id)?.status).toBe("busy")
  expect(guardedUpdate(store, "01K6A0000000000000000000ZZ", ["idle"], { status: "busy" })).toBeUndefined()
})

test("the run state is waiting then busy then idle", () => {
  expect(runState({ waiting: true, running: true })).toBe("waiting")
  expect(runState({ waiting: false, running: true })).toBe("busy")
  expect(runState({ waiting: false, running: false })).toBe("idle")
  expect(SETTLED).toEqual(["starting", "idle", "busy", "waiting"])
  expect(notWaiting("ended")).toEqual({ status: "ended", waiting_on: [], capped: false })
  expect(LIVE).toEqual(["starting", "idle", "busy", "waiting", "ending"])
  const error = new HarnessError(409, "live", "m")
  expect(error).toBeInstanceOf(Error)
  expect([error.status, error.code, error.message, error.name]).toEqual([409, "live", "m", "HarnessError"])
})

test("write state leaves ending debriefing and finished sessions alone", () => {
  const store = openStore()
  for (const left of ["ending", "debriefing", "ended", "failed", "interrupted"] as const) {
    const s = store.createSession(session({ status: left }))
    expect(writeState(store, s.id, "waiting", ["ngocbh"])).toBeUndefined()
    expect(store.getSession(s.id)?.status).toBe(left)
  }
})

test("starting lasts until the run shows a turn or a question", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "starting" }))
  expect(writeState(store, s.id, "busy", [])).toBeUndefined()
  expect(writeState(store, s.id, "busy", [], { fromStarting: ["idle", "busy", "waiting"] })?.status).toBe("busy")
  const t = store.createSession(session({ status: "starting" }))
  expect(writeState(store, t.id, "waiting", ["ngocbh"])?.waiting_on).toEqual(["ngocbh"])
})

test("waiting on names each person once and only while waiting", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  let got = writeState(store, s.id, "waiting", ["ann", null, "ann", "lead"], { capped: true })
  expect([got?.waiting_on, got?.capped]).toEqual([["ann", "lead"], true])
  got = writeState(store, s.id, "busy", ["ann"], { capped: true })
  expect([got?.waiting_on, got?.capped]).toEqual([[], false])
})

test("write state waits for a finish in flight and then leaves it", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  let inner: SessionRecord | undefined = s
  store.transaction(() => {
    store.updateSession(s.id, notWaiting("failed"))
    inner = writeState(store, s.id, "waiting", ["ngocbh"])
  })
  expect(inner).toBeUndefined()
  expect(writeState(store, s.id, "waiting", ["ngocbh"])).toBeUndefined()
  expect(store.getSession(s.id)?.status).toBe("failed")
})

test("write state with nothing new writes nothing", () => {
  const store = openStore()
  const s = store.createSession(session({ status: "idle" }))
  const events = recordEvents(store)
  expect(writeState(store, s.id, "idle", [])).toEqual(store.getSession(s.id))
  expect(events).toEqual([])
  writeState(store, s.id, "waiting", ["ann"])
  writeState(store, s.id, "waiting", ["ann"])
  expect(events.map((e) => e.type)).toEqual(["session.updated"])
})
