/** learn_hq's save_access tool: its checks come first, then a save card the owner answers in the chat, and on "Test
 *  it, then save it" the chain test in OpenCorp's connection shell before reach.sh and notes.md are saved. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { credentialWarning } from "../../../../src/features/reach/learning.ts"
import { beforeLearning, beforeSaving } from "../../../../src/features/reach/risks.ts"
import type { Spec } from "../../../../src/features/reach/spec.ts"
import { exitAll, isSocket, type ReachContext } from "../../../../src/features/reach/ssh.ts"
import { type Access, readAccess, sha256, writeAccess } from "../../../../src/features/reach/state.ts"
import { MAX_SCRIPT_BYTES } from "../../../../src/features/reach/tools/replay.ts"
import {
  CANCEL,
  SAVE,
  SAVE_TITLE,
  saveAccessTool,
  SAVED,
  saveQuestion,
  SAVING_ASKS,
  secretIn,
} from "../../../../src/features/reach/tools/save_access.ts"
import { type FakeSsh, fakeControlName } from "../../../../src/testing/fake_ssh.ts"
import { writePrivate } from "../../../../src/util/private_files.ts"
import { chain, KEY, learning, NOTES } from "../helpers.ts"

setDefaultTimeout(60_000)

const YES = { value: SAVE, typed: false }

test("a file with a secret is refused before any card", async () => {
  const base64 = Buffer.from(KEY).toString("base64")
  const cases: [Partial<{ script: string; notes: string }>, string][] = [
    [{ script: `export K=${KEY}\n` }, "it holds the model's API key"],
    [{ notes: `the key is ${base64}\n` }, "it holds the model's API key"],
    [{ script: "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nEOF\n" }, "it holds a private key"],
    [{ script: "sshpass -p hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "SSHPASS=hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "echo \x1b[2J\n" }, "reach.sh holds U+001B at line 1, column 6; use only printable ASCII, tabs and newlines"],
    [{ script: "echo listing jobs\n" }, "reach.sh holds U+00A0 at line 1, column 13"],
    [{ notes: "a\x1b[2J\n" }, "notes.md holds control characters"],
  ]
  for (const [files, why] of cases) {
    const { save, cards, ctx, fake } = await learning([], { secrets: [KEY] })
    const told = await save({ script: "echo {}\n", notes: NOTES, risks: [], ...files })
    expect(told).toStartWith("Not saved:")
    expect(told).toContain(why)
    expect(told).not.toContain(KEY)
    expect(cards).toEqual([])
    expect(fake.calls()).toEqual([])
    expect(fs.readdirSync(ctx.paths.dir).sort()).toEqual(["cm", "ssh"])
  }
  expect(secretIn("ssh login1 true", [""])).toBeNull()
  // So are files over 1 MiB, which a visit never reads.
  const { save, cards } = await learning([])
  const big = `${"#".repeat(MAX_SCRIPT_BYTES)}\n`
  expect(await save({ script: big, notes: NOTES, risks: [] })).toBe("Not saved: reach.sh is over 1 MiB.")
  expect(await save({ script: "exit 3\n", notes: big, risks: [] })).toBe("Not saved: notes.md is over 1 MiB.")
  expect(cards).toEqual([])
})

test("the save card shows both files numbered, the fixed risks before the setup's own and the warning, and offers to test and save", async () => {
  const { save, cards, ctx } = await learning([{ value: CANCEL, typed: false }])
  const script = `set -eu\nssh login1 true\ncat ${ctx.paths.provider}\n`
  await save({ script, notes: "Line one, café.\n\nLine ‮two.\n", risks: ["Duo on the node too: two prompts."] })
  expect(cards).toEqual([
    {
      title: SAVE_TITLE,
      question: [
        SAVE_TITLE,
        "",
        `${ctx.paths.script}, which runs on every visit:`,
        "  1  set -eu",
        "  2  ssh login1 true",
        `  3  cat ${ctx.paths.provider}`,
        "",
        `${ctx.paths.notes}:`,
        "  1  Line one, café.",
        "  2",
        "  3  Line <U+202E>two.",
        "",
        "Before you save it:",
        ...beforeSaving(ctx.paths).map((line) => `  - ${line}`),
        "  - Duo on the node too: two prompts.",
        "",
        credentialWarning(ctx.paths),
        "",
        saveQuestion(3),
      ].join("\n"),
      options: [SAVE, CANCEL],
      reason: SAVING_ASKS,
    },
  ])
  expect(SAVE_TITLE).toBe("OpenCorp wants to save how this machine reaches HQ")
  expect([SAVE, CANCEL]).toEqual(["Test it, then save it", "Don't save it"])
  expect(saveQuestion(3)).toBe("Save this 3-line reach.sh and the notes, after testing the whole connection?")
  expect(beforeLearning(ctx.paths).some((line) => cards[0]!.question.includes(line))).toBe(false)
})

test("the save card asks in every mode and is refused in dontAsk", async () => {
  // The tool never decides it: every call holds on the card, whatever the mode; a host in dontAsk refuses it.
  const { save, cards, ctx, fake } = await learning(["dontAsk"])
  const told = await save({ script: "exit 3\n", notes: NOTES, risks: [] })
  expect(told).toBe(`Not run: this session doesn't ask (dontAsk mode): ${SAVING_ASKS}.`)
  expect(cards).toHaveLength(1)
  expect(fake.calls()).toEqual([])
  expect(fs.existsSync(ctx.paths.script)).toBe(false)
  const tool = saveAccessTool({ state: null!, binding: null!, connection: null! })
  expect(tool.parameters).toMatchObject({ required: ["script", "notes", "risks"] })
})

test("a No with words reaches the agent as what should change, and saves nothing", async () => {
  const { save, ctx, fake, state } = await learning([{ value: "use squeue", typed: true }, { value: CANCEL, typed: false }])
  expect(await save({ script: "exit 3\n", notes: NOTES, risks: [] })).toBe("Not saved: the owner wants a change: use squeue")
  expect(await save({ script: "exit 3\n", notes: NOTES, risks: [] })).toBe("Not saved: the owner didn't save it.")
  for (const file of [ctx.paths.script, ctx.paths.notes, ctx.paths.access, ctx.paths.approved]) expect(fs.existsSync(file)).toBe(false)
  expect(fake.calls()).toEqual([])
  expect(state.connection).toBeNull()
  expect(state.shell).toBeNull()
})

/** reach.sh as the agent would write it: log in to login1 (leaving its master), then print `spec`; `before` runs
 *  first. */
