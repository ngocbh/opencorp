// The right pane beside the chat, the upstream TUI's split pane: Enter on a picker row opens a shell or a Codex or
// Claude Code session there, split by default. The divider drags its width, which a double click puts back to half and
// one setting on disk keeps for every pane; it keeps 24 columns and leaves the chat 44. Below 108 columns it is full
// screen. ctrl+x ←/→ move the keys between the chat and the pane, a click in either side focuses it, ctrl+x ↑ closes
// it, and ctrl+x f shows it full screen or split. Unlike upstream's, it sits in a box in its driver's colour, bright
// with the keys and dim without; its header says who drives it.
import type { Instrument, Message, Session } from "@opencorp/protocol"
import type { CapturedLine, RGBA } from "@opentui/core"
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "../../../src/core/global"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme, tint } from "../../../src/theme"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
// Each person's colour, by their place in the office's list: minh, the employee, then ngocbh, the owner.
const MINH = theme.secondary
const OWNER = theme.accent
const dim = (color: RGBA) => tint(theme.background, color, 0.4)
const AT = "2026-11-22T10:00:00.000Z"

// The app keeps kv.json under the preload's OPENCORP_HOME, which every test file shares.
const kvFile = () => path.join(Global.Path.state, "kv.json")
const kv = (): Record<string, unknown> => (existsSync(kvFile()) ? JSON.parse(readFileSync(kvFile(), "utf8")) : {})
/** Drops the pane's width and full-screen choice from kv.json. */
function resetPane() {
  const { pane_width: _w, pane_fullscreen: _f, ...rest } = kv()
  mkdirSync(Global.Path.state, { recursive: true })
  writeFileSync(kvFile(), JSON.stringify(rest))
}
// Each test starts with no width dragged and split chosen, and leaves none for later test files.
beforeEach(resetPane)
afterEach(resetPane)

let n = 0
/** Adds a shell to session `sid`, as its host does: a running PTY shell at 80x24 unless `fields` say otherwise. */
function shell(office: FakeOffice, sid: string, fields: Partial<Instrument> = {}) {
  return office.addInstrument(sid, {
    id: `01JA1P000000000000000000${String(++n).padStart(2, "0")}`,
    session_id: sid,
    kind: "terminal",
    name: "shell 1",
    driver: "minh",
    profile: "workspace",
    interactive: true,
    size: { cols: 80, rows: 24 },
    status: "running",
    command: "make test",
    created_at: AT,
    updated_at: AT,
    ...fields,
  })
}

/** Adds a Codex session minh's chat `chat` drives, its child session, listed as the chat's instrument `name`. */
function codex(office: FakeOffice, chat: string, status: Session["status"], name = "codex 1") {
  const child = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    kind: "instrument",
    instrument_of: chat,
    status,
  })
  office.addInstrument(chat, {
    id: child.id,
    session_id: chat,
    kind: "codex",
    name,
    driver: "minh",
    profile: "harness",
    interactive: false,
    status: status === "busy" ? "running" : status === "ended" ? "ended" : "idle",
    created_at: AT,
    updated_at: AT,
  })
  office.state.messages[child.id] = [
    {
      id: office.nextId(),
      session_id: child.id,
      role: "user",
      author: "minh",
      parts: [{ id: `pu${child.id}`, type: "text", text: "Fix the parser." }],
      created_at: AT,
    },
    {
      id: office.nextId(),
      session_id: child.id,
      role: "assistant",
      author: null,
      parts: [{ id: `pa${child.id}`, type: "text", text: "Codex says hello." }],
      created_at: AT,
    },
  ]
  return child
}

/** Boots session `sid` of `office`, its first unless given, on a `width`x30 screen (120 is the widest without the
 *  sidebar), and waits for `ready`, a chat's prompt unless given. */
async function boot(
  office = createFakeOffice(),
  width = 120,
  sid = office.state.sessions[0]!.id,
  ready = "@minh auto ·",
) {
  const app = await bootFrame(createStub(office), { sessionID: sid }, { width, height: 30 })
  await app.until((f) => f.includes(ready))
  return { office, sid, app }
}

/** Presses `key` (an arrow by name), giving the renderer a frame first. */
async function press(app: App, key: "up" | "down" | "left" | "right") {
  await app.setup.renderOnce()
  app.input.pressArrow(key)
}

/** Presses the leader, then `key`: an arrow by name, or a letter. */
async function leader(app: App, key: string) {
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  if (["up", "down", "left", "right"].includes(key)) app.input.pressArrow(key as "up")
  else app.input.pressKey(key)
}

/** Presses Esc alone: what comes next waits until the parser has taken it as Esc, not as Alt with that key. */
async function escape(app: App) {
  app.input.pressEscape()
  await Bun.sleep(100)
}

/** Opens the picker with ↓ on the first tab with something running, and its first row with Enter. */
async function openFirst(app: App) {
  await press(app, "down")
  await app.until((f) => f.includes("esc") && (f.includes("Shell") || f.includes("Sessions")))
  await app.setup.renderOnce()
  app.input.pressEnter()
  return app.until((f) => corner(f) !== undefined)
}

