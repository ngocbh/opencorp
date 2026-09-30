import { expect, test } from "bun:test"
import { createFakeOffice, createStub, OFFICE_501_ROUTES } from "../script/stub"
import { bootFrame } from "./fixture/frame"

test("Enter on home creates a session for the person in the cwd, prompts it, and opens it", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("@minh"))
    app.input.typeText("hello office")
    app.input.pressEnter()
    // The session view's header replaces home's person line once the new session opens.
    await app.until((f) => f.includes("hello office") && /@minh · (idle|busy)/.test(f))
    const posts = office.requests.filter((r) => r.method === "POST")
    expect(posts.map((r) => r.path)).toEqual(["/sessions", `/sessions/${office.state.sessions[0].id}/prompt`])
    expect(posts[0].body).toEqual({ person: "minh", cwd: "/tmp/proj" })
    expect(posts[1].body).toEqual({ text: "hello office" })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc while busy interrupts the session", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  office.onPrompt(() => {})
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("go")
    app.input.pressEnter()
    await app.until((f) => office.state.sessions[0].status === "busy" && f.includes("@minh · busy"))
    // Two Escs in one write would parse as alt+escape, so wait for the first to land.
    app.input.pressEscape()
    await app.until((f) => f.includes("again to interrupt"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${id}/interrupt`))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a 501 from the office shows as a toast, not a crash", async () => {
  const office = createFakeOffice({ notImplemented: OFFICE_501_ROUTES })
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("@minh"))
    app.input.typeText("hi")
    app.input.pressEnter()
    await app.until((f) => f.includes("not implemented yet"))
  } finally {
    await app.stop()
    office.stop()
  }
})
