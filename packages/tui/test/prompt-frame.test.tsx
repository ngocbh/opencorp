import type { Message } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "./fixture/fake-office"
import { INTERRUPTED_TEXT } from "../src/routes/chat/freeze"
import { bootFrame } from "./fixture/frame"
import { until } from "./fixture/until"

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

test.each([["spaces", "   "], ["a zero-width space", "\u200b"]])(
  "Enter on home with a message that doesn't show starts nothing [%s]",
  async (_case, text) => {
    const office = createFakeOffice()
    const app = await bootFrame(createStub(office))
    try {
      await app.until((f) => f.includes("@minh"))
      app.input.typeText(text)
      app.input.pressEnter()
      // Enter submits two timer turns later.
      await Bun.sleep(50)
      // The draft stays; once words follow it, it goes as one message in one new session.
      app.input.typeText("hello")
      app.input.pressEnter()
      await app.until((f) => f.includes("hello") && /@minh · (idle|busy)/.test(f))
      const posts = office.requests.filter((r) => r.method === "POST")
      expect(posts.map((r) => r.path)).toEqual(["/sessions", `/sessions/${office.state.sessions[0].id}/prompt`])
      expect(posts[1].body).toEqual({ text: expect.stringContaining("hello") })
    } finally {
      await app.stop()
      office.stop()
    }
  },
)

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
    // The stopped reply ends, and the session is idle again.
    office.replyEnded(id)
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

test("after Esc, the stopped reply's interrupted marker shows, and nothing else it streamed", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const first: Message = {
    id: office.nextId(),
    session_id: id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text: "Looking" }],
  }
  office.onPrompt(() => office.live({ type: "message.updated", session_id: id, data: first as never }))
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    app.input.typeText("go")
    app.input.pressEnter()
    await app.until((f) => f.includes("Looking") && f.includes("esc interrupt"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${id}/interrupt`))
    const part = { ...first.parts[0], text: "Looking at it" + INTERRUPTED_TEXT }
    office.live({ type: "part.updated", session_id: id, data: { message_id: first.id, part } as never })
    office.replyEnded(id)
    // The marker shows as "[interrupted]" until markdown highlighting conceals a link's brackets, then as "interrupted".
    await app.until((f) => /^\s*\[?interrupted\]?\s*$/m.test(f) && f.includes("@minh · idle"))
    expect(app.frame()).not.toContain("at it")
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
    office.replyEnded(id)
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

test("a send that fails after a newer Esc keeps that Esc's freeze", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /sessions/:id/prompt"] })
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
  // A session event after a reply: once the header shows it, the reply has arrived too.
  const after = (cost: number) => {
    office.state.sessions[0] = { ...office.state.sessions[0], cost }
    office.setStatus(id, "busy")
  }
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    reply("Looking")
    after(0.25)
    await app.until((f) => f.includes("Looking") && f.includes("@minh · busy · $0.25"))
    app.input.pressEscape()
    await app.until(() => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length === 1)
    // The office answers the send, with its 501, only once released.
    const release = office.hold("POST /sessions/:id/prompt")
    app.input.typeText("again")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${id}/prompt`))
    // The send lifted the first freeze, so the late words show; a second Esc freezes them in view.
    reply("late words")
    after(0.5)
    await app.until((f) => f.includes("late words") && f.includes("@minh · busy · $0.50"))
    app.input.pressEscape()
    await app.until(() => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length === 2)
    release()
    await app.until((f) => f.includes("not implemented yet"))
    for (let i = 0; i < 10; i++) await app.setup.renderOnce()
    expect(app.frame()).toContain("late words")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a 501 from the office shows as a toast, not a crash", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /sessions/:id/prompt"] })
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

test("Esc with a draft clears it and doesn't interrupt, idle or busy; on the empty prompt Esc interrupts", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const interrupts = () => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    await app.input.typeText("idle draft")
    await app.until((f) => f.includes("idle draft"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("idle draft"))
    office.setStatus(id, "busy")
    await app.until((f) => f.includes("@minh · busy") && f.includes("esc interrupt"))
    await app.input.typeText("half a thought")
    await app.until((f) => f.includes("half a thought"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("half a thought"))
    await Bun.sleep(100)
    expect(interrupts()).toBe(0)
    app.input.pressEscape()
    await until(() => interrupts() === 1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("while busy, Esc closes an open @ menu and keeps the draft; the next Esc clears it, and only then Esc interrupts", async () => {
  const office = createFakeOffice()
  const id = office.state.sessions[0].id
  const interrupts = () => office.requests.filter((r) => r.path === `/sessions/${id}/interrupt`).length
  const app = await bootFrame(createStub(office), { sessionID: id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    office.setStatus(id, "busy")
    await app.until((f) => f.includes("@minh · busy") && f.includes("esc interrupt"))
    await app.input.typeText("look at @")
    await app.until((f) => f.includes("look at @") && f.includes("No matching items"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("No matching items"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).toContain("look at @")
    expect(interrupts()).toBe(0)
    app.input.pressEscape()
    await app.until((f) => !f.includes("look at @"))
    await Bun.sleep(100)
    expect(interrupts()).toBe(0)
    app.input.pressEscape()
    await until(() => interrupts() === 1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a waiting session interrupts it", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.updateSession(s.id, { status: "waiting", waiting_on: ["ngocbh"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("@minh · waiting") && f.includes("esc interrupt"))
    // No spinner before the hint: a waiting session isn't working.
    expect(f.split("\n").find((l) => l.includes("esc interrupt"))).toMatch(/^\s*esc interrupt/)
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${s.id}/interrupt`))
  } finally {
    await app.stop()
    office.stop()
  }
})
