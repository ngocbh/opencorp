// A chat's shell, opened from the list under the prompt: floating over the chat, in a split beside it, or full screen.
// <leader>o opens one and cycles its views, and a setting in kv.json picks the view it opens in. A terminal's view
// draws the office's screen, then only the output past it, at the instrument's size; the approver's view sends its own
// size. While it has the keys, every key but the leader goes to the shell, Esc and Ctrl-C included; <leader>left and
// <leader>right move the keys between it and the chat. A pipes shell's view takes only Ctrl-C, and Esc puts it away. A
// shell waiting for a password opens itself. The split's pane, its handle and the muted chat beside it, and the key
// routing, are the upstream TUI's.
import type { Instrument, Message } from "@opencorp/protocol"
import { beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "../../../src/core/global"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
const AT = "2026-11-17T10:00:00.000Z"
const MIDWAY = "2026-11-17T10:02:00.000Z"
const LATER = "2026-11-17T10:05:00.000Z"
const KEY = "instrument_view"
// The app keeps kv.json under the preload's OPENCORP_HOME, which every test file shares.
const kvFile = () => path.join(Global.Path.state, "kv.json")
const kv = (): Record<string, unknown> => (existsSync(kvFile()) ? JSON.parse(readFileSync(kvFile(), "utf8")) : {})
// Each test starts on the default view; later test files expect it too.
beforeEach(() => {
  const { [KEY]: _, ...rest } = kv()
  mkdirSync(Global.Path.state, { recursive: true })
  writeFileSync(kvFile(), JSON.stringify(rest))
})

/** Boots session 0 of a fresh office on a 120x30 screen, the widest without the sidebar. */
async function boot() {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 120, height: 30 })
  await app.until((f) => f.includes("@minh auto ·"))
  return { office, sid: s.id, app }
}

let n = 0
/** Adds an instrument to session `sid`, as its host does: a running PTY shell at 80x24 unless `fields` say otherwise. */
function add(office: FakeOffice, sid: string, fields: Partial<Instrument> = {}) {
  const id = `01JA1J000000000000000000${String(++n).padStart(2, "0")}`
  return office.addInstrument(sid, {
    id,
    session_id: sid,
    kind: "terminal",
    name: "shell 1",
    driver: "minh",
    profile: "workspace",
    interactive: true,
    size: { cols: 80, rows: 24 },
    status: "running",
    created_at: AT,
    updated_at: AT,
    ...fields,
  })
}

/** Changes instrument `id` of session `sid` as its host does, after what the office changed of it since (a size). */
function update(office: FakeOffice, sid: string, id: string, fields: Partial<Instrument>) {
  const current = office.state.instruments[sid]!.find((i) => i.id === id)!
  return office.addInstrument(sid, { ...current, ...fields, updated_at: new Date(Date.now() + 1).toISOString() })
}

/** Waits until the line under the prompt counts `n` shells, so the TUI has them. */
async function listed(app: App, n: number) {
  await app.until((f) => line(f)?.includes(n === 1 ? "· 1 shell" : `· ${n} shells`) ?? false)
}

/** Presses the leader, then `key`. */
async function leader(app: App, key: string) {
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  app.input.pressKey(key)
}

/** Presses the leader, then the arrow `direction`. */
async function leaderArrow(app: App, direction: "left" | "right") {
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  app.input.pressArrow(direction)
}

/** Presses Esc alone: what comes next waits until the parser has taken it as Esc, not as Alt with that key. */
async function escape(app: App) {
  app.input.pressEscape()
  await Bun.sleep(100)
}

/** The keys the TUI sent instrument `id`, each request's in order. */
const typed = (office: FakeOffice, id: string) =>
  office.requests
    .filter((r) => r.method === "POST" && r.path.endsWith(`/instruments/${id}/keys`))
    .map((r) => (r.body as { data: string }).data)
/** Whether `text` is in any request but the keys to a shell, or in any file the TUI keeps. */
function leaked(office: FakeOffice, text: string) {
  const elsewhere = office.requests
    .filter((r) => !r.path.endsWith("/keys"))
    .some((r) => JSON.stringify(r).includes(text))
  const files = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const file = path.join(dir, name)
          return statSync(file).isDirectory() ? files(file) : [file]
        })
      : []
  return elsewhere || files(path.dirname(Global.Path.state)).some((file) => readFileSync(file, "utf8").includes(text))
}

