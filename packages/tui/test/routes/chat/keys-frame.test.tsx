import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

test("in a chat, one Ctrl+C says the session is saved and a second leaves", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave; the session is saved."))
    expect(app.setup.renderer.isDestroyed).toBe(false)
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(office.requests.filter((r) => r.method === "POST")).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("in a chat, Ctrl+C with text clears the prompt and doesn't count toward leaving", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    await app.input.typeText("half a thought")
    await app.until((f) => f.includes("half a thought"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("half a thought"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Press again to leave")
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    expect(app.setup.renderer.isDestroyed).toBe(false)
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
  } finally {
    await app.stop()
    office.stop()
  }
})

for (const status of ["ended", "failed", "interrupted"] as const) {
  test(`in a session that is ${status}, the Ctrl+C hint doesn't say the session is saved`, async () => {
    const office = createFakeOffice()
    const s = office.state.sessions[0]
    office.state.sessions[0] = { ...s, status }
    const app = await bootFrame(createStub(office), { sessionID: s.id })
    try {
      await app.until((f) => f.includes(`@minh · ${status}`))
      app.input.pressKey("c", { ctrl: true })
      const f = await app.until((f) => f.includes("Press again to leave"))
      expect(f).not.toContain("the session is saved")
      app.input.pressKey("c", { ctrl: true })
      await app.until(() => app.setup.renderer.isDestroyed)
    } finally {
      await app.stop()
      office.stop()
    }
  })
}

test("in a chat, <leader>q leaves on one press", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("q")
    await app.until(() => app.setup.renderer.isDestroyed)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("on home, one Ctrl+C still exits", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("Ask anything"))
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/end ends the session and opens its debrief", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    await app.input.typeText("/end")
    await app.until((f) => f.includes("End the session"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Writing the debrief…") || f.includes("No debrief yet."))
    expect(office.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([`/sessions/${s.id}/end`])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Enter while a reply runs steers: the text goes to the same prompt route and starts no new reply", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const replies: string[] = []
  office.onPrompt((_, req) => void replies.push(req.text))
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("fix the test")
    app.input.pressEnter()
    await app.until((f) => f.includes("@minh · busy"))
    app.input.typeText("use the retry helper")
    app.input.pressEnter()
    const prompts = () => office.requests.filter((r) => r.path === `/sessions/${s.id}/prompt`).map((r) => r.body)
    await app.until(() => prompts().length === 2)
    // The steer shows in the transcript, and the input box is empty again.
    await app.until((f) => f.split("use the retry helper").length === 2 && f.includes("@minh · busy"))
    expect(prompts()).toEqual([{ text: "fix the test" }, { text: "use the retry helper" }])
    expect(replies).toEqual(["fix the test"])
  } finally {
    await app.stop()
    office.stop()
  }
})
