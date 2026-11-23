// The picker, ported from the upstream TUI's composer picker. ↓ at the end of a chat's prompt opens it in the prompt's
// place, on the first tab with something running: Sessions, the chat's Codex and Claude Code sessions (each its child
// session, marked Running, Idle or Ended), or Shell, its shells. ←/→ switch tabs, ↑/↓ move, Enter opens the row in the
// right pane, ↑ on the first row or Esc closes; ctrl+d interrupts a session or sends a shell Ctrl-C. Sessions lists the
// live sessions, running or idle, and Shell the shells that run; ctrl+a shows the rest. The line under the prompt
// counts the same, after ↓, and a click opens the picker on the first tab with something running. A child whose
// session ended has no prompt: the picker sits in its place, and Esc goes back to the chat or closes the pane. An idle
// or running child keeps its prompt, where the owner writes to the harness. Each session keeps its own unsent draft.
import type { Instrument, Session } from "@opencorp/protocol"
import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "../../../src/core/global"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const AT = "2026-11-20T10:00:00.000Z"
/** The line the view of an ended Codex session shows above its picker. */
const ENDED = "This Codex session ended. It takes no more messages."
/** What the chat's line under the prompt ends with, which shows only while the prompt does. */
const COMMANDS = "ctrl+p commands"

/** A child's listing status for its session's. */
const LISTED: Partial<Record<Session["status"], Instrument["status"]>> = {
  starting: "starting",
  busy: "running",
  waiting: "waiting",
  idle: "idle",
  ended: "ended",
  failed: "failed",
}

let n = 0
/** minh's chat, the sessions it drives (each its child session, listed as the chat's instrument), and its shells. */
function office(
  children: { harness?: "codex" | "claude"; status: Session["status"] }[] = [],
  shells: Partial<Instrument>[] = [],
) {
  const fake = createFakeOffice()
  const chat = fake.state.sessions[0]!
  const count = { codex: 0, claude: 0 }
  const kids = children.map(({ harness = "codex", status }, i) => {
    const said = harness === "codex" ? "Codex" : "Claude Code"
    const index = ++count[harness]
    const child = fake.newSession({
      person: "minh",
      cwd: chat.cwd,
      harness,
      kind: "instrument",
      instrument_of: chat.id,
      status,
      created_at: `2026-11-20T10:0${i}:00.000Z`,
    })
    fake.addInstrument(chat.id, {
      id: child.id, session_id: chat.id, kind: harness, name: `${harness} ${index}`, driver: "minh", profile: "harness",
      interactive: false, status: LISTED[status] ?? "ended", created_at: AT, updated_at: AT,
    })
    fake.state.messages[child.id] = [
      { id: `m${child.id}`, session_id: child.id, role: "assistant", author: null,
        parts: [{ id: `p${child.id}`, type: "text", text: `${said} ${index} says hello.` }], created_at: AT },
    ]
    return child
  })
  const terms = shells.map((fields, i) =>
    fake.addInstrument(chat.id, {
      id: `01JA1M000000000000000000${String(++n).padStart(2, "0")}`, session_id: chat.id, kind: "terminal",
      name: `shell ${i + 1}`, driver: "minh", profile: "workspace", interactive: true, size: { cols: 80, rows: 24 },
      status: "running", command: `make step${i + 1}`, created_at: AT, updated_at: AT, ...fields,
    }),
  )
  return { fake, chat, children: kids, shells: terms }
}

async function boot(fake: FakeOffice, sessionID: string) {
  return bootFrame(createStub(fake), { sessionID }, { width: 120, height: 30 })
}

/** Presses `key` (an arrow by name), giving the renderer a frame first. */
async function press(app: App, key: "up" | "down" | "left" | "right") {
  await app.setup.renderOnce()
  app.input.pressArrow(key)
}

