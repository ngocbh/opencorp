import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

const stops = (office: ReturnType<typeof createFakeOffice>, id: string) =>
  office.requests.filter((r) => r.method === "POST" && r.path === `/questions/${id}/stop`)

test("Esc on a card asks 'Stop @minh? y/N'; Enter and n cancel, only y stops", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("esc stop @minh"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressEnter()
    await app.until((f) => !f.includes("Stop @minh? y/N") && f.includes("esc stop @minh"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("n")
    await app.until((f) => !f.includes("Stop @minh? y/N"))
    // A second Esc answers the confirm with no: a double Esc never stops the asker.
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Stop @minh? y/N"))
    expect(stops(office, q.id)).toEqual([])
    expect(office.state.questions[q.id].status).toBe("open")
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("y")
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.state.questions[q.id].answer_kind).toBe("interrupted")
    expect(stops(office, q.id)).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a human_input card offers no stop", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({ session_id: s.id, source: "human_input", node_id: "review", question: "Ship it?" })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("Ship it?") && f.includes("enter submit"))
    expect(f).not.toContain("esc stop")
    app.input.pressEscape()
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Stop @minh?")
    expect(office.requests.filter((r) => r.method === "POST")).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Ctrl+C on a card leaves the view on the second press and never stops the question", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(stops(office, q.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("<leader>q on a card leaves at once", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("q")
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(stops(office, q.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card whose question goes stale closes and says it expired", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    office.expire(q.id)
    await app.until((f) => !f.includes("Deploy now?") && f.includes("expired: the run restarted"))
  } finally {
    await app.stop()
    office.stop()
  }
})
