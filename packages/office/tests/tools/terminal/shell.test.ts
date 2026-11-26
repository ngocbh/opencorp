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
import { ended, makePolicy, ownSleepers, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"

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
      expect(t.shell.state()).toEqual({
        status: "idle", waiting: null, command: null, exit: null, error: null, ownerTyping: false,
      })
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
      expect(t.shell.state()).toEqual({
        status: "idle", waiting: null, command: null, exit: 1, error: null, ownerTyping: false,
      })
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
      // The variables the shell's markers read, reprinted as markers of their own: the command's, and the prompt's.
      const reprint =
        "printf '\\033]633;opencorp-mark;%s;0\\007' \"$__oc_n\"; echo \"n=[$__oc_n]\"; " +
        "printf '\\033]633;opencorp-mark;%s;0;1;5;/\\007' \"$__oc_q\"; " +
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

for (const kind of ["bash", "sh"] as const) {
  test(`${kind}: the shell reports the folder each of the agent's commands ends in, and none it can't trust`, async () => {
    const t = await openShell({ shell: kind })
    const folder = path.join(t.dir, "a folder")
    fs.mkdirSync(folder)
    // bash's first prompt says where it starts; sh's says nothing.
    expect(t.shell.cwd()).toBe(kind === "bash" ? t.dir : null)
    await t.shell.run(`cd '${folder}'`, 5000)
    expect(t.shell.cwd()).toBe(folder)
    // The kernel's folder, not what $PWD says, and never a marker the command prints itself.
    await t.shell.run("cd /; PWD=/srv; printf '\\033]633;opencorp-mark;;0;1;/srv\\007'", 5000)
    expect(t.shell.cwd()).toBe("/")
    // A folder whose name holds a control character can't be reported.
    await t.shell.run(`cd '${t.dir}' && mkdir "$(printf 'a\\001b')" && cd "$(printf 'a\\001b')"`, 5000)
    expect(t.shell.cwd()).toBeNull()
    await t.shell.run(`cd '${folder}'`, 5000)
    // The owner's command may have moved it: only the agent's own command's end says where the shell is.
    t.shell.ownerKeys("cd /\r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle" })
    expect(t.shell.cwd()).toBeNull()
    await t.shell.run("true", 5000)
    expect(t.shell.cwd()).toBe("/")
  })
}

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
  const sleeping = await ownSleepers("3131")
  expect(sleeping).toHaveLength(1)
  await t.shell.close()
  expect(t.shell.state().status).toBe("ended")
  expect(await ended(sleeping)).toBe(true)
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

test("the owner who deletes all they typed gives the line back, and the agent's next command runs", async () => {
  const t = await openShell()
  t.shell.ownerKeys("ech")
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  // Backspace (DEL) takes one character off; the last one gives the line back.
  t.shell.ownerKeys("\x7f\x7f")
  expect(t.shell.state().ownerTyping).toBe(true)
  t.shell.ownerKeys("\x7f")
  expect(t.shell.state().ownerTyping).toBe(false)
  // The host heard each change, so the owner's view shows the hold, then not.
  expect(t.states.map((state) => state.ownerTyping)).toEqual([false, true, false])
  const reply = await t.shell.run("echo agent-$((6*7))", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toContain("agent-42\n")
  // A Backspace on an empty line holds nothing.
  t.shell.ownerKeys("\x7f")
  expect(t.shell.state().ownerTyping).toBe(false)
  // A character past ASCII counts as its bytes, as a terminal that erases a byte at a time takes it off.
  t.shell.ownerKeys("é\x7f")
  expect(t.shell.state().ownerTyping).toBe(true)
  t.shell.ownerKeys("\x7f")
  expect(t.shell.state().ownerTyping).toBe(false)
  expect(await t.shell.run("echo agent-$((6*7))", 5000)).toMatchObject({ status: "idle", exit: 0 })
})

test("Ctrl-U gives the owner's line back, and what they typed never runs", async () => {
  const t = await openShell()
  t.shell.ownerKeys("echo owner-$((6*7))")
  t.shell.ownerKeys("\x15")
  expect(t.shell.state().ownerTyping).toBe(false)
  const reply = await t.shell.run("echo agent", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toContain("agent\n")
  expect(await t.view()).not.toContain("owner-42")
})

test("at the prompt, once the owner uses a key the line edits on its own, only Enter, Ctrl-C or Ctrl-U gives it back", async () => {
  const t = await openShell()
  // An arrow: the office can't know the line from the keys any more, so deleting what was typed doesn't free it.
  t.shell.ownerKeys("ab\x1b[D")
  t.shell.ownerKeys("\x7f".repeat(6))
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\x15")
  expect(t.shell.state().ownerTyping).toBe(false)
  expect((await t.shell.run("true", 5000)).refused).toBeUndefined()
  // A tab, then Ctrl-C.
  t.shell.ownerKeys("x\t\x7f\x7f")
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  await ctrlC(t)
  expect(t.shell.state().ownerTyping).toBe(false)
  expect((await t.shell.run("true", 5000)).refused).toBeUndefined()
  // Ctrl-W, then Enter.
  t.shell.ownerKeys("true x\x17")
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("true", 5000)).refused).toBeUndefined()
})

