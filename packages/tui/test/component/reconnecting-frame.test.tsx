// The overlay over every screen while the TUI reconnects to an office it was connected to. Before it was ever
// online, home's own notes say why it waits instead.
import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../fixture/fake-office"
import { bootFrame } from "../fixture/frame"

const LOST = "Connection lost…"
/** How long the connection stays down before the overlay shows, as the app waits; the tests wait a little longer. */
const GRACE_MS = 1000
const PAST_GRACE_MS = GRACE_MS + 300

test("before the TUI was ever online, a slow first connection or a missing office shows no overlay", async () => {
  // The office takes the stream but holds its state past the grace, so the TUI stays connecting.
  const office = createFakeOffice()
  const release = office.hold("GET /people")
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("Ask anything"))
    await Bun.sleep(PAST_GRACE_MS)
    const f = await app.until((f) => f.includes("Ask anything"))
    expect(f).not.toContain(LOST)
    expect(f).not.toContain("Office is not running")
  } finally {
    release()
    await app.stop()
    office.stop()
  }
  const away = await bootFrame(createStub())
  try {
    await away.until((f) => f.includes("Office is not running"))
    await Bun.sleep(PAST_GRACE_MS)
    const f = await away.until((f) => f.includes("Office is not running"))
    expect(f).not.toContain(LOST)
  } finally {
    await away.stop()
  }
}, 15_000)

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
    await Bun.sleep(PAST_GRACE_MS)
    expect(await app.until((f) => f.includes("@minh · idle"))).not.toContain(LOST)

    // The office goes away: nothing at once, then the overlay.
    office.stop()
    await app.setup.renderOnce()
    expect(app.frame()).not.toContain(LOST)
    const f = await app.until((f) => f.includes(LOST), 3000)
    expect(f).toContain("Reconnecting to the office automatically.")

    office = createFakeOffice({ socket, seed: office.state })
    await app.until((f) => !f.includes(LOST) && f.includes("@minh · idle"), 8000)
  } finally {
    await app.stop()
    office.stop()
  }
}, 20_000)
