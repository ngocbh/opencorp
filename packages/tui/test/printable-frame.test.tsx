import type { Message } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, seed } from "./fixture/fake-office"
import { bootFrame } from "./fixture/frame"

/** Control characters other than tab and newline, which the terminal would act on. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

test("a reply's control characters and terminal sequences never reach the screen; tabs and newlines do", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.state.sessions[0] = { ...s, model_note: "Fell back\x07 to gpt-4o" }
  office.state.messages[s.id] = [
    {
      id: "M1",
      session_id: s.id,
      role: "assistant",
      created_at: new Date().toISOString(),
      parts: [{ id: "p1", type: "text", text: "SO\x0eX bell\x07 \x1b]0;T\x07title \x1b[31mred\x1b[0m end\tx\nnext" }],
    } satisfies Message,
  ]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("SOX bell") && f.includes("Fell back to gpt-4o"))
    expect(f).not.toMatch(CONTROL)
    expect(f).toContain("SOX bell title red end")
    expect(f).not.toContain("[31m")
    expect(f).toMatch(/^\s*next\s*$/m)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a question and its options draw without control characters, and the answer goes back as sent", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const at = new Date().toISOString()
  office.state.workItems["w1"] = {
    id: "w1",
    title: "Cut\x07 the release",
    kind: "task",
    status: "in_progress",
    requester: "lan",
    created_at: at,
    updated_at: at,
  }
  const q = office.addQuestion({
    session_id: s.id,
    work_item_id: "w1",
    question: "QQ\x1b[2J?",
    options: ["o\x1b[31mne", "two"],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("QQ?") && f.includes("one") && f.includes('"Cut the release"'))
    expect(f).not.toMatch(CONTROL)
    app.input.pressKey("1")
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: "o\x1b[31mne",
      answer_kind: "option",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex card's title, question and options draw without control characters", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", status: "busy" })
  office.addQuestion({
    session_id: s.id,
    source: "harness",
    node_id: "1",
    run_id: "turn_1",
    title: "Codex wants\x07 to run",
    question: "$ touch\x1b[31m a",
    options: ["Ap\x0eprove", "Deny"],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("$ touch a") && f.includes("Approve") && f.includes("Codex wants to run"))
    expect(f).not.toMatch(CONTROL)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a person's name and title draw without control characters on home and in the people picker", async () => {
  const state = seed()
  state.people[0] = { ...state.people[0], name: "Min\x07h", title: "CE\x0eO" }
  const office = createFakeOffice({ seed: state })
  const app = await bootFrame(createStub(office))
  try {
    let f = await app.until((f) => f.includes("@minh · CEO"))
    expect(f).not.toMatch(CONTROL)
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("p")
    f = await app.until((f) => f.includes("Who do you want to talk to?") && f.includes("CEO"))
    expect(f).not.toMatch(CONTROL)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the side chat's header draws the question without control characters", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({ session_id: s.id, question: "Deploy\x1b[31m now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("Chat about this"))
    app.input.pressKey("o", { ctrl: true })
    const f = await app.until((f) => f.includes("Side chat with @minh") && f.includes("About: Deploy now?"))
    expect(f).not.toMatch(CONTROL)
  } finally {
    await app.stop()
    office.stop()
  }
})
