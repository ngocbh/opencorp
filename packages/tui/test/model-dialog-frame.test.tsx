import { beforeEach, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub } from "../script/stub"
import { Global } from "../src/core/global"
import type { CapturedLine } from "@opentui/core"
import { bootFrame } from "./fixture/frame"
import { typeInto } from "./routes/picker/type"

type App = Awaited<ReturnType<typeof bootFrame>>
type Office = ReturnType<typeof createFakeOffice>

// The app keeps model.json under the preload's AGENT_CORP_HOME; each test starts without one.
const modelFile = () => path.join(Global.Path.state, "model.json")
const saved = () => (existsSync(modelFile()) ? readFileSync(modelFile(), "utf8") : "")
beforeEach(() => rmSync(modelFile(), { force: true }))

/**
 * Opens the seeded session (or home, with `home`), then runs `body` against it. The terminal is
 * 60 rows so the dialog, at most half the height, shows every group.
 */
async function run(office: Office, body: (app: App, id: string) => Promise<void>, opts: { home?: boolean } = {}) {
  const id = office.state.sessions[0].id
  const app = await bootFrame(createStub(office), opts.home ? {} : { sessionID: id }, { width: 100, height: 60 })
  try {
    await app.until((f) => f.includes("@minh"))
    await body(app, id)
  } finally {
    await app.stop()
    office.stop()
  }
}

/** Types `/model` (or `slash`) in the prompt, opens the dialog, and waits for every connection's list. */
async function openDialog(app: App, slash = "/model", shown = (f: string) => f.includes("azure-2 (azure)")) {
  await app.input.typeText(slash)
  await app.until((f) => f.includes("Switch model"))
  app.input.pressEnter()
  return app.until((f) => f.includes("Select model") && shown(f) && !f.includes("listing…"))
}

/**
 * The dialog's list rows, below its search box, each with whether it is drawn highlighted: its
 * background, where the dialog's title starts, differs from the title's.
 */
function listRows(app: App) {
  const { lines } = app.setup.captureSpans()
  const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
  const bgAt = (l: CapturedLine, col: number) => {
    let x = 0
    for (const s of l.spans) if (col < (x += s.width)) return s.bg
  }
  const title = lines.findIndex((l) => text(l).includes("Select model"))
  if (title < 0) return []
  const col = text(lines[title]).indexOf("Select model")
  const end = lines.findIndex((l, i) => i > title && text(l).includes("favorite ctrl+f"))
  return lines
    .slice(title + 3, end)
    .map((l) => ({ text: text(l).trim(), highlighted: !bgAt(l, col)?.equals(bgAt(lines[title], col)) }))
    .filter((r) => r.text)
}

/** The highlighted row's text, or "" when none is. */
const highlighted = (app: App) => listRows(app).find((r) => r.highlighted)?.text ?? ""

/** Types `text` in the search box until `shown` holds and the dialog has highlighted the first match. */
async function search(app: App, text: string, shown: (f: string) => boolean) {
  await typeInto(app, text)
  return app.until((f) => shown(f) && listRows(app)[0]?.highlighted === true)
}

const line = (f: string, text: string) => f.split("\n").find((l) => l.includes(text))?.trimEnd() ?? ""

test("/model lists Favorites, Recent, then each connection; the session's model is marked", async () => {
  await Bun.write(
    modelFile(),
    JSON.stringify({
      recent: [{ connection: "azure-2", model: "o3-mini" }],
      favorite: [{ connection: "office", model: "gpt-4.1" }],
    }),
  )
  const office = createFakeOffice()
  await run(office, async (app) => {
    const f = await openDialog(app)
    const at = (s: string) => f.indexOf(s)
    expect(at("Favorites")).toBeLessThan(at("gpt-4.1"))
    expect(at("gpt-4.1")).toBeLessThan(at("Recent"))
    expect(at("Recent")).toBeLessThan(at("o3-mini"))
    expect(at("o3-mini")).toBeLessThan(at("office (azure)"))
    expect(at("office (azure)")).toBeLessThan(at("azure-2 (azure)"))
    expect(at("azure-2 (azure)")).toBeLessThan(at("gpt-4o-mini"))
    // A session with no connection or model runs on office's own model.
    expect(line(f, "● ")).toMatch(/● +gpt-4o$/)
    expect(f).toContain("gpt-4o (office)")
    expect(line(f, "Software engineer")).toMatch(/· gpt-4o$/)
  })
})

