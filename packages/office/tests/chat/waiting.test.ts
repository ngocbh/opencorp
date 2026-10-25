/** The run state the session actor writes: waiting (and on whom), busy, idle (Python's
 *  `tests/chat/test_waiting.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { waitFor } from "../helpers.ts"
import {
  chatOffice,
  fakeLlm,
  makeActor,
  newSession,
  noWorkersLeft,
  scriptedWorker,
  startActor,
  state,
  status,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

test("settle gives idle at the turn and busy while a live run has no turn", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const workers = scriptedWorker(o)
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  await actor.start()
  // A starting session stays starting until its run shows its turn.
  expect(status(o, sid)).toBe("starting")
  const { worker, handlers } = workers[0]!
  const waitsAtTurn = { type: "event", name: "NodeWaiting", data: { node_id: "chat#0/heard", call_ids: ["c1"] } }
  handlers.event(worker, waitsAtTurn)
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the turn" })
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "idle", waiting_on: [], capped: false })
  // The take has a message: the live run is no longer at its turn.
  handlers.event(worker, { type: "event", name: "NodeWoken", data: { node_id: "chat#0/heard" } })
  await waitFor(() => status(o, sid) === "busy", { what: "busy once the turn is taken" })
  actor.settle()
  expect(state(o, sid)).toEqual({ status: "busy", waiting_on: [], capped: false })
  handlers.event(worker, { type: "event", name: "NodeSucceeded", data: { node_id: "chat#0/heard" } })
  handlers.event(worker, { ...waitsAtTurn, data: { node_id: "chat#1/heard", call_ids: ["c2"] } })
  await waitFor(() => status(o, sid) === "idle", { what: "idle at the next turn" })
})

test("the turn alone is idle and a running reply is busy", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "slow", hold: true })
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  await actor.prompt("hi")
  expect(status(o, sid)).toBe("busy")
  // Held only once it arrives.
  await fake.waitForRequests(1, 30_000)
  fake.release()
  await waitFor(() => {
    const now = state(o, sid)
    return now.status === "idle" && now.waiting_on.length === 0
  }, { what: "idle again" })
})
