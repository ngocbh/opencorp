import type { Message } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

type Office = ReturnType<typeof createFakeOffice>

function say(office: Office, sessionId: string, text: string) {
  const message: Message = {
    id: office.nextId(),
    session_id: sessionId,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text }],
  }
  // Stored for a later read, and streamed to a TUI already watching.
  office.state.messages[sessionId].push(message)
  office.live({ type: "message.updated", session_id: sessionId, data: message as never })
}

const posts = (office: Office) => office.requests.filter((r) => r.method === "POST").map((r) => [r.path, r.body])

test("Ctrl+O opens a side chat: Enter goes to the side session, Esc interrupts it, /back returns", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  say(office, s.id, "main words")
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  office.onPrompt((id, req) => {
    if (id !== s.id && req.text === "why?") say(office, id, "Because staging is green")
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("main words") && f.includes("Chat about this"))
    app.input.pressKey("o", { ctrl: true })
    await app.until(
      (f) => f.includes("Side chat with @minh") && f.includes("About: Deploy now?") && !f.includes("main words"),
    )
    app.input.typeText("why?")
    app.input.pressEnter()
    await app.until((f) => f.includes("Because staging is green"))
    const side = office.state.questions[q.id].side_session_id!
    expect(side).toBeTruthy()
    app.input.typeText("and then?")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side}/prompt`))
    // The exit words are refused before they reach the side session.
    app.input.typeText("/end")
    app.input.pressEnter()
    await app.until((f) => f.includes("use /back to return to the question"))
    // Esc stops the side reply and never leaves the side chat.
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side}/interrupt`))
    await app.until((f) => f.includes("Side chat with @minh · idle"))
    expect(posts(office)).toEqual([
      [`/questions/${q.id}/side`, { text: "why?" }],
      [`/sessions/${side}/prompt`, { text: "and then?" }],
      [`/sessions/${side}/interrupt`, undefined],
    ])
    app.input.typeText("/back")
    app.input.pressEnter()
    await app.until((f) => f.includes("main words") && f.includes("Deploy now?") && !f.includes("Side chat with"))
    expect(office.state.questions[q.id].status).toBe("open")
    // Reopening continues the same side session; Ctrl+B also returns.
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Because staging is green"))
    app.input.pressKey("b", { ctrl: true })
    await app.until((f) => f.includes("main words") && !f.includes("Side chat with"))
    expect(posts(office).filter(([p]) => p === `/questions/${q.id}/side`)).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an ended side chat goes back through /side, which restarts it; exit words are refused in any case", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    app.input.typeText("why?")
    app.input.pressEnter()
    await app.until((f) => f.includes("Side chat with @minh · busy"))
    const side = office.state.questions[q.id].side_session_id!
    office.setStatus(side, "ended")
    await app.until((f) => f.includes("Side chat with @minh · ended"))
    app.input.typeText(" /Quit ")
    app.input.pressEnter()
    await app.until((f) => f.includes("use /back to return to the question"))
    app.input.typeText("still there?")
    app.input.pressEnter()
    await app.until((f) => f.includes("Side chat with @minh · busy"))
    expect(posts(office)).toEqual([
      [`/questions/${q.id}/side`, { text: "why?" }],
      [`/questions/${q.id}/side`, { text: "still there?" }],
    ])
    expect(office.state.questions[q.id].side_session_id).toBe(side)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("after a discussion the card offers Send discussion back, which sends an empty note", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    discussion: [{ role: "user", text: "why?" }],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Send discussion back"))
    // The rows wrap: up from the first option selects the last row.
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.state.questions[q.id].answer_kind).toBe("sent_back")
    expect(posts(office)).toEqual([[`/questions/${q.id}/send-back`, { note: "" }]])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a human_input card never offers Send discussion back", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({
    session_id: s.id,
    source: "human_input",
    node_id: "review",
    question: "Ship it?",
    discussion: [{ role: "user", text: "why?" }],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("Ship it?") && f.includes("Chat about this"))
    expect(f).not.toContain("Send discussion back")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a gate's side chat says it is the requester's explanation", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({ session_id: s.id, question: "Approve the spend?", options: ["yes", "no"], gate: true })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Approve the spend?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("@minh's explanation (the requester), not neutral advice"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the side chat closes when its question does", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    app.input.typeText("why?")
    app.input.pressEnter()
    await app.until(() => !!office.state.questions[q.id].side_session_id)
    office.expire(q.id)
    await app.until((f) => !f.includes("Side chat with") && f.includes("expired: the run restarted"))
    // The main prompt is back.
    app.input.typeText("hello")
    await app.until((f) => f.includes("hello"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a 501 from the side route or send back warns 'not available yet' and keeps the question", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /questions/:id/side", "POST /questions/:id/send-back"] })
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    discussion: [{ role: "user", text: "why?" }],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Send discussion back"))
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until((f) => f.includes("Sending a discussion back is not available yet"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    app.input.typeText("why?")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Side chats are not available yet"))
    expect(f).not.toContain("failed")
    expect(office.state.questions[q.id].status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a side session another client started loads when the side chat opens, and its replies show", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "idle" as const }
  // Written straight into the office's state: as if made before this TUI connected.
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  say(office, side.id, "Staging went green an hour ago")
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    side_session_id: side.id,
  })
  office.onPrompt((id, req) => {
    if (id === side.id && req.text === "and prod?") say(office, id, "Prod is next")
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · idle") && f.includes("Staging went green an hour ago"))
    app.input.typeText("and prod?")
    app.input.pressEnter()
    await app.until((f) => f.includes("Prod is next"))
    expect(posts(office)).toEqual([[`/sessions/${side.id}/prompt`, { text: "and prod?" }]])
    expect(office.state.questions[q.id].status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})
