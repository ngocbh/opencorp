// Upstream's pending and queued prompts: `<leader>return` queues the prompt for the next turn, which the running reply
// never reads; what is queued waits in a dock above the prompt (`N queued · <next>`), whose dialog steers one now,
// deletes it, or puts it back in the prompt; and a click on the owner's own grey, unread steer opens "Pending steer",
// which moves it to the queue or deletes it.
import type { LiveEvent, Message, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

const AT = "2026-11-24T10:00:00.000Z"

type App = Awaited<ReturnType<typeof bootFrame>>

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

/** Boots session 0, busy on the owner's message and the employee's reply so far, with `more` after them. */
async function boot(more: (sid: string) => Message[] = () => [], fields: Partial<Session> = {}) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  Object.assign(s, { status: "busy", ...fields })
  office.state.messages[s.id] = [
    message(s.id, "M1", "user", "Plan the trip."),
    message(s.id, "M2", "assistant", "Looking at flights."),
    ...more(s.id),
  ]
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 100, height: 30 })
  await app.until((f) => f.includes("Looking at flights.") && f.includes("@minh · busy"))
  return { office, app, s }
}

/** The screen row holding `needle`, and where it starts. */
function at(f: string, needle: string) {
  const rows = f.split("\n")
  const y = rows.findIndex((r) => r.includes(needle))
  if (y < 0) throw new Error(`${needle} isn't on screen:\n` + f)
  return { x: rows[y]!.indexOf(needle), y }
}

/** How many rows of `f` hold `needle`. */
const rowsWith = (f: string, needle: string) => f.split("\n").filter((r) => r.includes(needle)).length

/** The office's requests to `path`, as method and body. */
const sent = (office: ReturnType<typeof createFakeOffice>, path: string) =>
  office.requests.filter((r) => r.path === path).map((r) => [r.method, r.body ?? null])

/** Clicks the row holding `needle`, `dx` cells into it: a click within a cell of the last is a double click, which
 *  selects a word. */
async function click(app: App, needle: string, dx = 1) {
  const where = at(app.frame(), needle)
  await app.setup.mockMouse.click(where.x + dx, where.y)
}

