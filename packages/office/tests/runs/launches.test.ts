/** Each launch writes one row in runs, in the transaction that adds the session's run; a resume writes none
 *  (Python's `tests/runs/test_launches.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import type { SessionActor } from "../../src/chat/session_actor.ts"
import type { FakeLLM } from "../../src/testing/fake_llm.ts"
import type { Worker } from "../../src/worker/spawn.ts"
import {
  type ChatOffice,
  chatOffice,
  fakeLlm,
  LAN,
  makeActor,
  newSession,
  noWorkersLeft,
  session,
  startActor,
  status,
} from "../chat/helpers.ts"
import { waitFor } from "../helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** What `promise` was refused with: its status and code. */
function refusal(promise: Promise<unknown>): Promise<unknown[]> {
  return promise.then(
    () => [],
    (error) => [error.status, error.code],
  )
}

test("a main chat writes one row with its driver and flow", async () => {
  const o = await chatOffice(await fakeLlm())
  const { sid } = await startActor(o)
  const rows = o.office.store.runsOfSession(sid)
  expect(rows).toHaveLength(1)
  const [row] = rows
  expect(row!.runId).toBe(session(o, sid).run_ids.at(-1)!)
  expect([row!.flow, row!.flowPath, row!.driver, row!.replacesRunId, row!.endReason]).toEqual([
    "chat",
    "shared/flows/chat.yaml",
    "ngocbh",
    null,
    null,
  ])
})

test("the opener drives the run", async () => {
  const o = await chatOffice(await fakeLlm(), { files: LAN })
  const { sid } = await startActor(o, { openedBy: "lan" })
  expect(o.office.store.runsOfSession(sid)[0]!.driver).toBe("lan")
})

test("a start whose live run cant be built records no run", async () => {
  const o = await chatOffice(await fakeLlm())
  const sid = await newSession(o)
  const actor = makeActor(o, sid, {
    spec: async () => {
      throw new Error("the pin is gone")
    },
  })
  expect(await refusal(actor.start())).toEqual([500, "start_failed"])
  expect([status(o, sid), session(o, sid).run_ids, o.office.store.runsOfSession(sid), o.kinds]).toEqual([
    "failed",
    [],
    [],
    [],
  ])
  expect(actor.hasWorker).toBe(false)
})

test("a start whose run cant be stored lets go of the session", async () => {
  const o = await chatOffice(await fakeLlm())
  o.office.store.addRun = () => {
    throw new Error("the disk is full")
  }
  const sid = await newSession(o)
  const actor = makeActor(o, sid)
  expect(await refusal(actor.start())).toEqual([500, "start_failed"])
  expect([status(o, sid), session(o, sid).run_ids, o.office.store.runsOfSession(sid), o.kinds]).toEqual([
    "failed",
    [],
    [],
    [],
  ])
  expect([actor.runId, actor.hasWorker]).toEqual([null, false])
})

test.each(["build", "spawn"])(
  "a second start while one is in flight gets 409 and writes nothing [%s]",
  async (heldIn) => {
    const o = await chatOffice(await fakeLlm())
    const sid = await newSession(o)
    // The first start is held building its run spec, or spawning its worker once its run is stored.
    let release!: () => void
    let entered: Promise<void>
    let actor: SessionActor
    if (heldIn === "build") {
      const released = new Promise<void>((resolve) => (release = resolve))
      let enter!: () => void
      entered = new Promise<void>((resolve) => (enter = resolve))
      actor = makeActor(o, sid, {
        spec: async (s) => {
          enter()
          await released
          return o.ctx.spec(s)
        },
      })
    } else {
      const held = o.hold()
      ;({ entered, release } = held)
      actor = makeActor(o, sid)
    }
    const addRun = o.office.store.addRun.bind(o.office.store)
    let adds = 0
    o.office.store.addRun = (row) => {
      adds += 1
      return addRun(row)
    }
    const first = actor.start()
    await entered
    // The serial queue: the second start waits its turn, then finds the first's run.
    const second = refusal(actor.start())
    release()
    await first
    expect(await second).toEqual([409, "live"])
    await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
    const rows = o.office.store.runsOfSession(sid)
    expect(rows.map((row) => [row.runId, row.endReason])).toEqual([[actor.runId!, null]])
    expect(session(o, sid).run_ids).toEqual([actor.runId!])
    expect([adds, o.kinds]).toEqual([1, ["chat"]])
  },
)

test("a resumed run writes no row", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const { actor, sid } = await startActor(o)
  const worker = await holding(o, fake, actor)
  // The resumed reply calls the model again.
  fake.script({ content: "after" })
  const before = o.kinds.length
  process.kill(-worker.pgid, "SIGKILL")
  await waitFor(() => o.kinds.length > before && status(o, sid) === "idle" && !actor.hasWorker, {
    what: "the worker after the kill",
  })
  expect(o.kinds.slice(before)).toEqual(["advance"])
  expect(o.office.store.runsOfSession(sid)).toHaveLength(1)
})

/** Sends a message with the fake holding its reply; resolves with the worker running it once the model call is
 *  held. */
async function holding(o: ChatOffice, fake: FakeLLM, actor: SessionActor): Promise<Worker> {
  await waitFor(() => !actor.hasWorker, { what: "the last worker to exit" })
  const spawned: Worker[] = []
  o.afterSpawn((worker) => void spawned.push(worker))
  const n = fake.requests().length
  fake.script({ content: "held", hold: true })
  await actor.prompt("a")
  await fake.waitForRequests(n + 1, 30_000)
  return spawned[0]!
}
