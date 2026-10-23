import { afterEach, beforeEach, expect, test } from "bun:test"
import { createOfficeClient } from "@opencorp/client"
import { conflictText } from "@opencorp/tui/profile"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFakeOffice, type FakeOffice } from "@opencorp/tui/stub"
import { main } from "../src/main"

let home: string
let socket: string
let office: FakeOffice
const saved = { ...process.env }

beforeEach(() => {
  // A short path: unix socket paths are limited to about 100 bytes.
  home = mkdtempSync(path.join(os.tmpdir(), "acpe-"))
  mkdirSync(path.join(home, "office"))
  socket = path.join(home, "office", "office.sock")
  process.env.OPENCORP_HOME = home
  delete process.env.VISUAL
  delete process.env.EDITOR
  office = createFakeOffice({ socket })
})
afterEach(() => {
  office.stop()
  process.env = { ...saved }
  rmSync(home, { recursive: true, force: true })
})

/** Runs `opencorp profile …`, capturing what it writes to stdout and stderr. */
async function profile(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try {
    return { code: await main(["profile", ...argv]), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}

/** Makes $EDITOR the shell script `body`, in which $1 is the file being edited. */
function editor(body: string) {
  writeFileSync(path.join(home, "ed.sh"), body)
  process.env.EDITOR = `sh ${path.join(home, "ed.sh")}`
}

const puts = () => office.requests.filter((r) => r.method === "PUT").map((r) => r.body)

/** The file `err` says the unsaved edit is kept in; checks it is private to the user. */
function kept(err: string) {
  const file = /^opencorp profile: your edit is kept in (.+)$/m.exec(err)?.[1]
  if (!file) throw new Error(`no kept file in: ${err}`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  return readFileSync(file, "utf8")
}

test("edit opens the profile in $EDITOR and saves it over the version it read", async () => {
  const before = office.state.profiles.minh!
  editor(`printf -- '- Likes short replies.\\n' >> "$1"\n`)
  const r = await profile("edit", "@minh")
  expect(r).toMatchObject({ code: 0, err: "" })
  expect(puts()).toEqual([{ text: before.text + "- Likes short replies.\n", base_version: before.version }])
  expect(office.state.profiles.minh!.text).toBe(before.text + "- Likes short replies.\n")
  expect(r.out).toBe(`Saved the profile of @minh (${office.state.profiles.minh!.version.slice(0, 7)})`)
})

test("PERSON is a handle, with or without the @, and the profile is read and saved by handle", async () => {
  office.state.people.push({ handle: "lan", name: "Lan", kind: "agent", title: "QA", manager: "ngocbh" })
  office.state.profiles.lan = { person: "lan", text: "# Lan\n", version: "v-lan", over_budget: false }
  editor(`printf -- '- Tests first.\\n' >> "$1"\n`)
  expect((await profile("edit", "@lan")).code).toBe(0)
  expect((await profile("edit", "lan")).code).toBe(0)
  const paths = office.requests.filter((r) => r.path.startsWith("/profiles/")).map((r) => `${r.method} ${r.path}`)
  expect([...new Set(paths)]).toEqual(["GET /profiles/lan", "PUT /profiles/lan"])
  expect(office.state.profiles.lan!.text).toBe("# Lan\n- Tests first.\n- Tests first.\n")
})

/**
 * An editor that, on its first run, signals it opened, waits for the test to change the
 * profile by hand, then appends "My line."; on later runs it keeps a copy of what it was
 * given and runs `then` on the file.
 */
function racingEditor(then: string) {
  editor(
    [
      `if [ ! -f ${home}/first ]; then`,
      `  touch ${home}/first ${home}/opened`,
      `  while [ ! -f ${home}/go ]; do sleep 0.02; done`,
      `  printf 'My line.\\n' >> "$1"`,
      `else`,
      `  cp "$1" ${home}/seen.md`,
      `  ${then}`,
      `fi`,
      "",
    ].join("\n"),
  )
}

/** Starts `opencorp profile edit minh` and changes the profile to `theirs` while its editor is open. */
async function editDuringHandEdit(theirs: string) {
  const pending = profile("edit", "minh")
  while (!existsSync(path.join(home, "opened"))) await Bun.sleep(10)
  const other = createOfficeClient({ socket })
  const hand = await other.profiles.put("minh", { text: theirs, base_version: office.state.profiles.minh!.version })
  writeFileSync(path.join(home, "go"), "")
  return { r: await pending, hand }
}

test("a conflict re-opens the editor on the new text with the rejected edit under the marker", async () => {
  const before = office.state.profiles.minh!
  const mine = before.text + "My line.\n"
  const theirs = before.text + "Their line.\n"
  const merged = before.text + "Their line.\nMy line.\n"
  racingEditor(`printf '%s' '${merged}' > "$1"`)
  const { r, hand } = await editDuringHandEdit(theirs)
  expect(r.code).toBe(0)
  expect(r.err).toContain("changed while you edited it")
  expect(await Bun.file(path.join(home, "seen.md")).text()).toBe(conflictText(theirs, mine))
  expect(puts().slice(-2)).toEqual([
    { text: mine, base_version: before.version },
    { text: merged, base_version: hand.version },
  ])
  expect(office.state.profiles.minh!.text).toBe(merged)
})

test("a conflict with a profile that already holds the edit counts as saved", async () => {
  const mine = office.state.profiles.minh!.text + "My line.\n"
  racingEditor(":")
  const { r, hand } = await editDuringHandEdit(mine)
  expect(r).toMatchObject({ code: 0, out: `Saved the profile of @minh (${hand.version.slice(0, 7)})` })
  expect(existsSync(path.join(home, "seen.md"))).toBe(false)
  expect(r.err).not.toContain("kept")
  expect(office.state.profiles.minh!.text).toBe(mine)
})

test("after a conflict, saving without merging keeps the rejected edit in a file and says so", async () => {
  const before = office.state.profiles.minh!
  const theirs = before.text + "Their line.\n"
  // Leaves the file as given: the new text, the marker, and the rejected edit below it.
  racingEditor(":")
  const { r } = await editDuringHandEdit(theirs)
  expect(r).toMatchObject({ code: 1 })
  expect(r.err).toContain("opencorp profile: your edit was not saved")
  expect(kept(r.err)).toBe(before.text + "My line.\n")
  expect(puts()).toHaveLength(2)
  expect(office.state.profiles.minh!.text).toBe(theirs)
})

test("after a conflict, emptying the file or a failing editor keeps the rejected edit", async () => {
  const before = office.state.profiles.minh!
  racingEditor(`: > "$1"`)
  const emptied = (await editDuringHandEdit(before.text + "Their line.\n")).r
  expect(emptied.code).toBe(1)
  expect(kept(emptied.err)).toBe(before.text + "My line.\n")
  rmSync(path.join(home, "first"))
  rmSync(path.join(home, "opened"))
  rmSync(path.join(home, "go"))
  const now = office.state.profiles.minh!
  racingEditor("exit 3")
  const failed = (await editDuringHandEdit(now.text + "Another line.\n")).r
  expect(failed.code).toBe(1)
  expect(failed.err).toContain("opencorp profile: the editor exited with code 3")
  expect(kept(failed.err)).toBe(now.text + "My line.\n")
})

test("a save the office fails for another reason keeps the edit in a file", async () => {
  const before = office.state.profiles.minh!
  office.notImplemented.add("PUT /profiles/:person")
  editor(`printf 'My line.\\n' >> "$1"\n`)
  const r = await profile("edit", "minh")
  expect(r.code).toBe(1)
  expect(kept(r.err)).toBe(before.text + "My line.\n")
  expect(office.state.profiles.minh!.text).toBe(before.text)
})

test("a failed re-read after a conflict keeps the edit in a file", async () => {
  const before = office.state.profiles.minh!
  racingEditor(":")
  const pending = profile("edit", "minh")
  while (!existsSync(path.join(home, "opened"))) await Bun.sleep(10)
  const other = createOfficeClient({ socket })
  await other.profiles.put("minh", { text: before.text + "Their line.\n", base_version: before.version })
  office.notImplemented.add("GET /profiles/:person")
  writeFileSync(path.join(home, "go"), "")
  const r = await pending
  expect(r.code).toBe(1)
  expect(kept(r.err)).toBe(before.text + "My line.\n")
})

test("a finished edit leaves no temp file behind", async () => {
  editor(`printf '%s' "$1" > ${home}/path; printf 'More.\\n' >> "$1"\n`)
  expect((await profile("edit", "minh")).code).toBe(0)
  expect(existsSync(path.dirname(readFileSync(path.join(home, "path"), "utf8")))).toBe(false)
})

test("saving the text unchanged writes nothing", async () => {
  editor(`: # leaves the file as it is\n`)
  const r = await profile("edit", "minh")
  expect(r).toMatchObject({ code: 0, out: "No changes" })
  expect(puts()).toEqual([])
})

test("saving an empty file writes nothing", async () => {
  editor(`: > "$1"\n`)
  const r = await profile("edit", "minh")
  expect(r).toMatchObject({ code: 1, err: "opencorp profile: the file is empty; nothing saved" })
  expect(puts()).toEqual([])
})

test("a save over the profile budget warns", async () => {
  office.stop()
  office = createFakeOffice({ socket, profileMaxChars: 10 })
  editor(`printf 'More.\\n' >> "$1"\n`)
  const r = await profile("edit", "minh")
  expect(r.code).toBe(0)
  expect(r.err).toBe("opencorp profile: the profile is over the company's profile budget")
})

test("usage errors exit 2 and office errors exit 1", async () => {
  const noEditor = await profile("edit", "minh")
  expect(noEditor.code).toBe(2)
  expect(noEditor.err).toContain("$EDITOR")
  expect((await profile()).code).toBe(2)
  const show = await profile("show", "minh")
  expect(show.code).toBe(2)
  expect(show.err).toContain("Usage: opencorp profile edit PERSON")
  expect((await profile("edit", "minh", "extra")).code).toBe(2)
  editor(`: # leaves the file as it is\n`)
  const unknown = await profile("edit", "@nobody")
  expect(unknown).toMatchObject({ code: 1, err: "opencorp profile: no person @nobody" })
  editor(`exit 3\n`)
  const failed = await profile("edit", "minh")
  expect(failed.code).toBe(1)
  expect(failed.err).toBe("opencorp profile: the editor exited with code 3")
  expect(puts()).toEqual([])
})

test("with no office running, edit says so and exits 3", async () => {
  office.stop()
  rmSync(socket, { force: true })
  editor(`: # leaves the file as it is\n`)
  const r = await profile("edit", "minh")
  expect([r.code, r.err]).toEqual([3, "The office isn't running. Run `opencorp doctor`."])
})
