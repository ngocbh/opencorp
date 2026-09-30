import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "../../../script/stub"
import { createOfficeClient } from "../../../src/office/client"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

/** Opens the seeded session, then the profile of its person with /profile. */
async function openProfile(office: ReturnType<typeof createFakeOffice>) {
  const app = await bootFrame(createStub(office), { sessionID: office.state.sessions[0].id })
  await app.until((f) => f.includes("@minh"))
  await app.input.typeText("/profile")
  await app.until((f) => f.includes("Open profile"))
  app.input.pressEnter()
  await app.until((f) => f.includes("Writes small, tested changes."))
  return app
}

async function run(office: ReturnType<typeof createFakeOffice>, body: (app: App) => Promise<void>) {
  const app = await openProfile(office)
  try {
    await body(app)
  } finally {
    await app.stop()
    office.stop()
  }
}

test("/profile shows the session person's profile and its version; Esc goes back", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    const version = office.state.profiles.minh.version
    const f = await app.until((f) => f.includes(version.slice(0, 7)))
    expect(f).toContain("@minh · profile")
    expect(f).not.toContain("over budget")
    app.input.pressEscape()
    await app.until((f) => !f.includes("@minh · profile") && f.includes("@minh · idle"))
  })
})

test("an over-budget profile says feedback can't be learned until it is shorter", async () => {
  const office = createFakeOffice({ profileMaxChars: 10 })
  await run(office, async (app) => {
    await app.until((f) => f.includes("Over budget") && f.includes("until it is shorter"))
  })
})

test("a profile.updated event from elsewhere shows the new text and version", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    const client = createOfficeClient({ socket: office.socket })
    const base = office.state.profiles.minh.version
    const next = await client.profiles.put("minh", { text: "# Minh\n\nNow writes docs too.\n", base_version: base })
    await app.until((f) => f.includes("Now writes docs too.") && f.includes(next.version.slice(0, 7)))
  })
})
