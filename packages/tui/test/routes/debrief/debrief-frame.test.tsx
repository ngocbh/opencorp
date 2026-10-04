import { expect, test } from "bun:test"
import type { Debrief, Message } from "@agent-corp/protocol"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "../picker/type"

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

/** Opens the seeded session, then (after `before`) its debrief with /debrief. */
async function run(office: Office, body: (app: App, sessionId: string) => Promise<void>, before = () => {}) {
  const id = office.state.sessions[0].id
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh"))
    before()
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

test("a pending debrief says r retries it; r asks again; the ready debrief arrives by event", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, { state: "pending" })
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("Debrief pending (r retries now)."))
    const gets = () => office.requests.filter((r) => r.path === `/debriefs/${id}`).length
    const before = gets()
    app.input.pressKey("r")
    await app.until(() => gets() > before)
    office.addDebrief(id, READY)
    await app.until((f) => f.includes("Fixed the flaky clock test") && !f.includes("Debrief pending"))
  })
})

test("a read that was in flight when a newer debrief arrived by event is dropped", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, { state: "pending" })
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("Debrief pending"))
    const gets = () => office.requests.filter((r) => r.path === `/debriefs/${id}`).length
    const before = gets()
    // The reply is what the debrief was when the read came in: still pending.
    const release = office.hold("GET /debriefs/:session", "reply")
    app.input.pressKey("r")
    await app.until(() => gets() > before)
    office.addDebrief(id, READY)
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    release()
    await Bun.sleep(100)
    expect(await app.until((f) => f.includes("Debrief ·"))).toContain("Fixed the flaky clock test")
  })
})

test("a failed read shows its error until the debrief arrives by event", async () => {
  const office = createFakeOffice({ notImplemented: ["GET /debriefs/:session"] })
  await run(office, async (app, id) => {
    await app.until((f) => f.includes(`/debriefs/${id} is not implemented`))
    office.notImplemented.delete("GET /debriefs/:session")
    office.addDebrief(id, READY)
    await app.until((f) => f.includes("Fixed the flaky clock test") && !f.includes("not implemented"))
  })
})

test("a failed transcript load stays shown after the debrief reads fine, until r loads it", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, { state: "pending" })
  const before = () => office.notImplemented.add("GET /sessions/:id/messages")
  await run(
    office,
    async (app, id) => {
      await app.until((f) => f.includes("/messages is not implemented") && f.includes("Debrief pending"))
      office.state.debriefs[id] = { ...office.state.debriefs[id], ...READY } as Debrief
      app.input.pressKey("r")
      const f = await app.until((f) => f.includes("Fixed the flaky clock test"))
      expect(f).toContain("/messages is not implemented")
      // r also retries the transcript while loading it has failed.
      office.notImplemented.delete("GET /sessions/:id/messages")
      app.input.pressKey("r")
      await app.until((f) => !f.includes("/messages is not implemented"))
    },
    before,
  )
})

test("no debrief yet says so; while debriefing it says it is being written; then it fills in", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    // A live session's run isn't finished, so there is no feedback to give yet.
    let f = await app.until((f) => f.includes("No debrief yet"))
    expect(f).not.toContain("Feedback for the profile")
    app.input.pressKey("f")
    app.input.pressKey("t")
    office.setStatus(id, "debriefing")
    f = await app.until((f) => f.includes("Writing the debrief") && !f.includes("No debrief yet"))
    expect(f).toContain("Feedback for the profile")
    expect(f).not.toContain("No turns to pick from")
    expect(app.setup.renderer.currentFocusedEditor).toBeNull()
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

/** Ends the seeded session with two runs and a transcript with two turns. */
function withTurns(office: Office) {
  const s = office.state.sessions[0]
  Object.assign(s, { status: "ended", run_ids: ["run-a", "run-b"] })
  const msg = (role: Message["role"], text: string): Message => {
    const id = office.nextId()
    return { id, session_id: s.id, role, parts: [{ id: id + "P", type: "text", text }], created_at: "t" }
  }
  office.state.messages[s.id] = [
    msg("user", "Fix the flaky test"),
    msg("assistant", "Done."),
    msg("user", "Use a fake clock"),
  ]
  office.addDebrief(s.id, READY)
  return s.id
}

test("a rewritten debrief clears the marks and keeps the cursor on a follow-up", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, READY)
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("› [ ] Add a CI job"))
    app.input.pressArrow("down")
    app.input.pressKey(" ")
    await app.until((f) => f.includes("› [+] Bump the retry timeout"))
    office.addDebrief(id, { ...READY, follow_ups: [{ text: "Pin the clock" }] })
    await app.until((f) => f.includes("› [ ] Pin the clock"))
    app.input.pressKey("c")
    await app.until((f) => f.includes("[x] Pin the clock"))
    expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({ indices: [0] })
  })
})

