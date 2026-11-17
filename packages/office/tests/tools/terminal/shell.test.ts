/** The terminal's shell: a PTY bash with no line editing, which knows when a command ends, refuses the agent's keys at
 *  secret prompts, and passes the owner's keys straight to the running command. Real PTYs throughout: most tests start
 *  the shell without a sandbox, and the first four run again in it. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { now } from "@opencorp/protocol"
import { type PtyProcess, spawnPty } from "../../../src/platform.ts"
import { scrubbedEnv, startOnTerminal } from "../../../src/runtime/sandbox/run.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { ModelView } from "../../../src/tools/terminal/output.ts"
import { InstrumentRecord, readRecord } from "../../../src/tools/terminal/record.ts"
import { PtyShell, type ShellHost, type ShellState } from "../../../src/tools/terminal/shell.ts"
import { waitFor } from "../../helpers.ts"
import { gone, makePolicy, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"

setDefaultTimeout(30_000)

/** How a test starts its shell's PTY: plain, or in the sandbox. */
type Start = (dir: string) => { start: ShellHost["start"]; env: Record<string, string> }

/** A plain PTY in `dir`, with only PATH (the fake ssh's folder first, when given), TERM and HOME. */
const plain =
  (fake?: FakeSsh): Start =>
  (dir) => ({
    start: (argv, io) => spawnPty(argv, { cwd: dir, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData }),
    env: { PATH: `${fake ? `${fake.bin}:` : ""}/usr/bin:/bin`, TERM: "xterm-256color", HOME: dir },
  })

/** A PTY in the sandbox, with a writable workspace and its env. */
const sandboxed: Start = () => {
  const policy = makePolicy().make()
  return {
    start: (argv, { cols, rows, onData, env }) => startOnTerminal(policy, argv, { cols, rows, onData, env }),
    env: { ...scrubbedEnv(policy), TERM: "xterm-256color" },
  }
}

/** A shell opened on `start` in a fresh folder, with its record in `<dir>/record`. The test's end closes the shell,
 *  then removes the folder. */
