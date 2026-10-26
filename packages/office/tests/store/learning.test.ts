/** Profile proposals: round-trips, status moves, the commit, per-person lists. */
import { expect, test } from "bun:test"
import { DuplicateKey, InvalidTransition, StoreError, type Store } from "../../src/store/store.ts"
import { COMMIT, openStore, proposal, recordEvents, session, thrown } from "./helpers.ts"

/** A store with one session, and the session's id (Python's `sid` fixture). */
function withSession(): { store: Store; sid: string } {
  const store = openStore()
  return { store, sid: store.createSession(session()).id }
}

test("proposal round trips", () => {
  const { store, sid } = withSession()
  const events = recordEvents(store)
  const p = proposal(sid)
  expect(store.addProfileProposal(p)).toEqual(p)
  expect(store.getProfileProposal(p.id)).toEqual(p)
  expect(thrown(() => store.addProfileProposal(p))).toBeInstanceOf(DuplicateKey)
  expect(events.at(-1)!.type).toBe("profile_proposal.created")
})

test("proposal apply and terminal states", () => {
  const { store, sid } = withSession()
  const events = recordEvents(store)
  const p = store.addProfileProposal(proposal(sid))
  const applied = store.setProfileProposalStatus(p.id, "applied", { commit: COMMIT })
  expect([applied.status, applied.commit]).toEqual(["applied", COMMIT])
  expect(events.at(-1)!.type).toBe("profile_proposal.updated")
  for (const status of ["open", "stale", "discarded", "applied"] as const)
    expect(thrown(() => store.setProfileProposalStatus(p.id, status))).toBeInstanceOf(InvalidTransition)
})

test("proposal commit goes with applied only", () => {
  const { store, sid } = withSession()
  const p = store.addProfileProposal(proposal(sid))
  const missing = thrown(() => store.setProfileProposalStatus(p.id, "applied"))
  expect(missing).toBeInstanceOf(StoreError)
  expect((missing as Error).message).toMatch(/commit/)
  const extra = thrown(() => store.setProfileProposalStatus(p.id, "discarded", { commit: COMMIT }))
  expect(extra).toBeInstanceOf(StoreError)
  expect((extra as Error).message).toMatch(/commit/)
  expect(store.getProfileProposal(p.id)!.status).toBe("open")
})

test("list proposals per person", () => {
  const { store, sid } = withSession()
  const a = store.addProfileProposal(proposal(sid))
  const b = store.addProfileProposal(proposal(sid))
  store.addProfileProposal(proposal(sid, { person: "lan" }))
  store.setProfileProposalStatus(b.id, "stale")
  expect(store.listProfileProposals("minh").map((p) => p.id)).toEqual([a.id, b.id])
  expect(store.listProfileProposals("minh", { status: "open" }).map((p) => p.id)).toEqual([a.id])
})
