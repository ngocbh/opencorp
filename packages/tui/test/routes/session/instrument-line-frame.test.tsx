// The line under the prompt: after the cwd, or the spinner and "esc interrupt", a count per kind of the chat's
// instruments that haven't ended, and how many failed; on the right, what waits for the owner, in place of the
// shortcuts. Its layout is the upstream TUI's prompt line, with its footer's permissions count as the warning.
import type { Instrument } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { expect, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

const AT = "2026-11-17T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
/** The line as it was before instruments: the cwd, then the shortcuts. */
const IDLE = "   /tmp/proj                                      shift+tab mode  ctrl+x p people  ctrl+p commands"
const SHORTCUTS = "shift+tab mode  ctrl+x p people  ctrl+p commands"
/** The shortcuts, closing a line pattern. */
const ENDS_WITH_SHORTCUTS = ` +${SHORTCUTS.replaceAll("+", "\\+")}$`
/** The ssh shell's warning, its command cut to 30 columns, the last three the ellipsis the counts are cut with. */
const SSH_WAITS = "⚠ ssh nhb25@misha\\.ycrc\\.yale\\.e\\.\\.\\. is waiting for you$"

/** Boots session 0 of a fresh office; `width` widens the screen for a long line. */
async function boot(width = 100) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width, height: 30 })
  await app.until((f) => f.includes("@minh auto ·") && f.includes(SHORTCUTS))
  return { office, sid: s.id, app }
}

let n = 0
/** Adds an instrument to session `sid`, as its host does: a running pipes shell unless `fields` say otherwise. */
function add(office: FakeOffice, sid: string, fields: Partial<Instrument> = {}) {
  const id = `01JA1H000000000000000000${String(++n).padStart(2, "0")}`
  return office.addInstrument(sid, {
    id,
    session_id: sid,
    kind: "terminal",
    name: `shell ${n}`,
    driver: "minh",
    profile: "workspace",
    interactive: false,
    status: "running",
    created_at: AT,
    updated_at: AT,
    ...fields,
  })
}

/** The line under the prompt: the row below the prompt's bottom edge, its trailing blanks cut. */
function line(f: string) {
  const rows = f.split("\n")
  const edge = rows.findIndex((r) => r.trimStart().startsWith("╹▀"))
  if (edge < 0) throw new Error("no prompt on screen:\n" + f)
  return rows[edge + 1]!.trimEnd()
}

const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
/** The foreground of the first span holding `needle` on the line under the prompt. */
function fgOf(app: App, needle: string) {
  const lines = app.setup.captureSpans().lines
  const edge = lines.findIndex((l) => text(l).trimStart().startsWith("╹▀"))
  return lines[edge + 1]?.spans.find((s) => s.text.includes(needle))?.fg
}

