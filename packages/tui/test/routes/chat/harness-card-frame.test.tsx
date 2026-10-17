import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

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