/** Presses Esc alone: what comes next waits until the parser has taken it as Esc, not as Alt with that key. */
async function escape(app: App) {
  app.input.pressEscape()
  await Bun.sleep(100)
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

/** Makes `texts`, oldest first, the whole prompt history the next TUI reads. The app keeps it under the preload's
 *  OPENCORP_HOME, which every test file shares, and an earlier test's app may still be adding a text it sent: it is
 *  written again until it holds only these. */
async function seedHistory(...texts: string[]) {
  const file = path.join(Global.Path.state, "prompt-history.jsonl")
  const content = texts.map((text) => JSON.stringify(text) + "\n").join("")
  mkdirSync(Global.Path.state, { recursive: true })
  for (let i = 0; i < 20; i++) {
    writeFileSync(file, content)
    await Bun.sleep(50)
    if (readFileSync(file, "utf8") === content) return
  }
  throw new Error("the prompt history kept changing")
}

/** The right pane's rows, inside its box, their trailing blanks cut; empty when no pane shows. */
function pane(f: string) {
  const rows = f.split("\n")
  const y = rows.findIndex((r) => r.includes("┌"))
  if (y < 0) return ""
  const x = rows[y]!.indexOf("┌")
  return rows
    .slice(y + 1)
    .map((r) => r.slice(x + 1).replace(/[│┘└─]*\s*$/, "").trimEnd())
    .join("\n")
}
/** The chat's side of `f`: each row up to the pane, or whole when no pane shows. */
function chatSide(f: string) {
  const rows = f.split("\n")
  const x = rows.find((r) => r.includes("┌"))?.indexOf("┌") ?? Infinity
  return rows.map((r) => r.slice(0, x)).join("\n")
}

/** The row of `f` holding `text`, its trailing blanks cut. */
const row = (f: string, text: string) => f.split("\n").find((r) => r.includes(text))?.trimEnd() ?? ""

const prompts = (fake: FakeOffice, id: string) =>
  fake.requests.filter((r) => r.method === "POST" && r.path === `/sessions/${id}/prompt`)

test("↓ at the end of the chat's prompt opens the picker on Sessions; ↓ moves, and Enter opens the session in the pane, where the owner writes", async () => {
  const { fake, chat, children } = office([{ status: "busy" }, { status: "busy" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 2 Codex sessions"))
    await press(app, "down")
    let f = await app.until((f) => f.includes("Codex: codex 1") && f.includes("Codex: codex 2"))
    // In the prompt's place: its line under it is gone.
    expect(f).not.toContain(COMMANDS)
    expect(row(f, "Sessions")).toMatch(/Sessions {2}Shell +esc$/)
    expect(row(f, "Codex: codex 1")).toMatch(/Codex: codex 1 +Running$/)
    expect(f).toContain("interrupt ctrl+d")
    expect(f).toContain("show inactive ctrl+a")
    expect(f).toContain("tabs ←/→")
    await press(app, "down")
    await app.setup.renderOnce()
    app.input.pressEnter()
    f = await app.until((f) => pane(f).includes("Codex 2 says hello."))
    expect(pane(f)).toContain("@minh is driving · codex 2 · running")
    // The picker closed, and the child has its prompt beside the chat.
    expect(f).not.toContain("Codex: codex 1")
    expect(chatSide(f)).toContain("@minh auto ·")
    app.input.typeText("Use the staging database.")
    app.input.pressEnter()
    await until(() => prompts(fake, children[1]!.id).length === 1, 3000)
    expect(prompts(fake, children[0]!.id)).toEqual([])
    expect(prompts(fake, chat.id)).toEqual([])
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("↑ on the first row and Esc close the picker back to the prompt, with its draft", async () => {
  const { fake, chat } = office([{ status: "busy" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Codex session"))
    app.input.typeText("half a thought")
    await app.until((f) => f.includes("half a thought"))
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1") && !f.includes("half a thought"))
    await escape(app)
    await app.until((f) => f.includes("half a thought") && f.includes(COMMANDS) && !f.includes("Codex: codex 1"))
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1"))
    await press(app, "up")
    await app.until((f) => f.includes("half a thought") && !f.includes("Codex: codex 1"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("with the shell running and the Codex session ended, ↓ opens Shell; the ended session shows under ctrl+a and opens read-only in the pane", async () => {
  const { fake, chat, children } = office([{ status: "ended" }], [{ status: "running" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 shell"))
    expect(app.frame()).not.toContain("Codex session")
    await press(app, "down")
    let f = await app.until((f) => f.includes("shell 1 · make step1"))
    expect(row(f, "shell 1 · make step1")).toMatch(/Running$/)
    expect(f).not.toContain("Codex: codex 1")
    // ← to Sessions: nothing runs there.
    await press(app, "left")
    f = await app.until((f) => f.includes("No active sessions"))
    app.input.pressKey("a", { ctrl: true })
    f = await app.until((f) => f.includes("Codex: codex 1"))
    expect(row(f, "Codex: codex 1")).toMatch(/Codex: codex 1 +Ended$/)
    expect(f).toContain("show active ctrl+a")
    expect(f).not.toContain("interrupt ctrl+d")
    await app.setup.renderOnce()
    app.input.pressEnter()
    f = await app.until((f) => pane(f).includes("Codex 1 says hello.") && pane(f).includes(ENDED))
    // No prompt to write in: the picker in its place, on its own row.
    expect(pane(f)).not.toContain("╹▀")
    expect(row(pane(f), "Codex: codex 1")).toMatch(/Ended$/)
    app.input.typeText("hello?")
    app.input.pressEnter()
    // Esc closes the pane, back to the chat.
    await escape(app)
    await app.until((f) => f.includes("@minh auto ·") && f.includes(COMMANDS) && !f.includes(ENDED))
    expect(prompts(fake, children[0]!.id)).toEqual([])
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("Sessions lists the live sessions, running or idle, and ctrl+a only the ended ones; only a running row can be interrupted", async () => {
  const { fake, chat } = office([{ status: "busy" }, { harness: "claude", status: "idle" }, { status: "ended" }])
  const app = await boot(fake, chat.id)
  try {
    // The line under the prompt counts the same sessions.
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Codex session · 1 Claude Code session"))
    await press(app, "down")
    let f = await app.until((f) => f.includes("Codex: codex 1") && f.includes("Claude Code: claude 1"))
    expect(row(f, "Codex: codex 1")).toMatch(/Codex: codex 1 +Running$/)
    expect(row(f, "Claude Code: claude 1")).toMatch(/Claude Code: claude 1 +Idle$/)
    expect(f).not.toContain("Codex: codex 2")
    expect(f).toContain("interrupt ctrl+d")
    expect(f).toContain("show inactive ctrl+a")
    // The idle row takes messages but has no turn to interrupt.
    await press(app, "down")
    f = await app.until((f) => !f.includes("interrupt ctrl+d") && f.includes("show inactive ctrl+a"))
    expect(f).toContain("Claude Code: claude 1")
    app.input.pressKey("a", { ctrl: true })
    f = await app.until((f) => f.includes("Codex: codex 2"))
    expect(row(f, "Codex: codex 2")).toMatch(/Codex: codex 2 +Ended$/)
    expect(f).not.toContain("Codex: codex 1")
    expect(f).not.toContain("Claude Code: claude 1")
    expect(f).toContain("show active ctrl+a")
    expect(f).not.toContain("interrupt ctrl+d")
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("an ended child opened by its id has no prompt; ↑ on its row goes back to the chat", async () => {
  const { fake, chat, children } = office([{ status: "ended" }, { status: "busy" }])
  const app = await boot(fake, children[0]!.id)
  try {
    // Its name comes from the chat's list, loaded with it.
    let f = await app.until((f) => f.includes(ENDED) && f.includes("codex 1 · driven by @minh"))
    expect(f).toContain("Codex 1 says hello.")
    expect(f).not.toContain(COMMANDS)
    // Its own row, then the sessions that run.
    expect(row(f, "Codex: codex 1")).toMatch(/Ended$/)
    expect(row(f, "Codex: codex 2")).toMatch(/Running$/)
    expect(f.indexOf("Codex: codex 1")).toBeLessThan(f.indexOf("Codex: codex 2"))
    await press(app, "up")
    f = await app.until((f) => f.includes("@minh auto ·") && f.includes(COMMANDS))
    expect(f).not.toContain(ENDED)
    expect(app.frame()).toContain(chat.cwd)
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("an idle child keeps its prompt in the pane, where the owner's message resumes it; ↓ opens its picker and Esc closes it", async () => {
  const { fake, chat, children } = office([{ status: "idle" }])
  const app = await boot(fake, chat.id)
  try {
    // It is live: the line under the prompt counts it, so the owner knows it is there.
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Codex session"))
    await press(app, "down")
    // The picker lists it as it opens.
    let f = await app.until((f) => f.includes("Codex: codex 1"))
    expect(row(f, "Codex: codex 1")).toMatch(/Idle$/)
    expect(f).not.toContain("interrupt ctrl+d")
    await app.setup.renderOnce()
    app.input.pressEnter()
    f = await app.until((f) => pane(f).includes("Codex 1 says hello.") && pane(f).includes("╹▀"))
    expect(f).not.toContain(ENDED)
    await press(app, "down")
    // The pane's picker lists it too, its own row.
    f = await app.until((f) => pane(f).includes("Codex: codex 1") && !pane(f).includes("╹▀"))
    expect(row(pane(f), "Codex: codex 1")).toMatch(/Idle$/)
    await escape(app)
    await app.until((f) => pane(f).includes("╹▀") && !f.includes("Codex: codex 1"))
    app.input.typeText("Carry on.")
    app.input.pressEnter()
    await until(() => prompts(fake, children[0]!.id).length === 1, 3000)
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("in a live child, ↑ on the empty prompt shows the one text sent, and the next ↑ goes back to the chat", async () => {
  await seedHistory("the only text sent")
  const { fake, children } = office([{ status: "busy" }])
  const app = await boot(fake, children[0]!.id)
  try {
    await app.until((f) => f.includes("Codex 1 says hello.") && f.includes(COMMANDS))
    await press(app, "up")
    await app.until((f) => f.includes("the only text sent") && f.includes("driven by @minh"))
    await press(app, "up")
    await app.until((f) => f.includes("@minh auto ·") && !f.includes("driven by @minh"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("in a live child, ↑ from a typed draft walks back through the history, ↓ brings the draft back, and ↑ past the oldest goes to the chat", async () => {
  await seedHistory("first sent", "second sent")
  const { fake, children } = office([{ status: "busy" }])
  const app = await boot(fake, children[0]!.id)
  /** Presses `key`, then waits for the prompt to show `text` and not `gone`, still in the child. */
  const step = async (key: "up" | "down", text: string, gone: string) => {
    await press(app, key)
    await app.until((f) => f.includes(text) && !f.includes(gone) && f.includes("driven by @minh"))
  }
  try {
    await app.until((f) => f.includes("Codex 1 says hello.") && f.includes(COMMANDS))
    app.input.typeText("my draft")
    await app.until((f) => f.includes("my draft"))
    // The first ↑ takes the cursor to the start; the next shows the newest text sent, then the one before.
    await press(app, "up")
    await step("up", "second sent", "my draft")
    await step("up", "first sent", "second sent")
    // ↓ takes the cursor to the end, then walks forward, each text shown with the cursor at its end, back to the draft.
    await press(app, "down")
    await step("down", "second sent", "first sent")
    await step("down", "my draft", "second sent")
    // Past the oldest text, ↑ goes to the chat.
    await press(app, "up")
    await step("up", "second sent", "my draft")
    await step("up", "first sent", "second sent")
    await press(app, "up")
    await app.until((f) => f.includes("@minh auto ·") && !f.includes("driven by @minh"))
    expect(prompts(fake, children[0]!.id)).toEqual([])
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a message to a child that ends while it goes out says it failed, and the child turns read-only", async () => {
  const { fake, chat, children } = office([{ status: "busy" }])
  const child = children[0]!
  const app = await boot(fake, child.id)
  try {
    await app.until((f) => f.includes("Codex 1 says hello.") && f.includes(COMMANDS))
    const release = fake.hold("POST /sessions/:id/prompt")
    app.input.typeText("One more thing.")
    app.input.pressEnter()
    await until(() => prompts(fake, child.id).length === 1, 3000)
    // The session ends while the message is on its way: the office refuses it, 409 not_live.
    fake.setStatus(child.id, "ended")
    const listing = fake.state.instruments[chat.id]!.find((i) => i.id === child.id)!
    fake.addInstrument(chat.id, { ...listing, status: "ended" })
    await app.until((f) => f.includes(ENDED))
    release()
    const f = await app.until((f) => f.includes("Failed to send prompt"))
    expect(f).toContain("has no live run")
    expect(f).toContain(ENDED)
    expect(f).not.toContain(COMMANDS)
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("the line under the prompt counts after ↓, and a click opens the picker on the first tab with something running", async () => {
  const { fake, chat, children } = office([{ status: "idle" }], [{ status: "running" }])
  const app = await boot(fake, chat.id)
  try {
    let f = await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 shell · 1 Codex session"))
    expect(row(f, "↓ 1 shell")).toMatch(/\/tmp\/proj · ↓ 1 shell · 1 Codex session {2,}shift\+tab mode/)
    // Only the shell runs: the click opens Shell.
    const click = async (text: string) => {
      const rows = app.frame().split("\n")
      const y = rows.findIndex((r) => r.includes(text))
      await app.setup.mockMouse.click(rows[y]!.indexOf(text) + 2, y)
    }
    await click("↓ 1 shell")
    await app.until((f) => f.includes("shell 1 · make step1") && !f.includes(COMMANDS))
    await escape(app)
    await app.until((f) => f.includes(COMMANDS))
    // The Codex session runs: Sessions comes first.
    fake.setStatus(children[0]!.id, "busy")
    fake.addInstrument(chat.id, { ...fake.state.instruments[chat.id]!.find((i) => i.id === children[0]!.id)!, status: "running" })
    await app.until((f) => f.includes(COMMANDS))
    await click("↓ 1 shell")
    await app.until((f) => f.includes("Codex: codex 1") && f.includes("interrupt ctrl+d"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("the line under the prompt counts the live Codex and Claude Code sessions, running or idle, never an ended one", async () => {
  const { fake, chat, children } = office([
    { status: "busy" },
    { status: "idle" },
    { status: "ended" },
    { harness: "claude", status: "idle" },
  ])
  /** Sets child `i`'s session, and its listing in the chat, to `status`. */
  const set = (i: number, status: Session["status"]) => {
    const id = children[i]!.id
    fake.setStatus(id, status)
    const listing = fake.state.instruments[chat.id]!.find((x) => x.id === id)!
    fake.addInstrument(chat.id, { ...listing, status: LISTED[status] ?? "ended" })
  }
  const app = await boot(fake, chat.id)
  try {
    // codex 1 runs and codex 2 is idle, so both count; codex 3 ended. The owner's case: claude 1, idle, counts.
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 2 Codex sessions · 1 Claude Code session"))
    // An idle session that ends leaves the count.
    set(1, "ended")
    await app.until((f) => f.includes("↓ 1 Codex session · 1 Claude Code session"))
    // So does a running one.
    set(0, "ended")
    await app.until((f) => f.includes("↓ 1 Claude Code session") && !f.includes("Codex session"))
    set(3, "ended")
    await app.until((f) => f.includes(COMMANDS) && !f.includes("↓"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("ctrl+d interrupts a running session, and sends a running shell Ctrl-C; Enter opens a shell in the pane", async () => {
  const { fake, chat, children, shells } = office([{ status: "busy" }], [{ status: "running" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 shell · 1 Codex session"))
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1") && f.includes("interrupt ctrl+d"))
    app.input.pressKey("d", { ctrl: true })
    await until(() => fake.requests.some((r) => r.path === `/sessions/${children[0]!.id}/interrupt`), 3000)
    // The app is still up: ctrl+d didn't reach its exit.
    await press(app, "right")
    await app.until((f) => f.includes("shell 1 · make step1") && f.includes("interrupt ctrl+d"))
    app.input.pressKey("d", { ctrl: true })
    const keys = () =>
      fake.requests
        .filter((r) => r.path === `/sessions/${chat.id}/instruments/${shells[0]!.id}/keys`)
        .map((r) => (r.body as { data: string }).data)
    await until(() => keys().length === 1, 3000)
    expect(keys()).toEqual(["\x03"])
    await app.setup.renderOnce()
    app.input.pressEnter()
    const f = await app.until((f) => pane(f).includes("@minh is driving · shell 1 · running · make step1"))
    expect(pane(f)).toContain("ctrl+x o full screen")
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("each session keeps its own draft: the chat's unsent text never reaches a Codex session's prompt", async () => {
  const { fake, chat, children } = office([{ status: "busy" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Codex session"))
    app.input.typeText("for the chat only")
    await app.until((f) => f.includes("for the chat only"))
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1"))
    await app.setup.renderOnce()
    app.input.pressEnter()
    // Both prompts show at once, each with its own text.
    let f = await app.until((f) => pane(f).includes("Codex 1 says hello.") && pane(f).includes("╹▀"))
    expect(pane(f)).not.toContain("for the chat only")
    expect(chatSide(f)).toContain("for the chat only")
    app.input.typeText("for codex")
    f = await app.until((f) => pane(f).includes("for codex"))
    expect(chatSide(f)).not.toContain("for codex")
    // ctrl+x ↑ closes the pane: the chat keeps its draft.
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressArrow("up")
    f = await app.until((f) => !f.includes("┌") && f.includes("for the chat only"))
    expect(f).not.toContain("for codex")
    // Opened again, the Codex session has its own draft; Enter sends it there, and nothing went to the chat.
    await app.setup.renderOnce()
    app.input.pressKey("e", { ctrl: true })
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1"))
    await app.setup.renderOnce()
    app.input.pressEnter()
    f = await app.until((f) => pane(f).includes("Codex 1 says hello.") && pane(f).includes("for codex"))
    expect(pane(f)).not.toContain("for the chat only")
    app.input.pressEnter()
    await until(() => prompts(fake, children[0]!.id).length === 1, 3000)
    expect(prompts(fake, children[0]!.id)[0]!.body).toEqual({ text: "for codex" })
    expect(prompts(fake, chat.id)).toEqual([])
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("in a Codex session the chat drives, each message says who sent it, and the prompt says the owner writes as themselves", async () => {
  const { fake, chat, children } = office([{ status: "busy" }])
  const child = children[0]!
  fake.state.messages[child.id] = [
    { id: "u1", session_id: child.id, role: "user", author: "minh",
      parts: [{ id: "u1p", type: "text", text: "Fix the build." }], created_at: AT },
    { id: "u2", session_id: child.id, role: "user", author: "ngocbh",
      parts: [{ id: "u2p", type: "text", text: "Use the staging database." }], created_at: AT },
    { id: "a1", session_id: child.id, role: "assistant", author: null,
      parts: [{ id: "a1p", type: "text", text: "Using staging." }], created_at: AT },
  ]
  const app = await bootFrame(createStub(fake), { sessionID: chat.id }, { width: 120, height: 40 })
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Codex session"))
    // The chat itself has one speaker to the employee: its messages carry no label.
    expect(app.frame()).not.toContain("(owner)")
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 1"))
    await app.setup.renderOnce()
    app.input.pressEnter()
    // The running turn's last message is the owner's: the owner is at the controls.
    const f = await app.until((f) => pane(f).includes("Using staging.") && pane(f).includes("you are driving · codex 1"))
    const lines = pane(f).split("\n")
    const at = (text: string) => lines.findIndex((line) => line.includes(text))
    // Each message's sender is on the line above it.
    expect(lines[at("Fix the build.") - 1]).toMatch(/┃\s+@minh\s*$/)
    expect(lines[at("Use the staging database.") - 1]).toMatch(/┃\s+Ngoc Bui \(owner\)\s*$/)
    // The line under the prompt names who answers, the session on Codex, and that the owner writes as themselves.
    expect(pane(f)).toContain("codex 1 Codex · as @ngocbh")
    expect(pane(f)).not.toMatch(/@ngocbh · CEO|@minh · Software engineer/)
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a Claude Code session opens from the picker in the pane, where the owner writes with no mode to switch", async () => {
  const { fake, chat, children } = office([{ harness: "claude", status: "busy" }])
  const app = await boot(fake, chat.id)
  try {
    await app.until((f) => f.includes("@minh auto ·") && f.includes("↓ 1 Claude Code session"))
    await runCommand(app, "Open an instrument")
    let f = await app.until((f) => f.includes("Claude Code: claude 1"))
    expect(row(f, "Claude Code: claude 1")).toMatch(/Running$/)
    await app.setup.renderOnce()
    app.input.pressEnter()
    f = await app.until((f) => pane(f).includes("Claude Code 1 says hello.") && pane(f).includes("╹▀"))
    expect(pane(f)).toContain("@minh is driving · claude 1 · running")
    // Claude Code runs under the employee's permission and asks nothing: no mode label, and no Shift+Tab hint.
    expect(pane(f)).not.toContain(" auto ")
    expect(pane(f)).not.toContain("shift+tab")
    app.input.typeText("Use the staging database.")
    app.input.pressEnter()
    await until(() => prompts(fake, children[0]!.id).length === 1, 3000)
    // From the pane, "Go back to the chat" gives the chat the keys, the pane staying open.
    await runCommand(app, "Go back to the chat")
    await app.until((f) => pane(f).includes("ctrl+x → focus pane"))
    app.input.typeText("hello chat")
    await app.until((f) => chatSide(f).includes("hello chat"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a chat with nothing to pick shows no count, and ↓ opens an empty picker", async () => {
  const { fake, chat } = office()
  const app = await boot(fake, chat.id)
  try {
    const f = await app.until((f) => f.includes("@minh auto ·") && f.includes(COMMANDS))
    expect(f).not.toContain("↓")
    await press(app, "down")
    await app.until((f) => f.includes("No active sessions") && !f.includes(COMMANDS))
    await press(app, "right")
    await app.until((f) => f.includes("No active shells"))
    await escape(app)
    await app.until((f) => f.includes(COMMANDS))
  } finally {
    await app.stop()
    fake.stop()
  }
})
