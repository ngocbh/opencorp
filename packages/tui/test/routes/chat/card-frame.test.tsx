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

test("an ask card offers no stop", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({ session_id: s.id, source: "ask", node_id: "review", question: "Ship it?" })
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

test("a carried card shows the earlier discussion, can send it back, and can dismiss it", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const earlier = office.addQuestion({
    session_id: s.id,
    question: "Which database?",
    status: "stale",
    discussion: [
      { role: "user", text: "why Postgres?" },
      { role: "assistant", text: "it scales past one node" },
    ],
  })
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    carried_from: earlier.id,
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    // The earlier question isn't open, so the card reads it from the office.
    await app.until(
      (f) =>
        f.includes("From an earlier, expired question: Which database?") &&
        f.includes("you: why Postgres?") &&
        f.includes("@minh: it scales past one node") &&
        f.includes("[Send discussion back]") &&
        f.includes("[Dismiss earlier discussion]"),
    )
    // The rows wrap: up from the first option selects the last row.
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until((f) => !f.includes("From an earlier") && !f.includes("Dismiss earlier discussion"))
    // With no discussion of its own left, there is nothing to send back.
    const f = await app.until((f) => f.includes("Deploy now?") && f.includes("[Chat about this]"))
    expect(f).not.toContain("Send discussion back")
    expect(office.state.questions[q.id].carried_from ?? null).toBeNull()
    expect(office.state.questions[q.id].status).toBe("open")
    expect(office.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      `/questions/${q.id}/carried/dismiss`,
    ])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a carried card with no discussion of its own can still send the earlier one back", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const earlier = office.addQuestion({
    session_id: s.id,
    question: "Which database?",
    status: "stale",
    discussion: [{ role: "user", text: "why Postgres?" }],
  })
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    carried_from: earlier.id,
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("you: why Postgres?") && f.includes("[Send discussion back]"))
    app.input.pressArrow("up")
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.state.questions[q.id].answer_kind).toBe("sent_back")
    expect(office.requests.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([
      [`/questions/${q.id}/send-back`, { note: "" }],
    ])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a 501 from carried/dismiss warns 'not available yet' and keeps the earlier discussion", async () => {
  const office = createFakeOffice({ notImplemented: ["POST /questions/:id/carried/dismiss"] })
  const s = office.state.sessions[0]
  const earlier = office.addQuestion({
    session_id: s.id,
    question: "Which database?",
    status: "stale",
    discussion: [{ role: "user", text: "why Postgres?" }],
  })
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], carried_from: earlier.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("[Dismiss earlier discussion]"))
    app.input.pressArrow("up")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Dismissing a discussion is not available yet"))
    expect(f).toContain("From an earlier, expired question: Which database?")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the question stop returns closes the card without waiting for its event", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("esc stop @minh"))
    // No stream, so no question.updated event, until the stop is in.
    office.hold("GET /events")
    office.dropStreams()
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("y")
    await app.until(() => office.state.questions[q.id].status === "answered")
    await app.until((f) => !f.includes("Deploy now?"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a second stop while the first is in flight sends nothing and says the card is busy", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("esc stop @minh"))
    const release = office.hold("POST /questions/:id/stop")
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("y")
    await app.until(() => stops(office, q.id).length === 1)
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("y")
    await app.until((f) => f.includes("Busy: the last action is still sending"))
    release()
    await app.until((f) => !f.includes("Deploy now?"))
    expect(stops(office, q.id)).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a second dismiss or send back while the first is in flight sends nothing and says the card is busy", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const earlier = office.addQuestion({
    session_id: s.id,
    question: "Which database?",
    status: "stale",
    discussion: [{ role: "user", text: "why Postgres?" }],
  })
  const q = office.addQuestion({
    session_id: s.id,
    question: "Deploy now?",
    options: ["yes", "no"],
    carried_from: earlier.id,
    discussion: [{ role: "user", text: "is staging green?" }],
  })
  const posts = () => office.requests.filter((r) => r.method === "POST").map((r) => r.path)
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("[Dismiss earlier discussion]"))
    let release = office.hold("POST /questions/:id/carried/dismiss")
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until(() => posts().length === 1)
    app.input.pressEnter()
    await app.until((f) => f.includes("Busy: the last action is still sending"))
    release()
    await app.until((f) => !f.includes("Dismiss earlier discussion") && f.includes("[Send discussion back]"))
    release = office.hold("POST /questions/:id/send-back")
    app.input.pressArrow("up")
    app.input.pressEnter()
    await app.until(() => posts().length === 2)
    app.input.pressEnter()
    // The first busy toast may still show, so it can't tell that this press was handled.
    await Bun.sleep(100)
    release()
    await app.until(() => office.state.questions[q.id].status === "answered")
    await app.until((f) => !f.includes("Deploy now?"))
    expect(posts()).toEqual([`/questions/${q.id}/carried/dismiss`, `/questions/${q.id}/send-back`])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Ctrl+C while 'Stop @minh? y/N' shows leaves on the second press and never stops", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Deploy now?") && f.includes("esc stop @minh"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
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

test("an empty typed answer keeps the option picked on that page", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "release",
    question: "Set up the release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }, { label: "stable" }] },
      { question: "Which region?", header: "Region", options: [{ label: "eu" }, { label: "us" }] },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Question 1 of 2 · Channel"))
    app.input.pressKey("2")
    await app.until((f) => f.includes("Question 2 of 2 · Region"))
    app.input.pressArrow("left")
    await app.until((f) => f.includes("Question 1 of 2 · Channel"))
    app.input.pressKey("3")
    await app.input.typeText("x")
    await app.until((f) => f.includes("3. x") && f.includes("Question 1 of 2 · Channel"))
    app.input.pressBackspace()
    await app.until((f) => f.includes("3. Type your answer here") && f.includes("Question 1 of 2 · Channel"))
    // An empty box keeps "stable" picked and stays on the page.
    app.input.pressEnter()
    await Bun.sleep(100)
    expect(app.frame()).toContain("Question 1 of 2 · Channel")
    app.input.pressArrow("up")
    app.input.pressArrow("right")
    await app.until((f) => f.includes("Question 2 of 2 · Region"))
    app.input.pressKey("1")
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: { Channel: "stable", Region: "eu" },
      answer_kind: "option",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Down onto the typed row types straight in; Up leaves it and a number picks again", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?", options: ["main", "dev"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  const answers = () => office.requests.filter((r) => r.path === `/questions/${q.id}/answer`)
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    expect(app.frame()).not.toContain("Type your own answer")
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    // j and digits are text in the box, not moves or picks.
    await app.input.typeText("j1")
    await app.until((f) => f.includes("3. j1"))
    expect(answers()).toEqual([])
    app.input.pressArrow("up")
    app.input.pressKey("2")
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(answers().map((r) => r.body)).toEqual([{ answer: "dev", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc in the typed box clears its text first; on the empty box it asks to stop, and n gives the box back", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?", options: ["main", "dev"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    await app.input.typeText("rel")
    await app.until((f) => f.includes("3. rel"))
    app.input.pressEscape()
    await app.until((f) => f.includes("3. Type your answer here"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Stop @minh? y/N")
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("n")
    await app.until((f) => !f.includes("Stop @minh? y/N"))
    await app.input.typeText("release")
    await app.until((f) => f.includes("3. release"))
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: "release",
      answer_kind: "text",
    })
    expect(stops(office, q.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc off the typed box asks to stop even with text in it; n keeps the text", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?", options: ["main", "dev"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    await app.input.typeText("rel")
    await app.until((f) => f.includes("3. rel"))
    app.input.pressArrow("up")
    app.input.pressEscape()
    await app.until((f) => f.includes("Stop @minh? y/N"))
    app.input.pressKey("n")
    await app.until((f) => !f.includes("Stop @minh? y/N") && f.includes("3. rel"))
    app.input.pressArrow("down")
    await app.input.typeText("ease")
    await app.until((f) => f.includes("3. release"))
    expect(stops(office, q.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Ctrl+C in the typed box clears its text first; on the empty box it leaves on the second press", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({ session_id: s.id, question: "Which branch?", options: ["main", "dev"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    await app.input.typeText("rel")
    await app.until((f) => f.includes("3. rel"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("3. Type your answer here"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Press again to leave")
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    expect(app.setup.renderer.isDestroyed).toBe(false)
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(stops(office, q.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("each typed page keeps its own text when paging, across a page with no typed answer", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "release",
    question: "Set up the release",
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "beta" }] },
      { question: "Which size?", header: "Size", options: [{ label: "s" }, { label: "m" }] },
      { question: "Which region?", header: "Region", options: [{ label: "eu" }] },
    ],
    // An enum for Size makes that page pick-only.
    answer_schema: [{ name: "Size", type: "str", required: true, enum: ["s", "m"] }],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("Question 1 of 3 · Channel") && f.includes("2. Type your answer here"))
    app.input.pressKey("2")
    // Leaving right after typing keeps every character.
    await app.input.typeText("nightly")
    app.input.pressArrow("up")
    app.input.pressArrow("right")
    let f = await app.until((f) => f.includes("Question 2 of 3 · Size"))
    expect(f).not.toContain("Type your answer here")
    app.input.pressArrow("right")
    await app.until((f) => f.includes("Question 3 of 3 · Region") && f.includes("2. Type your answer here"))
    app.input.pressKey("2")
    await app.input.typeText("eu-west")
    app.input.pressArrow("up")
    app.input.pressArrow("left")
    app.input.pressArrow("left")
    await app.until((f) => f.includes("Question 1 of 3 · Channel") && f.includes("2. nightly"))
    app.input.pressArrow("right")
    app.input.pressArrow("right")
    f = await app.until((f) => f.includes("Question 3 of 3 · Region") && f.includes("2. eu-west"))
    expect(f).not.toContain("nightly")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("on a multi-select page, Enter on the empty box confirms the ticked options", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "tags",
    question: "Tag it",
    questions: [
      { question: "Which tags?", header: "Tags", options: [{ label: "infra" }, { label: "docs" }], multi_select: true },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressKey("1")
    await app.until((f) => f.includes("1. [x]"))
    app.input.pressArrow("down")
    app.input.pressArrow("down")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: { Tags: ["infra"] },
      answer_kind: "option",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("text typed on a multi-select page stays in its box while options are ticked, and is sent with them", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const q = office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "tags",
    question: "Tag it",
    questions: [
      { question: "Which tags?", header: "Tags", options: [{ label: "infra" }, { label: "docs" }], multi_select: true },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("3. Type your answer here"))
    app.input.pressKey("3")
    await app.input.typeText("abc")
    await app.until((f) => f.includes("3. abc"))
    // Up leaves the box with no Enter; ticking an option must not rebuild the box and lose the text.
    app.input.pressArrow("up")
    app.input.pressKey(" ")
    // The tick and any rebuild happen in the same key handler, so the first frame with the tick shows the box.
    const f = await app.until((f) => f.includes("2. [x] docs"))
    expect(f).toContain("3. abc")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status === "answered")
    expect(office.requests.find((r) => r.path === `/questions/${q.id}/answer`)?.body).toEqual({
      answer: { Tags: ["docs", "abc"] },
      answer_kind: "text",
    })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an office without the carried/dismiss route warns 'not available yet' too", async () => {
  const office = createFakeOffice({ missing: ["POST /questions/:id/carried/dismiss"] })
  const s = office.state.sessions[0]
  const earlier = office.addQuestion({
    session_id: s.id,
    question: "Which database?",
    status: "stale",
    discussion: [{ role: "user", text: "why Postgres?" }],
  })
  office.addQuestion({ session_id: s.id, question: "Deploy now?", options: ["yes", "no"], carried_from: earlier.id })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("[Dismiss earlier discussion]"))
    app.input.pressArrow("up")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Dismissing a discussion is not available yet"))
    expect(f).toContain("From an earlier, expired question: Which database?")
    expect(f).not.toContain("Dismissing failed")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a long option wraps instead of being cut", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")
  office.addQuestion({ session_id: s.id, question: "Which plan?", options: [long, "short"] })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("word29") && f.includes("2. short"))
    expect(f).toContain("1. word0")
    expect(f.split("\n").filter((l) => /word\d/.test(l)).some((l) => l.includes("…"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("options sit on consecutive rows; a description takes the row under its option", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.addQuestion({
    session_id: s.id,
    source: "ask",
    node_id: "setup",
    question: "Which database?",
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres", description: "the default" }, { label: "SQLite" }, { label: "Oracle" }],
      },
    ],
  })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    const f = await app.until((f) => f.includes("4. Type your answer here"))
    const lines = f.split("\n")
    const row = (text: string) => lines.findIndex((l) => l.includes(text))
    expect(row("the default")).toBe(row("1. Postgres") + 1)
    expect(row("2. SQLite")).toBe(row("the default") + 1)
    expect(row("3. Oracle")).toBe(row("2. SQLite") + 1)
    expect(row("4. Type your answer here")).toBe(row("3. Oracle") + 1)
  } finally {
    await app.stop()
    office.stop()
  }
})
