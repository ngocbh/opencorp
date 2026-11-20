// A local session: the TUI on a host with no office, opened on its one session as its owner. The session is the only
// route, with no home and no session list, and the TUI closes once the session is over, printing its epilogue.
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, seed } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

/** The home's logo, which only the home draws. */
const LOGO = "█  █ █▀▀█ █▀▀█ █▀▀▄ █    █▀▀█ █▀▀ █▀▀█"

/** A fake host serving the built-in agent's one session, and the TUI on it as a local session that ends when `end`
 *  is called. */
async function local() {
  const state = seed()
  state.people.push({ handle: "opencorp", name: "OpenCorp", kind: "agent", title: "Built-in agent", manager: null })
  const s = state.sessions[0]!
  Object.assign(s, { person: "opencorp", opened_by: "owner", office: "local" })
  const office = createFakeOffice({ seed: state })
  const until = Promise.withResolvers<string | undefined>()
  const app = await bootFrame({ ...createStub(office), local: { sessionID: s.id, until: until.promise } })
  return { office, s, app, end: until.resolve }
}

test("a local session opens on its chat with @opencorp auto and no home", async () => {
  const { office, s, app, end } = await local()
  try {
    const f = await app.until((frame) => frame.includes("@opencorp auto"))
    expect(f).not.toContain(LOGO)
    // Neither a new session nor the session list leaves it.
    for (const key of ["n", "l"]) {
      app.input.pressKey("x", { ctrl: true })
      app.input.pressKey(key)
      await Bun.sleep(100)
      await app.setup.renderOnce()
      expect(app.frame()).toContain("@opencorp auto")
      expect(app.frame()).not.toContain(LOGO)
      expect(app.frame()).not.toContain("Switch session")
    }
    // Its owner's messages go to that session.
    app.input.typeText("Learn how this machine reaches HQ")
    app.input.pressEnter()
    await app.until(() => office.requests.some((r) => r.method === "POST" && r.path === `/sessions/${s.id}/prompt`))
  } finally {
    end(undefined)
    await app.stop()
    office.stop()
  }
})

test("the session's end closes the TUI with its epilogue", async () => {
  const write = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  const { office, app, end } = await local()
  try {
    await app.until((frame) => frame.includes("@opencorp auto"))
    end("Learning ended.")
    await app.until(() => app.setup.renderer.isDestroyed)
    await app.stop()
    expect(stdout).toContain("Learning ended.")
    // Not the session's own: a local session can't be resumed.
    expect(stdout).not.toContain("opencorp -s")
  } finally {
    process.stdout.write = write
    office.stop()
  }
})
