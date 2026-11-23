// A message the employee's run hasn't read yet: its left border grey, as upstream greys a pending delivery's, and a
// muted line saying it is unread and what Esc does; once the run reads it, it looks like any other message.
import type { LiveEvent, Message, Session } from "@opencorp/protocol"
import type { CapturedLine } from "@opentui/core"
import { expect, test } from "bun:test"
import { DEFAULT_THEME, DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

const AT = "2026-11-23T10:00:00.000Z"
const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME]!, "dark")
const HINT = "unread · esc to interrupt so it's read now"

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

test("an unread message has a grey border and says so with what Esc does, and looks as any other once read", async () => {
  const { office, app, s, steer } = await boot("busy")
  try {
    // The hint names Esc once the session's status reaches the view, which may be a frame after the message.
    const f = await app.until((f) => f.includes(HINT))
    // The hint is under its own message only.
    const rows = f.split("\n")
    expect(rows.findIndex((r) => r.includes(HINT))).toBe(rows.findIndex((r) => r.includes("Also mention Rome.")) + 1)
    expect(rows.filter((r) => r.includes("unread"))).toHaveLength(1)
    const spans = app.setup.captureSpans().lines
    expect(border(spans, "Also mention Rome.")).toEqual(theme.border)
    expect(border(spans, "Plan the trip.")).toEqual(theme.secondary)
    // Its text keeps the text colour; the hint is muted.
    const fg = (needle: string) =>
      spans.flatMap((line) => line.spans).find((span) => span.text.includes(needle))?.fg
    expect(fg("Also mention Rome.")).toEqual(theme.text)
    expect(fg("unread")).toEqual(theme.textMuted)
    // The run reads it: the office sends it again, read, under its id.
    const read = { ...steer, unread: false } as unknown as LiveEvent["data"]
    office.live({ type: "message.updated", session_id: s.id, data: read })
    const after = await app.until((f) => !f.includes("unread"))
    expect(after).toContain("Also mention Rome.")
    expect(border(app.setup.captureSpans().lines, "Also mention Rome.")).toEqual(theme.secondary)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an unread message names no key while Esc can't stop anything: over the cost cap it waits for a raise", async () => {
  const { office, app } = await boot("waiting", { capped: true })
  try {
    const alone = (f: string) => {
      const rows = f.split("\n")
      return /┃\s+unread\s*$/.test(rows[rows.findIndex((r) => r.includes("Also mention Rome.")) + 1] ?? "")
    }
    const f = await app.until(alone)
    expect(f).not.toContain("esc to interrupt so")
    expect(border(app.setup.captureSpans().lines, "Also mention Rome.")).toEqual(theme.border)
  } finally {
    await app.stop()
    office.stop()
  }
})
