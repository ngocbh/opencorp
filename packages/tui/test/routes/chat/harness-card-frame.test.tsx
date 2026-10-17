import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"

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
