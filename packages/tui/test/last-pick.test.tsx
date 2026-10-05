import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub } from "../script/stub"
import { Global } from "../src/core/global"
import { bootFrame } from "./fixture/frame"
import { until } from "./fixture/until"
import { typeInto } from "./routes/picker/type"

type App = Awaited<ReturnType<typeof bootFrame>>
type Office = ReturnType<typeof createFakeOffice>

const KEY = "start_on_last_pick"
// The app keeps both files under the preload's AGENT_CORP_HOME, which every test file shares.
const modelFile = () => path.join(Global.Path.state, "model.json")
const kvFile = () => path.join(Global.Path.state, "kv.json")
const kv = (): Record<string, unknown> => (existsSync(kvFile()) ? JSON.parse(readFileSync(kvFile(), "utf8")) : {})
/** Sets the setting in kv.json, or with `undefined` takes it out, keeping other tests' keys. */
function setting(value: boolean | undefined) {
  const { [KEY]: _, ...rest } = kv()
  mkdirSync(Global.Path.state, { recursive: true })
  writeFileSync(kvFile(), JSON.stringify(value === undefined ? rest : { ...rest, [KEY]: value }))
}
beforeEach(() => {
  rmSync(modelFile(), { force: true })
  setting(undefined)
})
// Later test files expect the default.
afterEach(() => setting(undefined))

/** Opens the seeded session (or home, with `home`), then runs `body` against it. */
async function run(office: Office, body: (app: App) => Promise<void>, opts: { home?: boolean } = {}) {
  const id = office.state.sessions[0].id
  const app = await bootFrame(createStub(office), opts.home ? {} : { sessionID: id }, { width: 100, height: 60 })
  try {
    await app.until((f) => f.includes("@minh"))
    await body(app)
  } finally {
    await app.stop()
    office.stop()
  }
}

/** Picks the model matching `search` with `/model`, then waits for the dialog to close. */
async function pick(app: App, search: string, model: string) {
  await app.input.typeText("/model")
  await app.until((f) => f.includes("Switch model"))
  app.input.pressEnter()
  await app.until((f) => f.includes("Select model") && f.includes("azure-2 (azure)") && !f.includes("listing…"))
  await typeInto(app, search)
  await app.until((f) => f.includes(model) && !f.includes("gpt-4.1"))
  app.input.pressEnter()
  await app.until((f) => !f.includes("Select model"))
}

/** Goes home with `/new`, unless already there, and sends `text`; returns the new chat's `POST /sessions` body. */
async function newChat(app: App, office: Office, text: string) {
  if (!app.frame().includes("Ask anything")) {
    await app.input.typeText("/new")
    await app.until((f) => f.includes("New session"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Ask anything"))
  }
  const before = office.state.sessions.length
  await app.input.typeText(text)
  app.input.pressEnter()
  await app.until((f) => f.includes(text) && /@minh · (starting|idle|busy)/.test(f))
  expect(office.state.sessions.length).toBe(before + 1)
  return office.requests.findLast((r) => r.method === "POST" && r.path === "/sessions")?.body
}

async function runCommand(app: App, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  await typeInto(app, title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
  await app.until((f) => !f.includes("Commands"))
}

test("by default a new chat leaves its model to the office, even after a /model pick", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await pick(app, "4o-mini", "gpt-4o-mini")
    await app.until((f) => f.includes("Next reply uses azure-2/gpt-4o-mini"))
    expect(await newChat(app, office, "hello again")).toEqual({ person: "minh", cwd: "/tmp/proj" })
  })
})

test("the palette entry turns the setting on and kv.json keeps it", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await runCommand(app, "Start new chats on my last pick")
    await until(() => kv()[KEY] === true)
    // Now the entry turns it off.
    await runCommand(app, "Stop starting new chats on my last pick")
    await until(() => kv()[KEY] === false)
  })
})

test("with it on, a new chat starts on the pick made in another chat", async () => {
  setting(true)
  const office = createFakeOffice()
  await run(office, async (app) => {
    await pick(app, "4o-mini", "gpt-4o-mini")
    await app.until((f) => f.includes("Next reply uses azure-2/gpt-4o-mini"))
    expect(await newChat(app, office, "hello again")).toEqual({
      person: "minh",
      cwd: "/tmp/proj",
      connection: "azure-2",
      model: "gpt-4o-mini",
    })
    // azure-2's own model, which the office stores as null.
    await app.until((f) => f.includes("gpt-4o-mini (azure-2)"))
  })
})

test("with it on, a pick on the home screen is what the next new chat starts on", async () => {
  setting(true)
  const office = createFakeOffice()
  await run(
    office,
    async (app) => {
      await pick(app, "o3", "o3-mini")
      const f = await app.until((f) => f.includes("The next new chat starts on azure-2/o3-mini"))
      expect(f).not.toContain("New chats start on the agent's model")
      expect(await newChat(app, office, "hello")).toEqual({
        person: "minh",
        cwd: "/tmp/proj",
        connection: "azure-2",
        model: "o3-mini",
      })
      await app.until((f) => f.includes("o3-mini (azure-2)"))
    },
    { home: true },
  )
})

test("the last pick is sent even when its connection isn't on the office, and the office's note shows", async () => {
  setting(true)
  await Bun.write(
    modelFile(),
    JSON.stringify({
      recent: [
        { connection: "gone", model: "o3-mini" },
        { connection: "azure-2", model: "gpt-4o-mini" },
      ],
      favorite: [],
    }),
  )
  const office = createFakeOffice()
  await run(
    office,
    async (app) => {
      // /model's Recent hides the pick, since the office's list doesn't have its connection.
      await app.input.typeText("/model")
      await app.until((f) => f.includes("Switch model"))
      app.input.pressEnter()
      const f = await app.until((f) => f.includes("Select model") && f.includes("azure-2 (azure)") && !f.includes("listing…"))
      expect(f).not.toContain("gone")
      app.input.pressEscape()
      await app.until((f) => !f.includes("Select model"))
      expect(await newChat(app, office, "hello")).toMatchObject({ connection: "gone", model: "o3-mini" })
      const note = "Your last pick 'gone' isn't on this office; this chat uses office/gpt-4o."
      const shown = await app.until((f) => f.includes(note))
      expect(shown.indexOf("@minh · ")).toBeLessThan(shown.indexOf(note))
    },
    { home: true },
  )
})