test("/models opens it too, and <leader>m", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openDialog(app, "/models")
    app.input.pressEscape()
    await app.until((f) => !f.includes("Select model"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("m")
    await app.until((f) => f.includes("Select model"))
  })
})

test("typing filters across connections", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openDialog(app)
    const f = await search(app, "mini", (f) => f.includes("o3-mini") && f.includes("gpt-4o-mini") && !f.includes("gpt-4.1"))
    expect(line(f, "o3-mini")).toContain("azure-2 (azure)")
  })
})

test("Enter in a chat switches it: the header follows, the pick is a recent, and a toast says so", async () => {
  const office = createFakeOffice()
  // Switching needs no grant to manage connections.
  office.state.managers = []
  await run(office, async (app, id) => {
    await openDialog(app)
    await search(app, "4o-mini", (f) => f.includes("gpt-4o-mini") && !f.includes("o3-mini"))
    app.input.pressEnter()
    await app.until((f) => !f.includes("Select model") && f.includes("Next reply uses azure-2/gpt-4o-mini"))
    expect(office.requests.find((r) => r.path === `/sessions/${id}/model`)).toMatchObject({
      method: "POST",
      body: { connection: "azure-2", model: "gpt-4o-mini" },
    })
    // The connection's own model is stored as null and labelled from the connection list.
    const f = await app.until((f) => f.includes("gpt-4o-mini (azure-2)"))
    expect(f).not.toContain("gpt-4o (office)")
    expect(line(f, "Software engineer")).toMatch(/· gpt-4o-mini$/)
    await app.until(() => saved().includes("gpt-4o-mini"))
    const opened = await openDialog(app)
    const again = opened.slice(opened.indexOf("Select model"))
    expect(again.indexOf("Recent")).toBeLessThan(again.indexOf("gpt-4o-mini"))
    expect(line(again, "● ")).toMatch(/● +gpt-4o-mini/)
  })
})

test("on the home screen Enter only records the pick, and says new chats don't use it yet", async () => {
  const office = createFakeOffice()
  await run(
    office,
    async (app) => {
      await openDialog(app)
      await search(app, "o3", (f) => f.includes("o3-mini") && !f.includes("gpt-4.1"))
      app.input.pressEnter()
      await app.until((f) => !f.includes("Select model") && f.includes("New chats start on the agent's model"))
      expect(office.requests.some((r) => r.path.endsWith("/model"))).toBe(false)
      await app.until(() => saved().includes("o3-mini"))
    },
    { home: true },
  )
})

