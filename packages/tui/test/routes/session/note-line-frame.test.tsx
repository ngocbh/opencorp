// A note from the office in the transcript, such as a command of the employee's that ended: one line, `↳` and the
// note's first line, as the upstream TUI shows a background command's end; a click opens the whole note under it and
// closes it again.
import { type Message, OFFICE } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { expect, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

const AT = "2026-11-22T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")

const HEADING = "shell 1: `make test` ended, exit 2"
const NOTE = [
  HEADING,
  "It ran for 4m12s. Its last lines:",
  "```",
  "$ make test",
  "FAIL src/app.test.ts",
  "```",
  "[You haven't read its output before these lines: call terminal_read on shell 1 from 120.]",
].join("\n")

/** A message of session `sid`: from the owner, the employee, or the office. */
function message(sid: string, id: string, role: "user" | "assistant", text: string, author: string | null = null): Message {
  return { id, session_id: sid, role, author, created_at: AT, parts: [{ id: `${id}:0`, type: "text", text }] }
}

/** Boots session 0 with the owner's message, the employee's reply, the office's note and the employee's next reply,
 *  on a screen `width` columns wide. */
async function boot(width = 100) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.state.messages[s.id] = [
    message(s.id, "M1", "user", "run the tests", "ngocbh"),
    message(s.id, "M2", "assistant", "Started them; I'll wait."),
    message(s.id, "M3", "user", NOTE, OFFICE),
    message(s.id, "M4", "assistant", "The tests failed in app.test.ts."),
  ]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width, height: 30 })
  return { office, app }
}

/** The screen row holding `needle`, and where it starts. */
function at(f: string, needle: string) {
  const rows = f.split("\n")
  const y = rows.findIndex((r) => r.includes(needle))
  if (y < 0) throw new Error(`${needle} isn't on screen:\n` + f)
  return { x: rows[y]!.indexOf(needle), y }
}

/** The foreground of the first span holding `needle` in `lines`. */
function fg(lines: CapturedLine[], needle: string) {
  return lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))?.fg
}

test("a note shows as one line in the info colour, and a click opens the whole note and closes it again", async () => {
  const { office, app } = await boot()
  try {
    let f = await app.until((f) => f.includes("The tests failed in app.test.ts."))
    expect(f).toContain(`↳ ${HEADING}`)
    // One line: the rest of the note stays closed, and no person's box or name is drawn for it.
    expect(f).not.toContain("It ran for 4m12s")
    expect(f).not.toContain("FAIL src/app.test.ts")
    expect(f).not.toContain("@office")
    expect(fg(app.setup.captureSpans().lines, HEADING)).toEqual(theme.info)
    const line = at(f, HEADING)
    await app.setup.mockMouse.click(line.x + 2, line.y)
    f = await app.until((f) => f.includes("FAIL src/app.test.ts"))
    expect(f).toContain("It ran for 4m12s. Its last lines:")
    expect(f).toContain("call terminal_read on shell 1 from 120.")
    // Under the line, in order.
    expect(at(f, HEADING).y).toBeLessThan(at(f, "It ran for 4m12s").y)
    expect(at(f, "FAIL src/app.test.ts").y).toBeLessThan(at(f, "The tests failed").y)
    // Ten cells along the line: a click more than a cell from the last is never a double click, which selects a word.
    await app.setup.mockMouse.click(line.x + 12, at(f, HEADING).y)
    f = await app.until((f) => !f.includes("FAIL src/app.test.ts"))
    expect(f).toContain(`↳ ${HEADING}`)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a note's line is cut in its middle to the screen's width, never wrapped, so its exit still shows", async () => {
  const { office, app } = await boot(32)
  try {
    const f = await app.until((f) => f.includes("↳ shell 1"))
    const rows = f.split("\n")
    const row = rows.find((r) => r.includes("↳ shell 1"))!
    expect(row).toMatch(/↳ shell 1: .*\.\.\..*exit 2/)
    expect(rows.filter((r) => r.includes("ended") || r.includes("exit 2"))).toEqual([row])
  } finally {
    await app.stop()
    office.stop()
  }
})
