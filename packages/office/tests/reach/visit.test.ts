/** A visit from a machine where no office answers: approving the saved path, connecting, signing in or opening,
 *  another visit beside a running one, the failure table, and waiting with its reconnects. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import type { Spec } from "../../src/reach/spec.ts"
import { type Access, DEFAULT_PORT, readAccess, sha256, takeLock, writeAccess } from "../../src/reach/state.ts"
import {
  BUSY,
  LOST,
  NO_PATH,
  NOT_YET,
  RUN_THIS,
  RUNNING,
  SIGN_IN_HINT,
  USE_CHANGED,
  opener,
  realVisitDeps,
  type VisitOptions,
  visit,
} from "../../src/reach/visit.ts"
import { KeyboardInterrupt, TtyPrompter } from "../../src/install/prompts.ts"
import { defaultIncludes } from "../../src/reach/ssh.ts"
import { writePrivate } from "../../src/secrets.ts"
import { type FakeSsh, type FakeSshBehavior, fakeControlName } from "../../src/testing/fake_ssh.ts"
import { control, type ReachContext } from "../../src/reach/ssh.ts"
import { ps, waitFor } from "../helpers.ts"
import { fakeHome, fakeRemote, freePort, reachCtx, visitDeps } from "./helpers.ts"

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

test("Ctrl-C at the approval question exits 130 and approves nothing", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(paths.script, NO_JOB(path.join(dir, "ran")))
  const v = visitDeps(dir, fake)
  v.prompter.choose = async () => {
    throw new KeyboardInterrupt()
  }
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(130)
  expect(v.errors).toEqual([])
  expect(fs.existsSync(paths.access)).toBe(false)
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

/** Whether the master at `cm/node` answers `-O check`. */
async function nodeUp(dir: string, fake: FakeSsh): Promise<boolean> {
  const ctx: ReachContext = await reachCtx(dir, fake)
  return (await control(ctx, ctx.paths.node, "check")).code === 0
}

test("while another opencorp hq holds the lock it only opens HQ's URL, and the running visit's master survives", async () => {
  const { dir, fake, port } = await approvedHome({}, { signed_in_at: new Date().toISOString() })
  const first = await connected(dir, fake, { signIn: false, open: false })
  const second = visitDeps(dir, fake)
  expect(await visit({ signIn: false, open: true }, second.deps)).toBe(0)
  expect(second.opened).toEqual([`http://127.0.0.1:${port}/`])
  expect(second.errors).toEqual([RUNNING])
  expect(second.prompter.seen).toEqual([])
  expect(await nodeUp(dir, fake)).toBe(true)
  first.sigint()
  expect(await first.done).toBe(0)
})

test("--sign-in beside a running visit mints over its master and leaves the file for the sweep", async () => {
  const signedIn = new Date(Date.now() - DAY).toISOString()
  const { dir, fake, remote, port, paths } = await approvedHome({}, { signed_in_at: signedIn })
  const first = await connected(dir, fake, { signIn: false, open: false })
  const masters = fake.masters()
  const second = visitDeps(dir, fake)
  expect(await visit({ signIn: true, open: true }, second.deps)).toBe(0)
  expect(second.errors).toEqual([])
  expect(second.opened).toHaveLength(1)
  expect(fs.readFileSync(second.opened[0]!, "utf8")).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  expect(redirects(paths)).toEqual([path.basename(second.opened[0]!)])
  expect((await readAccess(paths))?.signed_in_at).not.toBe(signedIn)
  // It rode the running visit's masters: no new login, and they're still up.
  expect(fake.masters().sort()).toEqual(masters.sort())
  expect(fake.calls().filter((argv) => argv.includes("-M"))).toHaveLength(1)
  expect(await nodeUp(dir, fake)).toBe(true)
  first.sigint()
  expect(await first.done).toBe(0)
})