const rows = (f: string) => f.split("\n")
/** The pane box's top-left corner, or undefined when no pane shows. */
function corner(f: string) {
  const y = rows(f).findIndex((r) => r.includes("┌"))
  return y < 0 ? undefined : { x: rows(f)[y]!.indexOf("┌"), y }
}
/** The pane's header: the row under its top edge, inside the box, trimmed. */
function header(f: string) {
  const at = corner(f)
  if (!at) throw new Error("no pane open:\n" + f)
  return rows(f)[at.y + 1]!.slice(at.x + 1).replace(/│\s*$/, "").trim()
}
const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
/** The colour of the pane box's top-left corner. */
function boxColor(app: App) {
  for (const line of app.setup.captureSpans().lines) {
    const span = line.spans.find((s) => s.text.includes("┌"))
    if (span) return span.fg
  }
}
/** The foreground of the first span holding `needle`. */
function fg(app: App, needle: string) {
  return app.setup
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .find((s) => s.text.includes(needle))?.fg
}
/** The foreground of the last span holding `needle` on the pane's header row, the chat's header sharing it. */
function headerFg(app: App, needle: string) {
  const line = app.setup.captureSpans().lines.find((l) => / (is|are) driving/.test(text(l)))
  return line?.spans.findLast((s) => s.text.includes(needle))?.fg
}
/** The colour of the left border of the message whose speaker line holds `speaker`. */
function borderOf(app: App, speaker: string) {
  const line = app.setup.captureSpans().lines.find((l) => text(l).includes(speaker) && text(l).includes("┃"))
  return line?.spans.find((s) => s.text.includes("┃"))?.fg
}
/** The keys the TUI sent instrument `id`, joined. */
const typed = (office: FakeOffice, id: string) =>
  office.requests
    .filter((r) => r.method === "POST" && r.path.endsWith(`/instruments/${id}/keys`))
    .map((r) => (r.body as { data: string }).data)
    .join("")