test("ctrl+x enter queues the prompt: it waits in the dock above the prompt, not the transcript, until a turn takes it", async () => {
  const { office, app, s } = await boot()
  try {
    app.input.typeText("Then book the hotel.")
    await app.until((f) => f.includes("Then book the hotel."))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressEnter()
    let f = await app.until((f) => f.includes("1 queued · Then book the hotel."))
    expect(sent(office, `/sessions/${s.id}/queue`)).toEqual([["POST", { text: "Then book the hotel." }]])
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([])
    // The prompt is clear, and the message shows only in the dock, above the prompt.
    expect(rowsWith(f, "Then book the hotel.")).toBe(1)
    expect(at(f, "1 queued").y).toBeGreaterThan(at(f, "Looking at flights.").y)
    // The reply ends: the next turn takes it, and it joins the transcript as any message.
    office.replyEnded(s.id)
    f = await app.until((f) => !f.includes("queued ·") && f.includes("Then book the hotel."))
    expect(rowsWith(f, "Then book the hotel.")).toBe(1)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a word that quits or a command can't be queued, and says so", async () => {
  const { office, app, s } = await boot()
  try {
    app.input.typeText("quit")
    await app.until((f) => f.includes("quit"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressEnter()
    await app.until((f) => f.includes("This prompt cannot be queued"))
    expect(sent(office, `/sessions/${s.id}/queue`)).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the dock counts what is queued and names the next; its dialog steers one now, deletes one, or undoes one", async () => {
  const { office, app, s } = await boot((sid) => [
    message(sid, "Q1", "user", "Then book the hotel.", { unread: true, queued: true }),
    message(sid, "Q2", "user", "And a car.", { unread: true, queued: true }),
    message(sid, "Q3", "user", "Window seats.", { unread: true, queued: true }),
  ])
  try {
    let f = await app.until((f) => f.includes("3 queued · Then book the hotel."))
    expect(f).not.toContain("And a car.")
    await click(app, "3 queued")
    f = await app.until((f) => f.includes("Queued prompts") && f.includes("Window seats."))
    expect(f).toContain("1 of 3")
    expect(f).toContain("delete")
    expect(f).toContain("undo")
    expect(f).toContain("steer")
    // Enter steers the first now: it leaves the queue for the running reply.
    app.input.pressEnter()
    f = await app.until((f) => !f.includes("Queued prompts") && f.includes("2 queued · And a car."))
    expect(sent(office, `/sessions/${s.id}/inbox/Q1`)).toEqual([["PATCH", { delivery: "steer" }]])
    // It shows in the transcript now, unread, as a steer.
    expect(at(f, "Then book the hotel.").y).toBeLessThan(at(f, "2 queued").y)
    // Ctrl+D deletes the highlighted one, and the dialog stays while others are queued.
    await click(app, "2 queued", 5)
    await app.until((f) => f.includes("Queued prompts") && f.includes("Window seats."))
    app.input.pressKey("d", { ctrl: true })
    f = await app.until((f) => f.includes("Queued prompts") && !f.includes("And a car."))
    expect(sent(office, `/sessions/${s.id}/inbox/Q2`)).toEqual([["DELETE", null]])
    // Ctrl+U takes the last back into the prompt.
    app.input.pressKey("u", { ctrl: true })
    f = await app.until((f) => !f.includes("Queued prompts") && !f.includes("queued ·") && f.includes("Window seats."))
    expect(sent(office, `/sessions/${s.id}/inbox/Q3`)).toEqual([["DELETE", null]])
    // It is the prompt's text now: Enter sends it as a steer.
    app.input.pressEnter()
    await app.until(() => sent(office, `/sessions/${s.id}/prompt`).length > 0)
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([["POST", { text: "Window seats." }]])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Enter on an empty prompt steers the first queued message, as upstream's", async () => {
  const { office, app, s } = await boot((sid) => [
    message(sid, "Q1", "user", "Then book the hotel.", { unread: true, queued: true }),
  ])
  try {
    await app.until((f) => f.includes("1 queued · Then book the hotel."))
    app.input.pressEnter()
    await app.until((f) => !f.includes("queued ·"))
    expect(sent(office, `/sessions/${s.id}/inbox/Q1`)).toEqual([["PATCH", { delivery: "steer" }]])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a click on the owner's own unread steer opens Pending steer, which moves it to the queue or deletes it", async () => {
  const { office, app, s } = await boot((sid) => [
    message(sid, "M3", "user", "Also mention Rome.", { unread: true }),
    message(sid, "M4", "user", "And Florence.", { unread: true }),
  ])
  try {
    await app.until((f) => f.includes("And Florence."))
    await click(app, "Also mention Rome.")
    let f = await app.until((f) => f.includes("Pending steer"))
    expect(f).toContain("Move to queue")
    expect(f).toContain("Delete")
    app.input.pressEnter()
    f = await app.until((f) => !f.includes("Pending steer") && f.includes("1 queued · Also mention Rome."))
    expect(sent(office, `/sessions/${s.id}/inbox/M3`)).toEqual([["PATCH", { delivery: "queue" }]])
    expect(rowsWith(f, "Also mention Rome.")).toBe(1)
    await click(app, "And Florence.", 5)
    await app.until((f) => f.includes("Pending steer"))
    app.input.pressArrow("down")
    await app.setup.renderOnce()
    app.input.pressEnter()
    await app.until((f) => !f.includes("Pending steer") && !f.includes("And Florence."))
    expect(sent(office, `/sessions/${s.id}/inbox/M4`)).toEqual([["DELETE", null]])
    // A message the run has read opens the message's own actions, as before.
    await click(app, "Plan the trip.", 9)
    f = await app.until((f) => f.includes("Copy") || f.includes("copy"))
    expect(f).not.toContain("Pending steer")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a steer read meanwhile can't be moved: the office says so, and the message stays", async () => {
  const { office, app, s } = await boot((sid) => [message(sid, "M3", "user", "Also mention Rome.", { unread: true })])
  try {
    await app.until((f) => f.includes("Also mention Rome."))
    await click(app, "Also mention Rome.")
    await app.until((f) => f.includes("Pending steer"))
    // The run reads it before the move reaches the office.
    const read = { ...office.state.messages[s.id]!.at(-1)!, unread: false }
    office.state.messages[s.id] = [...office.state.messages[s.id]!.slice(0, -1), read]
    office.live({ type: "message.updated", session_id: s.id, data: read as unknown as LiveEvent["data"] })
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Failed to queue pending prompt"))
    expect(f).toContain("already read")
    expect(f).not.toContain("queued ·")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a move whose send fails after the run took it back says why, and puts the text back in the prompt", async () => {
  const { office, app, s } = await boot((sid) => [message(sid, "M3", "user", "Also mention Rome.", { unread: true })])
  try {
    await app.until((f) => f.includes("Also mention Rome."))
    office.moveFailures.push("lost")
    await click(app, "Also mention Rome.")
    await app.until((f) => f.includes("Pending steer"))
    app.input.pressEnter()
    const f = await app.until(
      (f) => f.includes("Failed to queue pending prompt") && f.includes("back in the prompt") && !f.includes("Pending steer"),
    )
    expect(f).toContain("the session is ending")
    expect(sent(office, `/sessions/${s.id}/inbox/M3`)).toEqual([["PATCH", { delivery: "queue" }]])
    // Gone from the transcript, and in the prompt for Enter to send again.
    expect(f).not.toContain("queued ·")
    await app.until((f) => rowsWith(f, "Also mention Rome.") === 1)
    app.input.pressEnter()
    await app.until(() => sent(office, `/sessions/${s.id}/prompt`).length > 0)
    expect(sent(office, `/sessions/${s.id}/prompt`)).toEqual([["POST", { text: "Also mention Rome." }]])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("someone else's queued message stays in the transcript, grey; the dock and Enter on an empty prompt are yours", async () => {
  const { office, app, s } = await boot((sid) => [
    { ...message(sid, "Q1", "user", "Lan's later.", { unread: true, queued: true }), author: "lan" },
  ])
  try {
    const f = await app.until((f) => f.includes("Lan's later."))
    expect(f).not.toContain("queued ·")
    // Nothing of yours waits: Enter on an empty prompt asks the office nothing.
    app.input.pressEnter()
    await Bun.sleep(100)
    expect(office.requests.filter((r) => r.path.startsWith(`/sessions/${s.id}/inbox/`))).toEqual([])
    // A click opens the message's own actions, not Pending steer.
    await click(app, "Lan's later.")
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain("Pending steer")
  } finally {
    await app.stop()
    office.stop()
  }
})
