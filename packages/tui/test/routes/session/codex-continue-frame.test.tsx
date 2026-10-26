import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

test("typing in an ended Codex session continues it in a new session on the same thread", async () => {
  const office = createFakeOffice()
  const old = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    status: "ended",
    harness_session_id: "thr_1",
  })
  const app = await bootFrame(createStub(office), { sessionID: old.id })
  try {
    await app.until((f) => f.includes("@minh") && f.includes("ended"))
    await app.input.typeText("pick up where we left off")
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.path === `/sessions/${old.id}/continue`), 3000)
    await until(() => office.state.sessions.some((s) => s.parent_session_id === old.id), 3000)
    const next = office.state.sessions.find((s) => s.parent_session_id === old.id)!
    expect(next.harness_session_id).toBe("thr_1")
    await until(() => office.requests.some((r) => r.path === `/sessions/${next.id}/prompt`), 3000)
    // The old session takes no message: the new one has it, and the view moved there.
    expect(office.requests.some((r) => r.path === `/sessions/${old.id}/prompt`)).toBe(false)
    await app.until((f) => f.includes("pick up where we left off") && !f.includes("ended"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a refused continue says so, with the office's reason, and keeps the message", async () => {
  const office = createFakeOffice()
  const codex = { person: "minh", cwd: "/tmp/proj", harness: "codex" as const, harness_session_id: "thr_1" }
  const old = office.newSession({ ...codex, status: "ended" })
  const holder = office.newSession({ ...codex, status: "idle", parent_session_id: old.id })
  const app = await bootFrame(createStub(office), { sessionID: old.id })
  try {
    await app.until((f) => f.includes("@minh") && f.includes("ended"))
    await app.input.typeText("pick up where we left off")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Couldn't continue this session"))
    // The toast wraps the office's reason, so its words and the holder's id are found apart.
    expect(f).toContain("this Codex thread is open in session")
    expect(f).toContain(holder.id)
    expect(f).toContain("pick up where we left off")
    expect(office.requests.some((r) => r.path.endsWith("/prompt"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})