test("--sign-in before the running visit has connected says to try again", async () => {
  const { dir, fake } = await approvedHome({ hosts: { node1: { login: "hang" } } })
  const first = visitDeps(dir, fake)
  const done = visit({ signIn: false, open: false }, first.deps)
  await waitFor(() => fake.calls().some((argv) => argv.includes("-M")), { what: "the node master" })
  const second = visitDeps(dir, fake)
  expect(await visit({ signIn: true, open: false }, second.deps)).toBe(1)
  expect(second.errors).toEqual([NOT_YET])
  first.sigint()
  expect(await done).toBe(130)
})

test("with the lock held and no access.json yet, it says another run is approving or learning", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  const lock = takeLock(paths)!
  try {
    const v = visitDeps(dir, fake)
    expect(await visit({ signIn: false, open: true }, v.deps)).toBe(1)
    expect(v.errors).toEqual([BUSY])
    expect(v.opened).toEqual([])
  } finally {
    lock.release()
  }
})

/** Each row: its setup on an approved home, then the line and the code it must end with. */
const FAILURES: [string, (h: Awaited<ReturnType<typeof approvedHome>>) => Promise<void> | void, (port: number) => string, number][] = [
  [
    "login refused",
    ({ fake }) => fake.set({ login: "refuse" }),
    () => "opencorp hq: couldn't connect: login1: Permission denied (publickey,password).",
    1,
  ],
  [
    "reach.sh exit 3",
    async ({ dir }) => void (await saved(dir, `echo "no job running" >&2\nexit 3\n`)),
    () => "opencorp hq: no office answers there: no job running. Start the job or the office there, or fix reach.sh if HQ moved.",
    3,
  ],
  [
    "check exit 1",
    ({ remote }) => remote.setCheck({ code: 1, stderr: "opencorp hq: this office has no HQ yet\n" }),
    () =>
      "opencorp hq: HQ isn't ready there: opencorp hq: this office has no HQ yet. Run `opencorp doctor` there, or update that checkout.",
    1,
  ],
  [
    "bad spec",
    async ({ dir, spec }) => void (await saved(dir, scriptFor({ ...spec, host: "-oProxyCommand=x" }))),
    () => "opencorp hq: the saved way to reach HQ is broken: reach.sh printed a spec that isn't valid: host: must be [user@]host",
    1,
  ],
  [
    "port held",
    async ({ port }) => {
      const holder = net.createServer()
      await new Promise<void>((resolve) => holder.listen({ port, host: "127.0.0.1" }, resolve))
      onTestFinished(() => void holder.close())
    },
    (port) =>
      `opencorp hq: port ${port} on 127.0.0.1 is taken by another program; pick a free one with \`opencorp hq --port N\` (you'll sign in again).`,
    1,
  ],
  [
    "blackhole forward",
    ({ fake }) => fake.set({ forward: "blackhole" }),
    (port) =>
      `opencorp hq: HQ didn't answer through the forward (the connection through port ${port} closed before HQ answered); the node's sshd may refuse socket forwarding (AllowStreamLocalForwarding).`,
    1,
  ],
]

test.each(FAILURES)("a failed visit says what to do and exits as the table says [%s]", async (_label, arrange, line, code) => {
  const home = await approvedHome()
  await arrange(home)
  const v = visitDeps(home.dir, home.fake)
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(code)
  expect(v.errors).toEqual([line(home.port)])
  expect(mints(home.fake)).toEqual([])
  expect(fs.readdirSync(home.paths.cm)).toEqual([])
  expect(home.fake.masters()).toEqual([])
})

/** The control sockets the fake's `-O exit` calls named, in order. */
const exits = (fake: FakeSsh) =>
  fake.calls().filter((argv) => argv.includes("-O") && argv.includes("exit")).map((argv) => argv[argv.indexOf("-S") + 1])

/** Drops the connection: SIGTERM to the node master, found by its control socket in its arguments. */
function dropNode(paths: ReachPaths): void {
  const line = processes(`-S ${paths.node}`).find((l) => l.includes(" -M "))
  if (line === undefined) throw new Error("no node master")
  process.kill(Number(line.split(/\s+/)[0]), "SIGTERM")
}

