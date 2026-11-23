// A reply's runs of tool calls, folded as upstream folds them: at Low each run is one muted line counting its finished
// work that a click opens, at Medium only reads and searches fold, and at High their groups start open. A question
// never folds, and a call waiting on an approval card stays visible below its run's line.
import type { Message, Part, ToolPart } from "@opencorp/protocol"
import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { SPINNER_FRAMES } from "../../../src/component/spinner"
import { INTERRUPTED_TEXT } from "../../../src/routes/chat/freeze"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { readKV, writeKV } from "../../fixture/kv"
import { until } from "../../fixture/until"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const AT = "2026-11-23T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
const VERBOSITY = "session_verbosity"
const GROUPING = "session_grouping"

// Each test starts on the defaults (Low, grouped); later test files expect them too.
beforeEach(() => writeKV({ [VERBOSITY]: undefined, [GROUPING]: undefined }))
afterAll(() => writeKV({ [VERBOSITY]: undefined, [GROUPING]: undefined }))

let n = 0
/** A completed call of `tool` with `input`, unless `fields` say otherwise. */
const call = (tool: string, input: Record<string, unknown>, fields: Partial<ToolPart> = {}): ToolPart => ({
  id: `p${++n}`,
  type: "tool",
  call_id: `call_${n}`,
  tool,
  state: "completed",
  input,
  ...fields,
})
const read = (path: string, fields?: Partial<ToolPart>) => call("workspace_read_file", { path }, fields)
const search = (pattern: string) => call("workspace_search", { pattern })
const shell = (command: string, fields?: Partial<ToolPart>) => call("workspace_shell", { command }, fields)
const write = (path: string) => call("workspace_write_file", { path, content: "x" })
const text = (value: string): Part => ({ id: `t${++n}`, type: "text", text: value })

/** Boots session 0 of `office` with a user message and one reply of `parts`. */
async function boot(parts: Part[], office: FakeOffice = createFakeOffice()) {
  const s = office.state.sessions[0]!
  office.state.messages[s.id] = [
    { id: "M1", session_id: s.id, role: "user", created_at: AT, parts: [{ id: "u", type: "text", text: "fix it" }] },
    { id: "M2", session_id: s.id, role: "assistant", created_at: AT, parts },
  ] satisfies Message[]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 100, height: 40 })
  await app.until((f) => f.includes("fix it"))
  return { office, s, app }
}

const rows = (f: string) => f.split("\n")
/** The screen's rows, trimmed. */
const lines = (f: string) => rows(f).map((r) => r.trim())
/** The screen row holding `needle`, trimmed, and where it is. */
function row(f: string, needle: string) {
  const y = rows(f).findIndex((r) => r.includes(needle))
  if (y < 0) throw new Error(`${needle} isn't on screen:\n` + f)
  return { text: rows(f)[y]!.trim(), x: rows(f)[y]!.indexOf(needle), y }
}
/** Whether the row holding `needle` starts with a spinner frame. */
const spins = (f: string, needle: string) => SPINNER_FRAMES.some((frame) => row(f, needle).text.startsWith(frame))
/** The foreground of the first span holding `needle`. */
const fg = (app: App, needle: string) =>
  app.setup
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .find((s) => s.text.includes(needle))?.fg
/** Clicks the row holding `needle`, a few cells into it. */
async function click(app: App, needle: string) {
  const at = row(app.frame(), needle)
  await app.setup.mockMouse.click(at.x + 2, at.y)
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
  await app.until((f) => !f.includes("Commands"))
}