test("Enter on the picker's Shell row opens the shell beside the chat, split, with the keys, in a box in the employee's colour", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    let f = await openFirst(app)
    // Half the screen, beside the chat, whose header still shows.
    expect(corner(f)).toEqual({ x: 60, y: 0 })
    expect(rows(f)[1]).toContain("@minh · idle")
    f = await app.until((f) => header(f).includes("@minh is driving"))
    expect(header(f)).toEndWith("@minh is driving · shell 1 · running · make test")
    // A spinner while it runs a command.
    expect(SPINNER_FRAMES.some((frame) => header(f).startsWith(frame))).toBe(true)
    expect(boxColor(app)).toEqual(MINH)
    expect(headerFg(app, "@minh")).toEqual(MINH)
    // The keys go to the shell.
    app.input.typeText("ls")
    await until(() => typed(office, sh.id) === "ls")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the divider drags the pane's width, a double click puts it back to half, and one width on disk serves every pane", async () => {
  const { office, sid, app } = await boot()
  try {
    shell(office, sid)
    shell(office, sid, { name: "shell 2", interactive: false, size: null, command: "make lint" })
    await app.until((f) => f.includes("↓ 2 shells"))
    await openFirst(app)
    const mouse = app.setup.mockMouse
    // The handle is the two columns at the pane's edge; dragged left, the pane widens to what leaves the chat 44.
    await mouse.pressDown(60, 10)
    await mouse.moveTo(40, 10)
    await mouse.release(40, 10)
    let f = await app.until((f) => corner(f)?.x === 44)
    await until(() => kv().pane_width === 76)
    // A double click on it goes back to half.
    await mouse.doubleClick(44, 10)
    f = await app.until((f) => corner(f)?.x === 60)
    await until(() => kv().pane_width === 60)
    // Dragged right, it keeps 24 columns.
    await mouse.pressDown(60, 10)
    await mouse.moveTo(115, 10)
    await mouse.release(115, 10)
    f = await app.until((f) => corner(f)?.x === 96)
    await until(() => kv().pane_width === 24)
    expect(rows(f)[1]).toContain("@minh · idle")
    // Another pane opens at the same width.
    await leader(app, "up")
    await app.until((f) => corner(f) === undefined)
    await press(app, "down")
    await app.until((f) => f.includes("shell 2 · make lint"))
    await press(app, "down")
    await app.setup.renderOnce()
    app.input.pressEnter()
    // Too narrow for the whole header, which keeps its status, the pane shows shell 2's command.
    f = await app.until((f) => corner(f) !== undefined && f.includes("No output yet."))
    expect(corner(f)?.x).toBe(96)
    expect(header(f)).toEndWith("· running")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("ctrl+x ← gives the chat the keys and dims the box, ctrl+x → gives them back, and a click focuses either side", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => f.includes("ctrl+x ← focus chat"))
    await leader(app, "left")
    let f = await app.until((f) => f.includes("ctrl+x → focus pane"))
    expect(corner(f)).toEqual({ x: 60, y: 0 })
    expect(boxColor(app)).toEqual(dim(MINH))
    app.input.typeText("hi")
    await app.until((f) => f.includes("hi"))
    expect(typed(office, sh.id)).toBe("")

    await leader(app, "right")
    await app.until((f) => f.includes("ctrl+x ← focus chat"))
    expect(boxColor(app)).toEqual(MINH)
    app.input.typeText("pwd")
    await until(() => typed(office, sh.id) === "pwd")

    // A click in the chat gives it the keys; one in the pane takes them back.
    await app.setup.mockMouse.click(10, 10)
    await app.until((f) => f.includes("ctrl+x → focus pane"))
    await app.setup.mockMouse.click(90, 10)
    await app.until((f) => f.includes("ctrl+x ← focus chat"))
    app.input.typeText("x")
    await until(() => typed(office, sh.id) === "pwdx")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("ctrl+x ↑ closes the pane and the chat gets the keys; ctrl+x ↓ opens the picker", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await leader(app, "up")
    await app.until((f) => corner(f) === undefined)
    app.input.typeText("hello")
    await app.until((f) => f.includes("hello"))
    expect(typed(office, sh.id)).toBe("")
    // From the pane, ctrl+x ↓ gives the chat the keys and opens the picker in the prompt's place.
    app.input.pressKey("u", { ctrl: true })
    await openFirst(app)
    await leader(app, "down")
    await app.until((f) => f.includes("shell 1 · make test") && f.includes("Running") && f.includes("esc"))
    // The chat has the keys: Esc closes its picker, and what is typed goes to its prompt.
    await escape(app)
    await app.until((f) => !f.includes("Running") && f.includes("ctrl+x → focus pane"))
    app.input.typeText("for the chat")
    await app.until((f) => f.includes("for the chat"))
    expect(typed(office, sh.id)).toBe("")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("ctrl+x f shows the pane full screen with the chat hidden, and back; the choice holds for the next pane", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => f.includes("ctrl+x f full screen"))
    await leader(app, "f")
    let f = await app.until((f) => corner(f)?.x === 0)
    expect(f).not.toContain("@minh · idle")
    expect(f).toContain("ctrl+x ↑ close")
    expect(f).toContain("ctrl+x f split")
    await until(() => kv().pane_fullscreen === true)
    // No chat to give the keys to: they stay with the shell.
    await leader(app, "left")
    app.input.typeText("a")
    app.input.pressEnter()
    await until(() => typed(office, sh.id) === "a\r")

    await leader(app, "f")
    f = await app.until((f) => corner(f)?.x === 60)
    expect(rows(f)[1]).toContain("@minh · idle")
    await until(() => kv().pane_fullscreen === false)

    // Chosen full, the next pane opens full.
    await leader(app, "f")
    await app.until((f) => corner(f)?.x === 0)
    await leader(app, "up")
    await app.until((f) => corner(f) === undefined && f.includes("@minh · idle"))
    f = await openFirst(app)
    expect(corner(f)?.x).toBe(0)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("below 108 columns a pane is full screen and ctrl+x f does nothing; wider, it splits again", async () => {
  const office = createFakeOffice()
  const { sid, app } = await boot(office, 100)
  try {
    shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    let f = await openFirst(app)
    expect(corner(f)?.x).toBe(0)
    expect(f).not.toContain("@minh · idle")
    expect(f).not.toContain("ctrl+x f")
    await leader(app, "f")
    await Bun.sleep(100)
    f = await app.until(() => true)
    expect(corner(f)?.x).toBe(0)
    expect(kv().pane_fullscreen).toBeUndefined()
    app.setup.resize(120, 30)
    f = await app.until((f) => corner(f)?.x === 60)
    expect(rows(f)[1]).toContain("@minh · idle")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("while the owner types into the shell its header says you are driving, in the owner's colour, as the box is", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => header(f).includes("@minh is driving"))
    app.input.typeText("git st")
    await until(() => typed(office, sh.id) === "git st")
    let f = await app.until((f) => header(f).includes("you are driving"))
    expect(header(f)).toContain("you are driving · shell 1 · running")
    expect(boxColor(app)).toEqual(OWNER)
    expect(headerFg(app, "you")).toEqual(OWNER)
    // Enter ends the line, and the employee has the controls again.
    app.input.pressEnter()
    f = await app.until((f) => header(f).includes("@minh is driving"))
    expect(boxColor(app)).toEqual(MINH)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a pipes shell shows the employee's commands as $ lines in their colour, and Esc closes it", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid, { interactive: false, size: null, command: "make lint" })
    office.instrumentOutput(sid, sh.id, "$ make test\nok 12 tests\n$ make lint\n")
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => f.includes("ok 12 tests") && f.includes("$ make lint"))
    // The command it runs now is the employee's.
    expect(fg(app, "$ make lint")).toEqual(MINH)
    expect(fg(app, "ok 12 tests")).toEqual(theme.text)
    // It takes no typing, so Esc closes it.
    await app.until((f) => f.includes("esc close"))
    await escape(app)
    await app.until((f) => corner(f) === undefined)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex session opens in the pane with its transcript and a prompt; @minh drives with a spinner, you once your message runs; borders by speaker", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    let f = await openFirst(app)
    f = await app.until((f) => f.includes("Codex says hello.") && header(f).includes("@minh is driving"))
    expect(header(f)).toEndWith("@minh is driving · codex 1 · running")
    expect(SPINNER_FRAMES.some((frame) => header(f).startsWith(frame))).toBe(true)
    expect(boxColor(app)).toEqual(MINH)
    // The employee's message has a border in their colour.
    expect(borderOf(app, "@minh")).toEqual(MINH)
    // The chat's header still shows beside it.
    expect(rows(f)[1]).toContain("@minh")

    // The owner writes to Codex from the pane's own prompt.
    app.input.typeText("Use the other API")
    await app.until((f) => f.includes("Use the other API"))
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${child.id}/prompt`))
    expect(office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${chat.id}/prompt`)).toBe(false)
    f = await app.until((f) => header(f).includes("you are driving") && f.includes("Ngoc Bui (owner)"))
    expect(boxColor(app)).toEqual(OWNER)
    expect(borderOf(app, "Ngoc Bui (owner)")).toEqual(OWNER)
    expect(borderOf(app, "@minh")).toEqual(MINH)
    // Ctrl-C in the pane's prompt clears its text; the TUI stays.
    app.input.typeText("half typed")
    await app.until((f) => f.includes("half typed"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("half typed"))
    await Bun.sleep(100)
    expect(app.setup.renderer.isDestroyed).toBe(false)
    expect(app.frame()).not.toContain("Press again to leave.")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an ended Codex session opens read-only in the pane, and Esc closes it", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  codex(office, chat.id, "ended")
  const { app } = await boot(office, 120, chat.id)
  try {
    await press(app, "down")
    await app.until((f) => f.includes("No active sessions"))
    app.input.pressKey("a", { ctrl: true })
    await app.until((f) => f.includes("Codex: codex 1") && f.includes("Ended"))
    await app.setup.renderOnce()
    app.input.pressEnter()
    let f = await app.until((f) => corner(f) !== undefined && f.includes("This Codex session ended."))
    expect(header(f)).toEndWith("@minh is driving · codex 1 · ended")
    expect(f).toContain("esc close")
    await escape(app)
    f = await app.until((f) => corner(f) === undefined)
    // The chat has the keys and its own keys again.
    app.input.typeText("back")
    await app.until((f) => f.includes("back"))
  } finally {
    await app.stop()
    office.stop()
  }
})

/** A Codex card asking for one of `options`, from the session `sid`'s harness. */
const harnessCard = (sid: string, n: string, options: string[]) => ({
  session_id: sid,
  source: "harness" as const,
  node_id: n,
  run_id: "turn_1",
  title: "Codex wants to run a command",
  question: "$ touch a",
  options,
})

test("a Codex card that opens while the owner types in the pane's prompt leaves the keys there, and isn't answered", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await app.until((f) => f.includes("Codex says hello."))
    app.input.typeText("half a")
    await app.until((f) => f.includes("half a"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    // It shows folded, saying how to reach it.
    await app.until((f) => f.includes("Codex asks: Codex wants to run a command"))
    // The draft keeps the keys: a digit and Enter go to the prompt, not to the card.
    app.input.typeText(" 1")
    await app.until((f) => f.includes("half a 1"))
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${child.id}/prompt`))
    expect(office.requests.some((r) => r.path === `/questions/${card.id}/answer`)).toBe(false)
    expect(office.state.questions[card.id]!.status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a secret card in a pane without the keys reads none of what the owner types in the chat", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    const card = office.addQuestion({
      session_id: child.id,
      source: "harness" as const,
      node_id: "2",
      run_id: "turn_1",
      question: "Token?",
      questions: [{ question: "Paste the deploy token", header: "Token", options: [], secret: true }],
    })
    await app.until((f) => f.includes("Paste the deploy token"))
    await leader(app, "left")
    await app.until((f) => f.includes("ctrl+x → focus pane"))
    // The card shows in the chat too, with the chat's keys: ctrl+t gives them to the chat's prompt.
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("codex 1 asks: Token? · ctrl+t to answer"))
    app.input.typeText("sentinel-77")
    await app.until((f) => f.includes("sentinel-77"))
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${chat.id}/prompt`))
    // No dot was typed into the secret, and nothing answered it.
    expect(app.frame()).not.toContain("•")
    expect(office.requests.some((r) => r.path === `/questions/${card.id}/answer`)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell that waits for a password while a card is open opens beside it, the card keeping the keys; ctrl+x → gives them", async () => {
  const { office, sid, app } = await boot()
  try {
    const ssh = shell(office, sid, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await app.until((f) => f.includes("↓ 1 shell"))
    const card = office.addApproval(sid, {
      kind: "command",
      tool: "terminal_run",
      action: "make deploy",
      args: { shell: "shell 1", command: "make deploy" },
      reason: "Ask mode",
      rules: [],
    })
    await app.until((f) => f.includes("make deploy") && f.includes("enter confirm"))
    office.addInstrument(sid, { ...ssh, status: "waiting", waiting: "secret", updated_at: new Date().toISOString() })
    let f = await app.until((f) => corner(f) !== undefined && f.includes("ctrl+x → focus pane"))
    expect(corner(f)).toEqual({ x: 60, y: 0 })
    expect(boxColor(app)).toEqual(dim(MINH))
    // A digit meant for the card goes to the card, not the password prompt.
    app.input.pressKey("2")
    await Bun.sleep(100)
    expect(typed(office, ssh.id)).toBe("")
    expect(office.requests.some((r) => r.path === `/questions/${card.id}/answer`)).toBe(false)
    await leader(app, "right")
    f = await app.until((f) => f.includes("type your password here"))
    app.input.typeText("pw")
    await until(() => typed(office, ssh.id) === "pw")
  } finally {
    await app.stop()
    office.stop()
  }
})

// A chat shows its Codex sessions' cards too, after its own, as the upstream TUI's parent session shows its
// descendants' permission prompts and forms.

/** The bodies of the requests sent to `path`. */
const sent = (office: FakeOffice, path: string) => office.requests.filter((r) => r.path === path).map((r) => r.body)

test("a Codex session's card, open before its chat was, shows in the chat above the prompt, says which session asks and answers from there", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
  const { app } = await boot(office, 120, chat.id)
  try {
    const f = await app.until((f) => f.includes("$ touch a"))
    expect(f).toContain("codex 1 asks")
    expect(f).not.toContain("Codex asks")
    expect(corner(f)).toBeUndefined()
    // The card has the keys: a digit answers it, and nothing goes to the chat.
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
    expect(sent(office, `/sessions/${chat.id}/prompt`)).toEqual([])
    await app.until((f) => !f.includes("$ touch a"))
    // The chat read only the session's open cards, not its transcript.
    expect(office.requests.some((r) => r.path.startsWith(`/sessions/${child.id}/messages`))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card a Codex session opens while the office's stream is down shows in the chat once it is back", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    // No stream hears it: the office has no replay, so the chat reads the session's cards again.
    office.dropStreams()
    office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("$ touch a"), 8000)
  } finally {
    await app.stop()
    office.stop()
  }
})

/** A Codex card asking for a secret, from the session `sid`'s harness. */
const secretCard = (sid: string, n: string) => ({
  session_id: sid,
  source: "harness" as const,
  node_id: n,
  run_id: "turn_1",
  question: "Token?",
  questions: [{ question: "Paste the deploy token", header: "Token", options: [], secret: true }],
})

/** Opens an approval card on the chat `sid` for `make deploy` in shell 1. */
const deployApproval = (office: FakeOffice, sid: string) =>
  office.addApproval(sid, {
    kind: "command",
    tool: "terminal_run",
    action: "make deploy",
    args: { shell: "shell 1", command: "make deploy" },
    reason: "Ask mode",
    rules: [],
  })

/** Types `hunt` into the secret card that has the keys, once it shows. */
async function typeHalfSecret(app: App) {
  await app.until((f) => f.includes("Paste the deploy token"))
  await Bun.sleep(100)
  app.input.typeText("hunt")
  await app.until((f) => f.includes("••••"))
}

test("the chat's own card holds the prompt's place; a Codex session's card that opens meanwhile waits as a line, then takes the keys", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const own = deployApproval(office, chat.id)
    await app.until((f) => f.includes("make deploy") && f.includes("enter confirm"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    const f = await app.until((f) => f.includes("codex 1 asks: Codex wants to run a command (waiting)"))
    expect(f).toContain("enter confirm")
    expect(f).not.toContain("$ touch a")
    office.expire(own.id)
    await app.until((f) => f.includes("$ touch a") && !f.includes("make deploy"))
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an approval the chat opens while a Codex secret card has the keys waits as a line; the secret's rest goes to the secret", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const secret = office.addQuestion(secretCard(child.id, "1"))
    await typeHalfSecret(app)
    const own = deployApproval(office, chat.id)
    await app.until((f) => f.includes("@minh wants to run a command · ctrl+t to answer") && f.includes("Paste the deploy token"))
    app.input.typeText("er1")
    await app.until((f) => f.includes("•••••••") && !f.includes("er1"))
    app.input.pressEnter()
    await until(() => office.state.questions[secret.id]!.status !== "open")
    expect(sent(office, `/questions/${secret.id}/answer`)).toEqual([{ answer: { Token: "hunter1" }, answer_kind: "text" }])
    expect(sent(office, `/questions/${own.id}/answer`)).toEqual([])
    // Then the chat's card takes the prompt's place, as it would have.
    await app.until((f) => f.includes("make deploy") && f.includes("enter confirm"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a question the chat opens while a Codex secret card has the keys waits as a line; the secret's rest never reaches it", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const secret = office.addQuestion(secretCard(child.id, "1"))
    await typeHalfSecret(app)
    const own = office.addQuestion({ session_id: chat.id, question: "Which branch?" })
    await app.until((f) => f.includes("@minh asks: Which branch? · ctrl+t to answer"))
    app.input.typeText("er2")
    await app.until((f) => f.includes("•••••••"))
    expect(app.frame()).not.toContain("er2")
    app.input.pressEnter()
    await until(() => office.state.questions[secret.id]!.status !== "open")
    expect(sent(office, `/questions/${secret.id}/answer`)).toEqual([{ answer: { Token: "hunter2" }, answer_kind: "text" }])
    expect(sent(office, `/questions/${own.id}/answer`)).toEqual([])
    await app.until((f) => f.includes("Which branch?") && !f.includes("to answer"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex secret card that goes stale mid-entry drops the rest of the line; the chat's waiting question gets the keys after Enter", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const secret = office.addQuestion(secretCard(child.id, "1"))
    await typeHalfSecret(app)
    const own = office.addQuestion({ session_id: chat.id, question: "Which branch?" })
    await app.until((f) => f.includes("@minh asks: Which branch? · ctrl+t to answer"))
    // Codex stops waiting: the card closes under the owner's typing, unanswered.
    office.expire(secret.id)
    const frames = [await app.until((f) => f.includes("The card closed: keys are dropped until Enter"))]
    app.input.typeText("er2")
    await Bun.sleep(100)
    frames.push(await app.until(() => true))
    app.input.pressEnter()
    frames.push(await app.until((f) => !f.includes("keys are dropped")))
    expect(frames.some((f) => f.includes("er2"))).toBe(false)
    expect(sent(office, `/questions/${own.id}/answer`)).toEqual([])
    expect(sent(office, `/sessions/${chat.id}/prompt`)).toEqual([])
    // A fresh line goes to the chat's question, which has the keys now.
    await app.until((f) => f.includes("Which branch?") && !f.includes("to answer"))
    app.input.typeText("main")
    await app.until((f) => f.includes("main"))
    app.input.pressEnter()
    await until(() => office.state.questions[own.id]!.status !== "open")
    expect(sent(office, `/questions/${own.id}/answer`)).toEqual([{ answer: "main", answer_kind: "text" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a Codex card with text on another page stops the turn and drops none of the owner's keys", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const card = office.addQuestion({
      session_id: child.id,
      source: "harness" as const,
      node_id: "1",
      run_id: "turn_1",
      question: "Two things",
      questions: [
        { question: "Branch name?", header: "Branch", options: [] },
        { question: "Proceed?", header: "Go", options: [{ label: "yes" }, { label: "no" }] },
      ],
    })
    await app.until((f) => f.includes("Branch name?"))
    await Bun.sleep(100)
    app.input.typeText("feat")
    await app.until((f) => f.includes("feat"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Proceed?"))
    await escape(app)
    await until(() => sent(office, `/sessions/${child.id}/interrupt`).length === 1)
    // The interrupt makes Codex stop waiting, which is the owner's doing.
    office.expire(card.id)
    await app.until((f) => !f.includes("Proceed?"))
    await Bun.sleep(100)
    expect(app.frame()).not.toContain("keys are dropped")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card that closes under the owner's typing in a full-screen pane says there that the keys are dropped", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await app.until((f) => f.includes("Codex says hello."))
    await leader(app, "f")
    await app.until((f) => corner(f)?.x === 0)
    const secret = office.addQuestion(secretCard(child.id, "1"))
    await typeHalfSecret(app)
    office.expire(secret.id)
    await app.until((f) => corner(f)?.x === 0 && f.includes("The card closed: keys are dropped until Enter"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card from an older Codex session waits behind a younger one's that has the keys, then takes them", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const older = codex(office, chat.id, "busy", "codex 1")
  const younger = codex(office, chat.id, "busy", "codex 2")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 2 Codex sessions"))
    const secret = office.addQuestion(secretCard(younger.id, "1"))
    await typeHalfSecret(app)
    const card = office.addQuestion(harnessCard(older.id, "2", ["Approve", "Deny"]))
    await app.until((f) => f.includes("codex 1 asks: Codex wants to run a command (waiting)"))
    app.input.typeText("er1")
    await app.until((f) => f.includes("•••••••"))
    app.input.pressEnter()
    await until(() => office.state.questions[secret.id]!.status !== "open")
    expect(sent(office, `/questions/${secret.id}/answer`)).toEqual([{ answer: { Token: "hunter1" }, answer_kind: "text" }])
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([])
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a draft keeps the keys over a folded Codex card, through one of the chat's own cards coming and going", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    app.input.typeText("half a")
    await app.until((f) => f.includes("half a"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("ctrl+t to answer"))
    const own = office.addQuestion({ session_id: chat.id, question: "Which branch?", options: ["main", "dev"] })
    await app.until((f) => f.includes("Which branch?") && f.includes("1. main"))
    await Bun.sleep(100)
    app.input.pressKey("1")
    await until(() => office.state.questions[own.id]!.status !== "open")
    // The keys go back to the draft, as before the chat's card opened: a digit is text there, not a pick.
    await app.until((f) => f.includes("half a") && f.includes("ctrl+t to answer"))
    app.input.typeText(" 2")
    await app.until((f) => f.includes("half a 2"))
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("with the chat's own card waiting behind a Codex card, ctrl+t says it answers that card, goes there, and comes back", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("$ touch a"))
    const own = office.addQuestion({ session_id: chat.id, question: "Which branch?", options: ["main", "dev"] })
    // Neither the card's hint nor the waiting line says the prompt: ctrl+t goes to the chat's card.
    const f = await app.until((f) => f.includes("@minh asks: Which branch? · ctrl+t to answer"))
    expect(f).toContain("$ touch a")
    expect(f).not.toContain("prompt")
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("1. main") && !f.includes("$ touch a"))
    await Bun.sleep(100)
    app.input.pressKey("2")
    await until(() => office.state.questions[own.id]!.status !== "open")
    expect(sent(office, `/questions/${own.id}/answer`)).toEqual([{ answer: "dev", answer_kind: "option" }])
    // Then the Codex card has the keys again, as before ctrl+t.
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
    expect(sent(office, `/sessions/${chat.id}/prompt`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("once the chat's card closes and the Codex card ctrl+t left for it went stale, a draft gets the keys back", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const older = codex(office, chat.id, "busy", "codex 1")
  const younger = codex(office, chat.id, "busy", "codex 2")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 2 Codex sessions"))
    app.input.typeText("half a")
    await app.until((f) => f.includes("half a"))
    const c1 = office.addQuestion(harnessCard(older.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("ctrl+t to answer"))
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("$ touch a"))
    const own = office.addQuestion({ session_id: chat.id, question: "Which branch?", options: ["main", "dev"] })
    await app.until((f) => f.includes("@minh asks: Which branch? · ctrl+t to answer"))
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("1. main"))
    office.expire(c1.id)
    const c2 = office.addQuestion({ ...harnessCard(younger.id, "2", ["Approve", "Deny"]), question: "$ touch b" })
    await app.until((f) => f.includes("codex 2 asks: Codex wants to run a command (waiting)"))
    await Bun.sleep(100)
    app.input.pressKey("1")
    await until(() => office.state.questions[own.id]!.status !== "open")
    // The card ctrl+t came from is gone, so the draft gets the keys back, as it would have had them.
    await app.until((f) => f.includes("half a") && f.includes("ctrl+t to answer"))
    app.input.typeText(" 1")
    await app.until((f) => f.includes("half a 1"))
    expect(sent(office, `/questions/${c2.id}/answer`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex session's card that opens while the chat's prompt holds a draft leaves the keys there; ctrl+t gives them", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    app.input.typeText("half a")
    await app.until((f) => f.includes("half a"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("codex 1 asks: Codex wants to run a command · ctrl+t to answer"))
    // A digit typed for the prompt stays text there and picks nothing.
    app.input.typeText(" 1")
    await app.until((f) => f.includes("half a 1"))
    expect(office.state.questions[card.id]!.status).toBe("open")
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => f.includes("$ touch a"))
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
    expect(sent(office, `/sessions/${chat.id}/prompt`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc on a Codex session's card in the chat interrupts that session, not the chat, whose reply goes on showing", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const reply: Message = {
    id: office.nextId(),
    session_id: chat.id,
    role: "assistant",
    created_at: new Date().toISOString(),
    parts: [{ id: office.nextId(), type: "text", text: "Looking" }],
  }
  const { app } = await boot(office, 120, chat.id)
  try {
    office.setStatus(chat.id, "busy")
    office.live({ type: "message.updated", session_id: chat.id, data: reply as never })
    office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("Looking") && f.includes("$ touch a"))
    await escape(app)
    await until(() => sent(office, `/sessions/${child.id}/interrupt`).length === 1)
    expect(sent(office, `/sessions/${chat.id}/interrupt`)).toEqual([])
    // Esc froze nothing in the chat: what its reply writes next still shows.
    const part = { ...reply.parts[0]!, text: "Looking at it" }
    office.live({ type: "part.updated", session_id: chat.id, data: { message_id: reply.id, part } as never })
    await app.until((f) => f.includes("Looking at it"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell that waits for a password while a Codex session's card is open in the chat opens beside it, the card keeping the keys", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    const ssh = shell(office, chat.id, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await app.until((f) => f.includes("1 shell") && f.includes("1 Codex session"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("$ touch a"))
    office.addInstrument(chat.id, { ...ssh, status: "waiting", waiting: "secret", updated_at: new Date().toISOString() })
    const f = await app.until((f) => corner(f) !== undefined && f.includes("ctrl+x → focus pane"))
    expect(corner(f)).toEqual({ x: 60, y: 0 })
    // A digit meant for the card answers it, and none reaches the password prompt.
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    expect(typed(office, ssh.id)).toBe("")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("ctrl+x ↓ opens no picker behind a Codex session's card in the chat, nor once the card closes", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => f.includes("$ touch a"))
    await leader(app, "down")
    await Bun.sleep(100)
    app.input.pressKey("1")
    await until(() => office.state.questions[card.id]!.status !== "open")
    await app.until((f) => !f.includes("$ touch a"))
    await Bun.sleep(100)
    expect(await app.until(() => true)).not.toContain("Sessions")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex card in both the chat and the pane leaves the pane's prompt its Esc, and an answer in the pane closes both", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  const shown = (f: string) => f.split("$ touch a").length - 1
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await app.until((f) => f.includes("Codex says hello."))
    const card = office.addQuestion(harnessCard(child.id, "1", ["Approve", "Deny"]))
    await app.until((f) => shown(f) === 2)
    // On the pane's prompt, under its card folded, the card the chat shows takes none of the pane's keys.
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => shown(f) === 1)
    app.input.typeText("draft")
    await app.until((f) => f.includes("draft"))
    await escape(app)
    await app.until((f) => !f.includes("draft"))
    expect(sent(office, `/sessions/${child.id}/interrupt`)).toEqual([])
    await escape(app)
    await until(() => sent(office, `/sessions/${child.id}/interrupt`).length === 1)
    app.input.pressKey("t", { ctrl: true })
    await app.until((f) => shown(f) === 2)
    app.input.pressKey("1")
    await app.until((f) => shown(f) === 0 && !f.includes("Codex asks") && !f.includes("codex 1 asks"))
    expect(sent(office, `/questions/${card.id}/answer`)).toEqual([{ answer: "Approve", answer_kind: "option" }])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a side chat keeps its keys after they go to the pane and back", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await leader(app, "left")
    await app.until((f) => f.includes("ctrl+x → focus pane"))
    office.addQuestion({ session_id: chat.id, question: "Deploy now?", options: ["yes", "no"] })
    await app.until((f) => f.includes("Deploy now?") && f.includes("Chat about this"))
    app.input.pressKey("o", { ctrl: true })
    await app.until((f) => f.includes("Side chat with @minh"))
    await leader(app, "right")
    await app.until((f) => f.includes("ctrl+x ← focus chat"))
    await leader(app, "left")
    await app.until((f) => f.includes("ctrl+x → focus pane"))
    // ctrl+b still goes back to the question.
    app.input.pressKey("b", { ctrl: true })
    await app.until((f) => !f.includes("Side chat with @minh") && f.includes("Deploy now?"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a card the chat gets the keys back for under an open palette takes none of the palette's keys", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const child = codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await leader(app, "left")
    await app.until((f) => f.includes("ctrl+x → focus pane"))
    const q = office.addQuestion({ session_id: chat.id, question: "Deploy now?", options: ["yes", "no"] })
    await app.until((f) => f.includes("Deploy now?") && f.includes("Chat about this"))
    await leader(app, "right")
    await app.until((f) => f.includes("ctrl+x ← focus chat"))
    app.input.pressKey("p", { ctrl: true })
    await app.until((f) => f.includes("Commands"))
    // The Codex session goes: the pane closes and the chat gets the keys back, the palette still open.
    office.removeInstrument(chat.id, child.id)
    await app.until((f) => corner(f) === undefined)
    await Bun.sleep(100)
    app.input.typeText("1")
    await app.until((f) => f.includes("Commands"))
    await Bun.sleep(200)
    expect(sent(office, `/questions/${q.id}/answer`)).toEqual([])
    expect(office.state.questions[q.id]!.status).toBe("open")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("with the chat's own approval card open beside the pane, Esc in the pane's prompt still clears a draft", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  codex(office, chat.id, "busy")
  const { app } = await boot(office, 120, chat.id)
  try {
    await app.until((f) => f.includes("↓ 1 Codex session"))
    await openFirst(app)
    await app.until((f) => f.includes("Codex says hello."))
    deployApproval(office, chat.id)
    await app.until((f) => f.includes("make deploy"))
    app.input.typeText("draft")
    await app.until((f) => f.includes("draft"))
    await escape(app)
    await app.until((f) => !f.includes("draft"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("below 108 columns a pane that opens itself over a draft or a card waits, a line says so, and ctrl+x → shows it", async () => {
  const office = createFakeOffice()
  const { sid, app } = await boot(office, 100)
  try {
    const ssh = shell(office, sid, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await app.until((f) => f.includes("↓ 1 shell"))
    app.input.typeText("a draft")
    await app.until((f) => f.includes("a draft"))
    office.addInstrument(sid, { ...ssh, status: "waiting", waiting: "secret", updated_at: new Date().toISOString() })
    let f = await app.until((f) => f.includes("shell 2 is open in the pane: ctrl+x → shows it"))
    // It doesn't cover the chat, and the draft keeps the keys.
    expect(corner(f)).toBeUndefined()
    app.input.typeText("-more")
    await app.until((f) => f.includes("a draft-more"))
    expect(typed(office, ssh.id)).toBe("")
    // ctrl+x → shows it, full screen, with the keys; ctrl+x ← puts it back to wait.
    await leader(app, "right")
    f = await app.until((f) => corner(f)?.x === 0 && f.includes("type your password here"))
    expect(f).not.toContain("a draft-more")
    app.input.typeText("pw")
    await until(() => typed(office, ssh.id) === "pw")
    app.input.pressEnter()
    await until(() => typed(office, ssh.id) === "pw\r")
    await leader(app, "left")
    f = await app.until((f) => corner(f) === undefined && f.includes("a draft-more"))
    expect(f).toContain("shell 2 is open in the pane")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("below 108 columns ctrl+x f on a card for a shell's command leaves the card in view, the shell waiting in the pane", async () => {
  const office = createFakeOffice()
  const { sid, app } = await boot(office, 100)
  try {
    const sh = shell(office, sid, { name: "shell 1", command: "tail -f build.log" })
    await app.until((f) => f.includes("↓ 1 shell"))
    office.addApproval(sid, {
      kind: "command",
      tool: "terminal_run",
      action: "make deploy",
      args: { shell: "shell 1", command: "make deploy" },
      reason: "Ask mode",
      rules: [],
    })
    await app.until((f) => f.includes("make deploy") && f.includes("enter confirm"))
    await leader(app, "f")
    const f = await app.until((f) => f.includes("shell 1 is open in the pane"))
    expect(corner(f)).toBeUndefined()
    expect(f).toContain("enter confirm")
    expect(typed(office, sh.id)).toBe("")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("in a Codex session's own view, Enter on a sibling's row goes to the chat with the sibling in its pane", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  const first = codex(office, chat.id, "busy")
  const second = codex(office, chat.id, "busy")
  office.addInstrument(chat.id, { ...office.state.instruments[chat.id]!.find((i) => i.id === second.id)!, name: "codex 2" })
  const { app } = await boot(office, 120, first.id, "codex 1 · driven by @minh")
  try {
    await press(app, "down")
    await app.until((f) => f.includes("Codex: codex 2"))
    await press(app, "down")
    await app.setup.renderOnce()
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("@minh auto ·") && corner(f) !== undefined && header(f).includes("codex 2"))
    expect(f).not.toContain("driven by @minh")
    // The sibling's prompt has the keys.
    app.input.typeText("Go on.")
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${second.id}/prompt`))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a pipes shell colours only the employee's own commands, from the chat's record, not output that looks like one", async () => {
  const office = createFakeOffice()
  const sid = office.state.sessions[0]!.id
  const sh = shell(office, sid, { interactive: false, size: null, command: "make lint" })
  office.state.messages[sid] = [
    {
      id: office.nextId(),
      session_id: sid,
      role: "assistant",
      author: null,
      created_at: AT,
      parts: [
        {
          id: office.nextId(),
          type: "tool",
          call_id: "call_1",
          tool: "terminal_run",
          state: "completed",
          input: { command: "make test", shell: "shell 1" },
          output: JSON.stringify({ shell: "shell 1", status: "idle", exit: 0, waiting: null, output: "", next: 0 }),
        },
      ],
    },
  ]
  const { app } = await boot(office)
  try {
    office.instrumentOutput(sid, sh.id, "$ make test\n$ echoed-by-a-script\nok\n$ make lint\n")
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => f.includes("$ echoed-by-a-script") && f.includes("$ make lint"))
    expect(fg(app, "$ make test")).toEqual(MINH)
    // The command it runs now is its own too.
    expect(fg(app, "$ make lint")).toEqual(MINH)
    expect(fg(app, "$ echoed-by-a-script")).toEqual(theme.text)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("in a half-screen pane the header keeps the password's status whole, the driver's label giving way", async () => {
  const { office, sid, app } = await boot()
  try {
    const ssh = shell(office, sid, { name: "shell 1", driver: "opencorp", profile: "ssh", command: "ssh login1 true" })
    await app.until((f) => f.includes("↓ 1 shell"))
    office.addInstrument(sid, { ...ssh, status: "waiting", waiting: "secret", updated_at: new Date().toISOString() })
    const f = await app.until((f) => corner(f) !== undefined && f.includes("ctrl+x ← focus chat"))
    expect(header(f)).toContain("· type your password here")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a child the chat no longer lists, ended after an office restart, opens as its own chat, read-only", async () => {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  // Stored, but not in the chat's list of instruments.
  office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    kind: "instrument",
    instrument_of: chat.id,
    status: "ended",
  })
  const { app } = await boot(office, 120, chat.id)
  try {
    await press(app, "down")
    await app.until((f) => f.includes("No active sessions"))
    app.input.pressKey("a", { ctrl: true })
    await app.until((f) => f.includes("Codex: Codex session") && f.includes("Ended"))
    await app.setup.renderOnce()
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("This Codex session ended.") && f.includes("driven by @minh"))
    expect(corner(f)).toBeUndefined()
    expect(f).not.toContain("@minh auto ·")
  } finally {
    await app.stop()
    office.stop()
  }
})
