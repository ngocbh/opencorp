import { expect, test } from "bun:test"
import type { Debrief } from "@agent-corp/protocol"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>
type Office = ReturnType<typeof createFakeOffice>

const READY: Partial<Debrief> = {
  state: "ready",
  summary: "Fixed the flaky clock test",
  status: "done",
  artifacts: ["src/clock.ts"],
  decisions: ["Use a fake clock"],
  follow_ups: [{ text: "Add a CI job for the clock tests" }, { text: "Bump the retry timeout" }],
  open_questions: ["Keep the retry?"],
  cost: 0.034,
}

/** Opens the seeded session, then its debrief with /debrief. */
async function run(office: Office, body: (app: App, sessionId: string) => Promise<void>) {
  const id = office.state.sessions[0].id
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh"))
    await app.input.typeText("/debrief")
    await app.until((f) => f.includes("Open debrief"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Debrief · @minh"))
    await body(app, id)
  } finally {
    await app.stop()
    office.stop()
  }
}

test("/debrief shows the session's debrief; Esc goes back to the session", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, READY)
  await run(office, async (app) => {
    const f = await app.until((f) => f.includes("Fixed the flaky clock test"))
    for (const s of ["done", "src/clock.ts", "Use a fake clock", "Add a CI job", "Keep the retry?", "$0.03"])
      expect(f).toContain(s)
    app.input.pressEscape()
    await app.until((f) => !f.includes("Debrief · @minh") && f.includes("@minh · idle"))
  })
})

test("a pending debrief says the office retries it; r asks again; the ready debrief arrives by event", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, { state: "pending" })
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("Debrief pending"))
    const gets = () => office.requests.filter((r) => r.path === `/debriefs/${id}`).length
    const before = gets()
    app.input.pressKey("r")
    await app.until(() => gets() > before)
    office.addDebrief(id, READY)
    await app.until((f) => f.includes("Fixed the flaky clock test") && !f.includes("Debrief pending"))
  })
})

test("no debrief yet says so; while debriefing it says it is being written; then it fills in", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("No debrief yet"))
    office.setStatus(id, "debriefing")
    await app.until((f) => f.includes("Writing the debrief") && !f.includes("No debrief yet"))
    office.addDebrief(id, { state: "pending" })
    await app.until((f) => f.includes("Writing the debrief") && !f.includes("Debrief pending"))
    office.addDebrief(id, READY)
    await app.until((f) => f.includes("Fixed the flaky clock test") && !f.includes("Writing the debrief"))
  })
})

test("space marks follow-ups and c confirms them; each confirmed one shows its work item", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, READY)
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("› [ ] Add a CI job") && f.includes("  [ ] Bump the retry timeout"))
    app.input.pressArrow("down")
    app.input.pressKey(" ")
    await app.until((f) => f.includes("› [+] Bump the retry timeout"))
    app.input.pressKey("c")
    await app.until((f) => f.includes("[x] Bump the retry timeout") && f.includes("Made 1 work item"))
    expect(office.requests.find((r) => r.method === "POST")).toMatchObject({
      path: `/debriefs/${id}/confirm`,
      body: { indices: [1] },
    })
    const item = office.state.debriefs[id].follow_ups![1].work_item_id!
    await app.until((f) => f.includes(`work item ${item.slice(-6)}`))
    // With nothing marked, c confirms the follow-up under the cursor.
    app.input.pressArrow("up")
    app.input.pressKey("c")
    await app.until((f) => f.includes("[x] Add a CI job"))
    expect(office.requests.filter((r) => r.method === "POST").at(-1)?.body).toEqual({ indices: [0] })
  })
})
