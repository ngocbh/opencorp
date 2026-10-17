import type { Message } from "@agent-corp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { INTERRUPTED_TEXT } from "../../../src/routes/chat/freeze"
import { bootFrame } from "../../fixture/frame"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"

/** The fake office with a Codex session in a turn (`busy`, as it is while Codex asks). */
function codexOffice() {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", status: "busy" })
  return { office, s }
}

const approval = (sid: string, n: string, question: string, options: string[]) => ({
  session_id: sid,
  source: "harness" as const,
  node_id: n,
  run_id: "turn_1",
  title: "Codex wants to run a command",
  question,
  options,
})

const secret = (sid: string, n: string) => ({
  session_id: sid,
  source: "harness" as const,
  node_id: n,
  run_id: "turn_1",
  question: "Token?",
  questions: [{ question: "Paste the deploy token", header: "Token", options: [], secret: true }],
})

/** The bodies of the requests sent to `path`. */
const sent = (office: ReturnType<typeof createFakeOffice>, path: string) =>
  office.requests.filter((r) => r.path === path).map((r) => r.body)

test("a Codex card says Codex asks, offers no side chat, and an option key answers it", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const a = office.addQuestion(
      approval(s.id, "1", "$ touch a", ["Approve", "Approve for this session", "Deny so Codex continues", "Deny and stop"]),
    )
    const f = await app.until((f) => f.includes("$ touch a"))
    expect(f).toContain("Codex asks")
    expect(f).not.toContain("Chat about this")
    app.input.pressKey("1")
    await app.until(() => office.state.questions[a.id].status !== "open")
    expect(sent(office, `/questions/${a.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an MCP approval card offers Allow, Allow for this session, Cancel", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    office.addQuestion({
      ...approval(s.id, "5", "docs: Allow docs to run search?", ["Allow", "Allow for this session", "Cancel"]),
      title: "Codex wants to use an MCP tool",
    })
    const f = await app.until((f) => f.includes("Allow for this session"))
    expect(f).toContain("Codex wants to use an MCP tool")
    expect(f).not.toContain("don't ask me again")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("every open Codex card shows above a prompt that stays; the first takes the keys", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const a = office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    office.addQuestion({
      ...approval(s.id, "2", "network", ["Approve for this turn", "Approve for this session", "Deny"]),
      title: "Codex asks for more permissions",
    })
    const f = await app.until((f) => f.includes("$ touch a") && f.includes("Codex asks for more permissions (waiting)"))
    expect(f).toContain("@minh · Software engineer") // the prompt is still there, under the cards
    // The card has the keys, so typing reaches neither the prompt nor the office as a message.
    await app.input.typeText("xyz")
    expect(await app.until(() => true)).not.toContain("xyz")
    app.input.pressKey("1")
    await app.until(() => office.state.questions[a.id].status !== "open")
    // The next card takes the keys.
    await app.until((f) => f.includes("Approve for this turn"))
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a secret typed into a Codex card shows nowhere, not in the prompt under it, and goes only to the answer", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const q = office.addQuestion(secret(s.id, "3"))
    await app.until((f) => f.includes("Paste the deploy token") && f.includes("@minh · Software engineer"))
    await app.input.typeText(SECRET)
    const f = await app.until((f) => f.includes("•".repeat(28)))
    expect(f).not.toContain("sentinel")
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status !== "open")
    expect(
      office.requests.filter((r) => JSON.stringify(r.body ?? null).includes("sentinel")).map((r) => r.path),
    ).toEqual([`/questions/${q.id}/answer`])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card that opens while the prompt holds a draft leaves the keys with the prompt", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    await app.input.typeText("draft")
    await app.until((f) => f.includes("draft"))
    const a = office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    // The card is one line, so a digit typed for the prompt stays text there and picks nothing.
    await app.until((f) => f.includes("Codex asks: Codex wants to run a command"))
    await app.input.typeText("1")
    await app.until((f) => f.includes("draft1"))
    expect(office.state.questions[a.id].status).toBe("open")
    expect(sent(office, `/questions/${a.id}/answer`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("ctrl+t moves to the prompt, where a message steers, leaves the cards open and never reaches a secret", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const q = office.addQuestion(secret(s.id, "3"))
    await app.until((f) => f.includes("Paste the deploy token"))
    app.input.pressKey("t", { ctrl: true })
    // On the prompt the card is one line, with the key back to it.
    await app.until((f) => f.includes("Codex asks: Token? · ctrl+t to answer") && !f.includes("Paste the deploy token"))
    await app.input.typeText("also add b")
    app.input.pressEnter()
    await app.until(() => sent(office, `/sessions/${s.id}/prompt`).length === 1)
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([{ text: "also add b" }])
    expect(office.state.questions[q.id].status).toBe("open")
    expect(sent(office, `/questions/${q.id}/answer`)).toEqual([])
    // Back on the card, the secret holds only what is typed there.
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("Paste the deploy token"))
    await app.input.typeText(SECRET)
    await app.until((f) => f.includes("•".repeat(28)) && !f.includes("•".repeat(29)))
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status !== "open")
    expect(sent(office, `/questions/${q.id}/answer`)).toEqual([{ answer: { Token: SECRET }, answer_kind: "text" }])
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([{ text: "also add b" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("from the prompt under an open card, Esc clears a draft, then interrupts the turn", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("ctrl+t to answer"))
    await app.input.typeText("draft")
    await app.until((f) => f.includes("draft"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("draft"))
    expect(sent(office, `/sessions/${s.id}/interrupt`)).toEqual([])
    app.input.pressEscape()
    await app.until(() => sent(office, `/sessions/${s.id}/interrupt`).length === 1, 2000)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a Codex card interrupts the turn instead of stopping an asker", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressEscape()
    await app.until(() => office.requests.some((r) => r.path === `/sessions/${s.id}/interrupt`))
    expect(office.requests.some((r) => r.path.endsWith("/stop"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc in a secret box with text clears it, and only then interrupts", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    office.addQuestion(secret(s.id, "3"))
    await app.until((f) => f.includes("Paste the deploy token"))
    await app.input.typeText("ab")
    await app.until((f) => f.includes("••"))
    app.input.pressEscape()
    await app.until((f) => f.includes("Type your answer here; it isn't shown"))
    // An interrupt would be on its way by now.
    await Bun.sleep(100)
    expect(sent(office, `/sessions/${s.id}/interrupt`)).toEqual([])
    app.input.pressEscape()
    await app.until(() => sent(office, `/sessions/${s.id}/interrupt`).length === 1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an answer Codex no longer waits for closes the card and says the answer wasn't used", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const a = office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    office.staleOnAnswer.add(a.id)
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("1")
    // The toast may wrap, so look for its two halves.
    await app.until(
      (f) => f.includes("Codex stopped waiting") && f.includes("answer wasn't used") && !f.includes("$ touch a"),
    )
    expect(office.state.questions[a.id].status).toBe("stale")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an answer Codex takes closes the card without a toast", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const a = office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("1")
    const f = await app.until((f) => !f.includes("$ touch a") && f.includes("@minh · Software engineer"))
    expect(office.state.questions[a.id].status).toBe("consumed")
    expect(f).not.toContain("Codex stopped waiting")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("keys typed into a dialog over a secret card never reach the secret", async () => {
  const { office, s } = codexOffice()
  // The session list on one key: its binding has no mode, so it opens over the card.
  const config = createTuiResolvedConfig({ keybinds: { session_list: "ctrl+l" } })
  const app = await bootFrame({ ...createStub(office), config }, { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const q = office.addQuestion(secret(s.id, "3"))
    await app.until((f) => f.includes("Paste the deploy token"))
    await app.input.typeText("ab")
    await app.until((f) => f.includes("••") && !f.includes("•••"))
    app.input.pressKey("l", { ctrl: true })
    await app.until((f) => f.includes("Sessions"))
    await app.input.typeText("zzz")
    expect(await app.until(() => true)).not.toContain("•••")
    app.input.pressEscape()
    await app.until((f) => !f.includes("Sessions") && f.includes("Paste the deploy token"))
    app.input.pressEnter()
    await app.until(() => office.state.questions[q.id].status !== "open")
    expect(sent(office, `/questions/${q.id}/answer`)).toEqual([{ answer: { Token: "ab" }, answer_kind: "text" }])
    // The Esc that closed the dialog didn't interrupt Codex.
    expect(sent(office, `/sessions/${s.id}/interrupt`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a Codex card freezes the transcript, as Esc in the prompt does", async () => {
  const { office, s } = codexOffice()
  const reply: Message = {
    id: office.nextId(),
    session_id: s.id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text: "Looking" }],
  }
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    office.live({ type: "message.updated", session_id: s.id, data: reply as never })
    office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    await app.until((f) => f.includes("Looking") && f.includes("$ touch a"))
    app.input.pressEscape()
    await app.until(() => sent(office, `/sessions/${s.id}/interrupt`).length === 1)
    // What Codex streams before it stops is hidden; its interrupted marker shows.
    const part = { ...reply.parts[0], text: "Looking at it" + INTERRUPTED_TEXT }
    office.live({ type: "part.updated", session_id: s.id, data: { message_id: reply.id, part } as never })
    await app.until((f) => f.includes("[interrupted]"))
    expect(app.frame()).not.toContain("at it")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a Codex card while no turn runs does nothing", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex", status: "idle" })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    office.addQuestion({ ...approval(s.id, "1", "docs: Allow docs to run search?", ["Allow", "Cancel"]), run_id: "codex-1" })
    const f = await app.until((f) => f.includes("docs: Allow docs to run search?"))
    expect(f).not.toContain("interrupt Codex")
    app.input.pressEscape()
    // An interrupt, or its failure, would be on its way by now.
    await Bun.sleep(200)
    expect(await app.until(() => true)).not.toContain("Interrupting failed")
    expect(sent(office, `/sessions/${s.id}/interrupt`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an answer that finds the card already stale says Codex stopped waiting, not that it was answered", async () => {
  const { office, s } = codexOffice()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · busy"))
    const a = office.addQuestion(approval(s.id, "1", "$ touch a", ["Approve", "Deny and stop"]))
    await app.until((f) => f.includes("$ touch a"))
    // The turn ends while the answer is on its way, so the office answers 409.
    const release = office.hold("POST /questions/:id/answer")
    app.input.pressKey("1")
    await app.until(() => sent(office, `/questions/${a.id}/answer`).length === 1)
    office.expire(a.id)
    release()
    const f = await app.until((f) => f.includes("Codex stopped waiting") && f.includes("answer wasn't used"))
    expect(f).not.toContain("already answered")
  } finally {
    await app.stop()
    office.stop()
  }
})