async function openShell(
  options: { start?: Start; cols?: number; shell?: "bash" | "sh"; argv?: (argv: readonly string[]) => string[] } = {},
) {
  const { start = plain(), cols = 80, shell: kind, argv } = options
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-shell-")))
  let shell: PtyShell | undefined
  onTestFinished(async () => {
    await shell?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const recordDir = path.join(dir, "record")
  const record = new InstrumentRecord(recordDir, {
    id: "sh_1",
    name: "shell 1",
    kind: "terminal",
    profile: "workspace",
    driver: "@minh",
    started: now(),
  })
  const { start: startPty, env } = start(dir)
  let pty: PtyProcess | undefined
  const states: ShellState[] = []
  const live: Uint8Array[] = []
  const host: ShellHost = {
    start: (args, io) => (pty = startPty(argv ? argv(args) : args, io)),
    env,
    record,
    driver: "@minh",
    changed: (state) => states.push(state),
    output: (chunk) => live.push(chunk),
    ...(kind ? { shell: kind } : {}),
  }
  shell = await PtyShell.open("sh_1", "shell 1", host, { cols, rows: 24 })
  return {
    shell,
    dir,
    recordDir,
    states,
    pty: () => pty!,
    /** The owner's live view so far, decoded. */
    live: () => new TextDecoder().decode(Buffer.concat(live)),
    /** All of the model's view so far, rebuilt from the live bytes, which are what it reads: a read would move the
     *  agent's place. */
    view: async () => {
      const view = new ModelView()
      view.append(new TextDecoder().decode(Buffer.concat(live)))
      return view.page(0, view.length + 1).output
    },
  }
}

/** A fake ssh in a short folder of its own, removed when the test finishes. */
function fakeSsh(behavior: FakeSshBehavior): FakeSsh {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return installFakeSsh(dir, behavior)
}

/** How many times `part` occurs in `text`. */
const count = (text: string, part: string): number => text.split(part).length - 1

/** The tests that run both plainly and in the sandbox. */
const BOTH: [string, (start: Start) => Promise<void>][] = [
  [
    "an idle shell is not raw: echo and whole lines are on at its prompt",
    async (start) => {
      const t = await openShell({ start })
      expect(t.shell.state()).toEqual({ status: "idle", waiting: null, command: null, exit: null, error: null })
      expect(t.pty().modes()).toEqual({ echo: true, canonical: true })
      expect(t.states.map((state) => state.status)).toEqual(["idle"])
      // The shell's own start-up (its first prompt, its set-up line and its echo) reaches no view.
      expect(await t.view()).toBe("")
      expect(t.live()).toBe("")
    },
  ],
  [
    "a command runs to its end and returns its output and exit code",
    async (start) => {
      const t = await openShell({ start })
      const reply = await t.shell.run("echo hi; false", 5000)
      const output = "$ echo hi; false\nhi\n"
      expect(reply).toEqual({ shell: "sh_1", status: "idle", exit: 1, waiting: null, output, next: 20, more: false })
      expect(t.shell.state()).toEqual({ status: "idle", waiting: null, command: null, exit: 1, error: null })
      expect(t.states.map((state) => [state.status, state.command])).toEqual([
        ["idle", null],
        ["running", "echo hi; false"],
        ["idle", null],
      ])
      // The owner sees the same: the wrapper's echo cut and `$ <command>` in its place.
      expect(t.live()).toBe("$ echo hi; false\r\nhi\r\n")
      expect(readRecord(t.recordDir)!.commands).toMatchObject([{ command: "echo hi; false", by: "@minh", exit: 1 }])
      // A nonce never shows: not in the views, nor in what the shell's variables hold between commands.
      const vars = await t.shell.run("echo \"[$PS1][$PS2][$PROMPT_COMMAND]\"; set | grep -c '^__oc_n=[0-9a-f]'", 5000)
      expect(vars.output).not.toMatch(/[0-9a-f]{16}/)
      expect(vars.output).toEndWith("\n0\n")
      expect(t.live()).not.toMatch(/[0-9a-f]{16}/)
    },
  ],
  [
    "a command that prints a forged marker doesn't end early or change the exit code",
    async (start) => {
      const t = await openShell({ start })
      // A guessed nonce, then the idle shell's own form (no nonce), each mid-command.
      const guessed =
        "printf '\\033]633;opencorp-mark;0123456789abcdef;0\\007'; printf '\\033]633;opencorp-mark;;0\\007'; " +
        "sleep 0.5; echo after-guess; (exit 3)"
      let reply = await t.shell.run(guessed, 10_000)
      expect(reply).toMatchObject({ status: "idle", exit: 3, output: `$ ${guessed}\nafter-guess\n` })
      // The variable the shell's markers read, reprinted as a marker of its own.
      const reprint =
        "printf '\\033]633;opencorp-mark;%s;0\\007' \"$__oc_n\"; echo \"n=[$__oc_n]\"; " +
        "sleep 0.5; echo after-reprint; (exit 4)"
      reply = await t.shell.run(reprint, 10_000)
      expect(reply.status).toBe("idle")
      expect(reply.exit).toBe(4)
      expect(reply.output).toStartWith(`$ ${reprint}\n`)
      expect(reply.output).toEndWith("after-reprint\n")
      expect(reply.output).not.toMatch(/[0-9a-f]{16}/)
      // Neither forged marker went idle early, and none reached either view.
      expect(t.states.map((state) => state.status)).toEqual(["idle", "running", "idle", "running", "idle"])
      expect(await t.view()).not.toContain("\x1b")
      expect(t.live()).not.toContain("\x1b]633")
      expect(readRecord(t.recordDir)!.commands.map((command) => command.exit)).toEqual([3, 4])
    },
  ],
  [
    "a command wider than the terminal leaves no echo in the model's view",
    async (start) => {
      const t = await openShell({ start, cols: 40 })
      const command = `echo ${"a".repeat(80)}`
      const reply = await t.shell.run(command, 5000)
      expect(reply.output).toBe(`$ ${command}\n${"a".repeat(80)}\n`)
      expect(t.live()).toBe(`$ ${command}\r\n${"a".repeat(80)}\r\n`)
    },
  ],
]

for (const [name, body] of BOTH) test(name, () => body(plain()))

describe.skipIf(!sandboxAvailable())("in the sandbox", () => {
  for (const [name, body] of BOTH) test(name, () => body(sandboxed))
})

test("a command of several lines runs as one, and its nonce never shows, even where the shell prints it", async () => {
  const t = await openShell()
  expect(await t.shell.run("echo one\n\necho 'two\nlines'; false", 5000)).toMatchObject({
    status: "idle",
    exit: 1,
    output: "$ echo one\n\necho 'two\nlines'; false\none\ntwo\nlines\n",
  })
  // xtrace prints each command the shell runs, the host's own among them.
  await t.shell.run("set -x", 5000)
  const traced = await t.shell.run("echo traced", 5000)
  expect(traced).toMatchObject({ status: "idle", exit: 0 })
  expect(traced.output).toContain("[nonce]")
  expect(await t.view()).not.toMatch(/[0-9a-f]{16}/)
  expect(t.live()).not.toMatch(/[0-9a-f]{16}/)
})

test("the shell keeps its folder between commands", async () => {
  const t = await openShell()
  const folder = path.join(t.dir, "a folder")
  fs.mkdirSync(folder)
  expect((await t.shell.run(`cd '${folder}'`, 5000)).exit).toBe(0)
  expect((await t.shell.run("pwd", 5000)).output).toBe(`$ pwd\n${folder}\n`)
})

test("a line over 1000 bytes is refused before anything is typed", async () => {
  const t = await openShell()
  for (const command of [`echo ${"x".repeat(1000)}`, `echo ok\necho ${"x".repeat(1000)}`]) {
    const reply = await t.shell.run(command, 1000)
    expect(reply.refused).toBe(
      "a line of this command is over 1000 bytes; a terminal cuts longer lines (Linux keeps 4095 bytes, macOS 1024): " +
        "write a script with the file tools and run it",
    )
    expect(reply.status).toBe("idle")
  }
  // A control character other than newline and tab is refused too.
  expect((await t.shell.run("echo \x1b[31mred", 1000)).refused).toMatch(/control character/)
  // Nothing was typed: no echo, no output, no command in the record.
  await Bun.sleep(300)
  expect(await t.view()).toBe("")
  expect(t.live()).toBe("")
  expect(readRecord(t.recordDir)!.commands).toEqual([])
  // A long line that fits, wrapper included, runs.
  const fits = `echo ${"y".repeat(900)}`
  expect((await t.shell.run(fits, 5000)).output).toBe(`$ ${fits}\n${"y".repeat(900)}\n`)
})

test("aliases and brace expansion are off", async () => {
  const t = await openShell()
  expect((await t.shell.run("alias ls='echo X'", 5000)).exit).toBe(0)
  const listed = await t.shell.run("ls /", 5000)
  expect(listed.exit).toBe(0)
  expect(listed.output.split("\n")).not.toContain("X")
  const braces = await t.shell.run("{echo,hi}", 5000)
  expect(braces.output).toContain("command not found")
  expect(braces.exit).toBe(127)
})

test("background jobs end with the shell", async () => {
  const t = await openShell()
  expect((await t.shell.run("sleep 3131 &", 5000)).status).toBe("idle")
  await t.shell.close()
  expect(t.shell.state().status).toBe("ended")
  expect(await gone("3131")).toBe(true)
})

test("a command that outlives the wait returns running, and read waits for more", async () => {
  const t = await openShell()
  const first = await t.shell.run("sleep 1; echo late", 200)
  expect(first).toMatchObject({ status: "running", exit: null, output: "$ sleep 1; echo late\n" })
  expect(t.shell.state().command).toBe("sleep 1; echo late")
  // Nothing new yet: a read that outlives its wait returns running too.
  expect(await t.shell.read({ waitMs: 50 })).toMatchObject({ status: "running", output: "" })
  const rest = await t.shell.read({ waitMs: 10_000 })
  expect(rest).toMatchObject({ status: "idle", exit: 0, output: "late\n" })
  // An aborted wait returns at once.
  const controller = new AbortController()
  const running = t.shell.run("sleep 5", 20_000, controller.signal)
  controller.abort()
  expect((await running).status).toBe("running")
  t.shell.interrupt()
})

test("a command reading input doesn't take the wrapper", async () => {
  const t = await openShell()
  expect((await t.shell.run("read x; echo got=$x", 500)).status).toBe("running")
  const reply = await t.shell.type("abc", { enter: true, waitMs: 5000 })
  expect(reply).toMatchObject({ status: "idle", exit: 0, output: "abc\ngot=abc\n" })
})

test("typed text keeps the agent's unfinished line", async () => {
  const t = await openShell()
  expect((await t.shell.type("x", { enter: true, waitMs: 0 })).refused).toMatch(/nothing is running/)
  await t.shell.run("cat", 300)
  expect((await t.shell.type("sca", { enter: false, waitMs: 100 })).refused).toBeUndefined()
  expect(t.shell.pendingLine()).toBe("sca")
  await t.shell.type("n", { enter: false, waitMs: 0 })
  expect(t.shell.pendingLine()).toBe("scan")
  for (const text of ["\x03", "a\tb", "é", "x".repeat(1001)]) {
    expect((await t.shell.type(text, { enter: false, waitMs: 0 })).refused).toBeString()
  }
  // A line that would grow past 1000 bytes is refused too.
  expect((await t.shell.type("x".repeat(997), { enter: false, waitMs: 0 })).refused).toMatch(/1000 bytes/)
  expect(t.shell.pendingLine()).toBe("scan")
  await t.shell.type("", { enter: true, waitMs: 300 })
  expect(t.shell.pendingLine()).toBe("")
  expect(await t.view()).toContain("scan\nscan\n")
  t.shell.interrupt()
  expect((await t.shell.read({ waitMs: 5000 })).status).toBe("idle")
})

test("at a password prompt the agent's keys are refused and the shell waits for the owner", async () => {
  const fake = fakeSsh({ login: "tty" })
  const t = await openShell({ start: plain(fake) })
  const asked = await t.shell.run("ssh h true", 10_000)
  expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
  expect(asked.output).toContain("fake password for h: ")
  expect(t.shell.state()).toMatchObject({ status: "waiting", waiting: "secret", command: "ssh h true" })
  const refused = await t.shell.type("pw-typed", { enter: true, waitMs: 100 })
  expect(refused.refused).toBe(
    "the program is asking for a password; only the owner types it. Call read to see what happens next.",
  )
  t.shell.ownerKeys("pw-s3cret\r")
  const done = await t.shell.read({ waitMs: 10_000 })
  expect(done).toMatchObject({ status: "idle", exit: 0 })
  expect(fake.tty()).toEqual(["pw-s3cret"])
  expect(await t.view()).not.toContain("pw-")
  expect(t.live()).not.toContain("pw-")
})

test("ssh's host key question takes the agent's yes", async () => {
  const fake = fakeSsh({ login: "host_key" })
  const t = await openShell({ start: plain(fake) })
  const question = "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
  const asked = await t.shell.run("ssh h echo in", 1500)
  expect(asked).toMatchObject({ status: "running", waiting: null })
  // The view shows the question as the screen does.
  const shown = async () => (await t.view()).endsWith(`SHA256:fake.\n${question}`)
  await waitFor(shown, { timeout: 10_000, what: "the question" })
  expect(await t.view()).toContain("The authenticity of host 'h' can't be established.\n")
  const answered = await t.shell.type("yes", { enter: true, waitMs: 10_000 })
  expect(answered.refused).toBeUndefined()
  expect(answered).toMatchObject({ status: "idle", exit: 0 })
  expect(await t.view()).toEndWith(`${question}yes\nin\n`)
  expect(fake.tty()).toEqual(["yes"])
})

test("Duo's prompt takes the agent's 1", async () => {
  const fake = fakeSsh({ login: "duo" })
  const t = await openShell({ start: plain(fake) })
  const asked = await t.shell.run("ssh h echo in", 1500)
  expect(asked).toMatchObject({ status: "running", waiting: null })
  const shown = async () => (await t.view()).endsWith("Passcode or option (1-3): ")
  await waitFor(shown, { timeout: 10_000, what: "the menu" })
  const answered = await t.shell.type("1", { enter: true, waitMs: 10_000 })
  expect(answered).toMatchObject({ status: "idle", exit: 0 })
  expect(await t.view()).toEndWith("Duo two-factor login for h\n\nPasscode or option (1-3): 1\nin\n")
  expect(fake.logins()).toEqual(["h"])
})

test("owner input the program echoes shows in the model's view and the record, as on screen", async () => {
  const t = await openShell()
  await t.shell.run("cat", 300)
  t.shell.ownerKeys("owner-typed-text\r")
  // The terminal echoes it, and cat prints it back.
  await waitFor(async () => count(await t.view(), "owner-typed-text") === 2, { timeout: 5000, what: "both copies" })
  const reply = await t.shell.read({ waitMs: 200 })
  expect(reply.output).toBe("owner-typed-text\nowner-typed-text\n")
  expect(count(t.live(), "owner-typed-text\r\n")).toBe(2)
  // Ctrl-D ends cat, and the record keeps what the screen showed.
  t.shell.ownerKeys("\x04")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  await t.shell.close()
  const log = fs.readFileSync(path.join(t.recordDir, "output.log"), "utf8")
  expect(log).toBe("$ cat\nowner-typed-text\nowner-typed-text\n")
})

test("owner input at an echo-off prompt appears in none of the model's view, the record or any log", async () => {
  const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((name) => spyOn(console, name))
  try {
    const t = await openShell()
    const asked = await t.shell.run("stty -echo; read x; stty echo; echo read-done", 5000)
    expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
    t.shell.ownerKeys("s3cret-pw\r")
    const done = await t.shell.read({ waitMs: 5000 })
    expect(done).toMatchObject({ status: "idle", exit: 0 })
    expect(done.output).toContain("read-done")
    await t.shell.close()
    const seen = [asked.output, done.output, await t.view(), t.live()]
    for (const name of fs.readdirSync(t.recordDir)) seen.push(fs.readFileSync(path.join(t.recordDir, name), "utf8"))
    for (const spy of spies) seen.push(JSON.stringify(spy.mock.calls))
    for (const text of seen) expect(text).not.toContain("s3cret-pw")
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})

test("the agent can't type into a line the owner is part-way through", async () => {
  const t = await openShell()
  await t.shell.run("cat", 300)
  t.shell.ownerKeys("abc")
  expect((await t.shell.type("x", { enter: false, waitMs: 0 })).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r")
  expect((await t.shell.type("x", { enter: true, waitMs: 300 })).refused).toBeUndefined()
  t.shell.interrupt()
  expect((await t.shell.read({ waitMs: 5000 })).status).toBe("idle")
  // At the prompt, a line the owner has started holds the agent's commands off too.
  t.shell.ownerKeys("ech")
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("o owner\r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("true", 5000)).refused).toBeUndefined()
})

test("interrupt stops the agent's own command and refuses the owner's", async () => {
  const t = await openShell()
  expect((await t.shell.run("sleep 30", 300)).status).toBe("running")
  expect(t.shell.interrupt().refused).toBeUndefined()
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 130 })
  expect(readRecord(t.recordDir)!.commands).toMatchObject([{ command: "sleep 30", exit: 130 }])
  expect(t.shell.interrupt().refused).toMatch(/nothing is running/)
  t.shell.ownerKeys("sleep 30\r")
  expect(t.shell.state()).toMatchObject({ status: "running", command: null })
  expect(t.shell.interrupt().refused).toMatch(/the owner's/)
  t.shell.ownerKeys("\x03")
  expect((await t.shell.read({ waitMs: 5000 })).status).toBe("idle")
})

test("an owner's command at the prompt shows running until the shell is ready again, and the view shows it as the screen does", async () => {
  const t = await openShell()
  t.shell.ownerKeys("sleep 0.3; echo owner-$((6*7))\r")
  expect(t.shell.state()).toEqual({ status: "running", waiting: null, command: null, exit: null, error: null })
  const reply = await t.shell.read({ waitMs: 5000 })
  expect(reply).toMatchObject({ status: "idle", exit: 0, output: "sleep 0.3; echo owner-$((6*7))\nowner-42\n" })
  // The owner's command isn't the agent's: the record takes none of it but the screen.
  expect(readRecord(t.recordDir)!.commands).toEqual([])
})

test("a shell that exits ends, keeps its output, and says so to run", async () => {
  const t = await openShell()
  const reply = await t.shell.run("echo bye; exit 3", 5000)
  expect(reply).toMatchObject({ status: "ended", exit: 3 })
  expect(reply.output).toStartWith("$ echo bye; exit 3\nbye\n")
  expect(t.shell.state()).toMatchObject({ status: "ended", exit: 3, command: null })
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the shell has ended/)
  expect(await t.view()).toContain("bye\n")
  const record = readRecord(t.recordDir)
  expect(record).toMatchObject({ state: "ended", commands: [{ command: "echo bye; exit 3", exit: 3 }] })
})

test("closing a shell ends its process group, SIGHUP then SIGKILL after 2 s", async () => {
  const t = await openShell()
  // The shell and its job ignore the hangup, so only the kill can end them.
  expect((await t.shell.run("trap '' HUP; sleep 4141 &", 5000)).status).toBe("idle")
  const started = performance.now()
  await t.shell.close()
  expect(performance.now() - started).toBeGreaterThanOrEqual(1900)
  expect(t.shell.state()).toMatchObject({ status: "ended", exit: null })
  expect(await gone("4141")).toBe(true)
  expect(readRecord(t.recordDir)!.state).toBe("ended")
})

test("a shell whose line editing stays on fails to start, saying so", async () => {
  // A wrapper that leaves echo off, as no shell's prompt should.
  const t = await openShell({ argv: (argv) => ["/bin/sh", "-c", 'stty -echo; exec "$@"', "sh", ...argv] })
  expect(t.shell.state()).toMatchObject({ status: "failed", error: "the shell's line editing couldn't be turned off" })
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the shell failed to start/)
  const record = readRecord(t.recordDir)
  expect(record).toMatchObject({ state: "failed", error: "the shell's line editing couldn't be turned off" })
})

test("a shell that can't start fails, saying why", async () => {
  const t = await openShell({ argv: () => ["/nonexistent/shell"] })
  expect(t.shell.state().status).toBe("failed")
  expect(t.shell.state().error).toMatch(/the shell couldn't start/)
})

test("without bash, sh runs commands with the same boundaries", async () => {
  const t = await openShell({ shell: "sh" })
  expect(t.shell.state().status).toBe("idle")
  const reply = await t.shell.run("echo hi; false", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 1, output: "$ echo hi; false\nhi\n" })
  const forged = "printf '\\033]633;opencorp-mark;;0\\007'; sleep 0.3; (exit 5)"
  expect(await t.shell.run(forged, 5000)).toMatchObject({ status: "idle", exit: 5 })
  t.shell.ownerKeys("echo owner\r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", output: "echo owner\nowner\n" })
  expect(await t.view()).not.toMatch(/[0-9a-f]{16}/)
})

test("the agent can't interrupt a prompt the owner is answering, or a line they are typing", async () => {
  const fake = fakeSsh({ login: "tty" })
  const t = await openShell({ start: plain(fake) })
  expect(await t.shell.run("ssh h true", 10_000)).toMatchObject({ status: "waiting", waiting: "secret" })
  expect(t.shell.interrupt().refused).toMatch(/waiting for the owner/)
  t.shell.ownerKeys("hunt")
  expect(t.shell.interrupt().refused).toMatch(/waiting for the owner/)
  t.shell.ownerKeys("er2\r")
  expect(await t.shell.read({ waitMs: 10_000 })).toMatchObject({ status: "idle", exit: 0 })
  expect(fake.tty()).toEqual(["hunter2"])
  // At a prompt that isn't secret, a line the owner has started is theirs too.
  await t.shell.run("cat", 300)
  t.shell.ownerKeys("abc")
  expect(t.shell.interrupt().refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r\x04")
  expect((await t.shell.read({ waitMs: 5000 })).status).toBe("idle")
  await t.shell.close()
  const record = fs.readFileSync(path.join(t.recordDir, "output.log"), "utf8")
  for (const text of [await t.view(), t.live(), record]) expect(text).not.toMatch(/hunt|er2/)
})

test("a secret prompt that ends while the owner is typing drops the rest of their line", async () => {
  const t = await openShell()
  // The read gives up after a second, with the owner part-way through their answer.
  const asked = await t.shell.run("stty -echo; read -t 1 x; stty echo; echo after", 5000)
  expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
  t.shell.ownerKeys("hunt")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  await waitFor(async () => (await t.view()).includes("press Enter"), { timeout: 5000, what: "the owner's note" })
  // Until the owner's Enter, their keys go nowhere, and the agent waits for that line too.
  t.shell.ownerKeys("er2")
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r")
  t.shell.ownerKeys("echo back\r")
  const reply = await t.shell.read({ waitMs: 5000 })
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toContain("echo back\nback\n")
  await t.shell.close()
  const record = fs.readFileSync(path.join(t.recordDir, "output.log"), "utf8")
  for (const text of [await t.view(), t.live(), record]) expect(text).not.toMatch(/hunt|er2/)
})

test("a command can't redefine, shadow or unset how the shell ends a command", async () => {
  const t = await openShell()
  const forged =
    "__oc_s() { printf '\\033]633;opencorp-mark;%s;0\\007' \"$1\"; sleep 2; echo STILL; }; " +
    "printf() { :; }; return() { :; }; builtin() { :; }; unset PROMPT_COMMAND; false"
  expect(await t.shell.run(forged, 10_000)).toMatchObject({ status: "idle", exit: 1 })
  // Every later command still ends with its own exit code, and nothing runs on after its end.
  expect(await t.shell.run("false", 10_000)).toMatchObject({ status: "idle", exit: 1 })
  expect(await t.shell.run("echo ok", 10_000)).toMatchObject({ status: "idle", exit: 0, output: "$ echo ok\nok\n" })
  expect(await t.shell.run("(exit 7); echo $?", 10_000)).toMatchObject({ exit: 0, output: "$ (exit 7); echo $?\n7\n" })
  await Bun.sleep(2500)
  expect(await t.view()).not.toMatch(/^STILL$/m)
  expect(t.states.filter((state) => state.status === "idle").length).toBe(5)
})

test("a command's line settings don't reach the next command", async () => {
  const t = await openShell()
  // An end-of-file or end-of-line key the host types would split its line and hand the nonce to the command.
  expect((await t.shell.run("stty eof ';' eol ':' -echo", 5000)).exit).toBe(0)
  const next = await t.shell.run("echo a; echo b:c", 5000)
  expect(next).toMatchObject({ status: "idle", exit: 0, output: "$ echo a; echo b:c\na\nb:c\n" })
  expect(t.pty().modes()).toEqual({ echo: true, canonical: true })
  expect(await t.view()).not.toMatch(/[0-9a-f]{16}/)
})

test("the agent's keys are refused once a read turns echo off, before the timed check sees it", async () => {
  const t = await openShell()
  await t.shell.run("stty -echo; read x; stty echo; echo got=[$x]", 60)
  await waitFor(() => !t.pty().modes().echo, { timeout: 2000, what: "echo off" })
  const typed = await t.shell.type("agent-typed", { enter: true, waitMs: 1000 })
  expect(typed.refused).toBe(
    "the program is asking for a password; only the owner types it. Call read to see what happens next.",
  )
  t.shell.ownerKeys("owner-typed\r")
  const done = await t.shell.read({ waitMs: 5000 })
  expect(done).toMatchObject({ status: "idle", exit: 0 })
  expect(done.output).toContain("got=[owner-typed]")
})

test("an unfinished line the agent leaves doesn't outlive its command", async () => {
  const t = await openShell()
  expect((await t.shell.run("sleep 1", 100)).status).toBe("running")
  await t.shell.type("echo INJECTED > inj.txt; ", { enter: false, waitMs: 0 })
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  expect(t.shell.pendingLine()).toBe("")
  const reply = await t.shell.run("echo hi", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toEndWith("$ echo hi\nhi\n")
  // The owner's keys can't inherit it either, even ones typed after it.
  expect((await t.shell.run("sleep 1", 100)).status).toBe("running")
  await t.shell.type("echo INJECTED > inj2.txt; ", { enter: false, waitMs: 0 })
  t.shell.ownerKeys("#")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  t.shell.ownerKeys("echo owner\r")
  expect((await t.shell.read({ waitMs: 5000 })).output).toEndWith("owner\n")
  expect(fs.readdirSync(t.dir).filter((name) => name.startsWith("inj"))).toEqual([])
  expect(readRecord(t.recordDir)!.commands.map((command) => command.command)).toEqual(["sleep 1", "echo hi", "sleep 1"])
})

test("a run's reply starts where the agent last read, so output in between is read once", async () => {
  const t = await openShell()
  t.shell.ownerKeys("echo between\r")
  await waitFor(() => t.shell.state().status === "idle", { timeout: 5000, what: "the owner's command to end" })
  const reply = await t.shell.run("echo after", 5000)
  expect(reply.output).toBe("echo between\nbetween\n$ echo after\nafter\n")
})

test("a nonce split across two reads of the terminal is still neutralised", async () => {
  const t = await openShell()
  // A DEBUG trap sees the line the host types, and prints the nonce in two halves, 0.3 s apart.
  const trap =
    "trap 'case $BASH_COMMAND in *\"__oc_s \"*) n=${BASH_COMMAND#* }; n=${n%% *}; " +
    "printf %s \"${n:0:8}\"; sleep 0.3; printf \"%s\\n\" \"${n:8}\";; esac' DEBUG"
  const reply = await t.shell.run(trap, 5000)
  expect(reply.status).toBe("idle")
  expect(reply.output).toContain("[nonce]")
  expect(await t.view()).not.toMatch(/[0-9a-f]{16}/)
  expect(t.live()).not.toMatch(/[0-9a-f]{16}/)
})

test("the owner's line is dropped too when the agent's unfinished line is killed with it", async () => {
  const t = await openShell()
  expect((await t.shell.run("sleep 0.3; stty -echo; read -t 1 x; stty echo", 100)).status).toBe("running")
  await t.shell.type("agent-left", { enter: false, waitMs: 0 })
  await waitFor(() => t.shell.state().status === "waiting", { timeout: 5000, what: "the secret prompt" })
  t.shell.ownerKeys("hunt")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle" })
  t.shell.ownerKeys("er2\r")
  t.shell.ownerKeys("echo back\r")
  expect((await t.shell.read({ waitMs: 5000 })).output).toContain("echo back\nback\n")
  expect(await t.view()).toContain("press Enter")
  for (const text of [await t.view(), t.live()]) expect(text).not.toMatch(/hunt|er2/)
})
