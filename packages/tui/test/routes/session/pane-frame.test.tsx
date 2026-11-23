// The right pane beside the chat, the upstream TUI's split pane: Enter on a picker row opens a shell or a Codex or
// Claude Code session there, split by default. The divider drags its width, which a double click puts back to half and
// one setting on disk keeps for every pane; it keeps 24 columns and leaves the chat 44. Below 108 columns it is full
// screen. ctrl+x ←/→ move the keys between the chat and the pane, a click in either side focuses it, ctrl+x ↑ closes
// it, and ctrl+x o shows it full screen or split. Unlike upstream's, it sits in a box in its driver's colour, bright
// with the keys and dim without; its header says who drives it.
import type { Instrument, Session } from "@opencorp/protocol"
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

/** Adds a Codex session minh's chat `chat` drives, its child session, listed as the chat's instrument `codex 1`. */
function codex(office: FakeOffice, chat: string, status: Session["status"]) {
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
    name: "codex 1",
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
    // Too narrow for the header to name it, the pane shows shell 2's command.
    f = await app.until((f) => corner(f) !== undefined && f.includes("No output yet."))
    expect(corner(f)?.x).toBe(96)
    expect(header(f)).toContain("@minh is driving")
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

test("ctrl+x o shows the pane full screen with the chat hidden, and back; the choice holds for the next pane", async () => {
  const { office, sid, app } = await boot()
  try {
    const sh = shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    await openFirst(app)
    await app.until((f) => f.includes("ctrl+x o full screen"))
    await leader(app, "o")
    let f = await app.until((f) => corner(f)?.x === 0)
    expect(f).not.toContain("@minh · idle")
    expect(f).toContain("ctrl+x ↑ close")
    expect(f).toContain("ctrl+x o split")
    await until(() => kv().pane_fullscreen === true)
    // No chat to give the keys to: they stay with the shell.
    await leader(app, "left")
    app.input.typeText("a")
    app.input.pressEnter()
    await until(() => typed(office, sh.id) === "a\r")

    await leader(app, "o")
    f = await app.until((f) => corner(f)?.x === 60)
    expect(rows(f)[1]).toContain("@minh · idle")
    await until(() => kv().pane_fullscreen === false)

    // Chosen full, the next pane opens full.
    await leader(app, "o")
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

test("below 108 columns a pane is full screen and ctrl+x o does nothing; wider, it splits again", async () => {
  const office = createFakeOffice()
  const { sid, app } = await boot(office, 100)
  try {
    shell(office, sid)
    await app.until((f) => f.includes("↓ 1 shell"))
    let f = await openFirst(app)
    expect(corner(f)?.x).toBe(0)
    expect(f).not.toContain("@minh · idle")
    expect(f).not.toContain("ctrl+x o")
    await leader(app, "o")
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
    expect(fg(app, "$ make test")).toEqual(MINH)
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

test("below 108 columns ctrl+x o on a card for a shell's command leaves the card in view, the shell waiting in the pane", async () => {
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
    await leader(app, "o")
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