test("with no instruments the line is as before", async () => {
  const { office, sid, app } = await boot()
  try {
    expect(line(app.frame())).toBe(IDLE)
    office.updateSession(sid, { status: "busy" })
    const f = await app.until((f) => f.includes("esc interrupt"))
    expect(line(f)).toMatch(new RegExp(`^   \\S+ esc interrupt${ENDS_WITH_SHORTCUTS}`))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the line counts the running shells and sessions by kind", async () => {
  const { office, sid, app } = await boot(120)
  try {
    add(office, sid)
    let f = await app.until((f) => line(f).includes("/tmp/proj · 1 shell"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 1 shell${ENDS_WITH_SHORTCUTS}`))
    add(office, sid, { status: "idle" })
    add(office, sid, { kind: "codex", name: "codex 1", profile: "harness" })
    const claude = add(office, sid, { kind: "claude", name: "claude 1", profile: "harness", status: "starting" })
    f = await app.until((f) => line(f).includes("2 shells"))
    expect(line(f)).toMatch(
      new RegExp(`^   /tmp/proj · 2 shells · 1 Codex session · 1 Claude Code session${ENDS_WITH_SHORTCUTS}`),
    )
    expect(fgOf(app, "2 shells")?.equals(theme.textMuted)).toBe(true)
    // One its host took out of the list leaves the count; while the session can be interrupted, the counts follow
    // "esc interrupt".
    office.removeInstrument(sid, claude.id)
    office.updateSession(sid, { status: "busy" })
    f = await app.until((f) => line(f).includes("esc interrupt"))
    expect(line(f)).toMatch(new RegExp(`^   \\S+ esc interrupt · 2 shells · 1 Codex session${ENDS_WITH_SHORTCUTS}`))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a failed instrument is counted as failed", async () => {
  const { office, sid, app } = await boot(120)
  try {
    add(office, sid)
    add(office, sid, { status: "failed", error: "No sandbox here: install bubblewrap" })
    let f = await app.until((f) => line(f).includes("1 failed"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 2 shells · 1 failed${ENDS_WITH_SHORTCUTS}`))
    expect(fgOf(app, "1 failed")?.equals(theme.error)).toBe(true)
    expect(fgOf(app, "2 shells")?.equals(theme.textMuted)).toBe(true)
    const codex = { kind: "codex", name: "codex 1", profile: "harness" } as const
    add(office, sid, { ...codex, status: "failed", error: "codex is missing" })
    f = await app.until((f) => line(f).includes("2 failed"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 2 shells · 1 Codex session · 2 failed${ENDS_WITH_SHORTCUTS}`))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a waiting shell shows what waits for you on the right, in place of the shortcuts", async () => {
  const { office, sid, app } = await boot()
  try {
    const ssh = add(office, sid, {
      profile: "ssh",
      interactive: true,
      size: { cols: 80, rows: 24 },
      status: "waiting",
      waiting: "secret",
      command: "ssh nhb25@misha.ycrc.yale.edu -t tmux attach",
    })
    let f = await app.until((f) => line(f).includes("is waiting for you"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 1 shell +${SSH_WAITS}`))
    expect(line(f)).not.toContain("shift+tab mode")
    expect(line(f)).not.toContain("commands")
    expect(fgOf(app, "⚠")?.equals(theme.warning)).toBe(true)
    expect(fgOf(app, "is waiting for you")?.equals(theme.warning)).toBe(true)

    // Once it no longer waits, the shortcuts come back. It opened itself and took the view's size, so the change
    // comes after that.
    add(office, sid, { ...ssh, status: "running", waiting: null, updated_at: new Date(Date.now() + 1).toISOString() })
    f = await app.until((f) => line(f).includes(SHORTCUTS))
    expect(line(f)).not.toContain("⚠")

    // With no command, it's named; a short command shows whole.
    add(office, sid, { status: "waiting", waiting: "approval" })
    f = await app.until((f) => line(f).includes("is waiting for you"))
    expect(line(f)).toMatch(/· 2 shells +⚠ shell \d+ is waiting for you$/)
    // The oldest waiting one shows first.
    add(office, sid, {
      ...ssh,
      status: "waiting",
      waiting: "secret",
      command: "sudo apt update",
      updated_at: new Date(Date.now() + 1).toISOString(),
    })
    f = await app.until((f) => line(f).includes("⚠ sudo apt update is waiting for you"))
    expect(line(f)).toMatch(/· 2 shells +⚠ sudo apt update is waiting for you$/)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("what waits draws a command's escapes and control characters harmlessly, and a blank one by name", async () => {
  const { office, sid, app } = await boot()
  try {
    const shell = add(office, sid, {
      status: "waiting",
      waiting: "approval",
      command: "printf '\x1b[31mred\x1b[0m\x07' && ssh h",
    })
    let f = await app.until((f) => line(f).includes("is waiting for you"))
    expect(line(f)).toMatch(/· 1 shell +⚠ printf 'red' && ssh h is waiting for you$/)
    expect(f).not.toContain("\x1b")
    expect(f).not.toContain("[31m")
    add(office, sid, { ...shell, name: "shell\x1b[2J\x07 9", command: " \n\t " })
    f = await app.until((f) => line(f).includes("⚠ shell 9 is waiting for you"))
    expect(line(f)).toMatch(/· 1 shell +⚠ shell 9 is waiting for you$/)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an ended shell leaves the count", async () => {
  const { office, sid, app } = await boot()
  try {
    const one = add(office, sid)
    const two = add(office, sid)
    await app.until((f) => line(f).includes("· 2 shells"))
    add(office, sid, { ...one, status: "ended" })
    let f = await app.until((f) => line(f).includes("· 1 shell") && !line(f).includes("2 shells"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 1 shell${ENDS_WITH_SHORTCUTS}`))
    add(office, sid, { ...two, status: "ended" })
    f = await app.until((f) => !line(f).includes("shell"))
    expect(line(f)).toBe(IDLE)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("on a narrow screen the counts give way, cut in the middle, and the rest of the line stays whole", async () => {
  const { office, sid, app } = await boot(80)
  try {
    add(office, sid)
    add(office, sid)
    add(office, sid, { kind: "codex", name: "codex 1", profile: "harness" })
    add(office, sid, { status: "failed", error: "No sandbox here: install bubblewrap" })
    add(office, sid, { kind: "claude", name: "claude 1", profile: "harness" })
    const f = await app.until((f) => line(f).includes("failed"))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 3 s.*\\.\\.\\..* failed${ENDS_WITH_SHORTCUTS}`))
    expect(f.split("\n").filter((r) => r.includes("/tmp/proj"))).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})


test("on a narrow screen what waits for you stays whole, and the counts give way", async () => {
  const { office, sid, app } = await boot(80)
  try {
    add(office, sid)
    add(office, sid)
    add(office, sid, { kind: "codex", name: "codex 1", profile: "harness" })
    add(office, sid, { status: "failed", error: "No sandbox here: install bubblewrap" })
    add(office, sid, { status: "waiting", waiting: "secret", command: "ssh nhb25@misha.ycrc.yale.edu -t tmux attach" })
    // The counts are cut to what fits beside the warning, here to their first and last letters.
    const f = await app.until((f) => line(f).includes("is waiting for you") && line(f).includes("4 ..."))
    expect(line(f)).toMatch(new RegExp(`^   /tmp/proj · 4 \\.\\.\\.\\S+  ${SSH_WAITS}`))
    expect(f.split("\n").filter((r) => r.includes("/tmp/proj"))).toHaveLength(1)
  } finally {
    await app.stop()
    office.stop()
  }
})
