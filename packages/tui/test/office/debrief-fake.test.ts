import { afterEach, expect, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import { createOfficeClient } from "../../src/office/client"
import { until } from "../fixture/until"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })
const failure = (p: Promise<unknown>): Promise<any> => p.then(() => Promise.reject(new Error("resolved")), (e) => e)

test("GET is a 404 until the session is debriefing, then pending until addDebrief writes it", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  expect((await failure(client().debriefs.get(id))).code).toBe("not_found")
  office.setStatus(id, "ending")
  expect((await failure(client().debriefs.get(id))).code).toBe("not_found")
  office.setStatus(id, "debriefing")
  expect(await client().debriefs.get(id)).toMatchObject({ session_id: id, state: "pending" })
  office.addDebrief(id, { state: "ready", summary: "Fixed the flaky test", follow_ups: [{ text: "Add a CI job" }] })
  const d = await client().debriefs.get(id)
  expect([d.state, d.summary, d.follow_ups]).toEqual(["ready", "Fixed the flaky test", [{ text: "Add a CI job" }]])
})

test("an ended session with no debrief is a 404: only debriefing implies one", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  office.setStatus(id, "ended")
  expect((await failure(client().debriefs.get(id))).code).toBe("not_found")
})

test("ending a main session goes ending, then debriefing a moment later; a ready debrief ends it", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const seen: string[] = []
  let connected!: () => void
  const open = new Promise<void>((r) => (connected = r))
  const events = client().events.subscribe((e) => {
    if (e.type === "connected") connected()
    if (e.type === "meta" && e.event.type === "session.updated") seen.push((e.event.data as { status: string }).status)
  })
  await open
  await client().sessions.end(id)
  expect((await client().sessions.get(id)).status).toBe("ending")
  // A second end while ending is a no-op.
  await client().sessions.end(id)
  await until(() => office.state.sessions[0].status === "debriefing")
  office.addDebrief(id, { state: "pending" })
  expect((await client().sessions.get(id)).status).toBe("debriefing")
  office.addDebrief(id, { state: "ready" })
  expect((await client().sessions.get(id)).status).toBe("ended")
  await Bun.sleep(50)
  events.close()
  expect(seen).toEqual(["ending", "debriefing", "ended"])
  // Other kinds aren't debriefed: they go from ending to ended.
  const side = office.state.sessions[0]
  Object.assign(side, { kind: "side", status: "idle" })
  await client().sessions.end(side.id)
  expect((await client().sessions.get(side.id)).status).toBe("ending")
  await until(() => office.state.sessions[0].status === "ended")
})

test("confirm makes a work item per newly confirmed follow-up; indices are deduped, repeats are no-ops", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  office.addDebrief(id, { state: "ready", follow_ups: [{ text: "Add a CI job" }, { text: "Bump the timeout" }] })
  const d = await client().debriefs.confirm(id, { indices: [1, 1] })
  expect(d.follow_ups!.map((f) => f.confirmed ?? false)).toEqual([false, true])
  const item = office.state.workItems[d.follow_ups![1].work_item_id!]
  // Requested by the human who confirms, for the session's person.
  expect([item.title, item.kind, item.status, item.requester, item.assignee]).toEqual([
    "Bump the timeout",
    "task",
    "open",
    "ngocbh",
    "minh",
  ])
  const again = await client().debriefs.confirm(id, { indices: [0, 1] })
  expect(Object.keys(office.state.workItems)).toHaveLength(2)
  expect(again.follow_ups![1].work_item_id).toBe(item.id)
  expect((await failure(client().debriefs.confirm(id, { indices: [2] }))).code).toBe("invalid_body")
})

test("feedback names a run of its session, the latest by default; feedbackStatus moves it along", async () => {
  office = createFakeOffice()
  const s = office.state.sessions[0]
  Object.assign(s, { status: "ended", run_ids: ["run-a", "run-b"] })
  expect((await client().feedback.create({ session_id: s.id, text: "About turn 1: x" })).run_id).toBe("run-b")
  expect((await client().feedback.create({ session_id: s.id, text: "y", run_id: "run-a" })).run_id).toBe("run-a")
  expect((await failure(client().feedback.create({ session_id: s.id, text: "z", run_id: "run-x" }))).code).toBe(
    "invalid_body",
  )
  const f = office.feedbackStatus(office.state.feedback[0].id, "applied")
  expect([f.status, office.state.feedback[0].status]).toEqual(["applied", "applied"])
})

test("confirm needs a ready debrief (409 not_ready); its work items hang under the session's work item", async () => {
  office = createFakeOffice()
  const s = office.state.sessions[0]
  s.work_item_id = "wi-session"
  const early = await failure(client().debriefs.confirm(s.id, { indices: [0] }))
  expect(early).toMatchObject({ status: 409, code: "not_ready" })
  office.addDebrief(s.id, { state: "pending" })
  expect((await failure(client().debriefs.confirm(s.id, { indices: [0] }))).code).toBe("not_ready")
  office.addDebrief(s.id, { state: "ready", follow_ups: [{ text: "Add a CI job" }] })
  const d = await client().debriefs.confirm(s.id, { indices: [0] })
  expect(office.state.workItems[d.follow_ups![0].work_item_id!].parent_id).toBe("wi-session")
  expect((await failure(client().debriefs.confirm("nope", { indices: [0] }))).code).toBe("not_found")
})

test("feedback: only main sessions learn; a session needs a run; the ready debrief's run counts", async () => {
  office = createFakeOffice()
  const s = office.state.sessions[0]
  Object.assign(s, { status: "ended", run_ids: [] })
  expect((await failure(client().feedback.create({ session_id: s.id, text: "x" }))).code).toBe("invalid_body")
  s.run_ids = ["run-a"]
  office.addDebrief(s.id, { state: "pending" }, { run: "run-debrief" })
  // A pending debrief's run hasn't finished well enough to learn from.
  expect((await failure(client().feedback.create({ session_id: s.id, text: "x", run_id: "run-debrief" }))).code).toBe(
    "invalid_body",
  )
  office.addDebrief(s.id, { state: "ready" }, { run: "run-debrief" })
  expect((await client().feedback.create({ session_id: s.id, text: "x", run_id: "run-debrief" })).run_id).toBe(
    "run-debrief",
  )
  Object.assign(s, { kind: "side" })
  expect(await failure(client().feedback.create({ session_id: s.id, text: "x" }))).toMatchObject({
    status: 422,
    code: "not_learnable",
  })
})

test("a live session's latest run is unfinished (409 run_unfinished); earlier runs are done", async () => {
  office = createFakeOffice()
  const s = office.state.sessions[0]
  s.run_ids = ["run-a", "run-b"]
  expect(await failure(client().feedback.create({ session_id: s.id, text: "x" }))).toMatchObject({
    status: 409,
    code: "run_unfinished",
  })
  expect((await client().feedback.create({ session_id: s.id, text: "x", run_id: "run-a" })).run_id).toBe("run-a")
  office.setStatus(s.id, "debriefing")
  expect((await client().feedback.create({ session_id: s.id, text: "x" })).run_id).toBe("run-b")
})