/** The owner's Ctrl-C at the idle prompt: the agent waits until the shell prompts again, having dropped what it read
 *  of the line, then may run. */
async function ctrlC(t: { shell: PtyShell }) {
  t.shell.ownerKeys("\x03")
  // Until then the owner still holds it, and their view says so.
  expect(t.shell.state().ownerTyping).toBe(true)
  expect(t.shell.runProblem("echo agent")).toMatch(/the owner is typing/)
  await waitFor(() => t.shell.runProblem("echo agent") === null, { timeout: 5000, what: "the prompt after Ctrl-C" })
  expect(t.shell.state().ownerTyping).toBe(false)
}

/** Whether the shell ran the owner's `touch OWNED` (and whatever joined it) in the test's folder. */
const ownedRan = async (t: { dir: string }) => fs.existsSync(path.join(t.dir, "OWNED"))

test("keys a running program reads one at a time hold through deletes and Ctrl-U, as over ssh, until Enter or Ctrl-C", async () => {
  const t = await openShell()
  // As ssh to a host whose erase key is Ctrl-H: the remote, not the office, edits the line.
  expect((await t.shell.run("stty -icanon -echo; cat", 300)).status).toBe("running")
  t.shell.ownerKeys(`touch OWNED ${"\x7f".repeat(11)}`)
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.type("echo agent", { enter: true, waitMs: 0 })).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\x15")
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.type("echo agent", { enter: true, waitMs: 0 })).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\x03")
  expect(t.shell.state().ownerTyping).toBe(false)
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle" })
})

