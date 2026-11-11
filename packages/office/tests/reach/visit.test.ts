/** A visit from a machine where no office answers: approving the saved path, connecting, signing in or opening,
 *  another visit beside a running one, the failure table, and waiting with its reconnects. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import type { Spec } from "../../src/reach/spec.ts"
import { type Access, DEFAULT_PORT, readAccess, sha256, takeLock, writeAccess } from "../../src/reach/state.ts"
import { NO_PATH, RUN_THIS, SIGN_IN_HINT, USE_CHANGED, type VisitOptions, visit } from "../../src/reach/visit.ts"
import { writePrivate } from "../../src/secrets.ts"
import type { FakeSsh, FakeSshBehavior } from "../../src/testing/fake_ssh.ts"
import { ps, waitFor } from "../helpers.ts"
import { fakeHome, fakeRemote, freePort, visitDeps } from "./helpers.ts"

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

/** The command lines of this user's processes that mention `text`, but not the `ps` listing them. */
function processes(text: string): string[] {
  const out = execFileSync(ps(), ["-A", "-o", "pid=,args="], { env: { LC_ALL: "C" }, encoding: "utf8", timeout: 5000 })
  return out
    .split("\n")
    .filter((line) => line.includes(text) && !line.includes(" -o pid=,args="))
    .map((line) => line.trim())
}

/** A home with HQ's machine reached as node1 through login1: an approved reach.sh and a free port. */
async function approvedHome(behavior: FakeSshBehavior = {}, over: Partial<Access> = {}) {
  const { dir, fake } = fakeHome(behavior)
  const remote = await fakeRemote(dir)
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  const port = await freePort()
  const paths = await saved(dir, scriptFor(spec), { port, ...over })
  return { dir, fake, remote, spec, port, paths }
}

/** Starts a visit and waits for its "Connected." line. */
async function connected(dir: string, fake: FakeSsh, options: VisitOptions, more: Parameters<typeof visitDeps>[2] = {}) {
  const v = visitDeps(dir, fake, more)
  const done = visit(options, v.deps)
  await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 0, { what: "the visit to connect" })
  expect(v.errors).toEqual([])
  return { ...v, done }
}

/** What's left of a visit once it returned: control sockets, fake masters, and processes naming the hq folder. */
function leftover(fake: FakeSsh, paths: ReachPaths) {
  return { cm: fs.readdirSync(paths.cm), masters: fake.masters(), processes: processes(paths.dir) }
}

test("a visit writes the ssh files with the given includes and starts one watcher", async () => {
  const { dir, fake, paths } = await approvedHome()
  const inc = path.join(dir, "inc")
  const v = await connected(dir, fake, { signIn: false, open: false }, { sshIncludes: [inc] })
  expect(fs.readFileSync(paths.config, "utf8")).toContain(`Include "${inc}"`)
  expect(fs.readFileSync(paths.batchConfig, "utf8")).toContain(`Include "${inc}"`)
  expect(fs.statSync(paths.wrapper).mode & 0o777).toBe(0o700)
  expect(processes(paths.cm).filter((line) => line.includes("opencorp-hq-watch"))).toHaveLength(1)
  v.sigint()
  expect(await v.done).toBe(0)
})