test("a connection that can't list offers its model and a typed name", async () => {
  const office = createFakeOffice()
  office.state.models["azure-2"] = { connection: "azure-2", models: [{ id: "gpt-4o-mini" }], listed: false, error: null }
  await run(office, async (app, id) => {
    const f = await openDialog(app)
    expect(f.indexOf("azure-2 (azure)")).toBeLessThan(f.indexOf("gpt-4o-mini"))
    expect(f.indexOf("gpt-4o-mini")).toBeLessThan(f.indexOf("Type a model name…"))
    await search(app, "type a model", (f) => f.includes("Type a model name…") && !f.includes("gpt-4o-mini"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Model on azure-2"))
    await app.until(() => app.setup.renderer.currentFocusedEditor !== null)
    await app.input.typeText("my-deployment")
    app.input.pressEnter()
    await app.until((f) => f.includes("Next reply uses azure-2/my-deployment"))
    expect(office.requests.find((r) => r.path === `/sessions/${id}/model`)?.body).toEqual({
      connection: "azure-2",
      model: "my-deployment",
    })
  })
})

test("a listing error shows beside its connection", async () => {
  const office = createFakeOffice()
  office.state.models["azure-2"] = {
    connection: "azure-2",
    models: [{ id: "gpt-4o-mini" }],
    listed: false,
    error: "HTTP 401",
  }
  await run(office, async (app) => {
    const f = await openDialog(app)
    expect(line(f, "azure-2 (azure)")).toContain("couldn't list: HTTP 401")
    expect(f).toContain("Type a model name…")
  })
})

test("Ctrl+F toggles a favorite", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openDialog(app)
    await search(app, "o3", (f) => f.includes("o3-mini") && !f.includes("gpt-4.1"))
    app.input.pressKey("f", { ctrl: true })
    await app.until(() => saved().includes("o3-mini"))
    expect(JSON.parse(saved()).favorite).toEqual([{ connection: "azure-2", model: "o3-mini" }])
    app.input.pressEscape()
    await app.until((f) => !f.includes("Select model"))
    const f = await openDialog(app)
    expect(f.indexOf("Favorites")).toBeLessThan(f.indexOf("o3-mini"))
    expect(f.indexOf("o3-mini")).toBeLessThan(f.indexOf("office (azure)"))
  })
})

test("Ctrl+F twice on the last row favorites that model, then unfavorites it", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openDialog(app)
    // The session's model is highlighted first; o3-mini is two rows below it, at the end.
    await app.until(() => highlighted(app) === "● gpt-4o")
    for (let i = 0; i < 2; i++) app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("o3-mini") && listRows(app).at(-1)?.highlighted === true)
    app.input.pressKey("f", { ctrl: true })
    await app.until(() => saved().includes("o3-mini"))
    expect(JSON.parse(saved()).favorite).toEqual([{ connection: "azure-2", model: "o3-mini" }])
    // The row moved up into Favorites, and the highlight went with it.
    await app.until((f) => f.indexOf("Favorites") < f.indexOf("o3-mini") && highlighted(app).startsWith("o3-mini"))
    app.input.pressKey("f", { ctrl: true })
    await app.until(() => JSON.parse(saved()).favorite.length === 0)
    expect(JSON.parse(saved())).toEqual({ recent: [], favorite: [] })
  })
})

test("a list that arrives late keeps the highlight on the same model", async () => {
  const office = createFakeOffice()
  const release = office.hold("GET /connections/office/models")
  await run(office, async (app) => {
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    await app.until((f) => f.includes("o3-mini") && f.includes("listing…"))
    for (let i = 0; i < 2; i++) app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("o3-mini"))
    release()
    await app.until((f) => f.includes("gpt-4.1") && !f.includes("listing…"))
    expect(highlighted(app)).toStartWith("o3-mini")
    app.input.pressEnter()
    await app.until((f) => f.includes("Next reply uses azure-2/o3-mini"))
  })
})

test("a refused switch shows the office's message and leaves the dialog open", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openDialog(app)
    await search(app, "o3", (f) => f.includes("o3-mini") && !f.includes("gpt-4.1"))
    // The connection goes away after the dialog listed it.
    office.state.connections = office.state.connections.filter((c) => c.name !== "azure-2")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("no connection 'azure-2' on this office"))
    expect(f).toContain("Select model")
    expect(f).not.toContain("Next reply uses")
    for (let i = 0; i < 2; i++) app.input.pressBackspace()
    await search(app, "gpt-4.1", (f) => f.includes("gpt-4.1") && !f.includes("o3-mini"))
    app.input.pressEnter()
    await app.until((f) => !f.includes("Select model") && f.includes("Next reply uses office/gpt-4.1"))
  })
})

test("a session that is ending refuses the switch, and the dialog stays open", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    office.updateSession(id, { status: "ending" })
    await app.until((f) => f.includes("@minh · ending"))
    await openDialog(app)
    await search(app, "o3", (f) => f.includes("o3-mini") && !f.includes("gpt-4.1"))
    app.input.pressEnter()
    const f = await app.until((f) => f.includes(`session ${id} is ending`))
    expect(f).toContain("Select model")
    expect(office.state.sessions[0]).not.toMatchObject({ connection: "azure-2" })
  })
})