test("keys typed while a raw command runs, which the shell reads later, hold until Enter or Ctrl-C at the prompt", async () => {
  const t = await openShell()
  expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
  t.shell.ownerKeys(`touch OWNED ${"\x7f".repeat(11)}\x15`)
  expect(t.shell.state().ownerTyping).toBe(true)
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  // The shell holds those bytes now: deletes and Ctrl-U at its prompt can't take them off.
  t.shell.ownerKeys("\x7f\x15")
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
  // Ctrl-C at the prompt drops what the shell holds of the line.
  await ctrlC(t)
  expect(t.shell.state().ownerTyping).toBe(false)
  const reply = await t.shell.run("echo agent", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toContain("agent\n")
  expect(await ownedRan(t)).toBe(false)
})

for (const [setting, deleting] of [["erase ^H", "\x7f".repeat(11)], ["kill ^X", "\x15"]] as const) {
  test(`keys typed while a command that sets stty ${setting} runs hold until Enter or Ctrl-C`, async () => {
    const t = await openShell()
    expect((await t.shell.run(`stty ${setting}; sleep 1`, 300)).status).toBe("running")
    t.shell.ownerKeys(`touch OWNED ${deleting}`)
    expect(t.shell.state().ownerTyping).toBe(true)
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
    t.shell.ownerKeys("\x15")
    expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
    await ctrlC(t)
    expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
    expect(await ownedRan(t)).toBe(false)
  })
}

test("in sh, whose prompt keeps the owner's line settings, deletes and Ctrl-U never give the line back", async () => {
  const t = await openShell({ shell: "sh" })
  t.shell.ownerKeys("stty erase ^H\r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  t.shell.ownerKeys(`touch OWNED ${"\x7f".repeat(11)}\x15`)
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
  await ctrlC(t)
  expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
  expect(await ownedRan(t)).toBe(false)
})

test("Ctrl-D part-way through a line hands it to the shell and keeps the hold; Ctrl-C gives it back", async () => {
  const t = await openShell()
  t.shell.ownerKeys("touch OWNED \x04")
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\x15\x7f")
  expect(t.shell.state().ownerTyping).toBe(true)
  await ctrlC(t)
  expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
  expect(await ownedRan(t)).toBe(false)
})

test("after the owner's keys at the prompt, the agent's next line kills what may be left on it first", async () => {
  const t = await openShell()
  // Ctrl-V puts a literal Ctrl-U on the line, which the office takes as the kill that gave it back.
  t.shell.ownerKeys("touch OWNED \x16\x15")
  expect(t.shell.state().ownerTyping).toBe(false)
  const reply = await t.shell.run("echo agent", 5000)
  expect(reply).toMatchObject({ status: "idle", exit: 0 })
  expect(reply.output).toContain("agent\n")
  expect(await ownedRan(t)).toBe(false)
})

test("the owner's Enter at the prompt leaves no kill for the agent to send into the program it starts", async () => {
  const t = await openShell()
  // The owner starts a program that reads keys one at a time; the agent types into it.
  t.shell.ownerKeys("IFS= read -r -n 5 x; printf '[%q]\\n' \"$x\"\r")
  await waitFor(() => !t.pty().modes().canonical, { timeout: 5000, what: "read -n's own line settings" })
  expect((await t.shell.type("hello", { enter: false, waitMs: 5000 })).refused).toBeUndefined()
  await waitFor(() => t.shell.state().status === "idle", { timeout: 5000, what: "the owner's command to end" })
  const view = await t.view()
  expect(view).toContain("[hello]")
  expect(view).not.toContain("025")
})

test("after trap '' INT the owner's Ctrl-C brings no prompt: the hold shows, and Enter ends it", async () => {
  const t = await openShell()
  expect(await t.shell.run("trap '' INT", 5000)).toMatchObject({ status: "idle", exit: 0 })
  t.shell.ownerKeys("touch OWNED \x03")
  await Bun.sleep(300)
  // The shell ignored it and never prompted again: the employee waits, and the owner's view says why.
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r")
  await waitFor(() => t.shell.runProblem("echo agent") === null, { timeout: 5000, what: "the prompt after Enter" })
  expect(t.shell.state().ownerTyping).toBe(false)
  expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
  expect(await ownedRan(t)).toBe(false)
})

for (const [end, name] of [["\r", "Enter"], ["\x03", "Ctrl-C"]] as const) {
  test(`the owner's ${name} while a raw command runs frees the hold, but what they typed never joins the agent's line`, async () => {
    const t = await openShell()
    expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
    // In raw mode the terminal neither ends the line nor stops the command: the shell reads it all later.
    t.shell.ownerKeys(`touch OWNED ${end}`)
    expect(t.shell.state().ownerTyping).toBe(false)
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
    const reply = await t.shell.run("echo agent", 5000)
    expect(reply).toMatchObject({ status: "idle", exit: 0 })
    expect(reply.output).toContain("agent\n")
    expect(await ownedRan(t)).toBe(false)
  })
}

for (const kind of ["bash", "sh"] as const) {
  test(`in ${kind}, lines the owner left queued behind a raw command never run, a cd among them, Ctrl-C ignored or not`, async () => {
    const t = await openShell({ shell: kind })
    fs.mkdirSync(path.join(t.dir, "sub"))
    for (const trap of ["", "trap '' INT"]) {
      if (trap !== "") expect(await t.shell.run(trap, 5000)).toMatchObject({ status: "idle", exit: 0 })
      expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
      // Raw, the terminal ends no line and stops nothing: Ctrl-J and Enter queue as bytes, for the shell to read once
      // whole lines are back. The last line, unended, would join the agent's.
      t.shell.ownerKeys("cd sub\ntouch OWNED1\ntouch OWNED \r")
      expect(t.shell.state().ownerTyping).toBe(false)
      expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
      await Bun.sleep(300)
      const reply = await t.shell.run("pwd", 5000)
      expect(reply).toMatchObject({ status: "idle", exit: 0 })
      expect(reply.output).toContain(`\n${t.dir}\n`)
      expect(t.shell.cwd()).toBe(t.dir)
      for (const file of ["OWNED1", "OWNED", "sub/OWNED1", "sub/OWNED"]) {
        expect(fs.existsSync(path.join(t.dir, file))).toBe(false)
      }
    }
  })
}

test("the agent's command waits for a prompt that dropped what the owner left, and fails closed without one", async () => {
  const t = await openShell()
  // The agent's own command takes the office's flag's place, so no prompt can drop the owner's keys.
  expect(await t.shell.run('mkdir "$__oc_d"', 5000)).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
  t.shell.ownerKeys("touch OWNED \r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("echo agent", 5000)).refused).toMatch(/the owner is typing/)
  expect(t.shell.state().ownerTyping).toBe(true)
  expect(readRecord(t.recordDir)!.commands.map((c) => c.command)).toEqual([
    'mkdir "$__oc_d"', "stty raw -echo; sleep 1",
  ])
  expect(await ownedRan(t)).toBe(false)
})

for (const kind of ["bash", "sh"] as const) {
  test(`in ${kind}, a drain flag a command removes leaves what the owner left held, never drained or joined`, async () => {
    const t = await openShell({ shell: kind })
    // The command removes the flag the owner's keys made before its prompt can find it.
    expect((await t.shell.run('stty raw -echo; sleep 1; rm -f "$__oc_d"', 300)).status).toBe("running")
    t.shell.ownerKeys("touch OWNED \r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
    // The office makes the flag again for the next prompt. bash's comes only after the owner's Ctrl-C; sh's own
    // prompt, just after the agent's line, may find it first and drain then.
    const first = await t.shell.run("echo agent", 5000)
    if (kind === "bash") expect(first.refused).toMatch(/the owner is typing/)
    if (first.refused !== undefined) {
      expect(first.refused).toMatch(/the owner is typing/)
      expect(t.shell.state().ownerTyping).toBe(true)
      expect(await ownedRan(t)).toBe(false)
      await ctrlC(t)
      expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
    }
    expect(await ownedRan(t)).toBe(false)
  })
}

test("a background process that keeps removing the drain flag leaves the owner's keys held", async () => {
  const t = await openShell()
  const deleter = 'for i in $(seq 100); do rm -f "$__oc_d"; sleep 0.05; done >/dev/null 2>&1 &'
  expect(await t.shell.run(deleter, 5000)).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
  t.shell.ownerKeys("touch OWNED \r")
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  expect((await t.shell.run("echo agent", 5000)).refused).toMatch(/the owner is typing/)
  expect(t.shell.state().ownerTyping).toBe(true)
  expect(await ownedRan(t)).toBe(false)
})

test("keys on the agent's unfinished line in a running command hold through deletes and Ctrl-U", async () => {
  const t = await openShell()
  await t.shell.run("cat", 300)
  expect((await t.shell.type("agent", { enter: false, waitMs: 0 })).refused).toBeUndefined()
  t.shell.ownerKeys("x\x7f\x15")
  expect(t.shell.state().ownerTyping).toBe(true)
  expect((await t.shell.type("fresh", { enter: true, waitMs: 0 })).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\x03")
  expect(t.shell.state().ownerTyping).toBe(false)
  expect((await t.shell.read({ waitMs: 5000 })).status).toBe("idle")
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
  expect(t.shell.state()).toEqual({
    status: "running", waiting: null, command: null, exit: null, error: null, ownerTyping: false,
  })
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
  const sleeping = await ownSleepers("4141")
  expect(sleeping).toHaveLength(1)
  const started = performance.now()
  await t.shell.close()
  expect(performance.now() - started).toBeGreaterThanOrEqual(1900)
  expect(t.shell.state()).toMatchObject({ status: "ended", exit: null })
  expect(await ended(sleeping)).toBe(true)
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

/** A marker with `fields` after its prefix, as printf's format in a command: the forms a command could forge. */
const mark = (fields: string) => `\\033]633;opencorp-mark;${fields}\\007`

for (const kind of ["bash", "sh"] as const) {
  test(`${kind}: a prompt's marker a command prints, drained or not, never ends the owner's command`, async () => {
    const t = await openShell({ shell: kind })
    // A background job keeps the prompt's nonce the shell held while the agent's command ran: dead once it ended.
    const stale = `q=$__oc_q; (for i in $(seq 40); do printf '${mark("%s;0;1;5;/")}' "$q"; sleep 0.05; done >/dev/tty) &`
    expect(await t.shell.run(stale, 5000)).toMatchObject({ status: "idle", exit: 0 })
    // The owner's command prints what it could guess: no nonce, a made-up one, and what a program finds of the shell's.
    const guesses = [";0", ";0;1", ";0;1;5;/", "0123456789abcdef;0;1;5;/", "1234567890123;0;1;5;/"]
    const forged = guesses.map((fields) => `printf '${mark(fields)}'`).join("; ")
    const program = `sh -c 'printf "${mark("%s;0;1;5;/")}" "$__oc_q"'`
    t.shell.ownerKeys(`${forged}; ${program}; echo forged-$((6*7)); sleep 1; echo owner-$((6*7))\r`)
    await waitFor(async () => (await t.view()).includes("forged-42\n"), { timeout: 5000, what: "the forged prompts" })
    await Bun.sleep(300)
    expect(t.shell.state().status).toBe("running")
    expect(t.shell.runProblem("echo agent")).toMatch(/the owner's command is running/)
    const reply = await t.shell.read({ waitMs: 5000 })
    expect(reply).toMatchObject({ status: "idle", exit: 0 })
    expect(reply.output).toEndWith("\nowner-42\n")
    expect(await t.view()).not.toContain("\x1b]633")
    // The shell's own prompts are still told: the agent's command runs, and the owner's Ctrl-C at the prompt frees it.
    expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
    await ctrlC(t)
  })

  test(`${kind}: prompts a command forges saying they drained leave what the owner left held, never joined`, async () => {
    const t = await openShell({ shell: kind })
    // The agent's command takes the drain flag's place, so no prompt of the shell's can drain; a background job then
    // prints prompts that say they did, with no nonce, a made-up one, and the one it kept.
    expect(await t.shell.run('mkdir "$__oc_d"', 5000)).toMatchObject({ status: "idle", exit: 0 })
    const forms = [mark(";0;1;5;/"), mark("0123456789abcdef;0;1;5;/"), mark("%s;0;1;5;/"), mark(";0;1")].join("")
    const forger = `q=$__oc_q; (for i in $(seq 120); do printf '${forms}' "$q"; sleep 0.05; done >/dev/tty) &`
    expect(await t.shell.run(forger, 5000)).toMatchObject({ status: "idle", exit: 0 })
    expect((await t.shell.run("stty raw -echo; sleep 1", 300)).status).toBe("running")
    t.shell.ownerKeys("touch OWNED \r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
    // The agent waits out its 2 s for a prompt that drained, then the shell is the owner's, through every forged one.
    expect((await t.shell.run("echo agent", 5000)).refused).toMatch(/the owner is typing/)
    await Bun.sleep(500)
    expect((await t.shell.run("echo agent", 1000)).refused).toMatch(/the owner is typing/)
    expect(t.shell.state().ownerTyping).toBe(true)
    expect(await ownedRan(t)).toBe(false)
  })

  test(`${kind}: after a Ctrl-C, a prompt's marker a program prints doesn't end the agent's command`, async () => {
    const t = await openShell({ shell: kind })
    // A program that outlives the Ctrl-C prints the prompt the shell would show once it stopped, in every form it can,
    // and ends after the office's last Ctrl-C (four, 300 ms apart), which would stop the rest of the line.
    const forms = [mark(";130;1;5;/"), mark("0123456789abcdef;130;1;5;/"), mark("%s;130;1;5;/"), mark(";130")]
    const survivor =
      `sh -c 'trap "" INT; sleep 0.6; printf "${forms.join("")}" "$__oc_q" >/dev/tty; sleep 1.4; echo survived; exit 4'`
    expect((await t.shell.run(survivor, 300)).status).toBe("running")
    expect(t.shell.interrupt().refused).toBeUndefined()
    await Bun.sleep(900)
    expect(t.shell.state()).toMatchObject({ status: "running", command: survivor })
    const reply = await t.shell.read({ waitMs: 5000 })
    expect(reply).toMatchObject({ status: "idle", exit: 4 })
    expect(reply.output).toContain("survived\n")
    expect(readRecord(t.recordDir)!.commands.map((command) => command.exit)).toEqual([4])
  })

  test(`${kind}: the prompt's nonce never shows, even traced or printed`, async () => {
    const t = await openShell({ shell: kind })
    expect(await t.shell.run("set -x", 5000)).toMatchObject({ status: "idle", exit: 0 })
    const shown = await t.shell.run('echo "q=[$__oc_q]"', 5000)
    expect(shown.output).toContain("q=[[nonce]]\n")
    t.shell.ownerKeys("true\r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
    expect(await t.shell.run("true", 5000)).toMatchObject({ status: "idle", exit: 0 })
    for (const text of [await t.view(), t.live()]) expect(text).not.toMatch(/\d{15}/)
  })

  test(`${kind}: a sub-shell's prompts don't end the owner's command, and the shell's own prompt after it does`, async () => {
    const t = await openShell({ shell: kind })
    // In sh the sub-shell takes the prompt from the environment, marker and all, but none of the shell's variables.
    t.shell.ownerKeys(`${kind === "bash" ? "bash --norc --noprofile" : "sh"} -i\r`)
    await Bun.sleep(500)
    t.shell.ownerKeys("echo in-$((6*7))\r")
    await waitFor(async () => (await t.view()).includes("in-42\n"), { timeout: 5000, what: "the sub-shell's command" })
    // exec in the sub-shell swaps it for another, which leaves the shell's own prompt as it was.
    t.shell.ownerKeys("exec sh -i\r")
    await Bun.sleep(500)
    t.shell.ownerKeys("echo again-$((6*7))\r")
    await waitFor(async () => (await t.view()).includes("again-42\n"), { timeout: 5000, what: "the exec'd shell" })
    expect(t.shell.state().status).toBe("running")
    expect(t.shell.runProblem("echo agent")).toMatch(/the owner's command is running/)
    t.shell.ownerKeys("exit\r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle" })
    expect(await t.shell.run("echo agent", 5000)).toMatchObject({ status: "idle", exit: 0 })
    t.shell.ownerKeys("echo owner\r")
    expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  })
}

test("bash: what a command does to PROMPT_COMMAND leaves every prompt told", async () => {
  const t = await openShell()
  for (const change of [
    "PROMPT_COMMAND='echo x'",
    "PROMPT_COMMAND+='; echo y'",
    "PROMPT_COMMAND[1]='echo z'",
    "unset PROMPT_COMMAND",
    "declare +r PROMPT_COMMAND",
  ]) {
    expect((await t.shell.run(change, 5000)).exit).not.toBe(0)
  }
  // The owner's command ends at the shell's own prompt, and so does their Ctrl-C there; nothing else runs at it.
  t.shell.ownerKeys("echo owner-$((6*7))\r")
  const owner = await t.shell.read({ waitMs: 5000 })
  expect(owner).toMatchObject({ status: "idle", exit: 0 })
  expect(owner.output).toEndWith("\nowner-42\n")
  await ctrlC(t)
  const agent = await t.shell.run("echo agent", 5000)
  expect(agent).toMatchObject({ status: "idle", exit: 0 })
  expect(agent.output).toEndWith("$ echo agent\nagent\n")
})

test("bash: after exec sh no prompt can be told from a forged one, so the owner's command runs on and the agent waits", async () => {
  const t = await openShell()
  t.shell.ownerKeys("exec sh\r")
  await Bun.sleep(500)
  t.shell.ownerKeys(`printf '${mark(";0;1;5;/")}'; echo forged-$((6*7))\r`)
  await waitFor(async () => (await t.view()).includes("forged-42\n"), { timeout: 5000, what: "the forged prompt" })
  await Bun.sleep(300)
  expect(t.shell.state().status).toBe("running")
  expect(t.shell.runProblem("echo agent")).toMatch(/the owner's command is running/)
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

test("at a secret prompt, deleting the answer or Ctrl-U gives nothing back, and the prompt's end still drops the line", async () => {
  const t = await openShell()
  const asked = await t.shell.run("stty -echo; read -t 1 x; stty echo; echo after", 5000)
  expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
  t.shell.ownerKeys(`hunt${"\x7f".repeat(4)}\x15`)
  // The prompt holds the shell on its own terms; there is no line to give back.
  expect(t.shell.state()).toMatchObject({ status: "waiting", ownerTyping: false })
  expect(await t.shell.read({ waitMs: 5000 })).toMatchObject({ status: "idle", exit: 0 })
  await waitFor(async () => (await t.view()).includes("press Enter"), { timeout: 5000, what: "the owner's note" })
  // The owner's keys are dropped through Backspace and Ctrl-U until Enter, and the agent waits for that.
  t.shell.ownerKeys("er2\x7f\x15")
  expect(t.shell.state().ownerTyping).toBe(false)
  expect((await t.shell.run("true", 1000)).refused).toMatch(/the owner is typing/)
  t.shell.ownerKeys("\r")
  expect((await t.shell.run("true", 5000)).refused).toBeUndefined()
  await t.shell.close()
  const record = fs.readFileSync(path.join(t.recordDir, "output.log"), "utf8")
  for (const text of [await t.view(), t.live(), record]) expect(text).not.toMatch(/hunt|er2/)
})

test("a cut-off that stops a secret prompt while the owner is typing drops the rest of their line too", async () => {
  const t = await openShell()
  const asked = await t.shell.run("stty -echo; read x; stty echo; echo after", 5000)
  expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
  t.shell.ownerKeys("hunt")
  // The agent's call is cut off: its stop sends Ctrl-C, which ends the prompt under the owner's answer.
  t.shell.stop()
  await waitFor(() => t.shell.state().status === "idle", { timeout: 5000, what: "the stopped prompt" })
  await waitFor(async () => (await t.view()).includes("press Enter"), { timeout: 5000, what: "the owner's note" })
  // The rest of the password goes nowhere until the owner's Enter, never to the shell's prompt.
  t.shell.ownerKeys("er2\r")
  t.shell.ownerKeys("echo back\r")
  const reply = await t.shell.read({ waitMs: 5000 })
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