const scriptFor = (spec: Spec, before = "") => `set -eu\n${before}ssh login1 true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`

test("save_access writes nothing until the whole chain passes in OpenCorp's connection shell, then keeps the connection open", async () => {
  const { ctx, state, spec, port, fake, save, listed } = await chain([YES])
  const early = "for f in reach.sh reach.approved.sh notes.md access.json; do [ ! -e \"$f\" ] || echo \"early $f\" >&2; done\n"
  const script = scriptFor(spec, early)
  expect(await save({ script, notes: NOTES, risks: [] })).toBe(`${SAVED} Reply with one line for the owner.`)
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
  // The chain ran in OpenCorp's connection shell, listed in the session, its screen with no early line.
  expect(listed).toHaveLength(1)
  expect(state.shell!.shell!.state().status).toBe("running")
  const log = fs.readFileSync(path.join(state.folder, "terminal", listed[0]!, "output.log"), "utf8")
  expect(log).not.toContain("early")
  expect(fs.readdirSync(paths.dir).filter((name) => name.startsWith(".reach-"))).toEqual([])
  await exitAll(ctx)
  expect(await state.connection!.master.exited).toBe(0)
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
  const c = await chain([YES, YES])
  const { ctx, state, fake, remote, spec, save } = c
  await oldPath(ctx, { port: c.port })
  const before = Object.fromEntries([ctx.paths.script, ctx.paths.approved, ctx.paths.notes, ctx.paths.access].map((f) => [f, fs.readFileSync(f, "utf8")]))
  arrange(c)
  expect(await save({ script: script(c), notes: NOTES, risks: [] })).toStartWith(told)
  for (const [file, text] of Object.entries(before)) expect(fs.readFileSync(file, "utf8")).toBe(text)
  expect(fs.readdirSync(ctx.paths.dir).filter((name) => name.startsWith(".reach-"))).toEqual([])
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
  expect(isSocket(loginSocket(ctx))).toBe(true)
  expect(state.connection).toBeNull()
  // The retry rides the login node's master in the same shell: no second login there, so no second Duo.
  fake.set({})
  remote.setCheck({ stdout: `${JSON.stringify(remote.status)}\n` })
  expect(await save({ script: scriptFor(spec), notes: NOTES, risks: [] })).toStartWith(SAVED)
  expect(loginsTo(fake, "login1")).toBe(1)
  expect(c.listed).toHaveLength(1)
})

test("a second save_access after one succeeded is refused before any card", async () => {
  const { ctx, spec, save, cards } = await chain([YES])
  await save({ script: scriptFor(spec), notes: NOTES, risks: [] })
  const saved = fs.readFileSync(ctx.paths.access, "utf8")
  expect(await save({ script: "exit 3\n", notes: "other\n", risks: [] })).toBe(
    "Not saved again: the path is saved and connected already; reply with one line for the owner.",
  )
  expect(cards).toHaveLength(1)
  expect(fs.readFileSync(ctx.paths.access, "utf8")).toBe(saved)
  expect(fs.readFileSync(ctx.paths.notes, "utf8")).toBe(NOTES)
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
    const c = await chain([YES])
    await oldPath(c.ctx, over(c))
    await c.save({ script: scriptFor(c.spec), notes: NOTES, risks: [] })
    expect({ label, access: await readAccess(c.ctx.paths) }).toMatchObject({
      label,
      access: { port: c.port, host: "node1", socket: c.remote.socket, last_used_at: kept.last_used_at, signed_in_at: signedIn },
    })
    await exitAll(c.ctx)
    expect(c.fake.masters()).toEqual([])
  }
})