test("t picks a turn and pre-fills About turn N with its text; Enter sends feedback on the latest run", async () => {
  const office = createFakeOffice()
  const id = withTurns(office)
  const text = 'About turn 2 ("Use a fake clock"): inject the clock instead'
  await run(office, async (app) => {
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    app.input.pressKey("t")
    await app.until((f) => f.includes("Turn 1: Fix the flaky test") && f.includes("Turn 2: Use a fake clock"))
    await typeInto(app, "fake clock")
    app.input.pressEnter()
    await app.until((f) => !f.includes("Turn 1:") && f.includes('About turn 2 ("Use a fake clock"): '))
    await typeInto(app, "inject the clock instead")
    app.input.pressEnter()
    await app.until((f) => f.includes(`queued · ${text}`) && f.includes("Feedback queued"))
    const post = office.requests.find((r) => r.method === "POST" && r.path === "/feedback")
    expect(post?.body).toEqual({ session_id: id, text })
    expect(office.state.feedback[0].run_id).toBe("run-b")
    office.feedbackStatus(office.state.feedback[0].id, "applied")
    await app.until((f) => f.includes(`applied · ${text}`))
  })
})

test("f writes feedback on the whole run; Esc leaves the input; pre-fill-only feedback isn't sent", async () => {
  const office = createFakeOffice()
  const id = withTurns(office)
  await run(office, async (app) => {
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    app.input.pressKey("f")
    await app.until(() => app.setup.renderer.currentFocusedEditor !== null)
    app.input.pressEnter()
    app.input.pressEscape()
    await app.until(() => app.setup.renderer.currentFocusedEditor === null)
    app.input.pressKey("t")
    await app.until((f) => f.includes("Turn 1: Fix the flaky test"))
    app.input.pressEnter()
    await app.until((f) => !f.includes("Turn 1:") && f.includes('About turn 1 ("Fix the flaky test"): '))
    await app.until(() => app.setup.renderer.currentFocusedEditor !== null)
    app.input.pressEnter()
    app.input.pressEscape()
    await app.until(() => app.setup.renderer.currentFocusedEditor === null)
    expect(office.requests.some((r) => r.path === "/feedback")).toBe(false)
    app.input.pressKey("f")
    await typeInto(app, "Good call on the fake clock")
    app.input.pressEnter()
    await app.until((f) => f.includes("queued · Good call on the fake clock"))
    expect(office.requests.find((r) => r.path === "/feedback")?.body).toEqual({
      session_id: id,
      text: "Good call on the fake clock",
    })
  })
})

