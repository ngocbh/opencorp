// A Codex session an employee's chat drives is the chat's child session. From the chat, "Open an instrument…" or
// <leader>down opens it as a chat of its own, where the owner reads and writes to Codex; above its prompt, the upstream
// TUI's subagent footer says which of the chat's Codex sessions it is and who drives it, and its Parent, Prev and Next
// (<leader>up, and each a button) move back to the chat and between its Codex sessions.
import type { Instrument, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

const AT = "2026-11-20T10:00:00.000Z"

/** minh's chat, and `n` sessions of `harness` it drives, each its child session listed as the chat's instrument. */
function office(n = 1, harness: "codex" | "claude" = "codex"): { office: FakeOffice; chat: Session; children: Session[] } {
  const said = harness === "codex" ? "Codex" : "Claude Code"
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const children = Array.from({ length: n }, (_, i) => {
    const child = office.newSession({
      person: "minh",
      cwd: chat.cwd,
      harness,
      kind: "instrument",
      instrument_of: chat.id,
      status: "idle",
      created_at: `2026-11-20T10:0${i}:00.000Z`,
    })
    const listing: Instrument = {
      id: child.id, session_id: chat.id, kind: harness, name: `${harness} ${i + 1}`, driver: "minh", profile: "harness",
      interactive: false, status: "idle", created_at: AT, updated_at: AT,
    }
    office.addInstrument(chat.id, listing)
    office.state.messages[child.id] = [
      { id: `m${i}`, session_id: child.id, role: "assistant", author: null,
        parts: [{ id: `p${i}`, type: "text", text: `${said} ${i + 1} says hello.` }], created_at: AT },
    ]
    return child
  })
  return { office, chat, children }
}

/** Presses the leader, then the arrow `direction`. */
async function leaderArrow(app: App, direction: "up" | "down") {
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  app.input.pressArrow(direction)
}

/** Opens the palette and picks the command titled `title`. */
async function runCommand(app: App, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

test("a Codex session the chat drives opens from the instrument list as its own chat, with the footer back to it", async () => {
  const { office: fake, chat, children } = office()
  const app = await bootFrame(createStub(fake), { sessionID: chat.id }, { width: 120, height: 30 })
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("1 Codex session"))
    await runCommand(app, "Open an instrument")
    await app.until((f) => f.includes("Open an instrument") && f.includes("codex 1"))
    await Bun.sleep(50)
    app.input.typeText("codex 1")
    await app.until((f) => f.split("codex 1").length > 1)
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Codex 1 says hello."))
    expect(f).toContain("codex 1")
    expect(f).toContain("(1 of 1)")
    expect(f).toContain("driven by @minh")
    expect(f).toContain("Parent ctrl+x up")
    // The owner writes to Codex in it.
    app.input.typeText("Use the staging database.")
    app.input.pressEnter()
    await until(() => fake.requests.some((r) => r.path === `/sessions/${children[0]!.id}/prompt`), 3000)
    // <leader>up goes back to the chat.
    await leaderArrow(app, "up")
    await app.until((f) => f.includes("@minh auto ·") && !f.includes("driven by @minh"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("<leader>down opens the chat's first Codex session, and Next and Prev move round them", async () => {
  const { office: fake, chat } = office(2)
  const app = await bootFrame(createStub(fake), { sessionID: chat.id }, { width: 120, height: 30 })
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("2 Codex sessions"))
    await leaderArrow(app, "down")
    await app.until((f) => f.includes("Codex 1 says hello.") && f.includes("(1 of 2)"))
    await runCommand(app, "Next Codex or Claude Code session")
    await app.until((f) => f.includes("Codex 2 says hello.") && f.includes("(2 of 2)"))
    await runCommand(app, "Next Codex or Claude Code session")
    await app.until((f) => f.includes("Codex 1 says hello.") && f.includes("(1 of 2)"))
    await runCommand(app, "Previous Codex or Claude Code session")
    await app.until((f) => f.includes("Codex 2 says hello.") && f.includes("codex 2"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a chat with no Codex session shows no footer, and <leader>down does nothing", async () => {
  const fake = createFakeOffice()
  const chat = fake.state.sessions[0]!
  const app = await bootFrame(createStub(fake), { sessionID: chat.id }, { width: 120, height: 30 })
  try {
    await app.until((f) => f.includes("@minh auto ·"))
    await leaderArrow(app, "down")
    await Bun.sleep(100)
    const f = await app.until((f) => f.includes("@minh auto ·"))
    expect(f).not.toContain("driven by")
    expect(f).not.toContain("Parent")
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a Claude Code session the chat drives opens with <leader>down as its own chat, where the owner writes to it with no mode to switch", async () => {
  const { office: fake, chat, children } = office(1, "claude")
  const app = await bootFrame(createStub(fake), { sessionID: chat.id }, { width: 120, height: 30 })
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("1 Claude Code session"))
    await leaderArrow(app, "down")
    const f = await app.until((f) => f.includes("Claude Code 1 says hello."))
    expect(f).toContain("claude 1")
    expect(f).toContain("(1 of 1)")
    expect(f).toContain("driven by @minh")
    // Claude Code runs under the employee's permission and asks nothing: no mode label, and no Shift+Tab hint.
    expect(f).not.toContain("@minh auto")
    expect(f).not.toContain("shift+tab mode")
    app.input.typeText("Use the staging database.")
    app.input.pressEnter()
    await until(() => fake.requests.some((r) => r.path === `/sessions/${children[0]!.id}/prompt`), 3000)
    await leaderArrow(app, "up")
    await app.until((f) => f.includes("@minh auto ·") && !f.includes("driven by @minh"))
  } finally {
    await app.stop()
    fake.stop()
  }
})
