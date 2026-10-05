import { expect, mock, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { InputRenderable, TextareaRenderable, type CapturedLine } from "@opentui/core"
import { createFakeOffice, createStub } from "../script/stub"
import * as clipboard from "../src/context/clipboard"
import { Global } from "../src/core/global"
import { bootFrame } from "./fixture/frame"
import { typeInto } from "./routes/picker/type"

type App = Awaited<ReturnType<typeof bootFrame>>
type Office = ReturnType<typeof createFakeOffice>

const SECRET = "sk-ant-sentinel-a7d93c10e5b2"
const DOTS = "•".repeat(SECRET.length)
const PLACEHOLDER = "Paste or type it here; it isn't shown"
const PROVIDERS = [
  "Azure OpenAI",
  "OpenAI",
  "ChatGPT subscription",
  "Anthropic",
  "Google",
  "OpenRouter",
  "xAI",
  "DeepSeek",
  "Other (OpenAI-compatible)",
]

/** What a prompt file under the app's state directory holds, or "" when there is none. */
const stateFile = (name: string) => {
  const file = path.join(Global.Path.state, name)
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}

/**
 * Opens the seeded session, then runs `body` against it; every frame `until` saw is checked for the
 * key afterwards. The terminal is 60 rows so the dialog, at most half the height, shows every row.
 */
async function run(office: Office, body: (app: App, id: string) => Promise<void>) {
  const id = office.state.sessions[0].id
  const app = await bootFrame(createStub(office), { sessionID: id }, { width: 100, height: 60 })
  const frames: string[] = []
  const watched: App = {
    ...app,
    until: (pred, ms) =>
      app.until((f) => {
        frames.push(f)
        return pred(f)
      }, ms),
  }
  try {
    await watched.until((f) => f.includes("@minh"))
    await body(watched, id)
    expect(frames.filter((f) => f.includes("sentinel"))).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
}

/** Types `/connect` in the prompt and opens the dialog, once the office has said who may manage connections. */
async function openConnect(app: App, office: Office) {
  await app.until(() => office.requests.some((r) => r.path === "/connections"))
  await app.input.typeText("/connect")
  await app.until((f) => f.includes("Connect a provider"))
  app.input.pressEnter()
  return app.until((f) => f.includes("Add a provider") && f.includes("Other (OpenAI-compatible)"))
}

/**
 * The rows of the dialog titled `title`, below its search box, each with whether it is drawn
 * highlighted. The dialog's lines keep its panel color in their first column; a highlighted row
 * differs from it where the title starts.
 */
function listRows(app: App, title: string) {
  const { lines } = app.setup.captureSpans()
  const text = (l: CapturedLine) => l.spans.map((s) => s.text).join("")
  const bgAt = (l: CapturedLine, col: number) => {
    let x = 0
    for (const s of l.spans) if (col < (x += s.width)) return s.bg
  }
  const at = lines.findIndex((l) => text(l).includes(title))
  if (at < 0) return []
  const col = text(lines[at]).indexOf(title)
  const panel = bgAt(lines[at], col)
  const rows: { text: string; highlighted: boolean }[] = []
  for (const l of lines.slice(at + 3)) {
    if (!bgAt(l, col - 4)?.equals(panel)) break
    if (text(l).trim()) rows.push({ text: text(l).trim(), highlighted: !bgAt(l, col)?.equals(panel) })
  }
  return rows
}

const highlighted = (app: App, title = "Connect a provider") => listRows(app, title).find((r) => r.highlighted)?.text ?? ""

/** Filters the provider list to `provider` and opens it. */
async function choose(app: App, provider: string, search = provider) {
  await typeInto(app, search)
  await app.until(() => highlighted(app).startsWith(provider))
  app.input.pressEnter()
}

/** The key box reads keys itself, so no input or textarea may have focus beside it to take them too. */
function expectNoInputFocused(app: App) {
  const focused = app.setup.renderer.currentFocusedRenderable
  expect(focused instanceof InputRenderable || focused instanceof TextareaRenderable).toBe(false)
}

/** Types the key in the key box, checking it shows only as dots. */
async function typeKey(app: App) {
  await app.until((f) => f.includes("API key") && f.includes(PLACEHOLDER))
  await app.input.typeText(SECRET)
  await app.until((f) => f.includes(DOTS) && !f.includes(PLACEHOLDER))
}

/** The requests that change something, as `METHOD path`. */
const writes = (office: Office) => office.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)

/** The reads of a subscription sign-in. */
const polls = (office: Office) =>
  office.requests.filter((r) => r.method === "GET" && r.path.startsWith("/connections/login/")).map((r) => r.path)

/** Opens ChatGPT subscription and waits for the code to enter. */
async function signIn(app: App, office: Office) {
  await openConnect(app, office)
  await choose(app, "ChatGPT subscription", "chatgpt")
  return app.until((f) => f.includes("ABCD-EFGH"))
}

test("/connect lists the connections, then every provider; managers see Make default and Remove on connected rows", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    const rows = listRows(app, "Connect a provider").map((r) => r.text)
    expect(rows[0]).toBe("Connected")
    expect(rows[1]).toStartWith("office")
    expect(rows[1]).toContain("default")
    expect(rows[2]).toStartWith("azure-2")
    expect(rows.slice(3)).toEqual(["Add a provider", ...PROVIDERS])
    // The default office connection is neither made default again nor removed.
    await app.until(() => highlighted(app).startsWith("office"))
    let f = app.frame()
    expect(f).not.toContain("make default")
    expect(f).not.toContain("remove")
    app.input.pressArrow("down")
    f = await app.until(() => highlighted(app).startsWith("azure-2"))
    expect(f).toContain("make default ctrl+s")
    expect(f).toContain("remove ctrl+d")
    app.input.pressArrow("down")
    f = await app.until(() => highlighted(app).startsWith("Azure OpenAI"))
    expect(f).not.toContain("make default")
    expect(f).not.toContain("remove")
  })
})

