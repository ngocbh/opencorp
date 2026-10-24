import type { Message } from "@opencorp/protocol"
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
    // The stopped reply's next turn opens: the side session is idle again.
    office.openTurn(side)
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

test("an ask card never offers Send discussion back", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({
    session_id: s.id,
    source: "ask",
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
  office.openTurn(side.id)
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

test("a side message the office refuses stays in the input", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /questions/:id/side"] })
  const s = office.state.sessions[0]
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    app.input.typeText("is staging green?")
    app.input.pressEnter()
    await app.until((f) => f.includes("Side chats are not available yet") && f.includes("is staging green?"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a side message clears once the side route takes it, before the side session loads", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    // The new side session's messages load only once released.
    const release = office.hold("GET /sessions/:id/messages")
    app.input.typeText("why?")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/questions/${q.id}/side`))
    await app.until((f) => f.includes("Ask @minh about the question"))
    app.input.pressEnter()
    release()
    const side = office.state.questions[q.id].side_session_id!
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side}/messages`))
    await Bun.sleep(100)
    expect(posts(office)).toEqual([[`/questions/${q.id}/side`, { text: "why?" }]])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a side send that fails puts the freeze back", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /sessions/:id/prompt"] })
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "busy" as const }
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  say(office, side.id, "Explaining")
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · busy") && f.includes("Explaining"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/interrupt`))
    // The stopped reply's next turn opens: the side session is idle again.
    office.openTurn(side.id)
    await app.until((f) => f.includes("Side chat with @minh · idle"))
    app.input.typeText("more")
    app.input.pressEnter()
    await app.until((f) => f.includes("Side chats are not available yet") && f.includes("more"))
    // Words the stopped reply sends after the failed send stay hidden, then a status event: once the
    // header shows it, they have arrived.
    say(office, side.id, "side late")
    office.setStatus(side.id, "busy")
    await app.until((f) => f.includes("Side chat with @minh · busy"))
    for (let i = 0; i < 10; i++) await app.setup.renderOnce()
    expect(app.frame()).toContain("Explaining")
    expect(app.frame()).not.toContain("side late")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc interrupts a starting side session; /Back returns in any case", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "starting" as const }
  office.state.sessions.push(side)
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · starting"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/interrupt`))
    app.input.typeText("/Back")
    app.input.pressEnter()
    await app.until((f) => f.includes("Deploy now?") && !f.includes("Side chat with"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a waiting side session still has its run: a message goes to it, and Esc interrupts it", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "waiting" as const, waiting_on: ["ngocbh"] }
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · waiting on @ngocbh"))
    app.input.typeText("go on")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/prompt`))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/interrupt`))
    expect(office.requests.some((r) => r.path.endsWith("/side"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap 20 in a side chat raises the side session's cap and sends nothing to the model", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "waiting" as const, waiting_on: ["ngocbh"],
    capped: true, cost: 1 }
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · cost cap reached, waiting on @ngocbh"))
    app.input.typeText("/cost-cap 20")
    await app.until((f) => f.includes("/cost-cap 20"))
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/cost-cap`))
    await app.until((f) => f.includes("Cost cap raised to $20.00") && !f.includes("/cost-cap 20"))
    expect(office.requests.some((r) => r.path.endsWith("/prompt") || r.path.endsWith("/side"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the typed box lets go of the keys while the side chat shows and keeps its text after /back", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressKey("3")
    await app.input.typeText("later")
    await app.until((f) => f.includes("3. later"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    await app.input.typeText("why?")
    app.input.pressEnter()
    await app.until(() => posts(office).length === 1)
    expect(posts(office)).toEqual([[`/questions/${q.id}/side`, { text: "why?" }]])
    app.input.typeText("/back")
    app.input.pressEnter()
    await app.until((f) => f.includes("Deploy now?") && f.includes("3. later") && !f.includes("Side chat with"))
    // The box has the keys again.
    await app.input.typeText("!")
    await app.until((f) => f.includes("3. later!"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("in the side chat, Ctrl+C and Esc clear a draft first; on the empty box Esc interrupts and Ctrl+C asks to leave", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "busy" as const }
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  say(office, side.id, "Explaining")
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const interrupts = () => office.requests.filter((r) => r.path === `/sessions/${side.id}/interrupt`).length
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · busy") && f.includes("Explaining"))
    await app.input.typeText("half a thought")
    await app.until((f) => f.includes("half a thought"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("half a thought") && f.includes("Ask @minh about the question"))
    await app.input.typeText("another")
    await app.until((f) => f.includes("another"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("another") && f.includes("Ask @minh about the question"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Press again to leave")
    expect(app.frame()).toContain("Side chat with @minh · busy")
    expect(interrupts()).toBe(0)
    app.input.pressEscape()
    await app.until(() => interrupts() === 1)
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    expect(app.setup.renderer.isDestroyed).toBe(false)
    expect(app.frame()).toContain("Side chat with @minh")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("while a side message is on its way, Esc interrupts and Ctrl+C asks to leave; the text stays for a failed send", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /sessions/:id/prompt"] })
  const s = office.state.sessions[0]
  const side = { ...s, id: office.nextId(), kind: "side" as const, status: "busy" as const }
  office.state.sessions.push(side)
  office.state.messages[side.id] = []
  say(office, side.id, "Explaining")
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], side_session_id: side.id })
  const interrupts = () => office.requests.filter((r) => r.path === `/sessions/${side.id}/interrupt`).length
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh · busy") && f.includes("Explaining"))
    // The office answers the send, with its 501, only once released.
    const release = office.hold("POST /sessions/:id/prompt")
    await app.input.typeText("more")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${side.id}/prompt`))
    // The text is on its way, so it is no draft to clear: Esc interrupts and Ctrl+C starts leaving, as before.
    app.input.pressEscape()
    await app.until(() => interrupts() === 1)
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    expect(app.frame()).toContain("more")
    release()
    await app.until((f) => f.includes("Side chats are not available yet") && f.includes("more"))
    expect(app.setup.renderer.isDestroyed).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})