/** The visit lines printed so far. */
const visitLines = (printed: string[]) => printed.filter((line) => line.startsWith("Connected."))

test("Ctrl-C while connected ends every master and exits 0", async () => {
  const { dir, fake, paths } = await approvedHome({}, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(exits(fake)).toEqual([])
  v.sigint()
  expect(await v.done).toBe(0)
  expect(exits(fake)).toEqual([paths.node, path.join(paths.cm, fakeControlName("login1"))])
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("a drop is retried once quietly in BatchMode before asking for Enter", async () => {
  const { dir, fake, paths } = await approvedHome({ batch: "ok", banner: "Welcome to the cluster\n" }, {
    signed_in_at: new Date().toISOString(),
  })
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.echoed.join("")).toContain("Welcome to the cluster")
  const echoed = v.echoed.length
  const batched = () => fake.calls().filter((argv) => argv.includes(paths.batchConfig))
  expect(batched()).toEqual([])
  dropNode(paths)
  await waitFor(() => visitLines(v.printed).length === 2, { what: "the visit to reconnect" })
  expect(v.errors).toEqual([])
  expect(batched().some((argv) => argv.includes("-M"))).toBe(true)
  expect(batched().some((argv) => argv.includes("login1"))).toBe(true)
  expect(v.echoed.length).toBe(echoed)
  v.sigint()
  expect(await v.done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("when the quiet try fails it waits for Enter, and again after each failure", async () => {
  const { dir, fake } = fakeHome({ batch: "refuse" })
  const remote = await fakeRemote(dir)
  const fail = path.join(dir, "fail")
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  const paths = await saved(dir, `[ ! -e '${fail}' ] || exit 1\n${scriptFor(spec)}`, {
    port: await freePort(),
    signed_in_at: new Date().toISOString(),
  })
  // No answers: a relearning question would fail the visit.
  const v = await connected(dir, fake, { signIn: false, open: false })
  const lost = () => v.errors.filter((line) => line === LOST).length
  dropNode(paths)
  await waitFor(() => lost() === 1, { what: "the first press Enter" })
  fs.writeFileSync(fail, "")
  v.stdin.write("\n")
  await waitFor(() => lost() === 2, { what: "the second press Enter" })
  expect(v.errors).toEqual([LOST, "opencorp hq: the saved way to reach HQ is broken: reach.sh exited 1", LOST])
  fs.rmSync(fail)
  v.stdin.write("\n")
  await waitFor(() => visitLines(v.printed).length === 2, { what: "the visit to reconnect" })
  expect(v.prompter.seen).toEqual([])
  v.sigint()
  expect(await v.done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("stdin closing while it waits for Enter ends the visit with 1", async () => {
  const { dir, fake, paths } = await approvedHome({ batch: "refuse" }, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: false })
  dropNode(paths)
  await waitFor(() => v.errors.includes(LOST), { what: "press Enter" })
  v.stdin.end()
  expect(await v.done).toBe(1)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("realVisitDeps asks on stderr, opens with open or xdg-open, and includes the passwd home's ssh config", () => {
  const deps = realVisitDeps("/h/o")
  expect(deps.home).toBe("/h/o")
  expect(deps.env).toBe(process.env)
  expect(deps.stdin).toBe(process.stdin)
  expect(deps.prompter).toBeInstanceOf(TtyPrompter)
  expect((deps.prompter as unknown as { output: unknown }).output).toBe(process.stderr)
  expect([opener("darwin"), opener("linux")]).toEqual(["open", "xdg-open"])
  // The passwd entry's home, which ssh's `~` means, whatever $HOME says; only the path, never read here.
  expect(deps.sshIncludes).toEqual(defaultIncludes(os.userInfo().homedir))
  expect(deps.limits).toBeUndefined()
})
