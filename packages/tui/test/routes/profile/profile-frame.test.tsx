import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub } from "../../../script/stub"
import { createOfficeClient } from "../../../src/office/client"
import { CONFLICT_MARKER } from "../../../src/routes/profile/profile"
import { bootFrame } from "../../fixture/frame"
import { until } from "../../fixture/until"

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