test("Make default makes the highlighted connection the default", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("azure-2"))
    app.input.pressKey("s", { ctrl: true })
    await app.until(() => {
      const rows = listRows(app, "Connect a provider")
      return rows[2]?.text.includes("default") === true && rows[1]?.text.includes("default") === false
    })
    expect(office.requests.find((r) => r.method === "PUT")).toMatchObject({
      path: "/connections/default",
      body: { connection: "azure-2" },
    })
  })
})

test("a failed Make default still lists the connections again", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    app.input.pressArrow("down")
    await app.until((f) => highlighted(app).startsWith("azure-2") && f.includes("make default ctrl+s"))
    office.broken.add("PUT /connections/default")
    app.input.pressKey("s", { ctrl: true })
    const reads = () => office.requests.map((r) => `${r.method} ${r.path}`)
    await app.until(() => reads().includes("PUT /connections/default"))
    await app.until(() => reads().slice(reads().indexOf("PUT /connections/default")).includes("GET /connections"))
  })
})

test("Remove asks first, and says chats on it move to the default; office has no Remove", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    // Ctrl+D on office does nothing.
    await app.until(() => highlighted(app).startsWith("office"))
    app.input.pressKey("d", { ctrl: true })
    await expect(app.until((f) => f.includes("Remove office"), 300)).rejects.toThrow()
    app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("azure-2"))
    app.input.pressKey("d", { ctrl: true })
    let f = await app.until((f) => f.includes("Remove azure-2?"))
    expect(f).toContain("Chats on it move to the default on their next message.")
    // Cancel goes back to the list with the connection kept.
    app.input.pressArrow("left")
    await app.setup.renderOnce()
    app.input.pressEnter()
    await app.until((f) => f.includes("Add a provider") && f.includes("azure-2"))
    expect(writes(office)).toEqual([])
    app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("azure-2"))
    app.input.pressKey("d", { ctrl: true })
    await app.until((f) => f.includes("Remove azure-2?"))
    app.input.pressEnter()
    // The toast still names it; the list doesn't.
    await app.until((f) => f.includes("Removed azure-2") && f.includes("Add a provider"))
    await app.until(() => !listRows(app, "Connect a provider").some((r) => r.text.startsWith("azure-2")))
    expect(writes(office)).toEqual(["DELETE /connections/azure-2"])
    expect(office.state.connections.map((c) => c.name)).toEqual(["office"])
  })
})

