// The overlay over every screen while the TUI reconnects to the office. Before the first connection home's own notes
// say why it waits instead, and any other screen gets the overlay only after a longer grace.
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../fixture/fake-office"
import { bootFrame } from "../fixture/frame"

const LOST = "Connection lost…"
/** How long the connection stays down before the overlay shows, as the app waits: after a drop, and before the first
 *  connection. */
const GRACE_MS = 1000
const FIRST_GRACE_MS = 5000
const PAST_GRACE_MS = GRACE_MS + 300

type App = Awaited<ReturnType<typeof bootFrame>>

/** Renders for `ms`, failing if the overlay shows meanwhile. */
async function absentFor(app: App, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain(LOST)
  }
}

test("before the TUI was ever online, home shows no overlay for a slow first connection or a missing office", async () => {
  // The office takes the stream but holds its state past the grace, so the TUI stays connecting.
  const office = createFakeOffice()
  const release = office.hold("GET /people")
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("Ask anything"))
    await absentFor(app, PAST_GRACE_MS)
    expect(app.frame()).not.toContain("Office is not running")
  } finally {
    release()
    await app.stop()
    office.stop()
  }
  const away = await bootFrame(createStub())
  try {
    await away.until((f) => f.includes("Office is not running"))
    await absentFor(away, PAST_GRACE_MS)
  } finally {
    await away.stop()
  }
}, 15_000)

test("a chat opened before the first connection shows the overlay after the first grace, and home doesn't", async () => {
  const app = await bootFrame(createStub(), { sessionID: "00000000000000000000000001" })
  try {
    // The overlay's timer starts once the TUI finds no office, a moment after it boots.
    await absentFor(app, FIRST_GRACE_MS - GRACE_MS)
    const f = await app.until((f) => f.includes(LOST), 5000)
    expect(f).toContain("Reconnecting to the office automatically.")
    // Home says why it waits instead.
    app.input.pressKey("x", { ctrl: true })
    app.input.pressKey("n")
    await app.until((f) => f.includes("Office is not running") && !f.includes(LOST))
    await absentFor(app, PAST_GRACE_MS)
  } finally {
    await app.stop()
  }
}, 20_000)

test("in a chat, a dropped connection shows the overlay past the grace, and it goes once the office is back", async () => {
  const socket = `/tmp/act-reconnect-${process.pid}.sock`
  let office = createFakeOffice({ socket })
  const s = office.state.sessions[0]!
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  const reads = () => office.requests.filter((r) => r.method === "GET" && r.path === "/people").length
  try {
    await app.until((f) => f.includes("@minh · idle"))
    // A drop the stream recovers from within the grace shows nothing.
    const before = reads()
    office.dropStreams()
    await app.until(() => reads() > before)
    await absentFor(app, PAST_GRACE_MS)

    // The office goes away: nothing within the grace, then the overlay.
    office.stop()
    await absentFor(app, 700)
    const f = await app.until((f) => f.includes(LOST), 3000)
    expect(f).toContain("Reconnecting to the office automatically.")

    office = createFakeOffice({ socket, seed: office.state })
    await app.until((f) => !f.includes(LOST) && f.includes("@minh · idle"), 8000)
  } finally {
    await app.stop()
    office.stop()
  }
}, 20_000)

test("after a drop, an office whose state can't be read shows why on the overlay, then recovers", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]!
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh · idle"))
    office.notImplemented.add("GET /people")
    office.dropStreams()
    const f = await app.until((f) => f.includes(LOST), 4000)
    expect(f).toContain("The office's state can't be read:")
    expect(f).toContain("not implemented")
    expect(f).not.toContain("Reconnecting to the office automatically.")
    office.notImplemented.clear()
    await app.until((f) => !f.includes(LOST) && f.includes("@minh · idle"), 8000)
  } finally {
    await app.stop()
    office.stop()
  }
}, 20_000)
