import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub } from "../../../script/stub"
import { createOfficeClient } from "../../../src/office/client"
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
    reply(office, manager.id, "Proposed a change: see below.")
    await app.until((f) => f.includes("manager: Proposed a change: see below."))
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

const PROPOSED = "# Minh\n\nWrites the test first, then small changes.\n"

test("the open proposal shows as a diff; a applies it", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Tests first" })
  const proposal = office.propose(manager.id, PROPOSED)
  await run(office, async (app) => {
    const f = await app.until((f) => f.includes("+Writes the test first, then small changes."))
    expect(f).toContain("-Writes small, tested changes.")
    expect(f).toContain("a apply")
    // The profile itself still shows above the proposal once the chat grows under it.
    reply(office, manager.id, "Here is a proposal.")
    const profileShown = /^  Writes small, tested changes\. *$/m
    await app.until((f) => f.includes("manager: Here is a proposal.") && profileShown.test(f))
    app.input.pressKey("a")
    await app.until((f) => f.includes("Proposal applied") && !f.includes("+Writes the test first"))
    const last = office.requests.filter((r) => r.method === "POST").at(-1)
    expect(last?.path).toBe(`/profile-proposals/${proposal.id}/apply`)
    expect(office.state.profiles.minh.text).toBe(PROPOSED)
  })
})

test("a proposal made while the view is open appears; applying it after a hand edit says it is stale", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Tests first" })
  await run(office, async (app) => {
    office.propose(manager.id, PROPOSED)
    await app.until((f) => f.includes("+Writes the test first, then small changes."))
    const base_version = office.state.profiles.minh.version
    await client.profiles.put("minh", { text: "# Minh\n\nHand edit.\n", base_version })
    await app.until((f) => f.includes("Hand edit."))
    app.input.pressKey("a")
    await app.until((f) => f.includes("The profile changed after this proposal") && !f.includes("a apply"))
    expect(office.state.profiles.minh.text).toBe("# Minh\n\nHand edit.\n")
  })
})

test("a reconnect re-reads the profile and the proposals (events sent while offline are lost)", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Tests first" })
  await run(office, async (app) => {
    // Direct edits send no events: only a re-read can find them.
    const text = "# Minh\n\nChanged while offline.\n"
    office.state.profiles.minh = { ...office.state.profiles.minh, text, version: "f".repeat(40) }
    office.state.proposals.P1 = {
      id: "P1",
      session_id: manager.id,
      person: "minh",
      base_version: "f".repeat(40),
      text: text + "More.\n",
      diff: "@@ -1,3 +1,4 @@\n+More.\n",
      status: "open",
      commit: null,
      created_at: new Date().toISOString(),
    }
    office.reset()
    await app.until((f) => f.includes("Changed while offline.") && f.includes("+More.") && f.includes("fffffff"))
  })
})

test("a re-read that answers after newer events doesn't undo them", async () => {
  const office = createFakeOffice()
  const client = createOfficeClient({ socket: office.socket })
  const manager = await client.profiles.manager("minh", { text: "Tests first" })
  await run(office, async (app) => {
    const reads = () => office.requests.filter((r) => r.method === "GET" && r.path.startsWith("/profiles/minh")).length
    const before = reads()
    // Both re-reads answer with the state from when they arrived, after the events below.
    const releaseProfile = office.hold("GET /profiles/:person", "reply")
    const releaseProposals = office.hold("GET /profiles/:person/proposals", "reply")
    office.reset()
    await until(() => reads() === before + 2)
    await client.profiles.put("minh", { text: "# Minh\n\nNewer.\n", base_version: office.state.profiles.minh.version })
    office.propose(manager.id, "# Minh\n\nNewer, proposed.\n")
    await app.until((f) => f.includes("Newer.") && f.includes("+Newer, proposed."))
    releaseProfile()
    releaseProposals()
    // Give the held replies time to land.
    await Bun.sleep(200)
    const f = await app.until(() => true)
    expect(f).toContain("Newer.")
    expect(f).toContain("+Newer, proposed.")
    expect(f).not.toContain("Writes small, tested changes.")
  })
})