test("a remove that finishes after the user moved on leaves what they opened", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    app.input.pressArrow("down")
    await app.until(() => highlighted(app).startsWith("azure-2"))
    const release = office.hold("DELETE /connections/azure-2")
    app.input.pressKey("d", { ctrl: true })
    await app.until((f) => f.includes("Remove azure-2?"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Add a provider"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Add a provider"))
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model"))
    release()
    await app.until((f) => f.includes("Removed azure-2"))
    expect(office.state.connections.map((c) => c.name)).toEqual(["office"])
    const f = app.frame()
    expect(f).toContain("Select model")
    expect(f).not.toContain("Add a provider")
  })
})

test("Anthropic asks only for the key; it shows as dots, and Enter posts it and opens the model list on it", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    await openConnect(app, office)
    await choose(app, "Anthropic")
    await app.until((f) => f.includes("Connect Anthropic") && f.includes("API key"))
    expectNoInputFocused(app)
    const release = office.hold("POST /connections")
    await typeKey(app)
    // Typing the key ran no command: nothing was sent, and the chat is still open behind the dialog.
    expect(writes(office)).toEqual([])
    app.input.pressEnter()
    let f = await app.until((f) => f.includes("Checking the key…"))
    expect(f).not.toContain(DOTS)
    release()
    f = await app.until((f) => f.includes("Select model") && f.includes("anthropic (anthropic)"))
    expect(writes(office)).toEqual(["POST /connections"])
    expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({ provider: "anthropic", api_key: SECRET })
    // The new connection lists no models, so the highlight is on typing one there.
    await app.until(() => highlighted(app, "Select model").startsWith("Type a model name…"))
    expect(f).toContain(`@minh`)
    expect(office.requests.some((r) => r.path === `/sessions/${id}/prompt`)).toBe(false)
    for (const file of ["prompt-history.jsonl", "prompt-stash.jsonl"]) expect(stateFile(file)).not.toContain("sentinel")
  })
})

test("Azure asks for the endpoint or resource name in a plain input, then the key", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    await choose(app, "Azure OpenAI", "azure open")
    await app.until((f) => f.includes("Connect Azure OpenAI") && f.includes("Endpoint or resource name"))
    await typeInto(app, "my-resource")
    app.input.pressEnter()
    await app.until((f) => f.includes("API key"))
    expectNoInputFocused(app)
    await typeKey(app)
    expect(app.frame()).toContain("my-resource")
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("azure (azure)"))
    expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({
      provider: "azure",
      api_key: SECRET,
      endpoint: "my-resource",
    })
  })
})

test("Other asks for the base URL and the model name, then the key", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    await choose(app, "Other (OpenAI-compatible)", "other")
    await app.until((f) => f.includes("Base URL"))
    await typeInto(app, "https://llm.example.com/v1")
    app.input.pressEnter()
    await app.until((f) => f.includes("Model name"))
    await typeInto(app, "my-model")
    app.input.pressEnter()
    await app.until((f) => f.includes("API key"))
    expectNoInputFocused(app)
    await typeKey(app)
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("custom (custom)"))
    await app.until(() => highlighted(app, "Select model").startsWith("my-model"))
    expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({
      provider: "openai",
      api_key: SECRET,
      endpoint: "https://llm.example.com/v1",
      model: "my-model",
    })
  })
})

test("a provider with no default model asks for one, then the key", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    await choose(app, "Google")
    await app.until((f) => f.includes("Model name"))
    // An empty answer is refused.
    await typeInto(app, "")
    app.input.pressEnter()
    await app.until((f) => f.includes("Type the model's name"))
    await typeInto(app, "gemini-x")
    app.input.pressEnter()
    await app.until((f) => f.includes("API key"))
    expectNoInputFocused(app)
    await typeKey(app)
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("google (google)"))
    expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({
      provider: "google",
      api_key: SECRET,
      model: "gemini-x",
    })
  })
})

test("a refused key or model shows the office's message and empties the box", async () => {
  const office = createFakeOffice()
  office.refusals.push(
    { error: "key_refused", message: "The key didn't work (HTTP 401)" },
    { error: "model_refused", message: "The model 'claude-x' didn't answer: no such model; name another model" },
  )
  await run(office, async (app) => {
    await openConnect(app, office)
    await choose(app, "Anthropic")
    await typeKey(app)
    app.input.pressEnter()
    let f = await app.until((f) => f.includes("The key didn't work (HTTP 401)") && f.includes(PLACEHOLDER))
    expect(f).not.toContain("•")
    await typeKey(app)
    app.input.pressEnter()
    f = await app.until((f) => f.includes("didn't answer: no such model") && f.includes(PLACEHOLDER))
    expect(f).not.toContain("HTTP 401")
    await typeKey(app)
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("anthropic (anthropic)"))
    expect(writes(office)).toEqual(["POST /connections", "POST /connections", "POST /connections"])
  })
})

