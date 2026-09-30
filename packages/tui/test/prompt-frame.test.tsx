import type { Message } from "@agent-corp/protocol"
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

test("one Esc while busy interrupts, and the reply stops showing at once", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const reply = (text: string) => {
    const message: Message = {
      id: office.nextId(),
      session_id: id,
      role: "assistant",
      created_at: new Date().toISOString(),
      parts: [{ id: office.nextId(), type: "text", text }],
    }
    office.live({ type: "message.updated", session_id: id, data: message as never })
    return message
  }
  let first: Message | undefined
  office.onPrompt((_, req) => {
    if (req.text === "go") first = reply("Looking")
    else reply("Fresh start")
  })
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("go")
    app.input.pressEnter()
    await app.until((f) => f.includes("@minh · busy") && f.includes("Looking") && f.includes("esc interrupt"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${id}/interrupt`))
    // The office's reply only stops at its next safe point; what it streams meanwhile stays hidden.
    const part = first!.parts[0].id
    office.live({ type: "part.delta", session_id: id, data: { message_id: first!.id, part_id: part, text: " at it" } })
    reply("late words")
    // A session event after the late words: once the header shows it, they have arrived too.
    office.state.sessions[0] = { ...office.state.sessions[0], cost: 0.5 }
    // The stopped reply's next turn opens, and the session is idle again.
    office.openTurn(id)
    await app.until((f) => f.includes("@minh · idle · $0.50"))
    for (let i = 0; i < 10; i++) await app.setup.renderOnce()
    expect(app.frame()).toContain("Looking")
    expect(app.frame()).not.toContain("Looking at it")
    expect(app.frame()).not.toContain("late words")
    app.input.typeText("again")
    app.input.pressEnter()
    await app.until((f) => f.includes("Fresh start"))
    expect(app.frame()).not.toContain("late words")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a second Esc keeps hiding a reply that arrived after the first", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const reply = (text: string) => {
    const message: Message = {
      id: office.nextId(),
      session_id: id,
      role: "assistant",
      created_at: new Date().toISOString(),
      parts: [{ id: office.nextId(), type: "text", text }],
    }
    office.live({ type: "message.updated", session_id: id, data: message as never })
  }
  office.onPrompt(() => reply("Looking"))
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("go")
    app.input.pressEnter()
    await app.until((f) => f.includes("Looking") && f.includes("esc interrupt"))
    app.input.pressEscape()
    await app.until(() => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length === 1)
    reply("late words")
    // A session event after the late words: once the header shows it, they have arrived too.
    office.state.sessions[0] = { ...office.state.sessions[0], cost: 0.5 }
    office.setStatus(id, "busy")
    await app.until((f) => f.includes("@minh · busy · $0.50"))
    app.input.pressEscape()
    await app.until(() => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length === 2)
    office.state.sessions[0] = { ...office.state.sessions[0], cost: 0.75 }
    office.setStatus(id, "busy")
    await app.until((f) => f.includes("@minh · busy · $0.75"))
    for (let i = 0; i < 10; i++) await app.setup.renderOnce()
    expect(app.frame()).toContain("Looking")
    expect(app.frame()).not.toContain("late words")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("after Esc, a new reply that streams in before the prompt call returns shows", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const reply = (text: string) => {
    const message: Message = {
      id: office.nextId(),
      session_id: id,
      role: "assistant",
      created_at: new Date().toISOString(),
      parts: [{ id: office.nextId(), type: "text", text }],
    }
    office.live({ type: "message.updated", session_id: id, data: message as never })
  }
  office.onPrompt((_, req) => {
    reply(req.text === "go" ? "Looking" : "Fresh start")
    // A session event after the reply: once the header shows it, the reply has arrived too.
    office.state.sessions[0] = { ...office.state.sessions[0], cost: req.text === "go" ? 0.5 : 0.75 }
    office.setStatus(id, "busy")
  })
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("go")
    app.input.pressEnter()
    await app.until((f) => f.includes("Looking") && f.includes("@minh · busy · $0.50"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${id}/interrupt`))
    office.openTurn(id)
    await app.until((f) => f.includes("@minh · idle · $0.50"))
    // The office answers the next prompt only after its reply has streamed.
    const release = office.hold("POST /sessions/:id/prompt", "reply")
    app.input.typeText("again")
    app.input.pressEnter()
    await app.until((f) => f.includes("@minh · busy · $0.75") && f.includes("Fresh start"))
    release()
    // The input clears once the call returns: "again" is left only in the transcript.
    await app.until((f) => f.split("again").length === 2 && f.includes("Fresh start"))
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
