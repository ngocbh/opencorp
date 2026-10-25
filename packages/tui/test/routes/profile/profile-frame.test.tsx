import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub, seed } from "../../../script/stub"
import { createOfficeClient } from "@opencorp/client"
import { CONFLICT_MARKER } from "../../../src/routes/profile/profile"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"
import { typeInto } from "../picker/type"

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

test("/profile from home opens the selected person's profile; Esc goes back home", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("@minh") && f.includes("Ask anything"))
    await app.input.typeText("/profile")
    await app.until((f) => f.includes("Open profile"))
    app.input.pressEnter()
    await app.until((f) => f.includes("@minh · profile") && f.includes("Writes small, tested changes."))
    app.input.pressEscape()
    await app.until((f) => !f.includes("@minh · profile") && f.includes("Ask anything"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/profile with nobody picked says to pick a person first", async () => {
  const office = createFakeOffice({ seed: { ...seed(), people: [], sessions: [], folders: {} } })
  const app = await bootFrame(createStub(office))
  try {
    // The picker opens at start with no one to pick; close it.
    await app.until((f) => f.includes("Who do you want to talk to?"))
    // Let the picker take the keyboard before Esc.
    await Bun.sleep(100)
    app.input.pressEscape()
    await app.until((f) => !f.includes("Who do you want to talk to?"))
    await app.input.typeText("/profile")
    await app.until((f) => f.includes("Open profile"))
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("Pick a person first"))
    expect(f).not.toContain("· profile")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an over-budget profile says it is longer than its budget", async () => {
  const office = createFakeOffice({ profileMaxChars: 10 })
  await run(office, async (app) => {
    await app.until((f) => f.includes("Over budget: this profile is longer than its budget."))
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

const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL }
let dir: string | undefined
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Points $EDITOR at a shell script; `$1` is the file, `$D` a scratch folder the test can read. */
function editor(script: string) {
  dir = mkdtempSync("/tmp/act-ed-")
  writeFileSync(path.join(dir, "ed.sh"), `D=${dir}\n${script}\n`)
  delete process.env.VISUAL
  process.env.EDITOR = `sh ${path.join(dir, "ed.sh")}`
  return dir
}

test("e edits the profile in $EDITOR and saves it with the version it started from", async () => {
  const d = editor(`cp "$1" "$D/seen"; printf '# Minh\\n\\nEdited by hand.\\n' > "$1"`)
  const office = createFakeOffice()
  await run(office, async (app) => {
    const base = office.state.profiles.minh.version
    app.input.pressKey("e")
    await app.until((f) => f.includes("Edited by hand.") && f.includes("Profile saved"))
    expect(readFileSync(path.join(d, "seen"), "utf8")).toBe("# Minh\n\nWrites small, tested changes.\n")
    const put = office.requests.find((r) => r.method === "PUT")
    expect(put?.body).toEqual({ text: "# Minh\n\nEdited by hand.\n", base_version: base })
  })
})

test("a save that lost a race re-opens the editor on the new text, the rejected edit under the marker", async () => {
  // First run: wait for the test to change the profile, then save an edit. Second run: add a line on top.
  const d = editor(
    [
      `if [ ! -e "$D/first" ]; then cp "$1" "$D/first"; while [ ! -e "$D/go" ]; do sleep 0.02; done`,
      `  printf 'Mine.\\n' > "$1"`,
      `else cp "$1" "$D/second"; { echo Merged.; cat "$D/second"; } > "$1"; fi`,
    ].join("\n"),
  )
  const office = createFakeOffice()
  await run(office, async (app) => {
    app.input.pressKey("e")
    await until(() => existsSync(path.join(d, "first")))
    const client = createOfficeClient({ socket: office.socket })
    const theirs = await client.profiles.put("minh", {
      text: "# Minh\n\nNow writes docs too.\n",
      base_version: office.state.profiles.minh.version,
    })
    writeFileSync(path.join(d, "go"), "")
    await app.until((f) => f.includes("Merged.") && f.includes("Profile saved"), 6000)
    expect(readFileSync(path.join(d, "second"), "utf8")).toBe(
      `# Minh\n\nNow writes docs too.\n\n${CONFLICT_MARKER}\nMine.\n`,
    )
    const puts = office.requests.filter((r) => r.method === "PUT" && r.raw === "/profiles/minh").map((r) => r.body)
    expect(puts.at(-1)).toEqual({ text: "Merged.\n# Minh\n\nNow writes docs too.\n", base_version: theirs.version })
  })
})

test("saving the conflict round without merging says the edit was not saved", async () => {
  // First run: wait for the test to change the profile, then save an edit. Second run: save as is.
  const d = editor(
    [
      `if [ ! -e "$D/first" ]; then cp "$1" "$D/first"; while [ ! -e "$D/go" ]; do sleep 0.02; done`,
      `  printf 'Mine.\\n' > "$1"`,
      `else touch "$D/second"; fi`,
    ].join("\n"),
  )
  const office = createFakeOffice()
  await run(office, async (app) => {
    app.input.pressKey("e")
    await until(() => existsSync(path.join(d, "first")))
    const client = createOfficeClient({ socket: office.socket })
    await client.profiles.put("minh", {
      text: "# Minh\n\nNow writes docs too.\n",
      base_version: office.state.profiles.minh.version,
    })
    writeFileSync(path.join(d, "go"), "")
    const f = await app.until((f) => f.includes("Your edit was not saved"), 6000)
    expect(f).not.toContain("No changes")
    expect(existsSync(path.join(d, "second"))).toBe(true)
    expect(office.requests.filter((r) => r.method === "PUT").length).toBe(2)
  })
})

test("with no $EDITOR, e says how to set one; an unchanged save writes nothing", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    delete process.env.EDITOR
    delete process.env.VISUAL
    app.input.pressKey("e")
    await app.until((f) => f.includes("Set $EDITOR"))
    editor(`true`)
    app.input.pressKey("e")
    await app.until((f) => f.includes("No changes"))
    expect(office.requests.some((r) => r.method === "PUT")).toBe(false)
  })
})

