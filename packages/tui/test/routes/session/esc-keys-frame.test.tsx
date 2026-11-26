// Esc and Ctrl+C in a chat, as Claude Code's: while the employee works, Esc and Ctrl+C interrupt them and keep the
// draft, and the person's unread and queued messages stay for the next turn; idle, Esc does nothing on one press and
// Esc Esc clears the draft into the history, and Ctrl+C clears the draft, or on an empty prompt asks to be pressed
// again to leave.
import type { Message, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

const AT = "2026-11-26T10:00:00.000Z"

/** A message of session `sid` from the owner (a user message) or the employee, unread or queued as `waits` says. */
function message(
  sid: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  waits: Pick<Message, "unread" | "queued"> = {},
): Message {
  return {
    id,
    session_id: sid,
    role,
    author: role === "user" ? "ngocbh" : null,
    created_at: AT,
    parts: [{ id: `${id}:0`, type: "text", text }],
    ...waits,
  }
}

/** Boots session 0 in `status`, on the owner's message and the employee's reply so far, with `more` after them. */
async function boot(status: Session["status"], more: (sid: string) => Message[] = () => []) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  Object.assign(s, { status })
  office.state.messages[s.id] = [
    message(s.id, "M1", "user", "Plan the trip."),
    message(s.id, "M2", "assistant", "Looking at flights."),
    ...more(s.id),
  ]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 100, height: 30 })
  await app.until((f) => f.includes("Looking at flights.") && f.includes(`@minh · ${status}`))
  const interrupts = () => office.requests.filter((r) => r.path === `/sessions/${s.id}/interrupt`).length
  /** The requests that take one of the session's messages back or move it. */
  const takes = () =>
    office.requests.filter((r) => r.path.startsWith(`/sessions/${s.id}/inbox/`)).map((r) => [r.method, r.path])
  return { office, app, s, interrupts, takes }
}

test("working, with a draft: Esc interrupts the turn and keeps the draft", async () => {
  const { office, app, interrupts } = await boot("busy")
  try {
    await app.until((f) => f.includes("esc to interrupt"))
    await app.input.typeText("half a thought")
    await app.until((f) => f.includes("half a thought"))
    app.input.pressEscape()
    await until(() => interrupts() === 1)
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).toContain("half a thought")
    // Typing goes on after it.
    await app.input.typeText(" and more")
    await app.until((f) => f.includes("half a thought and more"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("working, with unread and queued messages: Esc interrupts, and they stay for the next turn, not taken back", async () => {
  const { office, app, s, interrupts, takes } = await boot("busy", (sid) => [
    message(sid, "M3", "user", "Also mention Rome.", { unread: true }),
    message(sid, "Q1", "user", "Then book the hotel.", { unread: true, queued: true }),
  ])
  try {
    await app.until((f) => f.includes("Also mention Rome.") && f.includes("1 queued · Then book the hotel."))
    app.input.pressEscape()
    await until(() => interrupts() === 1)
    await Bun.sleep(100)
    const f = await app.until(() => true)
    expect(takes()).toEqual([])
    // Both still wait: the steer in the transcript, the queued one in the dock; the prompt stays empty.
    expect(f).toContain("Also mention Rome.")
    expect(f).toContain("1 queued · Then book the hotel.")
    // The next turn reads them.
    office.replyEnded(s.id)
    await app.until((f) => !f.includes("queued ·") && f.includes("Then book the hotel."))
    expect(takes()).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("working, nothing typed: Esc interrupts", async () => {
  const { office, app, interrupts } = await boot("busy")
  try {
    await app.until((f) => f.includes("esc to interrupt"))
    app.input.pressEscape()
    await until(() => interrupts() === 1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("idle, with a draft: one Esc keeps it and says esc again to clear; Esc Esc clears it into the history", async () => {
  const { office, app, interrupts } = await boot("idle")
  try {
    await app.input.typeText("an idle draft to keep")
    await app.until((f) => f.includes("an idle draft to keep"))
    app.input.pressEscape()
    let f = await app.until((f) => f.includes("esc again to clear"))
    expect(f).toContain("an idle draft to keep")
    // Typing after it starts over: the next Esc only asks again.
    await app.input.typeText("!")
    await app.until((f) => f.includes("an idle draft to keep!") && !f.includes("esc again to clear"))
    app.input.pressEscape()
    await app.until((f) => f.includes("esc again to clear"))
    app.input.pressEscape()
    f = await app.until((f) => !f.includes("an idle draft to keep!"))
    expect(f).not.toContain("esc again to clear")
    expect(interrupts()).toBe(0)
    // ↑ brings it back from the history.
    app.input.pressArrow("up")
    await app.until((f) => f.includes("an idle draft to keep!"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("idle, with a draft: the hint goes once the second Esc is too late, and the draft stays", async () => {
  const { office, app } = await boot("idle")
  try {
    await app.input.typeText("a slow draft")
    await app.until((f) => f.includes("a slow draft"))
    app.input.pressEscape()
    await app.until((f) => f.includes("esc again to clear"))
    await app.until((f) => !f.includes("esc again to clear"), 3000)
    app.input.pressEscape()
    const f = await app.until((f) => f.includes("esc again to clear"))
    expect(f).toContain("a slow draft")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("idle, the prompt empty: Esc and Esc Esc do nothing", async () => {
  const { office, app, interrupts } = await boot("idle")
  try {
    app.input.pressEscape()
    app.input.pressEscape()
    await Bun.sleep(150)
    const f = await app.until(() => true)
    expect(interrupts()).toBe(0)
    expect(f).not.toContain("esc again to clear")
    expect(f).not.toContain("Press again to leave")
    expect(app.setup.renderer.isDestroyed).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("working, with a draft: Ctrl+C interrupts the turn and keeps the draft", async () => {
  const { office, app, interrupts } = await boot("busy")
  try {
    await app.until((f) => f.includes("esc to interrupt"))
    await app.input.typeText("hold this")
    await app.until((f) => f.includes("hold this"))
    app.input.pressKey("c", { ctrl: true })
    await until(() => interrupts() === 1)
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).toContain("hold this")
    expect(app.frame()).not.toContain("Press again to leave")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("working, the prompt empty: Ctrl+C interrupts and never counts toward leaving", async () => {
  const { office, app, s, interrupts } = await boot("busy")
  try {
    await app.until((f) => f.includes("esc to interrupt"))
    app.input.pressKey("c", { ctrl: true })
    await until(() => interrupts() === 1)
    app.input.pressKey("c", { ctrl: true })
    await until(() => interrupts() === 2)
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Press again to leave")
    expect(app.setup.renderer.isDestroyed).toBe(false)
    // Once the employee rests, Ctrl+C asks to be pressed again, and the second leaves.
    office.setStatus(s.id, "idle")
    await app.until((f) => f.includes("@minh · idle"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => f.includes("Press again to leave"))
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(interrupts()).toBe(2)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("idle, with a draft: Ctrl+C clears it into the history, and ↑ brings it back", async () => {
  const { office, app, interrupts } = await boot("idle")
  try {
    await app.input.typeText("short one")
    await app.until((f) => f.includes("short one"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("short one"))
    expect(interrupts()).toBe(0)
    app.input.pressArrow("up")
    await app.until((f) => f.includes("short one"))
  } finally {
    await app.stop()
    office.stop()
  }
})
