// A message the employee's run hasn't read yet: its left border grey, as upstream greys a pending delivery's, with no
// line under it; once the run reads it, it looks like any other message.
import type { LiveEvent, Message, Session } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { expect, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

const AT = "2026-11-23T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")

/** A message of session `sid` from the owner (a user message) or the employee. */
function message(sid: string, id: string, role: "user" | "assistant", text: string, unread = false): Message {
  return {
    id,
    session_id: sid,
    role,
    author: role === "user" ? "ngocbh" : null,
    unread,
    created_at: AT,
    parts: [{ id: `${id}:0`, type: "text", text }],
  }
}

/** Boots session 0 in `status` with the owner's message, the employee's reply so far, and the owner's steer, unread. */
async function boot(status: Session["status"], fields: Partial<Session> = {}) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  Object.assign(s, { status, ...fields })
  const steer = message(s.id, "M3", "user", "Also mention Rome.", true)
  office.state.messages[s.id] = [
    message(s.id, "M1", "user", "Plan the trip."),
    message(s.id, "M2", "assistant", "Looking at flights."),
    steer,
  ]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 100, height: 30 })
  return { office, app, s, steer }
}

/** The foreground of the left border on the row holding `needle`. */
function border(lines: CapturedLine[], needle: string) {
  const line = lines.find((l) => l.spans.some((span) => span.text.includes(needle)))
  if (!line) throw new Error(`${needle} isn't on screen`)
  return line.spans.find((span) => span.text.includes("┃"))?.fg
}

/** The rows of `frame` from the one showing `text` to the end of its message's box: the row whose left border ends. */
function messageRows(frame: string, text: string) {
  const rows = frame.split("\n")
  const start = rows.findIndex((r) => r.includes(text))
  const end = rows.findIndex((r, y) => y > start && !r.includes("┃"))
  return rows.slice(start, end)
}

test("an unread message has a grey border and nothing under its text, and looks as any other once read", async () => {
  const { office, app, s, steer } = await boot("busy")
  try {
    // The session's status reaches the view a frame after the message.
    const f = await app.until((f) => f.includes("Also mention Rome.") && f.includes("@minh · busy"))
    // Its box holds its text and nothing else: no hint line.
    expect(messageRows(f, "Also mention Rome.").slice(1).every((r) => r.replace("┃", "").trim() === "")).toBe(true)
    // The only word of it is the prompt's: ↑ takes it back.
    expect(f).toContain("Press ↑ to edit unread messages")
    expect(f.replace("Press ↑ to edit unread messages", "")).not.toContain("unread")
    expect(f).not.toContain("esc to interrupt so")
    const spans = app.setup.captureSpans().lines
    expect(border(spans, "Also mention Rome.")).toEqual(theme.border)
    expect(border(spans, "Plan the trip.")).toEqual(theme.secondary)
    // Its text keeps the text colour.
    const fg = (needle: string) =>
      spans.flatMap((line) => line.spans).find((span) => span.text.includes(needle))?.fg
    expect(fg("Also mention Rome.")).toEqual(theme.text)
    // The run reads it: the office sends it again, read, under its id.
    const read = { ...steer, unread: false } as unknown as LiveEvent["data"]
    office.live({ type: "message.updated", session_id: s.id, data: read })
    await app.until(() => border(app.setup.captureSpans().lines, "Also mention Rome.")?.equals(theme.secondary) === true)
    expect(messageRows(app.frame(), "Also mention Rome.")).toEqual(messageRows(f, "Also mention Rome."))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("over the cost cap an unread message is grey too, with nothing under it", async () => {
  const { office, app } = await boot("waiting", { capped: true })
  try {
    const f = await app.until((f) => f.includes("cost cap reached") && f.includes("Also mention Rome."))
    expect(f.replace("Press ↑ to edit unread messages", "")).not.toContain("unread")
    expect(border(app.setup.captureSpans().lines, "Also mention Rome.")).toEqual(theme.border)
  } finally {
    await app.stop()
    office.stop()
  }
})
