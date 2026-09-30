import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../script/stub"
import { bootFrame } from "./fixture/frame"

test("an open question shows its options; picking one answers it", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    const q = office.addQuestion({
      session_id: s.id,
      question: "Retry the flaky test?",
      options: ["Back off up to 30s", "Fail fast"],
    })
    await app.until((f) => f.includes("Retry the flaky test?") && f.includes("Fail fast"))
    app.input.pressKey("2")
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: "Fail fast",
      answer_kind: "option",
    })
    await app.until((f) => !f.includes("Retry the flaky test?") && f.includes("@minh · Software engineer"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a question open before the session loads shows, and a typed answer is sent as text", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?" })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Which branch?") && f.includes("Type your own answer"))
    app.input.pressKey("1")
    // The answer box opens with the same text as its placeholder.
    await app.until((f) => f.split("Type your own answer").length > 2)
    app.input.typeText("main")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: "main",
      answer_kind: "text",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("multi-page questions render from `questions`; a 409 says someone else answered", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Set up the release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }, { label: "stable" }] },
      { question: "Tag it?", header: "Tag", options: [{ label: "yes" }, { label: "no" }] },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Channel") && f.includes("Tag") && f.includes("Which channel?"))
    // Someone else answers without the TUI hearing about it.
    office.state.questions[q.id] = { ...q, status: "answered", answer: "done", answer_kind: "text" }
    app.input.pressKey("2")
    await app.until((f) => f.includes("Tag it?"))
    app.input.pressKey("1")
    await app.until((f) => f.includes("Review"))
    app.input.pressEnter()
    await app.until((f) => f.includes("This question was already answered"))
    await app.until((f) => !f.includes("Which channel?") && !f.includes("Review"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a multi-page answer is sent as one text answer, a line per page", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Set up the release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }, { label: "stable" }] },
      { question: "Tag it?", header: "Tag", options: [{ label: "yes" }, { label: "no" }] },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Which channel?"))
    app.input.pressKey("2")
    await app.until((f) => f.includes("Tag it?"))
    app.input.pressKey("1")
    await app.until((f) => f.includes("Review"))
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: "Channel: stable\nTag: yes",
      answer_kind: "text",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("dismissing calls stop; a 501 toasts 'not available yet' and the question stays", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /questions/:id/stop"] })
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressEscape()
    await app.until((f) => f.includes("not available yet"))
    expect(office.requests.some((r) => r.method === "POST" && r.path === `/questions/${q.id}/stop`)).toBe(true)
    expect(app.frame()).toContain("Deploy now?")
    expect(office.state.questions[q.id].status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})
