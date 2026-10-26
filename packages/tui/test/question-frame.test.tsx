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
    await app.until((f) => f.includes("Which branch?") && f.includes("1. Type your answer here"))
    // A page with only a typed answer starts in its box; Enter right after typing sends all of it.
    await app.input.typeText("main")
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

test("the question the answer call returns closes the card without waiting for its event", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Retry the flaky test?",
    options: ["Back off", "Fail fast"],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Retry the flaky test?") && f.includes("Fail fast"))
    // No stream, so no question.updated event, until the answer is in.
    office.hold("GET /events")
    office.dropStreams()
    app.input.pressKey("2")
    await app.until(() => office.state.questions[q.id].status === "answered")
    await app.until((f) => !f.includes("Retry the flaky test?"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a second pick while the answer is in flight sends nothing", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    question: "Retry the flaky test?",
    options: ["Back off", "Fail fast"],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Retry the flaky test?") && f.includes("Fail fast"))
    const release = office.hold("POST /questions/:id/answer")
    const answers = () => office.requests.filter((r) => r.path === `/questions/${q.id}/answer`)
    app.input.pressKey("2")
    await app.until(() => answers().length === 1)
    app.input.pressKey("1")
    app.input.pressKey("2")
    await Bun.sleep(100)
    release()
    await app.until(() => office.state.questions[q.id].status === "answered")
    await app.until((f) => !f.includes("Retry the flaky test?"))
    expect(answers().map((r) => r.body)).toEqual([{ answer: "Fail fast", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a reconnect that re-reads the question keeps the typed draft and the answer in flight", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?", options: ["main", "dev"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  const rereads = () => office.requests.filter((r) => r.path === `/questions/${q.id}`).length
  const reconnect = async () => {
    const before = rereads()
    office.reset()
    await app.until(() => rereads() > before)
    await app.until((f) => f.includes("@minh · idle") && f.includes("Which branch?"))
  }
  try {
    await app.until((f) => f.includes("Which branch?") && f.includes("3. Type your answer here"))
    app.input.pressKey("3")
    await app.input.typeText("rel")
    await app.until((f) => f.includes("3. rel"))
    await reconnect()
    await app.input.typeText("ease")
    await app.until((f) => f.includes("3. release"))
    const release = office.hold("POST /questions/:id/answer")
    const answers = () => office.requests.filter((r) => r.path === `/questions/${q.id}/answer`)
    app.input.pressEnter()
    await app.until(() => answers().length === 1)
    await reconnect()
    // On the box, "1" would be typed instead of picking.
    app.input.pressArrow("up")
    app.input.pressKey("1")
    await Bun.sleep(100)
    release()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(answers().map((r) => r.body)).toEqual([{ answer: "release", answer_kind: "text" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a 409 says someone else answered and re-reads the question", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which channel?", options: ["beta", "stable"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Which channel?") && f.includes("stable"))
    // Someone else answers without the TUI hearing about it.
    office.state.questions[q.id] = { ...q, status: "answered", answer: "beta", answer_kind: "option" }
    app.input.pressKey("2")
    await app.until((f) => f.includes("This question was already answered"))
    await app.until((f) => !f.includes("Which channel?"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a multi-page question answers with a record, page by page; the header names the work item", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const at = new Date().toISOString()
  office.state.workItems["w1"] = {
    id: "w1",
    title: "Cut the release",
    kind: "task",
    status: "in_progress",
    requester: "lan",
    created_at: at,
    updated_at: at,
  }
  const q = office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "release",
    work_item_id: "w1",
    question: "Set up the release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }, { label: "stable" }] },
      {
        question: "Which targets?",
        header: "Targets",
        multi_select: true,
        options: [{ label: "linux" }, { label: "mac" }],
      },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until(
      (f) => f.includes('@minh asks · work item "Cut the release"') && f.includes("Question 1 of 2 · Channel"),
    )
    app.input.pressKey("2")
    await app.until((f) => f.includes("Question 2 of 2 · Targets") && f.includes("[ ] linux"))
    app.input.pressKey("1")
    app.input.pressKey("2")
    await app.until((f) => f.includes("[x] linux") && f.includes("[x] mac"))
    expect(office.requests.some((r) => r.path === `/questions/${q.id}/answer`)).toBe(false)
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: { Channel: "stable", Targets: ["linux", "mac"] },
      answer_kind: "option",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a prompt gate with a record output can't be answered here", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "fill",
    question: "Describe the bug",
    answer_schema: [
      { name: "title", type: "str", required: true },
      { name: "severity", type: "int", required: true },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("can't be answered here yet"))
    expect(f).toContain("Describe the bug")
    expect(f).toContain("@minh asks")
    expect(f).not.toContain("Chat about this")
    app.input.pressKey("1")
    app.input.pressEnter()
    await Bun.sleep(50)
    expect(office.requests.some((r) => r.path === `/questions/${q.id}/answer`)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("stopping calls stop; a 501 toasts 'not available yet' and the question stays", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /questions/:id/stop"] })
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("y")
    await app.until((f) => f.includes("not available yet"))
    expect(office.requests.some((r) => r.method === "POST" && r.path === `/questions/${q.id}/stop`)).toBe(true)
    expect(app.frame()).toContain("Deploy now?")
    expect(office.state.questions[q.id].status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an ask node question in the chat is a card", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle") && f.includes("@minh · Software engineer"))
    office.addQuestion({ session_id: s.id, source: "ask", node_id: "chat#1/review", question: "Ship it?" })
    await app.until((f) => f.includes("Ship it?") && f.includes("Type your answer here"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a secret page on a Codex card masks what is typed, and sends it only as the answer", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", status: "busy" })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const q = office.addQuestion({
      session_id: s.id,
      source: "harness",
      run_id: "turn_1",
      node_id: "4",
      question: "Token?",
      questions: [{ question: "Paste the deploy token", header: "Token", options: [], secret: true }],
    })
    await app.until((f) => f.includes("Paste the deploy token"))
    await app.input.typeText("sk-ant-sentinel-a7d93c10e5b2")
    const f = await app.until((f) => f.includes("•".repeat(28)))
    expect(f).not.toContain("sentinel")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status !== "open")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: { Token: "sk-ant-sentinel-a7d93c10e5b2" },
      answer_kind: "text",
    })
    expect(
      office.requests.filter((r) => JSON.stringify(r.body ?? null).includes("sentinel")).map((r) => r.path),
    ).toEqual([`/questions/${q.id}/answer`])
  } finally {
    await app.stop()
    office.stop()
  }
})