test("a session's model note shows under the header until it is cleared", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    const note = "azure-2 refused the key, so this chat moved to office"
    office.updateSession(id, { model_note: note })
    const f = await app.until((f) => f.includes(note))
    expect(f.indexOf("@minh · idle")).toBeLessThan(f.indexOf(note))
    office.updateSession(id, { model_note: null })
    await app.until((f) => !f.includes(note))
  })
})

test("on a subscription connection, the header's cost label says subscription, unpriced", async () => {
  const office = createFakeOffice()
  office.state.connections.push({ name: "chatgpt", provider: "chatgpt", method: "subscription", model: "gpt-5" })
  await run(office, async (app, id) => {
    let f = await app.until((f) => f.includes("gpt-4o (office)"))
    expect(line(f, "@minh · idle")).not.toContain("subscription")
    office.updateSession(id, { connection: "chatgpt" })
    f = await app.until((f) => f.includes("gpt-5 (chatgpt)"))
    expect(line(f, "@minh · idle")).toEndWith("· $0.00 (subscription, unpriced) · gpt-5 (chatgpt)")
  })
})

test("a connection's configured model comes first, as the office lists it", async () => {
  const office = createFakeOffice()
  office.state.connections = office.state.connections.map((c) =>
    c.name === "azure-2" ? { ...c, model: "zz-deployment" } : c,
  )
  office.state.models["azure-2"] = {
    connection: "azure-2",
    models: [{ id: "zz-deployment" }, { id: "a-model" }, { id: "b-model" }],
    listed: true,
    error: null,
  }
  await run(office, async (app) => {
    const f = await openDialog(app)
    const at = (s: string) => f.indexOf(s)
    expect(at("azure-2 (azure)")).toBeLessThan(at("zz-deployment"))
    expect(at("zz-deployment")).toBeLessThan(at("a-model"))
    expect(at("a-model")).toBeLessThan(at("b-model"))
  })
})

test("when the connection list can't be read, the header names the connection and /model still opens", async () => {
  const office = createFakeOffice()
  office.broken.add("GET /connections")
  await run(office, async (app) => {
    const f = await app.until((f) => f.includes("@minh · idle"))
    expect(line(f, "@minh · idle")).toMatch(/· office$/)
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("Couldn't list connections"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Select model"))
    office.broken.delete("GET /connections")
    await openDialog(app)
  })
})

test("a slow earlier read of the connections can't overwrite a later one", async () => {
  const office = createFakeOffice()
  // The startup read is answered with the list as it is now, but held back.
  const stale = office.hold("GET /connections", "reply")
  await run(office, async (app) => {
    await app.until(() => office.requests.some((r) => r.path === "/connections"))
    office.state.connections = office.state.connections.map((c) => (c.name === "office" ? { ...c, model: "gpt-4.1" } : c))
    // A second hold, released at once, lets later reads through while the first stays held.
    office.hold("GET /connections", "reply")()
    await openDialog(app)
    await app.until((f) => f.includes("gpt-4.1 (office)"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Select model"))
    stale()
    await expect(app.until((f) => f.includes("gpt-4o (office)"), 500)).rejects.toThrow()
  })
})

test("hundreds of models list and filter", async () => {
  const office = createFakeOffice()
  const ids = Array.from({ length: 300 }, (_, i) => `vendor/model-${String(i).padStart(3, "0")}`)
  office.state.models.office = { connection: "office", models: ids.map((id) => ({ id })), listed: true, error: null }
  await run(office, async (app, id) => {
    await openDialog(app, "/model", (f) => f.includes("vendor/model-000"))
    await search(app, "model-299", (f) => f.includes("vendor/model-299") && !f.includes("vendor/model-000"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Next reply uses office/vendor/model-299"))
    expect(office.requests.find((r) => r.path === `/sessions/${id}/model`)?.body).toEqual({
      connection: "office",
      model: "vendor/model-299",
    })
  })
})
