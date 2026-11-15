/** Spend per person since a time. */
import { expect, test } from "bun:test"
import { openStore, session } from "./helpers.ts"

const T0 = "2026-10-19T00:00:00.000Z"

test("priced usage and unpriced harness sessions per person", () => {
  const store = openStore()
  const minh = store.createSession(session({ person: "minh" }))
  const side = store.createSession(session({ person: "minh", kind: "side" }))
  store.createSession(session({ person: "ann", harness: "codex" }))
  for (const [sessionId, usd] of [[minh.id, 1.0], [side.id, 0.25]] as const) {
    store.recordUsage({ sessionId, runId: "r", model: "m", usd })
  }
  expect(store.costsSince(T0)).toEqual({
    since: T0,
    people: { ann: { usd: 0, unpriced_sessions: 1 }, minh: { usd: 1.25, unpriced_sessions: 0 } },
  })
})

test("usage and sessions before since are left out", () => {
  const store = openStore()
  const s = store.createSession(session({ person: "minh" }))
  store.createSession(session({ person: "ann", harness: "claude" }))
  store.recordUsage({ sessionId: s.id, runId: "r", model: "m", usd: 2.0 })
  expect(store.costsSince("2999-01-01T00:00:00.000Z").people).toEqual({})
})
