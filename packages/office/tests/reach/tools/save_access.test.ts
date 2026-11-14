/** learn_hq's save_access tool, which tests the whole chain before it saves reach.sh and notes.md. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ReportedToolError } from "@ngocbh/yian"
import { beforeLearning, beforeSaving } from "../../../src/reach/risks.ts"
import type { Spec } from "../../../src/reach/spec.ts"
import { exitAll, isSocket, type ReachContext } from "../../../src/reach/ssh.ts"
import { type Access, readAccess, sha256, writeAccess } from "../../../src/reach/state.ts"
import { MAX_SCRIPT_BYTES } from "../../../src/reach/tools/replay.ts"
import {
  CANCEL,
  SAVE,
  saveQuestion,
  SAVED,
  saveAccess,
  saveAccessTool,
  secretIn,
  WHAT_SHOULD_CHANGE,
} from "../../../src/reach/tools/save_access.ts"
import { writePrivate } from "../../../src/secrets.ts"
import { fakeControlName } from "../../../src/testing/fake_ssh.ts"
import type { FakeSsh } from "../../../src/testing/fake_ssh.ts"
import { chain, KEY, learning, NOTES, rejection } from "../helpers.ts"

setDefaultTimeout(30_000)

test("save_access refuses the model's key, a private key and sshpass, before showing anything", async () => {
  const base64 = Buffer.from(KEY).toString("base64")
  const cases: [Partial<{ script: string; notes: string }>, string][] = [
    [{ script: `export K=${KEY}\n` }, "it holds the model's API key"],
    [{ notes: `the key is ${base64}\n` }, "it holds the model's API key"],
    [{ script: "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nEOF\n" }, "it holds a private key"],
    [{ script: "sshpass -p hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "SSHPASS=hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "echo \x1b[2J\n" }, "reach.sh holds U+001B at line 1, column 6; use only printable ASCII, tabs and newlines"],
    [{ notes: "a\x1b[2J\n" }, "notes.md holds control characters"],
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
  await rejection(saveAccess({ script, notes: "Line one, café.\n\nLine \u202etwo.\n", risks: ["Duo on the node too: two prompts."] }, state))
  expect(prompter.seen).toEqual([
    `The model wants to save how this machine reaches HQ. ${ctx.paths.script}, which runs on every visit:`,
    "  1  set -eu",
    "  2  ssh login1 true",
    "  3  printf '%s\\n' '{}'",
    `${ctx.paths.notes}:`,
    "  1  Line one, café.",
    "  2",
    "  3  Line <U+202E>two.",
    "Before you save it:",
    ...beforeSaving(ctx.paths).map((line) => `  - ${line}`),
    "  - Duo on the node too: two prompts.",
    "Save this 3-line reach.sh and the notes, after testing the whole connection?",
    WHAT_SHOULD_CHANGE,
  ])
  expect(saveQuestion(3)).toBe("Save this 3-line reach.sh and the notes, after testing the whole connection?")
  expect(prompter.offered).toEqual([[SAVE, CANCEL]])
  expect(beforeLearning(ctx.paths).some((line) => prompter.seen.includes(line))).toBe(false)
})

test("declining to save tells the model what should change and saves nothing", async () => {
  const { prompter, state, ctx, fake } = await learning(["2", "use squeue"])
  const error = await rejection(saveAccess({ script: "exit 3\n", notes: NOTES, risks: [] }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("Not saved: the owner wants a change: use squeue")
  expect(prompter.seen.at(-2)).toBe(saveQuestion(1))
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

test("relearning keeps signed_in_at only while the port, the host and HQ's socket are the same", async () => {
  const kept = { last_used_at: "2026-11-02T10:00:00.000Z", signed_in_at: "2026-11-02T10:00:00.000Z" }
  const cases: [string, (c: Chain) => Partial<Access>, string | null][] = [
    ["all the same", (c) => ({ port: c.port, host: "node1", socket: c.remote.socket }), kept.signed_in_at],
    ["another port", (c) => ({ port: c.port === 49381 ? 49382 : 49381, host: "node1", socket: c.remote.socket }), null],
    ["another host", (c) => ({ port: c.port, host: "node9", socket: c.remote.socket }), null],
    ["another socket", (c) => ({ port: c.port, host: "node1", socket: "/elsewhere/hq.sock" }), null],
    ["none recorded", (c) => ({ port: c.port }), null],
  ]
  for (const [label, over, signedIn] of cases) {
    const c = await chain(["1"])
    await oldPath(c.ctx, over(c))
    await saveAccess({ script: scriptFor(c.spec), notes: NOTES, risks: [] }, c.state)
    expect({ label, access: await readAccess(c.ctx.paths) }).toMatchObject({
      label,
      access: { port: c.port, host: "node1", socket: c.remote.socket, last_used_at: kept.last_used_at, signed_in_at: signedIn },
    })
    await exitAll(c.ctx)
    expect(c.fake.masters()).toEqual([])
  }
})

test("save_access refuses a reach.sh or notes.md over 1 MiB before showing anything", async () => {
  const { prompter, state } = await learning([])
  const big = `${"#".repeat(MAX_SCRIPT_BYTES)}\n`
  expect((await rejection(saveAccess({ script: big, notes: NOTES, risks: [] }, state))).message).toBe(
    "Not saved: reach.sh is over 1 MiB.",
  )
  expect((await rejection(saveAccess({ script: "exit 3\n", notes: big, risks: [] }, state))).message).toBe(
    "Not saved: notes.md is over 1 MiB.",
  )
  expect(prompter.seen).toEqual([])
})