test("a key refused after the dialog was closed shows as a toast, and leaves what the user opened", async () => {
  const office = createFakeOffice()
  office.refusals.push({ error: "key_refused", message: "The key didn't work (HTTP 401)" })
  await run(office, async (app) => {
    await openConnect(app, office)
    await choose(app, "Anthropic")
    const release = office.hold("POST /connections")
    await typeKey(app)
    app.input.pressEnter()
    await app.until((f) => f.includes("Checking the key…"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Checking the key…"))
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model"))
    release()
    // The toast wraps the office's message.
    const f = await app.until((f) => f.includes("Couldn't connect Anthropic: The key didn't work"))
    expect(f).toContain("Select model")
    expect(f).not.toContain("API key")
  })
})

test("Esc on a key box with text clears it first; Esc on an empty one closes the dialog", async () => {
  const office = createFakeOffice()
  await run(office, async (app, id) => {
    await openConnect(app, office)
    await choose(app, "OpenAI", "openai")
    await typeKey(app)
    app.input.pressEscape()
    // A lone ESC counts as Esc only after the input parser's timeout.
    await app.until((f) => f.includes("API key") && f.includes(PLACEHOLDER))
    app.input.pressEscape()
    await app.until((f) => !f.includes("API key") && !f.includes("Add a provider"))
    // Esc closed only the dialog: the reply was not interrupted.
    expect(writes(office)).toEqual([])
    expect(office.requests.some((r) => r.path === `/sessions/${id}/interrupt`)).toBe(false)
  })
})

test("ChatGPT subscription shows the link in full, the code, and that it waits for the sign-in; c copies the code", async () => {
  const office = createFakeOffice()
  // The machine's clipboard is left alone: the app's writes are kept here instead.
  const real = { ...clipboard }
  const copied: string[] = []
  const fake = { write: async (text: string) => void copied.push(text) }
  mock.module("../src/context/clipboard", () => ({ ...real, useClipboard: () => fake }))
  try {
    await run(office, async (app) => {
      const f = await signIn(app, office)
      expect(f).toContain("Connect ChatGPT subscription")
      expect(f).toContain("https://auth.openai.com/codex/device")
      expect(f).toContain("Waiting for you to sign in…")
      expect(f).toContain("c copy")
      expect(writes(office)).toEqual(["POST /connections/login"])
      expect(office.requests.find((r) => r.method === "POST")?.body).toEqual({ provider: "openai" })
      await app.input.typeText("c")
      await app.until((f) => f.includes("Copied to clipboard") && f.includes("ABCD-EFGH"))
      expect(copied).toEqual(["ABCD-EFGH"])
    })
  } finally {
    mock.module("../src/context/clipboard", () => real)
  }
})

test("the sign-in is read every 2 s; once signed in, the model list opens on the new connection", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await signIn(app, office)
    // The connections are read again once signed in; held, the screen says what it waits on.
    const release = office.hold("GET /connections")
    await app.until((f) => f.includes("Signed in. Opening the model list…"), 10_000)
    const id = office.logins()[0].id
    expect(polls(office)).toEqual(Array(3).fill(`/connections/login/${id}`))
    const at = office.requests.filter((r) => r.path.startsWith("/connections/login/")).map((r) => r.at)
    expect(at[1] - at[0]).toBeGreaterThan(1900)
    expect(at[2] - at[1]).toBeGreaterThan(1900)
    release()
    await app.until((f) => f.includes("Select model") && f.includes("chatgpt (chatgpt)"))
    await app.until(() => highlighted(app, "Select model").startsWith("gpt-5"))
    expect(app.frame()).toContain("Connected chatgpt")
    expect(writes(office)).toEqual(["POST /connections/login"])
  })
}, 20_000)

