/** A visit from a machine where no office answers: approving the saved path, connecting, signing in or opening,
 *  another visit beside a running one, the failure table, and waiting with its reconnects. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ReachPaths } from "../../src/reach/paths.ts"
import { type Spec } from "../../src/reach/spec.ts"
import { type Access, DEFAULT_PORT, readAccess, sha256, writeAccess } from "../../src/reach/state.ts"
import { NO_PATH, RUN_THIS, USE_CHANGED, visit } from "../../src/reach/visit.ts"
import { makeDirs } from "../../src/reach/paths.ts"
import { writePrivate } from "../../src/secrets.ts"
import { fakeHome, fakeRemote, visitDeps } from "./helpers.ts"

setDefaultTimeout(30_000)

/** reach.sh as an owner would write it: log in to login1 (leaving its master), then print `spec`. */
const scriptFor = (spec: Spec) => `set -eu\nssh login1 true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`

/** Makes `<dir>/hq` and writes `body` as reach.sh, approved (with access.json) unless `approved` is false. */
async function saved(dir: string, body: string, over: Partial<Access> = {}): Promise<ReachPaths> {
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(paths.script, body)
  await writePrivate(paths.approved, body)
  await writeAccess(paths, {
    port: DEFAULT_PORT,
    sha256: sha256(body),
    learned_at: "2026-11-01T10:00:00.000Z",
    last_used_at: null,
    signed_in_at: null,
    ...over,
  })
  return paths
}

const NO_JOB = (marker: string) => `touch '${marker}'\necho "no job running" >&2\nexit 3\n`

test("with no reach.sh it says how to write one and exits 1", async () => {
  const { dir, fake } = fakeHome()
  const { deps, errors } = visitDeps(dir, fake)
  expect(await visit({ signIn: false, open: false }, deps)).toBe(1)
  expect(errors).toEqual([NO_PATH(new ReachPaths(dir))])
  expect(fake.masters()).toEqual([])
})

test("an owner-written reach.sh is shown whole and runs only once approved", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  const marker = path.join(dir, "ran")
  const body = NO_JOB(marker)
  fs.writeFileSync(paths.script, body, { mode: 0o644 })
  const { deps, prompter, errors } = visitDeps(dir, fake, { answers: ["1"] })
  expect(await visit({ signIn: false, open: false }, deps)).toBe(3)
  expect(prompter.seen).toContain(`  touch '${marker}'`)
  expect(prompter.seen).toContain("  exit 3")
  expect(prompter.seen.filter((line) => line === RUN_THIS)).toHaveLength(1)
  expect(fs.readFileSync(paths.approved, "utf8")).toBe(body)
  const access = await readAccess(paths)
  expect(access).toMatchObject({ sha256: sha256(body), port: 49381, signed_in_at: null, last_used_at: null })
  expect(fs.existsSync(marker)).toBe(true)
  expect(errors).toEqual([
    "opencorp hq: no office answers there: no job running. Start the job or the office there, or fix reach.sh if HQ moved.",
  ])
})

test("an approval left unanswered stops the visit", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  const marker = path.join(dir, "ran")
  fs.writeFileSync(paths.script, NO_JOB(marker))
  const { deps } = visitDeps(dir, fake, { interactive: false })
  expect(await visit({ signIn: false, open: false }, deps)).toBe(1)
  expect(fs.existsSync(paths.access)).toBe(false)
  expect(fs.existsSync(paths.approved)).toBe(false)
  expect(fs.existsSync(marker)).toBe(false)
})

test("a changed reach.sh shows the diff and asks once; no stops the visit", async () => {
  const { dir, fake } = fakeHome()
  const remote = await fakeRemote(dir)
  const before = scriptFor({ host: "node1", jump: ["login1"], opencorp: remote.opencorp })
  const paths = await saved(dir, before)
  const access = fs.readFileSync(paths.access, "utf8")
  const marker = path.join(dir, "ran")
  fs.writeFileSync(paths.script, `touch '${marker}'\n${before}`)
  const { deps, prompter, errors } = visitDeps(dir, fake, { answers: ["2"] })
  expect(await visit({ signIn: false, open: false }, deps)).toBe(1)
  expect(prompter.seen).toContain(`+touch '${marker}'`)
  expect(prompter.seen.filter((line) => line === USE_CHANGED)).toHaveLength(1)
  expect(fs.readFileSync(paths.access, "utf8")).toBe(access)
  expect(fs.readFileSync(paths.approved, "utf8")).toBe(before)
  expect(fs.existsSync(marker)).toBe(false)
  expect(errors).toEqual(["opencorp hq: stopped; reach.sh isn't approved."])
  expect(fake.calls()).toEqual([])
})
