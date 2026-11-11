/** Learning the path to HQ: the shell tool the agent runs commands with, save_access, which tests the whole chain
 *  before it saves, and a run of learn_hq with the fake model. */
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ReportedToolError } from "@ngocbh/yian"
import {
  CANCEL,
  DONT_RUN,
  Learning,
  RUN,
  RUN_QUESTION,
  runShell,
  SAVE,
  SAVE_QUESTION,
  SAVED,
  saveAccess,
  saveAccessTool,
  secretIn,
  shellResult,
  WHAT_SHOULD_CHANGE,
} from "../../src/reach/learn.ts"
import { BEFORE_LEARNING, beforeSaving } from "../../src/reach/risks.ts"
import type { Spec } from "../../src/reach/spec.ts"
import { exitAll, isSocket, type ReachContext } from "../../src/reach/ssh.ts"
import { type Access, readAccess, sha256, writeAccess } from "../../src/reach/state.ts"
import { writePrivate } from "../../src/secrets.ts"
import { fakeControlName } from "../../src/testing/fake_ssh.ts"
import type { FakeSsh, FakeSshBehavior } from "../../src/testing/fake_ssh.ts"
import { Script } from "../install/helpers.ts"
import { fakeHome, fakeRemote, freePort, reachCtx } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A learning run over a fake ssh: its context, the owner's `answers`, and what reached the owner's terminal. */
async function learning(
  answers: string[],
  { behavior, secrets = [], port = 49381, ...more }: { behavior?: FakeSshBehavior; secrets?: string[]; port?: number } & Partial<ReachContext> = {},
) {
  const { dir, fake } = fakeHome(behavior)
  const echoed: string[] = []
  const ctx = await reachCtx(dir, fake, { echo: (t) => void echoed.push(t), ...more })
  const prompter = new Script(answers)
  const stdin = new PassThrough()
  const state = new Learning(ctx, prompter, stdin, secrets, port)
  return { dir, fake, ctx, prompter, stdin, state, echoed }
}