/** Opens the palette and picks the command titled `title`. */
async function runCommand(app: App, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  // The search box takes focus a moment after it renders.
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

/** Picks how instruments open, `view` titling the choice, and waits until kv.json keeps it as `value`. */
async function setView(app: App, view: string, value: string) {
  await runCommand(app, "Choose how instruments open")
  await app.until((f) => f.includes("Open instruments") && f.includes("Full screen"))
  await Bun.sleep(50)
  app.input.typeText(view)
  await app.until((f) => f.split(view).length > 2)
  app.input.pressEnter()
  await until(() => kv()[KEY] === value)
}

const rows = (f: string) => f.split("\n")
/** The row and column of the open view's top-left corner, or undefined when none is open. */
function corner(f: string) {
  const y = rows(f).findIndex((r) => r.includes("╭"))
  return y < 0 ? undefined : { x: rows(f)[y]!.indexOf("╭"), y, right: rows(f)[y]!.lastIndexOf("╮") }
}
/** The view's title row: the row under its top border, inside the border, trimmed. */
function title(f: string) {
  const at = corner(f)
  if (!at) throw new Error("no view open:\n" + f)
  return rows(f)[at.y + 1]!.slice(at.x + 1, at.right).trim()
}
/** The line under the prompt: the row below the prompt's bottom edge. */
function line(f: string) {
  const r = rows(f)
  const edge = r.findIndex((x) => x.trimStart().startsWith("╹▀"))
  return edge < 0 ? undefined : r[edge + 1]!.trimEnd()
}
/** The sizes the TUI asked the office to give instrument `id`, in order. */
const sizes = (office: FakeOffice, id: string) =>
  office.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/instruments/${id}/size`)).map((r) => r.body)
const screens = (office: FakeOffice, id: string) =>
  office.requests.filter((r) => r.path.endsWith(`/instruments/${id}/screen`)).length
const SCREEN = "GET /sessions/:id/instruments/:iid/screen"
/** How many times `needle` shows in `f`. */
const count = (f: string, needle: string) => f.split(needle).length - 1
/** `text`'s bytes as an `instrument.output` event of instrument `id` publishes them, from `offset`. */
const output = (id: string, offset: number, text: string) => ({
  instrument_id: id,
  offset,
  data: Buffer.from(text).toString("base64"),
})

test("<leader>o opens the waiting shell floating over the chat, then cycles it to a split, to full screen and back to the list", async () => {
  const { office, sid, app } = await boot()
  try {
    add(office, sid, { name: "shell 1" })
    // Waiting on an approval card, which doesn't open it.
    const ssh = add(office, sid, {
      name: "shell 2",
      profile: "ssh",
      status: "waiting",
      waiting: "approval",
      command: "ssh nhb25@misha",
    })
    office.instrumentOutput(sid, ssh.id, "Are you sure you want to continue connecting (yes/no)? ")
    await app.until((f) => line(f)?.includes("is waiting for you") ?? false)
    expect(app.frame()).not.toContain("╭")

    // Floating: 80% of the screen, centred, over the chat, whose header still shows above it.
    await leader(app, "o")
    let f = await app.until((f) => f.includes("(yes/no)?") && f.includes("ctrl+x o: split"))
    expect(title(f)).toBe("shell 2 · waiting for you · ssh nhb25@misha · ctrl+x o: split · ctrl+x left: chat")
    expect(corner(f)).toEqual({ x: 12, y: 3, right: 107 })
    expect(rows(f)[1]).toContain("@minh · idle")

    // A split: the right half, beside the chat. Its title has no room for the command.
    await leader(app, "o")
    f = await app.until((f) => f.includes("ctrl+x o: full screen"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    expect(title(f)).toStartWith("shell 2 · waiting for you · ctrl+x o: full screen")
    expect(f).toContain("(yes/no)?")
    expect(rows(f)[1]!.slice(0, 60)).toContain("@minh · idle")

    // Full screen: in place of the messages and the prompt; the line under the prompt stays at the bottom.
    await leader(app, "o")
    f = await app.until((f) => f.includes("ctrl+x o: back to the list"))
    expect(corner(f)).toEqual({ x: 0, y: 0, right: 119 })
    expect(f).not.toContain("@minh · idle")
    expect(f).toContain("(yes/no)?")
    expect(rows(f)[28]).toContain("/tmp/proj · 2 shells")
    expect(rows(f)[28]).toContain("is waiting for you")

    // Back to the list.
    await leader(app, "o")
    f = await app.until((f) => !f.includes("╭"))
    expect(f).toContain("@minh · idle")
    expect(f).not.toContain("(yes/no)?")
    expect(line(f)).toContain("/tmp/proj · 2 shells")
    // The leader and the keys after it went to none of the shells.
    expect(office.requests.some((r) => r.path.endsWith("/keys"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a pipes shell's view takes Ctrl-C as an interrupt, and Esc puts it away", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { interactive: false, size: null, command: "make" })
    office.instrumentOutput(sid, shell.id, "compiling")
    office.updateSession(sid, { status: "busy" })
    await app.until((f) => f.includes("esc interrupt") && f.includes("· 1 shell"))
    await leader(app, "o")
    const open = await app.until((f) => f.includes("compiling") && f.includes("esc: back to the list"))
    // A click in the view keeps the keys there.
    const at = corner(open)!
    await app.setup.mockMouse.click(at.x + 5, at.y + 5)
    // Ctrl-C interrupts its command, not the agent, and the TUI stays.
    app.input.pressKey("c", { ctrl: true })
    await until(() => typed(office, shell.id).length === 1)
    expect(typed(office, shell.id)).toEqual(["\x03"])
    expect(app.setup.renderer.isDestroyed).toBe(false)
    // Other keys reach neither the shell nor the chat's prompt.
    app.input.typeText("zq")
    await app.setup.renderOnce()
    await escape(app)
    let f = await app.until((f) => !f.includes("╭"))
    expect(f).not.toContain("compiling")
    // Esc went to the view, not to the agent.
    expect(office.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(false)
    expect(f).not.toContain("zq")
    expect(typed(office, shell.id)).toEqual(["\x03"])
    // The prompt has the keys again.
    app.input.typeText("hello")
    f = await app.until((f) => f.includes("hello"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("hello"))
    expect(office.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the view setting picks how a shell opens", async () => {
  const { office, sid, app } = await boot()
  try {
    add(office, sid, { name: "shell 1", command: "htop" })
    add(office, sid, { name: "shell 2", command: "tail -f log", updated_at: LATER })
    await app.until((f) => line(f)?.includes("2 shells") ?? false)

    await setView(app, "In a split", "split")
    // The shell that changed last opens, in a split; then the cycle goes on to full screen and back.
    await leader(app, "o")
    let f = await app.until((f) => f.includes("ctrl+x o: full screen"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    expect(title(f)).toStartWith("shell 2 · running ·")
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: back to the list"))
    await leader(app, "o")
    await app.until((f) => !f.includes("╭"))

    await setView(app, "Full screen", "full")
    // The palette lists the chat's shells; the one picked opens in the setting's view.
    await runCommand(app, "Open an instrument")
    f = await app.until((f) => f.includes("shell 1") && f.includes("shell 2") && f.includes("htop"))
    app.input.typeText("shell 1")
    await app.until((f) => !f.includes("tail -f log"))
    app.input.pressEnter()
    f = await app.until((f) => f.includes("ctrl+x o: back to the list"))
    expect(corner(f)).toEqual({ x: 0, y: 0, right: 119 })
    expect(title(f)).toStartWith("shell 1 · running · htop")
    await leader(app, "o")
    await app.until((f) => !f.includes("╭"))

    await setView(app, "Floating", "floating")
    await leader(app, "o")
    f = await app.until((f) => f.includes("ctrl+x o: split"))
    expect(corner(f)).toEqual({ x: 12, y: 3, right: 107 })
    // Shell 1 changed last: it took this view's size.
    expect(title(f)).toStartWith("shell 1 · running · htop")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell joined late shows its screen, then only the output past it", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    const screen = "row 1\r\nrow 2\r\n" + "z".repeat(74) + "\r\n" + "tail-bytes"
    expect(Buffer.byteLength(screen)).toBe(100)
    office.instrumentOutput(sid, shell.id, screen)
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("tail-bytes") && f.includes("row 1") && f.includes("z".repeat(74)))
    // The terminal takes the theme's text and panel colours as its own.
    const span = app.setup
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((s) => s.text.includes("row 1"))!
    expect(span.fg.toInts().slice(0, 3)).toEqual(theme.text.toInts().slice(0, 3))
    expect(span.bg.toInts().slice(0, 3)).toEqual(theme.backgroundPanel.toInts().slice(0, 3))
    // Its first 10 bytes are ones the screen already had.
    const overlap = { instrument_id: shell.id, offset: 90, data: Buffer.from("WRONGBYTES and more.").toString("base64") }
    office.live({ type: "instrument.output", session_id: sid, data: overlap })
    let f = await app.until((f) => f.includes("tail-bytes and more."))
    expect(f).not.toContain("WRONGBYTES")
    expect(screens(office, shell.id)).toBe(1)

    // Output past what it has is a gap: it reads the screen again, and draws only what the office holds.
    const gap = { instrument_id: shell.id, offset: 500, data: Buffer.from("GAPDATA").toString("base64") }
    office.live({ type: "instrument.output", session_id: sid, data: gap })
    await until(() => screens(office, shell.id) === 2)
    f = await app.until((f) => f.includes("tail-bytes") && !f.includes("and more."))
    expect(f).not.toContain("GAPDATA")
    office.instrumentOutput(sid, shell.id, "\r\nafter the gap")
    await app.until((f) => f.includes("after the gap"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a pipes shell shows its output lines", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { interactive: false, size: null, command: "make test" })
    office.instrumentOutput(sid, shell.id, "\x1b[32mok\x1b[0m line one\r\nline two\n")
    await listed(app, 1)
    await leader(app, "o")
    let f = await app.until((f) => f.includes("ok line one") && f.includes("line two"))
    expect(title(f)).toBe("shell 1 · running · make test · ctrl+x o: split · esc: back to the list")
    expect(f).not.toContain("[32m")
    expect(f).not.toContain("\x1b")
    // Its command shows above the output, and new lines follow it.
    const at = corner(f)!
    expect(rows(f)[at.y + 2]).toContain("make test")
    office.instrumentOutput(sid, shell.id, "line three\n")
    f = await app.until((f) => f.includes("line three"))
    expect(f.indexOf("line two")).toBeLessThan(f.indexOf("line three"))
    // Nothing is sent for a pipes shell's size.
    expect(sizes(office, shell.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an ended shell can still be opened until the agent's turn ends, then leaves the list", async () => {
  const { office, sid, app } = await boot()
  try {
    office.updateSession(sid, { status: "busy" })
    add(office, sid, { name: "shell 1", command: "sleep 100" })
    const done = add(office, sid, { name: "shell 2", command: "make" })
    office.instrumentOutput(sid, done.id, "built it")
    add(office, sid, { ...done, status: "ended", updated_at: LATER })
    // A failed one leaves with it.
    add(office, sid, { name: "shell 3", command: "ssh h", status: "failed", error: "no sandbox", updated_at: MIDWAY })
    await app.until((f) => f.includes("esc interrupt"))
    // It changed last, so <leader>o opens it, with its scrollback.
    await leader(app, "o")
    let f = await app.until((f) => f.includes("built it"))
    expect(title(f)).toStartWith("shell 2 · ended · make")
    // The turn ends: it leaves the list, and its view closes.
    office.updateSession(sid, { status: "idle" })
    f = await app.until((f) => !f.includes("╭"))
    expect(f).not.toContain("built it")
    await leader(app, "o")
    f = await app.until((f) => f.includes("sleep 100") && f.includes("╭"))
    expect(title(f)).toStartWith("shell 1 · running · sleep 100")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("output that comes while the screen loads is drawn once, each byte", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    const screen = "row 1\r\nrow 2\r\n" + "z".repeat(74) + "\r\n" + "tail-bytes"
    office.instrumentOutput(sid, shell.id, screen)
    await listed(app, 1)
    const release = office.hold(SCREEN, "reply")
    await leader(app, "o")
    await until(() => screens(office, shell.id) === 1)
    // While the screen is on its way: bytes it holds, bytes that straddle its end, and bytes past it, twice over.
    // Those it holds come in capitals here, so a byte drawn from them instead of from the screen shows.
    office.live({ type: "instrument.output", session_id: sid, data: output(shell.id, 0, screen.toUpperCase()) })
    office.live({ type: "instrument.output", session_id: sid, data: output(shell.id, 90, "TAIL-BYTES one") })
    office.live({ type: "instrument.output", session_id: sid, data: output(shell.id, 100, " one two") })
    office.live({ type: "instrument.output", session_id: sid, data: output(shell.id, 108, " three") })
    // Let the events reach the view while the screen is still held back.
    await Bun.sleep(200)
    release()
    // The screen's own text shows once its reply is drawn; the output past it follows.
    const f = await app.until((f) => f.includes("row 1") && f.includes("tail-bytes one two three"))
    expect(f).not.toContain("ROW 1")
    expect(f).not.toContain("TAIL-BYTES")
    expect(count(f, "row 1")).toBe(1)
    expect(count(f, "tail-bytes")).toBe(1)
    expect(count(f, " one")).toBe(1)
    expect(count(f, "z".repeat(74))).toBe(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a resize that comes while the screen loads draws after the output before it", async () => {
  const { office, sid, app } = await boot()
  try {
    // Someone else sizes the shell, so only the office's sizes apply.
    office.updateSession(sid, { opened_by: "lan" })
    const shell = add(office, sid, { size: { cols: 80, rows: 10 } })
    await listed(app, 1)
    const release = office.hold(SCREEN, "reply")
    await leader(app, "o")
    await until(() => screens(office, shell.id) === 1)
    // Drawn at 80 columns, "edge" sits at column 75; narrowed to 40 after, the line wraps it whole. Drawn at 40, it
    // would be cut at the edge.
    office.instrumentOutput(sid, shell.id, "\x1b[1;75Hedge")
    add(office, sid, { ...shell, size: { cols: 40, rows: 10 }, updated_at: LATER })
    await Bun.sleep(200)
    release()
    await app.until((f) => f.includes("edge"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("while the screen can't be read the view tries again, slower each time, and keeps what comes until it can", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { interactive: false, size: null, command: "make" })
    await listed(app, 1)
    office.broken.add(SCREEN)
    await leader(app, "o")
    // The office's error names the route it failed on.
    await app.until((f) => f.includes(`/instruments/${shell.id}/screen`))
    // More output than a view holds back.
    for (let i = 1; i <= 1100; i++) office.instrumentOutput(sid, shell.id, `line ${i}\n`)
    await Bun.sleep(400)
    expect(screens(office, shell.id)).toBeLessThanOrEqual(3)
    office.broken.delete(SCREEN)
    const f = await app.until((f) => f.includes("line 1100"), 8000)
    expect(f).not.toContain(`/instruments/${shell.id}/screen`)
    expect(count(f, "line 1100")).toBe(1)
    expect(count(f, "line 1099")).toBe(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("size requests go one at a time, and the newest size follows the one in flight", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    await listed(app, 1)
    const release = office.hold("POST /sessions/:id/instruments/:iid/size")
    await leader(app, "o")
    await until(() => sizes(office, shell.id).length === 1)
    // The window narrows twice while the office is slow to answer.
    app.setup.resize(110, 30)
    await app.until((f) => corner(f)?.x === 11)
    app.setup.resize(100, 30)
    await app.until((f) => corner(f)?.x === 10)
    await Bun.sleep(200)
    expect(sizes(office, shell.id)).toEqual([{ cols: 92, rows: 21 }])
    release()
    // Floating at 100 columns is 80 wide: 76 inside.
    await until(() => sizes(office, shell.id).length === 2)
    await Bun.sleep(200)
    expect(sizes(office, shell.id)).toEqual([
      { cols: 92, rows: 21 },
      { cols: 76, rows: 21 },
    ])
    expect(office.state.instruments[sid]![0]!.size).toEqual({ cols: 76, rows: 21 })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the chat's own keys do nothing while a shell has the keys, and work again once it is put away", async () => {
  const office = createFakeOffice()
  const sid = office.state.sessions[0].id
  office.state.messages[sid] = Array.from(
    { length: 30 },
    (_, i): Message => ({
      id: `01JA1K0000000000000000${String(i).padStart(4, "0")}`,
      session_id: sid,
      role: "user",
      created_at: AT,
      parts: [{ id: `01JA1M0000000000000000${String(i).padStart(4, "0")}`, type: "text", text: `message ${i + 1}` }],
    }),
  )
  const app = await bootFrame(createStub(office), { sessionID: sid }, { width: 120, height: 30 })
  try {
    await app.until((f) => f.includes("message 30") && f.includes("@minh auto ·"))
    const shell = add(office, sid)
    await listed(app, 1)
    await setView(app, "In a split", "split")
    await leader(app, "o")
    let f = await app.until((f) => f.includes("ctrl+x o: full screen"))
    const chat = (f: string) => rows(f).map((r) => r.slice(0, 60))
    const before = chat(f)
    // PageUp doesn't scroll the chat, Shift+Tab doesn't switch its mode: both go to the shell.
    app.input.pressKey("\x1b[5~")
    app.input.pressTab({ shift: true })
    await until(() => typed(office, shell.id).join("") === "\x1b[5~\x1b[Z")
    f = await app.until(() => true)
    expect(chat(f)).toEqual(before)
    expect(office.requests.some((r) => r.path.endsWith("/mode"))).toBe(false)
    // Back in the list, both work.
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: back to the list"))
    await leader(app, "o")
    await app.until((f) => !f.includes("╭"))
    app.input.pressKey("\x1b[5~")
    await app.until((f) => !f.includes("message 30"))
    app.input.pressTab({ shift: true })
    await app.until((f) => f.includes("@minh default ·"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the approver's view sends its size on open and on a resize; it draws at the instrument's size", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: split"))
    // Floating is 96x24: inside its border, a column of margin either side and under its title, 92x21.
    await until(() => sizes(office, shell.id).length === 1)
    expect(sizes(office, shell.id)).toEqual([{ cols: 92, rows: 21 }])
    await leader(app, "o")
    // A split is 60 columns: 56x27 inside.
    await until(() => sizes(office, shell.id).length === 2)
    expect(sizes(office, shell.id)[1]).toEqual({ cols: 56, rows: 27 })
    // A wider screen widens the split; it takes the sidebar's place.
    app.setup.resize(140, 30)
    await until(() => sizes(office, shell.id).length === 3)
    expect(sizes(office, shell.id)[2]).toEqual({ cols: 66, rows: 27 })

    // It draws at the instrument's size, whoever set it: 30 columns here.
    add(office, sid, { ...shell, size: { cols: 30, rows: 5 }, updated_at: LATER })
    office.instrumentOutput(sid, shell.id, "a".repeat(40))
    const f = await app.until((f) => f.includes("a".repeat(30)) && f.includes("a".repeat(10) + " "))
    expect(f).not.toContain("a".repeat(31))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a view that isn't the approver's only follows the instrument's size", async () => {
  const { office, sid, app } = await boot()
  try {
    // Someone else opened the chat, so only they may size its shells.
    office.updateSession(sid, { opened_by: "lan" })
    const shell = add(office, sid)
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: split"))
    await until(() => sizes(office, shell.id).length === 1)
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: full screen"))
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: back to the list"))
    await Bun.sleep(100)
    // The office refused the first; it sent no more.
    expect(sizes(office, shell.id)).toHaveLength(1)
    expect(office.state.instruments[sid]![0]!.size).toEqual({ cols: 80, rows: 24 })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the split's width follows its handle", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    await listed(app, 1)
    await setView(app, "In a split", "split")
    await leader(app, "o")
    let f = await app.until((f) => f.includes("ctrl+x o: full screen"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    await until(() => sizes(office, shell.id).length === 1)
    // The handle is the two columns at the pane's edge; dragged left, the pane widens to what leaves the chat its
    // 44 columns.
    const mouse = app.setup.mockMouse
    await mouse.pressDown(60, 10)
    await mouse.moveTo(40, 10)
    await mouse.release(40, 10)
    f = await app.until((f) => corner(f)?.x === 44)
    expect(corner(f)).toEqual({ x: 44, y: 0, right: 119 })
    await until(() => sizes(office, shell.id).some((s: any) => s.cols === 72))
    // Clicking the chat gives it the keys, and the view stays open.
    await mouse.click(10, 10)
    app.input.typeText("hi there")
    f = await app.until((f) => f.includes("hi there"))
    expect(corner(f)?.x).toBe(44)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell waiting for a password opens itself, takes the owner's keys, and goes back to the list after", async () => {
  const { office, sid, app } = await boot()
  try {
    const SECRET = "hunter2-xq7"
    const ssh = add(office, sid, { name: "shell 2", profile: "ssh", command: "ssh nhb25@misha" })
    await listed(app, 1)
    expect(app.frame()).not.toContain("╭")
    office.instrumentOutput(sid, ssh.id, "nhb25@misha's password: ")
    add(office, sid, { ...ssh, status: "waiting", waiting: "secret", updated_at: MIDWAY })
    // It opens in the default view, floating, with the keys.
    let f = await app.until((f) => f.includes("password:") && f.includes("╭"))
    expect(corner(f)).toEqual({ x: 12, y: 3, right: 107 })
    expect(title(f)).toStartWith("shell 2 · waiting for you: type your password here · ")
    await app.until((f) => f.includes("ctrl+x left: chat"))
    app.input.typeText(SECRET)
    app.input.pressEnter()
    await until(() => typed(office, ssh.id).join("") === SECRET + "\r")
    // The shell shows only what the program echoes: the password is nowhere else.
    f = await app.until(() => true)
    expect(f).not.toContain(SECRET)
    expect(leaked(office, SECRET)).toBe(false)

    // The wait ends: it goes back to the list, and the prompt has the keys.
    update(office, sid, ssh.id, { status: "running", waiting: null })
    f = await app.until((f) => !f.includes("╭"))
    expect(f).not.toContain("password:")
    app.input.typeText("hello")
    await app.until((f) => f.includes("hello"))
    expect(typed(office, ssh.id).join("")).toBe(SECRET + "\r")
    expect(leaked(office, SECRET)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell the owner opened stays open after its wait ends; a pipes shell's wait doesn't open it", async () => {
  const { office, sid, app } = await boot()
  try {
    const pipes = add(office, sid, { interactive: false, size: null, command: "make" })
    add(office, sid, { ...pipes, status: "waiting", waiting: "secret" })
    await app.until((f) => line(f)?.includes("is waiting for you") ?? false)
    await Bun.sleep(100)
    expect(app.frame()).not.toContain("╭")
    add(office, sid, { ...pipes, status: "running", waiting: null })

    const ssh = add(office, sid, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await listed(app, 2)
    await leader(app, "o")
    await app.until((f) => title(f).startsWith("shell 2 · running"))
    update(office, sid, ssh.id, { status: "waiting", waiting: "secret" })
    await app.until((f) => title(f).startsWith("shell 2 · waiting for you: type your password here"))
    update(office, sid, ssh.id, { status: "running", waiting: null })
    const f = await app.until((f) => title(f).startsWith("shell 2 · running"))
    expect(corner(f)).toEqual({ x: 12, y: 3, right: 107 })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Ctrl-C in an open shell goes to its command, not to the chat", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { command: "sleep 100" })
    office.updateSession(sid, { status: "busy" })
    await app.until((f) => f.includes("esc interrupt") && f.includes("· 1 shell"))
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x left: chat"))
    app.input.pressKey("c", { ctrl: true })
    await until(() => typed(office, shell.id).length === 1)
    expect(typed(office, shell.id)).toEqual(["\x03"])
    await Bun.sleep(100)
    // The agent goes on, and the TUI stays.
    expect(office.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(false)
    expect(app.setup.renderer.isDestroyed).toBe(false)
    expect(corner(await app.until(() => true))).toBeDefined()
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc and ctrl+o in a focused shell go to the shell, and <leader>o cycles the view and puts it away", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { command: "vim notes.txt" })
    office.updateSession(sid, { status: "busy" })
    await app.until((f) => f.includes("esc interrupt") && f.includes("· 1 shell"))
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: split"))
    await escape(app)
    app.input.pressKey("o", { ctrl: true })
    await until(() => typed(office, shell.id).join("") === "\x1b\x0f")
    let f = await app.until(() => true)
    expect(corner(f)).toEqual({ x: 12, y: 3, right: 107 })
    expect(office.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(false)

    await leader(app, "o")
    f = await app.until((f) => f.includes("ctrl+x o: full screen"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    await leader(app, "o")
    f = await app.until((f) => f.includes("ctrl+x o: back to the list"))
    expect(corner(f)).toEqual({ x: 0, y: 0, right: 119 })
    await leader(app, "o")
    await app.until((f) => !f.includes("╭"))
    // The leader and the o after it went to neither the shell nor the chat.
    expect(typed(office, shell.id).join("")).toBe("\x1b\x0f")
    expect(office.requests.some((r) => r.path.endsWith("/interrupt"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("<leader>left moves focus to the chat with the view still open, and <leader>right back to the shell", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    await listed(app, 1)
    await setView(app, "In a split", "split")
    await leader(app, "o")
    // A split's title has room for the keys' names, not what they do.
    let f = await app.until((f) => f.includes("ctrl+x left"))
    await leaderArrow(app, "left")
    f = await app.until((f) => f.includes("ctrl+x right"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    // The chat's prompt, beside the view, takes what is typed now.
    app.input.typeText("note-to-minh")
    f = await app.until((f) => rows(f).some((r) => r.slice(0, 60).includes("note-to-minh")))
    expect(typed(office, shell.id)).toEqual([])
    await leaderArrow(app, "right")
    await app.until((f) => f.includes("ctrl+x left"))
    app.input.typeText("ls")
    await until(() => typed(office, shell.id).join("") === "ls")
    f = await app.until(() => true)
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    expect(rows(f).some((r) => r.slice(0, 60).includes("note-to-minhls"))).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("in nano the leader twice reaches it as ^X", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { command: "nano notes.txt" })
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: split"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("x", { ctrl: true })
    await until(() => typed(office, shell.id).length === 1)
    expect(typed(office, shell.id)).toEqual(["\x18"])
    // The view stays as it was.
    expect(corner(await app.until(() => true))).toEqual({ x: 12, y: 3, right: 107 })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the owner's keys go out batched, as typed, and the TUI adds none of them to the chat", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid)
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: split"))
    const TEXT = "echo batched-keys-q9"
    app.input.typeText(TEXT)
    app.input.pressEnter()
    await until(() => typed(office, shell.id).join("") === TEXT + "\r")
    // Fewer requests than keys: a frame's keys go together.
    expect(typed(office, shell.id).length).toBeLessThan(TEXT.length)
    const f = await app.until(() => true)
    // The fake shell echoes nothing, so nothing of it shows; the chat got no message.
    expect(f).not.toContain("batched-keys")
    expect(office.requests.some((r) => r.path.endsWith("/prompt"))).toBe(false)
    expect(leaked(office, "batched-keys-q9")).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("<leader>o on an approval card for a terminal command opens its shell beside the card", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { name: "shell 1", command: "tail -f build.log" })
    office.instrumentOutput(sid, shell.id, "waiting for input")
    // Another shell changed later, which <leader>o would open with no card.
    add(office, sid, { name: "shell 2", command: "htop", updated_at: LATER })
    await listed(app, 2)
    const card = office.addApproval(sid, {
      kind: "command",
      tool: "terminal_run",
      action: "make deploy",
      args: { shell: "shell 1", command: "make deploy" },
      reason: "Ask mode",
      rules: [],
    })
    await app.until((f) => f.includes("make deploy") && f.includes("enter confirm"))
    await leader(app, "o")
    // A split beside the card, which keeps the keys.
    let f = await app.until((f) => f.includes("waiting for input") && f.includes("╭"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    expect(title(f)).toStartWith("shell 1 · running")
    f = await app.until((f) => f.includes("ctrl+x right"))
    expect(rows(f).some((r) => r.slice(0, 60).includes("make deploy"))).toBe(true)
    // The card takes a digit, which selects Yes, and Enter, which sends it; the shell gets neither.
    app.input.pressKey("1")
    await Bun.sleep(100)
    app.input.pressEnter()
    await until(() => office.requests.some((r) => r.path === `/questions/${card.id}/answer`))
    expect(office.requests.find((r) => r.path === `/questions/${card.id}/answer`)?.body).toEqual({
      answer: "Yes",
      answer_kind: "option",
    })
    expect(typed(office, shell.id)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the rest of a password typed after its wait ends goes to the shell, never to the chat", async () => {
  const { office, sid, app } = await boot()
  try {
    const ssh = add(office, sid, { name: "shell 2", profile: "ssh", command: "sudo make install" })
    await listed(app, 1)
    office.instrumentOutput(sid, ssh.id, "[sudo] password for nhb25: ")
    update(office, sid, ssh.id, { status: "waiting", waiting: "secret" })
    await app.until((f) => f.includes("╭") && title(f).includes("type your password here") && f.includes("left: chat"))
    await app.input.typeText("hunt")
    await until(() => typed(office, ssh.id).join("") === "hunt")
    // sudo's pwfeedback echoes stars; the office sees the wait end as the program draws them.
    office.instrumentOutput(sid, ssh.id, "****")
    update(office, sid, ssh.id, { status: "running", waiting: null })
    const frames: string[] = []
    // The view stays, with the keys, until the line is done.
    frames.push(await app.until((f) => title(f).startsWith("shell 2 · running")))
    await app.input.typeText("er2-zz")
    frames.push(await app.until(() => true))
    app.input.pressEnter()
    await until(() => typed(office, ssh.id).join("") === "hunter2-zz\r")
    // Then it goes back to the list, and the prompt is as it was: empty.
    frames.push(await app.until((f) => !f.includes("╭")))
    expect(frames.some((f) => f.includes("er2-zz") || f.includes("hunt"))).toBe(false)
    expect(leaked(office, "er2-zz")).toBe(false)
    expect(office.requests.some((r) => r.path.endsWith("/prompt"))).toBe(false)
    app.input.typeText("hello")
    const f = await app.until((f) => f.includes("hello"))
    expect(f).not.toContain("er2-zz")
    expect(rows(f).find((r) => r.includes("hello"))!.trim()).toMatch(/^┃\s*hello$/)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell waiting for a password opens itself only for the session's approver", async () => {
  const { office, sid, app } = await boot()
  try {
    // Someone else opened the chat, so only they may type into its shells.
    office.updateSession(sid, { opened_by: "lan" })
    const ssh = add(office, sid, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await listed(app, 1)
    update(office, sid, ssh.id, { status: "waiting", waiting: "secret" })
    await app.until((f) => line(f)?.includes("is waiting for you") ?? false)
    await Bun.sleep(200)
    expect(app.frame()).not.toContain("╭")
    // Opened by hand, it waits for its approver, not for this viewer.
    await leader(app, "o")
    let f = await app.until((f) => f.includes("╭"))
    expect(title(f)).toStartWith("shell 2 · waiting for you · ssh h")
    expect(f).not.toContain("type your password here")
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: full screen"))
    await leader(app, "o")
    await app.until((f) => f.includes("ctrl+x o: back to the list"))
    await leader(app, "o")
    await app.until((f) => !f.includes("╭"))

    // The chat is this viewer's again: the waiting shell opens itself for them.
    office.updateSession(sid, { opened_by: "ngocbh" })
    f = await app.until((f) => f.includes("╭") && title(f).includes("type your password here"))
    expect(title(f)).toStartWith("shell 2 · waiting for you: type your password here")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell that waits for a password while the owner has a draft opens beside it, the draft keeping the keys", async () => {
  const { office, sid, app } = await boot()
  try {
    const ssh = add(office, sid, { name: "shell 2", profile: "ssh", command: "ssh h" })
    await listed(app, 1)
    await app.input.typeText("a draft")
    await app.until((f) => f.includes("a draft"))
    update(office, sid, ssh.id, { status: "waiting", waiting: "secret" })
    // Its title says how to give it the keys, not to type the password, which would go to the draft.
    let f = await app.until((f) => f.includes("╭") && f.includes("ctrl+x right: shell"))
    expect(corner(f)).toEqual({ x: 60, y: 0, right: 119 })
    expect(title(f)).toStartWith("shell 2 · waiting for you · ")
    expect(f).not.toContain("type your password here")
    // What comes next goes on with the draft.
    await app.input.typeText("-ft-more")
    f = await app.until((f) => f.includes("a draft-ft-more"))
    expect(typed(office, ssh.id)).toEqual([])
    // <leader>right gives the shell the keys.
    await leaderArrow(app, "right")
    await app.until((f) => f.includes("╭") && title(f).includes("type your password here"))
    await app.input.typeText("pw")
    await until(() => typed(office, ssh.id).join("") === "pw")
    f = await app.until(() => true)
    expect(f).toContain("a draft-ft-more")
    expect(f).not.toContain("a draft-ft-morepw")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an office's refusal of the keys shows over a floating view", async () => {
  const { office, sid, app } = await boot()
  try {
    office.updateSession(sid, { opened_by: "lan" })
    const shell = add(office, sid, { command: "vim" })
    office.instrumentOutput(sid, shell.id, "editing")
    await listed(app, 1)
    await leader(app, "o")
    await app.until((f) => f.includes("editing") && f.includes("ctrl+x o: split"))
    app.input.typeText("i")
    await app.until((f) => f.includes("only @lan may type"))
    // Refused once, the view sends no more.
    app.input.typeText("x")
    await Bun.sleep(100)
    expect(typed(office, shell.id)).toEqual(["i"])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a shell's view sends nothing once it is put away, its terminal's focus report as it goes included", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, { command: "vim" })
    // The program asks for focus reports, which the terminal sends as it gains and loses focus.
    office.instrumentOutput(sid, shell.id, "\x1b[?1004hediting")
    await listed(app, 1)
    await setView(app, "Full screen", "full")
    await leader(app, "o")
    await app.until((f) => f.includes("editing") && f.includes("ctrl+x o: back to the list"))
    app.input.typeText("i")
    await until(() => typed(office, shell.id).join("") === "i")
    await leader(app, "o")
    await app.until((f) => !f.includes("editing"))
    await Bun.sleep(100)
    expect(typed(office, shell.id).join("")).toBe("i")
  } finally {
    await app.stop()
    office.stop()
  }
})