test("Esc cancels the sign-in at the office and closes the dialog; it isn't read again", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await signIn(app, office)
    app.input.pressEscape()
    await app.until((f) => !f.includes("ABCD-EFGH") && !f.includes("Add a provider"))
    const id = office.logins()[0].id
    await app.until(() => writes(office).includes(`DELETE /connections/login/${id}`))
    expect(office.logins()[0].state).toBe("cancelled")
    await Bun.sleep(2500)
    expect(polls(office)).toEqual([])
  })
}, 15_000)

test("a sign-in the office starts after the dialog closed is cancelled", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await openConnect(app, office)
    const release = office.hold("POST /connections/login")
    await choose(app, "ChatGPT subscription", "chatgpt")
    await app.until((f) => f.includes("Getting a sign-in code…"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Getting a sign-in code…"))
    release()
    await app.until(() => writes(office).some((w) => w.startsWith("DELETE /connections/login/")))
    expect(office.logins()[0].state).toBe("cancelled")
  })
})

test("a failed sign-in says so and to try /connect again", async () => {
  const office = createFakeOffice()
  office.loginFailures.push("HTTP 400")
  await run(office, async (app) => {
    await signIn(app, office)
    const f = await app.until((f) => f.includes("Sign-in failed (HTTP 400). Try /connect again."))
    expect(f).not.toContain("Waiting for you to sign in…")
    expect(f).not.toContain("c copy")
  })
}, 10_000)

test("a sign-in whose code comes on a later read shows the spinner until a read brings the link and code", async () => {
  const office = createFakeOffice()
  office.loginCodeReads.push(1)
  await run(office, async (app) => {
    await openConnect(app, office)
    // The first read is held, so the screen shows the office's first answer, which has no code.
    const release = office.hold("GET /connections/login/:id")
    await choose(app, "ChatGPT subscription", "chatgpt")
    await app.until(() => polls(office).length === 1, 5000)
    expect(office.logins()[0]).toMatchObject({ state: "waiting", url: null, user_code: null })
    let f = await app.until((f) => f.includes("Getting a sign-in code…"))
    expect(f).not.toContain("c copy")
    release()
    f = await app.until((f) => f.includes("ABCD-EFGH"))
    expect(f).toContain("https://auth.openai.com/codex/device")
    expect(f).toContain("c copy")
    expect(f).not.toContain("Getting a sign-in code…")
    expect(polls(office)).toHaveLength(1)
  })
}, 10_000)

test("a sign-in that can't be read says so rather than waiting on", async () => {
  const office = createFakeOffice()
  office.broken.add("GET /connections/login/:id")
  await run(office, async (app) => {
    await signIn(app, office)
    const f = await app.until((f) => f.includes("Couldn't check the sign-in"), 5000)
    expect(f).not.toContain("Waiting for you to sign in…")
    expect(polls(office)).toHaveLength(1)
  })
}, 10_000)

test("Ctrl+A in /model opens it for managers", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await app.until(() => office.requests.some((r) => r.path === "/connections"))
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Select model") && f.includes("connect ctrl+a"))
    app.input.pressKey("a", { ctrl: true })
    await app.until((f) => f.includes("Add a provider") && !f.includes("Select model"))
  })
})

test("without can_manage, /connect is in neither the slash list nor the palette, and Ctrl+A does nothing in /model", async () => {
  const office = createFakeOffice()
  office.state.managers = []
  await run(office, async (app) => {
    await app.until(() => office.requests.some((r) => r.path === "/connections"))
    await app.input.typeText("/conn")
    await expect(app.until((f) => f.includes("Connect a provider"), 300)).rejects.toThrow()
    for (let i = 0; i < 5; i++) app.input.pressBackspace()
    await app.until((f) => !f.includes("/conn"))
    app.input.pressKey("p", { ctrl: true })
    await app.until((f) => f.includes("Commands") && f.includes("Switch model"))
    await typeInto(app, "connect")
    await expect(app.until((f) => f.includes("Connect a provider"), 300)).rejects.toThrow()
    app.input.pressEscape()
    await app.until((f) => !f.includes("Commands"))
    await app.input.typeText("/model")
    await app.until((f) => f.includes("Switch model"))
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Select model") && !f.includes("listing…"))
    expect(f).not.toContain("connect ctrl+a")
    app.input.pressKey("a", { ctrl: true })
    await expect(app.until((f) => f.includes("Add a provider"), 300)).rejects.toThrow()
    expect(app.frame()).toContain("Select model")
  })
})