/** What `promise` rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

test("a command runs only once the owner approves it, and the model gets its exit, stdout and stderr", async () => {
  const { prompter, state, echoed } = await learning(["1"])
  const got = await runShell({ command: "echo out\necho err >&2; exit 4", why: "see what the login node says" }, state)
  expect(got).toBe("exit 4\nstdout:\nout\nstderr:\nerr")
  expect(prompter.seen).toEqual([
    "The model wants to run a command: see what the login node says",
    "  echo out",
    "  echo err >&2; exit 4",
    RUN_QUESTION,
  ])
  expect(prompter.offered).toEqual([[RUN, DONT_RUN]])
  expect(echoed.join("")).toContain("out\n")
  expect(echoed.join("")).toContain("err\n")
  expect(state.commands).toEqual([{ command: "echo out\necho err >&2; exit 4", code: 4 }])
})

test("a refused command doesn't run and the model is told why", async () => {
  const { dir, prompter, state } = await learning(["2", "not that host"])
  const marker = path.join(dir, "ran")
  const error = await rejection(runShell({ command: `touch '${marker}'`, why: "check" }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("The owner didn't run it: not that host")
  expect(prompter.seen.at(-1)).toBe("Why not? (empty to skip)")
  expect(fs.existsSync(marker)).toBe(false)
  expect(state.commands).toEqual([{ command: `touch '${marker}'`, code: null }])
})

test("an unanswered approval doesn't run", async () => {
  const { dir, state } = await learning(["", ""])
  const marker = path.join(dir, "ran")
  const error = await rejection(runShell({ command: `touch '${marker}'`, why: "check" }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("The owner didn't run it.")
  expect(fs.existsSync(marker)).toBe(false)
})

test("a command with control characters is refused unseen", async () => {
  const { prompter, state } = await learning([])
  for (const command of ["echo \x1b[2Jhi", "echo a\rb", "echo \x9bx"]) {
    const error = await rejection(runShell({ command, why: "x" }, state))
    expect(error).toBeInstanceOf(ReportedToolError)
    expect(error.message).toContain("control characters")
  }
  expect(prompter.seen).toEqual([])
})

test("an ssh that couldn't connect inside a command is named for the model", async () => {
  const { state } = await learning(["1"], { behavior: { login: "refuse" } })
  const got = await runShell({ command: "ssh x true || true", why: "try" }, state)
  expect(got).toStartWith("exit 0\nan ssh in it exited 255: it couldn't connect\n")
  expect(got).toContain("Permission denied")
})

test("commands get our env, stdin from /dev/null, the hq folder and 5 minutes", async () => {
  const { ctx, state } = await learning(["1", "1"], {
    env: { PATH: "/usr/bin:/bin", HOME: "/h", SSH_AUTH_SOCK: "/h/agent", SECRET: "x" },
  })
  const got = await runShell({ command: "env | cut -d= -f1 | sort; [ -t 0 ] || echo nostdin; pwd", why: "env" }, state)
  const names = got
    .split("\n")
    .filter((l) => /^[A-Z_][A-Z0-9_]*$/.test(l) && !["PWD", "SHLVL", "_"].includes(l))
  expect(names).toEqual(["HOME", "OPENCORP_SSH_CONFIG", "OPENCORP_SSH_STATUS", "PATH", "SSH_AUTH_SOCK"])
  expect(got).toContain("\nnostdin\n")
  expect(got).toContain(`\n${ctx.paths.dir}\n`)
  const short = new Learning({ ...ctx, limits: { promptMs: 300, stepMs: 300 } }, new Script(["1"]), new PassThrough(), [], 49381)
  expect(await runShell({ command: "sleep 10", why: "wait" }, short)).toStartWith(
    "stopped: it didn't finish within 5 minutes\n",
  )
})

test("after the owner approves, stdin leaves raw mode and is paused before the command runs", async () => {
  const modes: boolean[] = []
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => void modes.push(on) })
  const { ctx } = await learning([])
  const seen: { paused: boolean; modes: boolean[] }[] = []
  stdin.resume()
  const state = new Learning(
    { ...ctx, echo: () => void seen.push({ paused: stdin.isPaused(), modes: [...modes] }) },
    new Script(["1"]),
    stdin,
    [],
    49381,
  )
  await runShell({ command: "echo hi >&2", why: "x" }, state)
  expect(seen[0]).toEqual({ paused: true, modes: [false] })
})

test("a result says when there was no output", () => {
  const ran = { code: 0, stdout: "", stderr: "", timedOut: false }
  expect(shellResult(ran, [])).toBe("exit 0\nstdout:\n(none)\nstderr:\n(none)")
  expect(shellResult({ ...ran, stdout: "a\x1b[31mb\n" }, [0])).toBe("exit 0\nstdout:\na[31mb\nstderr:\n(none)")
})

const KEY = "sk-ant-test-0123456789abcdef"
const NOTES = "Log in to login1, then find the job's node with squeue.\n"

test("save_access refuses the model's key, a private key and sshpass, before showing anything", async () => {
  const base64 = Buffer.from(KEY).toString("base64")
  const cases: [Partial<{ script: string; notes: string }>, string][] = [
    [{ script: `export K=${KEY}\n` }, "it holds the model's API key"],
    [{ notes: `the key is ${base64}\n` }, "it holds the model's API key"],
    [{ script: "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nEOF\n" }, "it holds a private key"],
    [{ script: "sshpass -p hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "SSHPASS=hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "echo \x1b[2J\n" }, "control characters"],
  ]
  for (const [files, why] of cases) {
    const { prompter, state, ctx } = await learning([], { secrets: [KEY] })
    const error = await rejection(saveAccess({ script: "echo {}\n", notes: NOTES, risks: [], ...files }, state))
    expect(error).toBeInstanceOf(ReportedToolError)
    expect(error.message).toStartWith("Not saved:")
    expect(error.message).toContain(why)
    expect(error.message).not.toContain(KEY)
    expect(prompter.seen).toEqual([])
    expect(fs.readdirSync(ctx.paths.dir).sort()).toEqual(["cm", "ssh"])
  }
  expect(secretIn("ssh login1 true", [""])).toBeNull()
})

test("save_access shows both files whole and the fixed risks before the setup's own", async () => {
  const { prompter, state, ctx } = await learning(["2", ""])
  const script = "set -eu\nssh login1 true\nprintf '%s\\n' '{}'\n"
  await rejection(saveAccess({ script, notes: "Line one.\n\nLine \u202etwo.\n", risks: ["Duo on the node too: two prompts."] }, state))
  expect(prompter.seen).toEqual([
    `The model wants to save how this machine reaches HQ. ${ctx.paths.script}, which runs on every visit:`,
    "  set -eu",
    "  ssh login1 true",
    "  printf '%s\\n' '{}'",
    `${ctx.paths.notes}:`,
    "  Line one.",
    "  ",
    "  Line <U+202E>two.",
    "Before you save it:",
    ...beforeSaving(ctx.paths).map((line) => `  - ${line}`),
    "  - Duo on the node too: two prompts.",
    SAVE_QUESTION,
    WHAT_SHOULD_CHANGE,
  ])
  expect(prompter.offered).toEqual([[SAVE, CANCEL]])
  expect(BEFORE_LEARNING.some((line) => prompter.seen.includes(line))).toBe(false)
})

test("declining to save tells the model what should change and saves nothing", async () => {
  const { prompter, state, ctx, fake } = await learning(["2", "use squeue"])
  const error = await rejection(saveAccess({ script: "exit 3\n", notes: NOTES, risks: [] }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("Not saved: the owner wants a change: use squeue")
  expect(prompter.seen.at(-2)).toBe(SAVE_QUESTION)
  for (const file of [ctx.paths.script, ctx.paths.notes, ctx.paths.access, ctx.paths.approved]) expect(fs.existsSync(file)).toBe(false)
  expect(fake.calls()).toEqual([])
  expect(state.connection).toBeNull()
  const unanswered = await learning(["", ""])
  expect((await rejection(saveAccess({ script: "exit 3\n", notes: NOTES, risks: [] }, unanswered.state))).message).toBe(
    "Not saved: the owner didn't save it.",
  )
})

/** reach.sh as the agent would write it: log in to login1 (leaving its master), then print `spec`; `before` runs
 *  first. */