/** Streams an assistant message into a session, as the harness would. */
function reply(office: ReturnType<typeof createFakeOffice>, sessionId: string, text: string) {
  const at = new Date().toISOString()
  const id = office.nextId()
  const parts = [{ id: id + "P", type: "text", text }]
  const msg = { id, session_id: sessionId, role: "assistant", parts, created_at: at }
  office.state.messages[sessionId].push(msg as never)
  office.live({ type: "message.updated", session_id: sessionId, data: msg as never })
}

test("m starts a profile manager chat; later messages prompt the same session", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    app.input.pressKey("m")
    await typeInto(app, "Say Minh writes tests first")
    app.input.pressEnter()
    await app.until((f) => f.includes("you: Say Minh writes tests first"))
    const manager = office.state.sessions.find((s) => s.kind === "profile_manager")!
    expect(office.requests.find((r) => r.method === "POST")).toMatchObject({
      path: "/profiles/minh/manager",
      body: { text: "Say Minh writes tests first" },
    })
    await app.until((f) => f.includes("The profile manager is thinking…"))
    reply(office, manager.id, "Noted: tests first.")
    office.setStatus(manager.id, "idle")
    // The profile itself still shows above the chat as the chat grows under it.
    const profileShown = /^  Writes small, tested changes\. *$/m
    await app.until((f) => f.includes("manager: Noted: tests first.") && !f.includes("thinking…") && profileShown.test(f))
    await typeInto(app, "Shorter please")
    app.input.pressEnter()
    await app.until((f) => f.includes("you: Shorter please"))
    expect(office.requests.filter((r) => r.method === "POST").at(-1)).toMatchObject({
      path: `/sessions/${manager.id}/prompt`,
      body: { text: "Shorter please" },
    })
  })
})

test("once the chat this view started ends, the next message starts a new one", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    app.input.pressKey("m")
    await typeInto(app, "Say Minh writes tests first")
    app.input.pressEnter()
    await app.until((f) => f.includes("you: Say Minh writes tests first"))
    const first = office.state.sessions.find((s) => s.kind === "profile_manager")!
    office.setStatus(first.id, "ended")
    await app.until((f) => !f.includes("you: Say Minh writes tests first"))
    await typeInto(app, "Shorter please")
    app.input.pressEnter()
    await app.until((f) => f.includes("you: Shorter please"))
    expect(office.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
      "/profiles/minh/manager",
      "/profiles/minh/manager",
    ])
  })
})