test("a visit's end runs exitAll, then releases the watcher, before the lock is free", async () => {
  const { dir, fake, paths } = await approvedHome()
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(takeLock(paths)).toBeNull()
  expect(fake.masters().length).toBe(2)
  v.sigint()
  expect(await v.done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
  const lock = takeLock(paths)
  expect(lock).not.toBeNull()
  lock!.release()
})

test("Ctrl-C before connecting returns 130 and leaves nothing", async () => {
  const { dir, fake, paths } = await approvedHome({ hosts: { node1: { login: "hang" } } })
  const v = visitDeps(dir, fake)
  const done = visit({ signIn: false, open: false }, v.deps)
  await waitFor(() => fake.calls().some((argv) => argv.includes("-M")), { what: "the node master" })
  v.sigint()
  expect(await done).toBe(130)
  expect(v.errors).toEqual([])
  await waitFor(() => processes(paths.dir).length === 0, { what: "the hung login to end", timeout: 10_000 })
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

/** The fake's mux calls that ran `opencorp hq --json` there: a code minted. */
const mints = (fake: FakeSsh) => fake.calls().filter((argv) => argv.at(-1)!.endsWith("'hq' '--json'"))
/** The redirect files in the hq folder. */
const redirects = (paths: ReachPaths) => fs.readdirSync(paths.dir).filter((name) => name.startsWith("pair-"))
const DAY = 24 * 60 * 60_000

test("the first visit signs in through a redirect file and records signed_in_at", async () => {
  const { dir, fake, remote, port, paths } = await approvedHome()
  const v = await connected(dir, fake, { signIn: false, open: true })
  expect(v.opened).toHaveLength(1)
  const file = v.opened[0]!
  expect(path.dirname(file)).toBe(paths.dir)
  expect(path.basename(file)).toMatch(/^pair-[0-9a-f]{16}\.html$/)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(file, "utf8")).toContain(`href="http://127.0.0.1:${port}/pair#${remote.code}"`)
  const access = await readAccess(paths)
  expect(access?.signed_in_at).not.toBeNull()
  expect(access?.last_used_at).not.toBeNull()
  v.sigint()
  expect(await v.done).toBe(0)
})

test("a later visit opens HQ's URL and mints nothing", async () => {
  const { dir, fake, port, paths } = await approvedHome({}, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: true })
  expect(v.opened).toEqual([`http://127.0.0.1:${port}/`])
  expect(mints(fake)).toEqual([])
  expect(redirects(paths)).toEqual([])
  expect(v.printed).not.toContain(SIGN_IN_HINT)
  v.sigint()
  expect(await v.done).toBe(0)
})

test("--sign-in mints again, and --port moves the port and signs in again", async () => {
  const signedIn = new Date(Date.now() - DAY).toISOString()
  const { dir, fake, remote, port, paths } = await approvedHome({}, { signed_in_at: signedIn })
  let v = await connected(dir, fake, { signIn: true, open: false })
  expect(v.printed).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  expect(mints(fake)).toHaveLength(1)
  v.sigint()
  expect(await v.done).toBe(0)
  expect((await readAccess(paths))?.signed_in_at).not.toBe(signedIn)
  const moved = await freePort()
  v = await connected(dir, fake, { signIn: false, port: moved, open: false })
  expect(v.printed).toContain(`http://127.0.0.1:${moved}/pair#${remote.code}`)
  expect(mints(fake)).toHaveLength(2)
  const res = await fetch(`http://127.0.0.1:${moved}/api/health`, { headers: { connection: "close" } })
  expect(res.status).toBe(200)
  v.sigint()
  expect(await v.done).toBe(0)
  expect((await readAccess(paths))?.port).toBe(moved)
})

test("after 30 days signed in it hints at --sign-in", async () => {
  const old = new Date(Date.now() - 31 * DAY).toISOString()
  const { dir, fake } = await approvedHome({}, { signed_in_at: old })
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.printed).toContain(SIGN_IN_HINT)
  expect(mints(fake)).toEqual([])
  v.sigint()
  expect(await v.done).toBe(0)
})

test("without opening it prints the URL or the sign-in link", async () => {
  const { dir, fake, remote, port, paths } = await approvedHome()
  let v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.printed).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  expect([v.opened, redirects(paths)]).toEqual([[], []])
  v.sigint()
  expect(await v.done).toBe(0)
  v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.printed).toContain(`http://127.0.0.1:${port}/`)
  v.sigint()
  expect(await v.done).toBe(0)
})

test("when the opener can't start it says why and prints the link", async () => {
  const { dir, fake, remote, port } = await approvedHome()
  const v = visitDeps(dir, fake, {
    open: () => {
      throw new Error("no xdg-open")
    },
  })
  const done = visit({ signIn: false, open: true }, v.deps)
  await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")), { what: "the visit to connect" })
  expect(v.errors).toEqual(["opencorp hq: couldn't open a browser (no xdg-open); open this link:"])
  expect(v.printed).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  v.sigint()
  expect(await done).toBe(0)
})

test("the visit line names what stays open until Ctrl-C", async () => {
  const { dir, fake, port } = await approvedHome()
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.printed.at(-1)).toBe(
    `Connected. Until Ctrl-C these stay open: SSH to node1 through login1, and HQ at http://127.0.0.1:${port}/.`,
  )
  v.sigint()
  expect(await v.done).toBe(0)
})
