// The row under the prompt's text names who answers, as the upstream TUI's names the agent and its model. In a chat:
// the employee's handle in their colour, the mode, their title and the chat's model. In a Codex or Claude Code
// session's pane: the session's name, its harness and its model, then a muted "as @<owner>", since the owner writes
// there as themselves. Short of room it stays one row: the mode goes first, then the harness and the title, then
// "as @…", and then the model is cut short.
import type { Session } from "@opencorp/protocol"
import type { RGBA } from "@opentui/core"
import { expect, setDefaultTimeout, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

// A test here waits on several frames in turn, each up to 3 s.
setDefaultTimeout(20_000)

const AT = "2026-11-23T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
// minh, the employee, has the office's first colour.
const MINH = theme.secondary

/** Adds a session of `harness` that minh's chat `chat` drives, running a turn, listed as the chat's instrument `name`. */
function harnessed(office: FakeOffice, chat: string, harness: "codex" | "claude", name: string, model: string | null) {
  const child = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness,
    kind: "instrument",
    instrument_of: chat,
    status: "busy",
    harness_model: model,
  } as Partial<Session> & Pick<Session, "person" | "cwd">)
  office.addInstrument(chat, {
    id: child.id,
    session_id: chat,
    kind: harness,
    name,
    driver: "minh",
    profile: "harness",
    interactive: false,
    status: "running",
    created_at: AT,
    updated_at: AT,
  })
  return child
}

/** Boots minh's chat on a `width`x30 screen, with a `harness` session listed as `name` when one is given, and waits
 *  for its prompt's line. */
async function boot(width: number, child?: { harness: "codex" | "claude"; name: string; model: string | null }) {
  const office = createFakeOffice()
  const chat = office.state.sessions[0]!
  if (child) harnessed(office, chat.id, child.harness, child.name, child.model)
  const app = await bootFrame(createStub(office), { sessionID: chat.id }, { width, height: 30 })
  await app.until((f) => who(f).startsWith("@minh"))
  return { office, app }
}

/** Opens the chat's first session in the pane from the picker, and waits for its prompt. */
async function openSession(app: App) {
  await app.setup.renderOnce()
  app.input.pressArrow("down")
  await app.until((f) => f.includes("Sessions"))
  await app.setup.renderOnce()
  app.input.pressEnter()
  return app.until((f) => pane(f).includes("╹▀"))
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

/** The prompt's rows in `f`: those after its left edge `┃`, trimmed, up to its bottom edge; none with no prompt. */
function promptRows(f: string) {
  const rows = f.split("\n")
  const edge = rows.findIndex((r) => r.trimStart().startsWith("╹▀"))
  if (edge < 0) return []
  let top = edge
  while (top > 0 && rows[top - 1]!.trimStart().startsWith("┃")) top--
  return rows.slice(top, edge).map((r) => r.trimStart().slice(1).trim())
}
/** The last of the prompt's rows that shows anything: the line naming who answers. */
const who = (f: string) => promptRows(f).findLast((r) => r !== "") ?? ""

/** Renders until the line under the prompt in `view` of the frame (the whole screen, or the pane) reads `line`, which
 *  it may only once it knows its width. */
function shows(app: App, line: string, view = (f: string) => f) {
  return app.until((f) => who(view(f)) === line)
}

/** The foreground of the last span holding `needle` on the row that holds `row`. */
function fg(app: App, row: string, needle: string): RGBA | undefined {
  const line = app.setup
    .captureSpans()
    .lines.find((l) => l.spans.map((s) => s.text).join("").includes(row))
  return line?.spans.findLast((s) => s.text.includes(needle))?.fg
}

test("the chat's line names the employee who answers in their colour, then the mode, their title and the chat's model", async () => {
  const { office, app } = await boot(100)
  try {
    const f = await shows(app, "@minh auto · Software engineer · gpt-4o")
    expect(promptRows(f).filter((r) => r !== "")).toHaveLength(1)
    expect(fg(app, "Software engineer", "@minh")).toEqual(MINH)
    expect(fg(app, "Software engineer", "auto")).toEqual(theme.textMuted)
    expect(fg(app, "Software engineer", "gpt-4o")).toEqual(theme.textMuted)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a narrow chat keeps the line on one row: the mode goes first, then the title", async () => {
  // The line has the screen less 9 columns: the chat's margins, the prompt's edge and its padding. At 43, its 34 are
  // just room for all but the mode.
  let { office, app } = await boot(43)
  try {
    const f = await shows(app, "@minh · Software engineer · gpt-4o")
    expect(promptRows(f).filter((r) => r !== "")).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
  ;({ office, app } = await boot(42))
  try {
    const f = await shows(app, "@minh · gpt-4o")
    expect(f).not.toContain("Software")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Claude Code session's pane names the session, Claude Code and its model, and that the owner writes as themselves", async () => {
  const { office, app } = await boot(160, { harness: "claude", name: "claude 1", model: "claude-opus-5-5" })
  try {
    await openSession(app)
    const f = await shows(app, "claude 1 Claude Code · claude-opus-5-5 · as @ngocbh", pane)
    // Not who the owner is: the line no longer names them with their title.
    expect(pane(f)).not.toContain("CEO")
    expect(fg(app, "claude-opus-5-5 · as", "claude 1")).toEqual(MINH)
    expect(fg(app, "claude-opus-5-5 · as", "Claude Code")).toEqual(theme.text)
    expect(fg(app, "claude-opus-5-5 · as", "as @ngocbh")).toEqual(theme.textMuted)
    // The chat beside it still names its employee.
    expect(f).toContain("@minh auto · Software engineer · gpt-4o")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a Codex session's pane names the session and Codex, with no model until Codex reports one", async () => {
  const { office, app } = await boot(160, { harness: "codex", name: "codex 1", model: null })
  try {
    await openSession(app)
    const f = await shows(app, "codex 1 Codex · as @ngocbh", pane)
    expect(pane(f)).not.toContain("CEO")
  } finally {
    await app.stop()
    office.stop()
  }
  const second = await boot(160, { harness: "codex", name: "codex 1", model: "gpt-5.5-codex" })
  try {
    await openSession(second.app)
    await shows(second.app, "codex 1 Codex · gpt-5.5-codex · as @ngocbh", pane)
  } finally {
    await second.app.stop()
    second.office.stop()
  }
})

test("a narrow pane keeps the line on one row: the harness goes first, then whom the owner writes as, then the model is cut short", async () => {
  const child = { harness: "claude" as const, name: "claude 1", model: "claude-opus-5-5" }
  // Half of 110 columns: the harness, which the session's name already says, gives way.
  let { office, app } = await boot(110, child)
  try {
    await openSession(app)
    await shows(app, "claude 1 · claude-opus-5-5 · as @ngocbh", pane)
  } finally {
    await app.stop()
    office.stop()
  }
  // Under 108 columns the pane is full screen.
  ;({ office, app } = await boot(40, child))
  try {
    await openSession(app)
    await shows(app, "claude 1 · claude-opus-5-5", pane)
  } finally {
    await app.stop()
    office.stop()
  }
  ;({ office, app } = await boot(30, child))
  try {
    await openSession(app)
    const f = await shows(app, "claude 1 · claude-op…", pane)
    expect(promptRows(pane(f)).filter((r) => r !== "")).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})