test("an open manager chat for the person is picked up with its transcript", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Earlier ask" })
  reply(office, manager.id, "Earlier answer")
  await run(office, async (app) => {
    await app.until((f) => f.includes("you: Earlier ask") && f.includes("manager: Earlier answer"))
    app.input.pressKey("m")
    await typeInto(app, "Again")
    app.input.pressEnter()
    await app.until((f) => f.includes("you: Again"))
    expect(office.requests.filter((r) => r.method === "POST").at(-1)?.path).toBe(`/sessions/${manager.id}/prompt`)
  })
})

test("a reconnect re-reads the profile (events sent while offline are lost)", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    // A direct edit sends no event: only a re-read can find it.
    const text = "# Minh\n\nChanged while offline.\n"
    office.state.profiles.minh = { ...office.state.profiles.minh, text, version: "f".repeat(40) }
    office.reset()
    await app.until((f) => f.includes("Changed while offline.") && f.includes("fffffff"))
  })
})

test("a re-read that answers after newer events does not undo them", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  await run(office, async (app) => {
    const reads = () => office.requests.filter((r) => r.method === "GET" && r.path.startsWith("/profiles/minh")).length
    const before = reads()
    // The re-read answers with the state from when it arrived, after the event below.
    const releaseProfile = office.hold("GET /profiles/:person", "reply")
    office.reset()
    await until(() => reads() === before + 1)
    await client.profiles.put("minh", { text: "# Minh\n\nNewer.\n", base_version: office.state.profiles.minh.version })
    await app.until((f) => f.includes("Newer."))
    releaseProfile()
    // Give the held reply time to land.
    await Bun.sleep(200)
    const f = await app.until(() => true)
    expect(f).toContain("Newer.")
    expect(f).not.toContain("Writes small, tested changes.")
  })
})

test("the chat's history is loaded once; the office's own re-read keeps it on reconnect", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Earlier ask" })
  await run(office, async (app) => {
    await app.until((f) => f.includes("you: Earlier ask"))
    const loads = () => office.requests.filter((r) => r.path === `/sessions/${manager.id}/messages`).length
    const before = loads()
    office.reset()
    await until(() => loads() > before)
    await Bun.sleep(200)
    expect(loads()).toBe(before + 1)
  })
})

test("in the message box, Ctrl+C and Esc clear a draft; on the empty box Esc leaves the box, and Ctrl+C exits", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    app.input.pressKey("m")
    await typeInto(app, "Say Minh writes tests first")
    await app.until((f) => f.includes("Say Minh writes tests first"))
    app.input.pressKey("c", { ctrl: true })
    await app.until((f) => !f.includes("Say Minh writes tests first") && f.includes("Ask the profile manager"))
    await typeInto(app, "Shorter please")
    await app.until((f) => f.includes("Shorter please"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Shorter please") && f.includes("Ask the profile manager"))
    await Bun.sleep(100)
    await app.setup.renderOnce()
    expect(app.setup.renderer.isDestroyed).toBe(false)
    expect(app.setup.renderer.currentFocusedEditor).not.toBeNull()
    // Esc on the empty box leaves the box, and the view stays.
    app.input.pressEscape()
    await app.until(() => app.setup.renderer.currentFocusedEditor === null)
    expect(app.frame()).toContain("@minh · profile")
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
    expect(office.requests.filter((r) => r.method === "POST")).toEqual([])
  })
})

test("with no box focused, one Ctrl+C exits", async () => {
  const office = createFakeOffice()
  await run(office, async (app) => {
    await app.until((f) => f.includes("@minh · profile"))
    expect(app.setup.renderer.currentFocusedEditor).toBeNull()
    app.input.pressKey("c", { ctrl: true })
    await app.until(() => app.setup.renderer.isDestroyed)
  })
})