const scriptFor = (spec: Spec, before = "") => `set -eu\n${before}ssh login1 true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`

/** A learning run whose owner answers `answers`, HQ's machine reached as node1 through login1, and a free port. */
async function chain(answers: string[], behavior: FakeSshBehavior = {}) {
  const port = await freePort()
  const run = await learning(answers, { behavior, port })
  const remote = await fakeRemote(run.dir)
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  return { ...run, remote, spec, port }
}

test("save_access writes nothing until the whole chain passes, then keeps the connection open", async () => {
  const { ctx, state, spec, port, echoed, fake, prompter } = await chain(["1"])
  const early = "for f in reach.sh reach.approved.sh notes.md access.json; do [ ! -e \"$f\" ] || echo \"early $f\" >&2; done\n"
  const script = scriptFor(spec, early)
  const got = await saveAccess({ script, notes: NOTES, risks: [] }, state)
  expect(got).toBe("Saved, and the whole connection works. Reply with one line for the owner.")
  expect(echoed.join("")).not.toContain("early")
  const { paths } = ctx
  expect(fs.readFileSync(paths.script, "utf8")).toBe(script)
  expect(fs.readFileSync(paths.approved, "utf8")).toBe(script)
  expect(fs.readFileSync(paths.notes, "utf8")).toBe(NOTES)
  for (const file of [paths.script, paths.approved, paths.notes, paths.access]) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  const access = await readAccess(paths)
  expect(access).toMatchObject({ port, sha256: sha256(script), last_used_at: null, signed_in_at: null })
  expect(Date.now() - Date.parse(access!.learned_at)).toBeLessThan(60_000)
  expect(state.connection).toMatchObject({ spec, port })
  expect(isSocket(paths.node)).toBe(true)
  expect(prompter.seen.at(-1)).toBe("Saved, and the whole connection works.")
  expect(fs.readdirSync(paths.dir).filter((name) => name.startsWith(".reach-"))).toEqual([])
  expect(saveAccessTool.name).toBe("save_access")
  await exitAll(ctx)
  expect(fake.masters()).toEqual([])
})

const OLD = "set -eu\necho old >&2\nexit 3\n"

/** Saves `OLD` as the approved path, with `over` in its access.json. */
async function oldPath(ctx: ReachContext, over: Partial<Access> = {}): Promise<void> {
  await writePrivate(ctx.paths.script, OLD)
  await writePrivate(ctx.paths.approved, OLD)
  await writePrivate(ctx.paths.notes, "old notes\n")
  await writeAccess(ctx.paths, {
    port: 49381,
    sha256: sha256(OLD),
    learned_at: "2026-11-01T10:00:00.000Z",
    last_used_at: "2026-11-02T10:00:00.000Z",
    signed_in_at: "2026-11-02T10:00:00.000Z",
    ...over,
  })
}