test("at Low, a run of tool calls is one muted line counting its work, which a click opens and closes", async () => {
  const { office, app } = await boot([
    read("src/a.ts"),
    shell("make test"),
    write("notes.md"),
    text("All done."),
    shell("make lint"),
  ])
  try {
    let f = await app.until((f) => f.includes("+ 1 command, 1 edit, 1 read") && f.includes("All done."))
    // Text breaks a run: the call after it is a run of its own.
    expect(lines(f)).toContain("+ 1 command")
    for (const hidden of ["src/a.ts", "make test", "notes.md", "make lint"]) expect(f).not.toContain(hidden)
    expect(fg(app, "1 command, 1 edit, 1 read")?.equals(theme.textMuted)).toBe(true)

    await click(app, "+ 1 command, 1 edit, 1 read")
    f = await app.until((f) => f.includes("− 1 command, 1 edit, 1 read") && f.includes("make test"))
    expect(f).toContain("Write notes.md")
    // Reads inside a run fold on their own, as upstream's exploration subgroup.
    expect(f).toContain("→ Explored: 1 read")
    expect(f).not.toContain("src/a.ts")
    expect(f).not.toContain("make lint")
    expect(row(f, "Explored").y).toBeLessThan(row(f, "make test").y)
    expect(row(f, "make test").y).toBeLessThan(row(f, "All done.").y)

    await click(app, "Explored: 1 read")
    await app.until((f) => f.includes("Read src/a.ts"))

    await click(app, "− 1 command, 1 edit, 1 read")
    f = await app.until((f) => f.includes("+ 1 command, 1 edit, 1 read"))
    expect(f).not.toContain("make test")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a run with nothing finished spins with what runs, then counts what finished", async () => {
  const office = createFakeOffice()
  const running = shell("make build", { state: "running" })
  const { s, app } = await boot([running], office)
  try {
    let f = await app.until((f) => f.includes("Running command…"))
    expect(spins(f, "Running command…")).toBe(true)
    expect(f).not.toContain("make build")
    const next = read("src/b.ts", { state: "running" })
    const update = (parts: Part[]) =>
      office.live({
        type: "message.updated",
        session_id: s.id,
        data: { id: "M2", session_id: s.id, role: "assistant", created_at: AT, parts } as never,
      })
    update([{ ...running, state: "completed" }, next])
    f = await app.until((f) => f.includes("1 command") && !f.includes("Running command…"))
    // Still working: the line spins with what finished.
    expect(spins(f, "1 command")).toBe(true)
    update([{ ...running, state: "completed" }, { ...next, state: "error", error: "no such file" }])
    f = await app.until((f) => f.includes("+ 1 command, 1 read"))
    expect(spins(f, "1 command, 1 read")).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("at Medium only reads and searches fold, and at High their groups start open", async () => {
  writeKV({ [VERBOSITY]: "medium" })
  const parts = () => [read("src/a.ts"), search("TODO"), shell("make test"), read("src/b.ts")]
  let { office, app } = await boot(parts())
  try {
    const f = await app.until((f) => f.includes("Explored: 1 read, 1 search") && f.includes("make test"))
    expect(lines(f)).toContain("→ Explored: 1 read")
    expect(f).not.toContain("src/a.ts")
    expect(f).not.toContain('Search "TODO"')
    await click(app, "Explored: 1 read, 1 search")
    await app.until((f) => f.includes("Read src/a.ts") && f.includes('Search "TODO"'))
  } finally {
    await app.stop()
    office.stop()
  }

  writeKV({ [VERBOSITY]: "high" })
  ;({ office, app } = await boot(parts()))
  try {
    const f = await app.until((f) => f.includes("Explored: 1 read, 1 search") && f.includes("Read src/b.ts"))
    expect(f).toContain("Read src/a.ts")
    expect(f).toContain('Search "TODO"')
    expect(f).toContain("make test")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a question never folds, and ends the run before it", async () => {
  const { office, app } = await boot([
    read("src/a.ts"),
    call("ask_user", { question: "Which license?" }, { output: 'The user chose "MIT" (option 1 of 2 shown).' }),
    read("src/b.ts"),
  ])
  try {
    const f = await app.until((f) => f.includes("Which license?"))
    expect(f.split("+ 1 read").length).toBe(3)
    expect(row(f, "+ 1 read").y).toBeLessThan(row(f, "Which license?").y)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a call waiting on an approval card shows below its run's line, which leaves it out", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]!
  const q = office.addApproval(s.id, {
    kind: "command",
    tool: "shell",
    action: "rm -rf build",
    reason: "Ask mode",
    rules: [],
  })
  const { app } = await boot(
    [
      shell("ls -la"),
      // The held call, which the card names by yian's id.
      shell("make deploy", { state: "running", yian_call_id: q.call_id! }),
      shell("make all", { state: "running" }),
    ],
    office,
  )
  try {
    const f = await app.until((f) => f.includes("make deploy") && f.includes("1 command"))
    expect(f).not.toContain("ls -la")
    expect(f).not.toContain("make all")
    expect(spins(f, "1 command")).toBe(true)
    expect(row(f, "1 command").y).toBeLessThan(row(f, "make deploy").y)
    expect(fg(app, "make deploy")?.equals(theme.warning)).toBe(true)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the verbosity command cycles Low, Medium and High, and kv.json keeps it", async () => {
  const { office, app } = await boot([read("src/a.ts"), shell("make test")])
  try {
    await app.until((f) => f.includes("+ 1 command, 1 read"))
    await runCommand(app, "Verbosity: Low")
    await app.until((f) => f.includes("Explored: 1 read") && f.includes("make test"))
    await until(() => readKV()[VERBOSITY] === "medium")
    await runCommand(app, "Verbosity: Medium")
    await app.until((f) => f.includes("Read src/a.ts"))
    await until(() => readKV()[VERBOSITY] === "high")
    await runCommand(app, "Verbosity: High")
    await app.until((f) => f.includes("+ 1 command, 1 read"))
    await until(() => readKV()[VERBOSITY] === "low")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("showing tool calls individually drops the reads' group, and kv.json keeps it", async () => {
  writeKV({ [VERBOSITY]: "medium" })
  const { office, app } = await boot([read("src/a.ts"), read("src/b.ts"), shell("make test")])
  try {
    await app.until((f) => f.includes("Explored: 2 reads"))
    await runCommand(app, "Show tool calls individually")
    const f = await app.until((f) => f.includes("Read src/a.ts") && f.includes("Read src/b.ts"))
    expect(f).not.toContain("Explored")
    await until(() => readKV()[GROUPING] === "none")
    await runCommand(app, "Group related tool calls")
    await app.until((f) => f.includes("Explored: 2 reads"))
    await until(() => readKV()[GROUPING] === "auto")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("after Esc, a run counts only the calls the frozen view shows", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]!
  office.updateSession(s.id, { status: "busy" })
  const first = shell("make test")
  const second = shell("make lint", { state: "running" })
  // The stopped reply's second call ends interrupted, and a call it made after Esc comes in late.
  office.onInterrupt(() => {
    const parts = [first, { ...second, state: "interrupted" as const }, shell("make late"), text(INTERRUPTED_TEXT.trimStart())]
    office.live({
      type: "message.updated",
      session_id: s.id,
      data: { id: "M2", session_id: s.id, role: "assistant", created_at: AT, parts } as never,
    })
    office.replyEnded(s.id)
  })
  const { app } = await boot([first, second], office)
  try {
    await app.until((f) => f.includes("1 command") && f.includes("@minh · busy"))
    app.input.pressEscape()
    const f = await app.until((f) => f.includes("+ 2 commands") && f.includes("@minh · idle"))
    expect(f).not.toContain("3 commands")
    expect(f).toContain("[interrupted]")
  } finally {
    await app.stop()
    office.stop()
  }
})