test("t and f keep a draft, swapping only the About turn pre-fill; text typed while sending stays", async () => {
  const office = createFakeOffice()
  withTurns(office)
  await run(office, async (app) => {
    const unfocused = () => app.setup.renderer.currentFocusedEditor === null
    const pick = async (app: App, turn: string) => {
      app.input.pressEscape()
      await app.until(unfocused)
      app.input.pressKey("t")
      await app.until((f) => f.includes("Turn 1: Fix the flaky test"))
      await typeInto(app, turn)
      app.input.pressEnter()
      await app.until((f) => !f.includes("Turn 1:") && !unfocused())
    }
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    app.input.pressKey("f")
    await typeInto(app, "Too slow")
    await pick(app, "fake clock")
    await app.until((f) => f.includes('> About turn 2 ("Use a fake clock"): Too slow'))
    await pick(app, "flaky")
    await app.until((f) => f.includes('> About turn 1 ("Fix the flaky test"): Too slow'))
    app.input.pressEscape()
    await app.until(unfocused)
    app.input.pressKey("f")
    await app.until((f) => f.includes("> Too slow") && !unfocused())
    const release = office.hold("POST /feedback")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === "/feedback"))
    await typeInto(app, " and too long")
    release()
    await app.until((f) => f.includes("queued · Too slow") && f.includes("> and too long"))
    expect(office.requests.find((r) => r.path === "/feedback")?.body).toMatchObject({ text: "Too slow" })
  })
})

test("a failed confirm or send shows the office's error and keeps the follow-up and the draft", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /debriefs/:session/confirm", "POST /feedback"] })
  withTurns(office)
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("› [ ] Add a CI job"))
    app.input.pressKey("c")
    await app.until((f) => f.includes(`/debriefs/${id}/confirm is`) && f.includes("› [ ] Add a CI job"))
    app.input.pressKey("f")
    await typeInto(app, "Good call")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("/feedback is not implemented"))
    expect(f).toContain("> Good call")
    expect(f).not.toContain("queued ·")
  })
})

test("feedback items keep their place as they move along, and a late update never moves one back", async () => {
  const office = createFakeOffice()
  withTurns(office)
  await run(office, async (app) => {
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    for (const text of ["Good call", "Too slow"]) {
      app.input.pressKey("f")
      await typeInto(app, text)
      app.input.pressEnter()
      await app.until((f) => f.includes(`queued · ${text}`) && app.setup.renderer.currentFocusedEditor === null)
    }
    const [first, second] = office.state.feedback
    office.feedbackStatus(first.id, "applied")
    let f = await app.until((f) => f.includes("applied · Good call"))
    expect(f.indexOf("applied · Good call")).toBeLessThan(f.indexOf("queued · Too slow"))
    office.feedbackStatus(first.id, "learning")
    office.feedbackStatus(second.id, "learning")
    f = await app.until((f) => f.includes("learning · Too slow"))
    expect(f).toContain("applied · Good call")
  })
})

test("a reconnect re-reads the debrief, since events missed while offline are not replayed", async () => {
  const office = createFakeOffice()
  office.addDebrief(office.state.sessions[0].id, { state: "pending" })
  await run(office, async (app, id) => {
    await app.until((f) => f.includes("Debrief pending"))
    // Changed without an event, as if it happened while the stream was down.
    office.state.debriefs[id] = { ...office.state.debriefs[id], ...READY } as Debrief
    office.reset()
    await app.until((f) => f.includes("Fixed the flaky clock test"))
  })
})

test("Ctrl+C in the feedback box clears a draft and stays; on the empty box it asks for a second press, which exits", async () => {
  const office = createFakeOffice()
  withTurns(office)
  await run(office, async (app) => {
    await app.until((f) => f.includes("Fixed the flaky clock test"))
    app.input.pressKey("f")
    await typeInto(app, "Too slow")
    await app.until((f) => f.includes("> Too slow"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("Too slow") && f.includes("Feedback for the profile"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.setup.renderer.isDestroyed).toBe(false)
    expect(app.frame()).not.toContain("Press again to exit")
    expect(app.frame()).toContain("Debrief · @minh")
    expect(app.setup.renderer.currentFocusedEditor).not.toBeNull()
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to exit"))
    expect(app.setup.renderer.isDestroyed).toBe(false)
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(office.requests.some((r) => r.path === "/feedback")).toBe(false)
  })
})