type Chain = Awaited<ReturnType<typeof chain>>
/** Each row: how it breaks the chain, the script to save, and what the model is told. */
const BREAKS: [string, (c: Chain) => void, (c: Chain) => string, string][] = [
  ["reach.sh exits 1", () => {}, () => "set -eu\nssh login1 true\necho nope >&2\nexit 1\n", "Not saved: reach.sh failed the test (broken): reach.sh exited 1: nope"],
  [
    "login refused",
    ({ fake }) => fake.set({ hosts: { node1: { login: "refuse" } } }),
    ({ spec }) => scriptFor(spec),
    "Not saved: reach.sh ran, then couldn't connect: ssh couldn't log in to node1",
  ],
  [
    "check exit 1",
    ({ remote }) => remote.setCheck({ code: 1, stderr: "opencorp hq: this office has no HQ yet\n" }),
    ({ spec }) => scriptFor(spec),
    "Not saved: reach.sh ran, then HQ isn't ready there: opencorp hq: this office has no HQ yet.",
  ],
  [
    "blackhole forward",
    ({ fake }) => fake.set({ forward: "blackhole" }),
    ({ spec }) => scriptFor(spec),
    "Not saved: reach.sh ran, then HQ didn't answer through the forward",
  ],
]

/** The login node's control socket. */
const loginSocket = (ctx: ReachContext) => path.join(ctx.paths.cm, fakeControlName("login1"))
/** How many times `host` logged in. */
const loginsTo = (fake: FakeSsh, host: string) => fake.logins().filter((h) => h === host).length

test.each(BREAKS)("a failed chain test leaves the old path and tells the model which step failed [%s]", async (_label, arrange, script, told) => {
  const c = await chain(["1", "1"])
  const { ctx, state, fake, remote, spec } = c
  await oldPath(ctx, { port: c.port })
  const before = Object.fromEntries([ctx.paths.script, ctx.paths.approved, ctx.paths.notes, ctx.paths.access].map((f) => [f, fs.readFileSync(f, "utf8")]))
  arrange(c)
  const error = await rejection(saveAccess({ script: script(c), notes: NOTES, risks: [] }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toStartWith(told)
  for (const [file, text] of Object.entries(before)) expect(fs.readFileSync(file, "utf8")).toBe(text)
  expect(fs.existsSync(ctx.paths.candidate)).toBe(false)
  expect(fs.readdirSync(ctx.paths.dir).filter((name) => name.startsWith(".reach-"))).toEqual([])
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
  expect(isSocket(loginSocket(ctx))).toBe(true)
  expect(state.connection).toBeNull()
  // The retry rides the login node's master: no second login there, so no second Duo.
  fake.set({})
  remote.setCheck({ stdout: `${JSON.stringify(remote.status)}\n` })
  expect(await saveAccess({ script: scriptFor(spec), notes: NOTES, risks: [] }, state)).toStartWith(SAVED)
  expect(loginsTo(fake, "login1")).toBe(1)
  await exitAll(ctx)
  expect(fake.masters()).toEqual([])
})

test("a second save_access after one succeeded is refused", async () => {
  const { ctx, state, spec, fake, prompter } = await chain(["1"])
  await saveAccess({ script: scriptFor(spec), notes: NOTES, risks: [] }, state)
  const seen = prompter.seen.length
  const saved = fs.readFileSync(ctx.paths.access, "utf8")
  const error = await rejection(saveAccess({ script: "exit 3\n", notes: "other\n", risks: [] }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("Not saved again: the path is saved and connected already; reply with one line for the owner.")
  expect(prompter.seen.length).toBe(seen)
  expect(fs.readFileSync(ctx.paths.access, "utf8")).toBe(saved)
  expect(fs.readFileSync(ctx.paths.notes, "utf8")).toBe(NOTES)
  await exitAll(ctx)
  expect(fake.masters()).toEqual([])
})

test("relearning keeps signed_in_at when the port is the same", async () => {
  let c = await chain(["1"])
  await oldPath(c.ctx, { port: c.port })
  await saveAccess({ script: scriptFor(c.spec), notes: NOTES, risks: [] }, c.state)
  expect(await readAccess(c.ctx.paths)).toMatchObject({
    port: c.port,
    last_used_at: "2026-11-02T10:00:00.000Z",
    signed_in_at: "2026-11-02T10:00:00.000Z",
  })
  await exitAll(c.ctx)
  c = await chain(["1"])
  await oldPath(c.ctx, { port: c.port === 49381 ? 49382 : 49381 })
  await saveAccess({ script: scriptFor(c.spec), notes: NOTES, risks: [] }, c.state)
  expect(await readAccess(c.ctx.paths)).toMatchObject({ port: c.port, last_used_at: "2026-11-02T10:00:00.000Z", signed_in_at: null })
  await exitAll(c.ctx)
  expect(c.fake.masters()).toEqual([])
})
