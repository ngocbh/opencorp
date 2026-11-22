/** A terminal: one session's shells by name, as its host binds them. Calls on one shell queue, waits end together,
 *  a call cut off stops the command it waited on, close ends them all, a start failure says what to fix, the gate reads
 *  the profile from the shells' sandbox, and the host's audit gets each command the gate decided. Plain PTYs or a
 *  fake pipes runner, except the pipes test, which runs in the sandbox where one runs. */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { isPending } from "@ngocbh/yian/tools"
import { type Result, run, SandboxUnavailable } from "../../../src/runtime/sandbox/run.ts"
import type { Verdict, Where } from "../../../src/runtime/permissions/policy.ts"
import { Terminal } from "../../../src/tools/terminal/terminal.ts"
import { waitFor } from "../../helpers.ts"
import { goldenPolicy, goldenSshPolicy, gone, makePolicy, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import { fakePipes, HOST_WHERE, json, openTerminal, permissions, plainShells, rule, sshShells } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A pipes call's result, as `run` gives it, with `exit`. */
function result(exit: number | null): Result {
  const empty = Buffer.alloc(0)
  return {
    exit, stdout: empty, stderr: empty, stdoutTail: empty, stderrTail: empty, stdoutBytes: 0, stderrBytes: 0,
    timedOut: false, interrupted: false, truncated: false, duration: 0, refused: false,
  }
}

test("a new shell gets the next name, and a named one is reused", async () => {
  const t = openTerminal({ perms: permissions().perms })
  expect(json(await t.call("run", { command: "echo a", why: "x" }))).toMatchObject({ shell: "shell 1", output: "$ echo a\na\n" })
  expect(json(await t.call("run", { command: "echo b", why: "x", shell: "new" }))).toMatchObject({ shell: "shell 2" })
  expect(json(await t.call("run", { command: "echo c", why: "x", shell: "shell 1" }))).toMatchObject({
    shell: "shell 1", output: "$ echo c\nc\n",
  })
  expect(t.terminal.shells().map(({ id, name, state }) => [id, name, state.status])).toEqual([
    ["sh_1", "shell 1", "idle"],
    ["sh_2", "shell 2", "idle"],
  ])
  expect(t.record("sh_1").commands.map((c) => [c.command, c.by])).toEqual([["echo a", "@minh"], ["echo c", "@minh"]])
  expect(t.record("sh_1").profile).toBe("none")
  expect(json(await t.call("read", { shell: "shell 3" }))).toEqual({
    refused: 'no shell is named "shell 3": the shells are shell 1, shell 2; run with no shell starts a new one',
  })
})

test("two calls on one shell queue, and calls on two shells run together", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  await t.call("run", { command: "true", why: "x", shell: "new" })
  const [first, second] = await Promise.all([
    t.call("run", { command: "sleep 0.5; echo a", why: "x", shell: "shell 1" }),
    t.call("run", { command: "echo b", why: "x", shell: "shell 1" }),
  ])
  expect(json(first)).toMatchObject({ status: "idle", output: "$ sleep 0.5; echo a\na\n" })
  expect(json(second)).toMatchObject({ status: "idle", output: "$ echo b\nb\n" })
  const started = performance.now()
  const both = await Promise.all([
    t.call("run", { command: "sleep 0.8", why: "x", shell: "shell 1" }),
    t.call("run", { command: "sleep 0.8", why: "x", shell: "shell 2" }),
  ])
  expect(both.map((reply) => json(reply).status)).toEqual(["idle", "idle"])
  expect(performance.now() - started).toBeLessThan(1500)
})

test("interruptWaits ends every waiting reply at once, and stops the commands they waited on", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  const started = performance.now()
  const waiting = Promise.all([
    t.call("run", { command: "sleep 10.41", why: "x", shell: "shell 1", wait: 60 }),
    t.call("run", { command: "sleep 10.41", why: "x", wait: 60 }),
  ])
  await waitFor(() => t.terminal.shells().filter(({ state }) => state.status === "running").length === 2, {
    what: "both commands",
  })
  t.terminal.interruptWaits()
  // Each reply says its command ended, as a Ctrl-C ends it.
  expect((await waiting).map((reply) => [json(reply).status, json(reply).exit])).toEqual([["idle", 130], ["idle", 130]])
  expect(performance.now() - started).toBeLessThan(3000)
  expect(t.terminal.shells().map(({ state }) => [state.status, state.command])).toEqual([
    ["idle", null],
    ["idle", null],
  ])
  expect(await gone("10.41")).toBe(true)
})

test("a run whose reply is cut off stops its command, in a pipes shell and in a PTY shell", async () => {
  // A pipes shell: the call's own signal, then the terminal's interruptWaits.
  const allowMake = [rule("allow", "command", "make *")]
  let fake!: ReturnType<typeof fakePipes>
  const pipes = openTerminal({ perms: permissions({ rules: allowMake }).perms, shells: (dir) => (fake = fakePipes(dir)).shells, audit: true })
  const stop = new AbortController()
  const cut = pipes.call("run", { command: "make one", why: "x", wait: 60 }, { signal: stop.signal })
  await waitFor(() => fake.running().length === 1, { what: "the command" })
  stop.abort()
  expect(json(await cut)).toMatchObject({ shell: "shell 1", status: "idle", exit: null })
  const waited = pipes.call("run", { command: "make two", why: "x", wait: 60, shell: "shell 1" })
  await waitFor(() => fake.running().length === 1, { what: "the second command" })
  pipes.terminal.interruptWaits()
  expect(json(await waited)).toMatchObject({ shell: "shell 1", status: "idle", exit: null })
  expect(fake.running()).toEqual([])
  expect(pipes.audits.map((row) => [row.outcome, row.text, "exit" in row ? [row.exit, row.stopped] : undefined])).toEqual([
    ["error", "make one", [null, "its call was cut off"]],
    ["error", "make two", [null, "its call was cut off"]],
  ])
  // The agent's interrupt, the owner's Ctrl-C and a close each say why the command ended with no exit.
  const why = async (stop: (t: typeof pipes) => Promise<unknown> | void, command: string) => {
    expect(json(await pipes.call("run", { command, why: "x", wait: 0, shell: "shell 1" }))).toMatchObject({ status: "running" })
    await stop(pipes)
    await waitFor(() => pipes.audits.length > 2, { what: "the stopped command's row" })
    const row = pipes.audits.pop()!
    return "stopped" in row ? row.stopped : undefined
  }
  expect(await why((t) => t.call("interrupt", { shell: "shell 1" }), "make three")).toBe("the agent interrupted it")
  expect(await why((t) => t.terminal.shell(t.terminal.shells()[0]!.id)!.ownerKeys("\x03"), "make four")).toBe(
    "it was stopped, or couldn't run",
  )
  expect(await why((t) => t.call("close", { shell: "shell 1" }), "make five")).toBe("its shell ended")
  // An approved run's command stops with its own signal.
  const { perms, held } = permissions({ mode: "ask" })
  let approvedFake!: ReturnType<typeof fakePipes>
  const asked = openTerminal({ perms, shells: (dir) => (approvedFake = fakePipes(dir)).shells })
  expect(isPending(await asked.call("run", { command: "make three", why: "x" }))).toBe(true)
  const approval = new AbortController()
  const approved = asked.terminal.runApproved("terminal_run", held[0]!.card.args, approval.signal, "approved by @ngocbh")
  await waitFor(() => approvedFake.running().length === 1, { what: "the approved command" })
  approval.abort()
  expect(json(await approved)).toMatchObject({ status: "idle", exit: null })
  expect(approvedFake.running()).toEqual([])
  // A PTY shell gets a Ctrl-C.
  const pty = openTerminal({ perms: permissions().perms })
  const ptyStop = new AbortController()
  const sleeping = pty.call("run", { command: "sleep 30.31", why: "x", wait: 60 }, { signal: ptyStop.signal })
  await waitFor(() => pty.terminal.shells()[0]?.state.status === "running", { what: "the PTY command" })
  ptyStop.abort()
  expect(json(await sleeping)).toMatchObject({ shell: "shell 1", status: "idle", exit: 130 })
  expect(await gone("30.31")).toBe(true)
  // A read cut off stops nothing: there is nothing it started.
  let readFake!: ReturnType<typeof fakePipes>
  const reader = openTerminal({ perms: permissions({ rules: allowMake }).perms, shells: (dir) => (readFake = fakePipes(dir)).shells })
  expect(json(await reader.call("run", { command: "make four", why: "x", wait: 0 }))).toMatchObject({ status: "running" })
  const reading = new AbortController()
  const read = reader.call("read", { shell: "shell 1", wait: 60 }, { signal: reading.signal })
  reading.abort()
  expect(json(await read)).toMatchObject({ status: "running" })
  expect(readFake.running()).toEqual(["make four"])
  readFake.end("make four", 0)
})

/** Plain PTY shells (`plainShells`) whose terminal logs, in order, what the shell writes to it (`data`) and what is
 *  typed (`write`); `onWrite` sees each write once it has gone. */
function loggedShells(dir: string, onWrite: (data: string) => void = () => {}) {
  const log: { data?: string; write?: string }[] = []
  const shells = plainShells(dir)
  const start: typeof shells.start = (argv, io) => {
    const onData = (chunk: Uint8Array) => {
      log.push({ data: Buffer.from(chunk).toString("latin1") })
      io.onData(chunk)
    }
    const pty = shells.start(argv, { ...io, onData })
    return {
      get pid() { return pty.pid },
      get exited() { return pty.exited },
      write: (data) => {
        pty.write(data)
        log.push({ write: String(data) })
        onWrite(String(data))
      },
      resize: (cols, rows) => pty.resize(cols, rows),
      modes: () => pty.modes(),
      kill: (signal) => pty.kill(signal),
      close: () => pty.close(),
    }
  }
  return { shells: { ...shells, start }, log }
}

/** Where in `log` the first Ctrl-C was typed, and where the shell first said it read a command's line. */
function ctrlCAfterStart(log: { data?: string; write?: string }[]): [number, number] {
  const started = log.findIndex((e) => /opencorp-mark;[0-9a-f]+;start\x07/.test(e.data ?? ""))
  return [log.findIndex((e) => e.write === "\x03"), started]
}

test("on a PTY, a cut-off's Ctrl-C and the agent's interrupt reach the shell once it has read the command's line", async () => {
  // Cut off the moment the command's line is typed, before the shell can have read it.
  const stop = new AbortController()
  let logged!: ReturnType<typeof loggedShells>
  const t = openTerminal({
    perms: permissions().perms,
    shells: (dir) => (logged = loggedShells(dir, (data) => data.includes("sleep 30.71") && stop.abort())).shells,
  })
  await t.call("run", { command: "true", why: "x" })
  const cut = t.call("run", { command: "sleep 30.71", why: "x", wait: 60, shell: "shell 1" }, { signal: stop.signal })
  expect(json(await cut)).toMatchObject({ status: "idle", exit: 130 })
  const [ctrlC, started] = ctrlCAfterStart(logged.log)
  expect(started).toBeGreaterThan(-1)
  expect(ctrlC).toBeGreaterThan(started)
  expect(await gone("30.71")).toBe(true)
  // The agent's interrupt right after a reply that didn't wait.
  logged.log.length = 0
  const quick = await t.call("run", { command: "sleep 30.72", why: "x", wait: 0, shell: "shell 1" })
  expect(json(quick)).toMatchObject({ status: "running" })
  t.call("interrupt", { shell: "shell 1" })
  await waitFor(() => t.terminal.shells()[0]!.state.status === "idle", { what: "the interrupted command's end" })
  const [interrupted, read] = ctrlCAfterStart(logged.log)
  expect(read).toBeGreaterThan(-1)
  expect(interrupted).toBeGreaterThan(read)
  expect(await gone("30.72")).toBe(true)
})

test("a reply whose exit is null says why in its note: still running, cut off, interrupted, stopped, or the shell gone", async () => {
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({
    perms: permissions({ rules: [rule("allow", "command", "make *")] }).perms,
    shells: (dir) => (fake = fakePipes(dir)).shells,
  })
  const note = (reply: unknown) => json(reply).note
  const running = await t.call("run", { command: "make one", why: "x", wait: 0 })
  expect(json(running)).toMatchObject({ status: "running", exit: null })
  expect(note(running)).toBe("No exit yet: the command is still running.")
  // An exit says it all: no note.
  fake.end("make one", 2)
  expect(json(await t.call("read", { shell: "shell 1", wait: 10 }))).toMatchObject({ status: "idle", exit: 2 })
  expect(note(await t.call("read", { shell: "shell 1" }))).toBeUndefined()
  // Cut off.
  const stop = new AbortController()
  const cut = t.call("run", { command: "make two", why: "x", wait: 60, shell: "shell 1" }, { signal: stop.signal })
  await waitFor(() => fake.running().length === 1, { what: "the command" })
  stop.abort()
  expect(note(await cut)).toBe("No exit: the command was stopped because its call was cut off.")
  // The agent's interrupt, and the owner's Ctrl-C.
  const stopped = async (how: () => unknown, command: string) => {
    await t.call("run", { command, why: "x", wait: 0, shell: "shell 1" })
    await how()
    await waitFor(() => fake.running().length === 0, { what: "the command's end" })
    return note(await t.call("read", { shell: "shell 1" }))
  }
  expect(await stopped(() => t.call("interrupt", { shell: "shell 1" }), "make three")).toBe("No exit: you interrupted the command.")
  const owner = () => t.terminal.shell(t.terminal.shells()[0]!.id)!.ownerKeys("\x03")
  expect(await stopped(owner, "make four")).toBe(
    "No exit: the owner stopped the command (Ctrl-C), or it couldn't run.",
  )
  // A shell that ends while its command runs.
  await t.call("run", { command: "make five", why: "x", wait: 0, shell: "shell 1" })
  expect(note(await t.call("close", { shell: "shell 1" }))).toBe("No exit: the shell ended while the command ran.")
  // A PTY shell killed by a signal.
  const pty = openTerminal({ perms: permissions().perms })
  await pty.call("run", { command: "true", why: "x" })
  expect(note(await pty.call("close", { shell: "shell 1" }))).toBe("No exit: the shell ended, closed or killed by a signal.")
})

test("a call ends on its interrupt too, so an Esc that came before the call reached the terminal still cuts it off", async () => {
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({
    perms: permissions({ rules: [rule("allow", "command", "make *")] }).perms,
    shells: (dir) => (fake = fakePipes(dir)).shells,
  })
  const tools = t.terminal.tools()
  expect(json(await tools.run.call({ command: "make long", why: "x", wait: 0 }, { callId: "r/n/1/0" }))).toMatchObject({
    status: "running",
  })
  // Esc's cut-off found no call: this read reaches the terminal after it, and only its interrupt says so.
  t.terminal.interruptWaits()
  const interrupt = new AbortController()
  const read = tools.read.call({ shell: "shell 1", wait: 60 }, { callId: "r/n/2/0", interrupted: interrupt.signal })
  interrupt.abort()
  expect(json(await read)).toMatchObject({ shell: "shell 1", status: "running" })
  // The command its run's reply said is running goes on.
  expect(fake.running()).toEqual(["make long"])
  // A run whose interrupt comes while it waits stops its command, as a cut-off does.
  fake.end("make long", 0)
  const stop = new AbortController()
  const run = tools.run.call({ command: "make two", why: "x", wait: 60, shell: "shell 1" }, { callId: "r/n/3/0", interrupted: stop.signal })
  await waitFor(() => fake.running().length === 1, { what: "the command" })
  stop.abort()
  expect(json(await run)).toMatchObject({ status: "idle", exit: null })
  expect(fake.running()).toEqual([])
})

test("a command whose reply said running goes on when a later call is cut off", async () => {
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({
    perms: permissions({ rules: [rule("allow", "command", "make *")] }).perms,
    shells: (dir) => (fake = fakePipes(dir)).shells,
    audit: true,
  })
  expect(json(await t.call("run", { command: "make long", why: "x", wait: 0 }))).toMatchObject({
    shell: "shell 1", status: "running",
  })
  // A later call on another shell, cut off by the terminal's interruptWaits, as Esc does.
  const later = t.call("run", { command: "make short", why: "x", wait: 60 })
  await waitFor(() => fake.running().length === 2, { what: "the second command" })
  t.terminal.interruptWaits()
  expect(json(await later)).toMatchObject({ shell: "shell 2", status: "idle", exit: null })
  // The one the agent was told is running goes on, and the agent reads it later.
  expect(fake.running()).toEqual(["make long"])
  expect(t.terminal.shells().map(({ name, state }) => [name, state.status])).toEqual([["shell 1", "running"], ["shell 2", "idle"]])
  fake.end("make long", 0)
  expect(json(await t.call("read", { shell: "shell 1", wait: 10 }))).toMatchObject({ status: "idle", exit: 0 })
})

/** A terminal of fake pipes whose host takes notes, where `make *` and `echo *` run: the terminal, and its pipes. */
function notedTerminal() {
  let fake!: ReturnType<typeof fakePipes>
  const perms = permissions({ rules: [rule("allow", "command", "make *"), rule("allow", "command", "echo *")] }).perms
  const t = openTerminal({ perms, shells: (dir) => (fake = fakePipes(dir)).shells, notes: true })
  return { t, fake }
}

/** The first line of each note `t`'s host got. */
const headings = (t: ReturnType<typeof openTerminal>) => t.notes.map((note) => note.text.split("\n")[0])

test("a command the agent was told is still running gets one note when it ends, and the agent's place stays", async () => {
  const { t, fake } = notedTerminal()
  const running = json(await t.call("run", { command: "make all", why: "x", wait: 0 }))
  expect(running).toMatchObject({ shell: "shell 1", status: "running", output: "$ make all\n" })
  expect(running.note).toBe(
    "No exit yet: the command is still running, and you'll be told when it ends, with its exit code and last lines. " +
      "Don't poll it with read; do other work, or end your reply if you have nothing else to do.",
  )
  expect(t.notes).toEqual([])
  fake.end("make all", 2, "compiling\nerror: no rule\n")
  await waitFor(() => t.notes.length === 1, { what: "the note" })
  const [note] = t.notes
  expect([note!.key, note!.shell]).toEqual(["terminal:sh_1:1", "shell 1"])
  const lines = note!.text.split("\n")
  expect(lines[0]).toBe("shell 1: `make all` ended, exit 2")
  expect(lines[1]).toMatch(/^It ran for \d+s\. Its last lines:$/)
  expect(lines.slice(2)).toEqual(["$ make all", "compiling", "error: no rule"])
  // The note moves nothing: a read still returns all the agent hasn't read.
  expect(json(await t.call("read", { shell: "shell 1" }))).toMatchObject({
    status: "idle", exit: 2, output: "compiling\nerror: no rule\n",
  })
  // The next command in the shell gets a note of its own, under its own key.
  expect(json(await t.call("run", { command: "make two", why: "x", wait: 0, shell: "shell 1" }))).toMatchObject({
    status: "running",
  })
  fake.end("make two", 0)
  await waitFor(() => t.notes.length === 2, { what: "the second note" })
  expect([t.notes[1]!.key, headings(t)[1]]).toEqual(["terminal:sh_1:2", "shell 1: `make two` ended, exit 0"])
})

test("no note when a reply carries the end, the agent interrupts or closes, or the terminal closes; the owner's Ctrl-C gets one", async () => {
  const { t, fake } = notedTerminal()
  // The reply carries the end.
  expect(json(await t.call("run", { command: "echo hi", why: "x" }))).toMatchObject({ status: "idle", exit: 0 })
  // A read waiting on the command when it ends carries it.
  expect(json(await t.call("run", { command: "make a", why: "x", wait: 0, shell: "shell 1" }))).toMatchObject({
    status: "running",
  })
  const read = t.call("read", { shell: "shell 1", wait: 30 })
  await Bun.sleep(50)
  fake.end("make a", 0)
  expect(json(await read)).toMatchObject({ status: "idle", exit: 0 })
  // The agent's interrupt, and its close.
  await t.call("run", { command: "make b", why: "x", wait: 0, shell: "shell 1" })
  expect(json(await t.call("interrupt", { shell: "shell 1" })).refused).toBeUndefined()
  await t.call("run", { command: "make c", why: "x", wait: 0 })
  await t.call("close", { shell: "shell 2" })
  await waitFor(() => fake.running().length === 0, { what: "the stopped commands" })
  await Bun.sleep(50)
  expect(t.notes).toEqual([])
  // The owner's Ctrl-C, which the agent didn't see.
  await waitFor(() => t.terminal.shells()[0]!.state.status === "idle", { what: "shell 1 idle" })
  await t.call("run", { command: "make d", why: "x", wait: 0, shell: "shell 1" })
  t.terminal.shell("sh_1")!.ownerKeys("\x03")
  await waitFor(() => t.notes.length === 1, { what: "the note" })
  expect(headings(t)).toEqual(["shell 1: `make d` ended with no exit code: it was stopped, or couldn't run"])
  // The terminal closing, as the chat ends: the command stops, and nobody is told.
  await t.call("run", { command: "make e", why: "x", wait: 0, shell: "shell 1" })
  await t.terminal.close()
  expect(fake.running()).toEqual([])
  await Bun.sleep(50)
  expect(t.notes).toHaveLength(1)
})

test("a note keeps the last 20 lines, at most 2 KiB of them, and says where the output the agent hasn't read starts", async () => {
  const { t, fake } = notedTerminal()
  const reply = json(await t.call("run", { command: "make many\nmake    more", why: "x", wait: 0 }))
  const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
  fake.end("make many\nmake    more", 0, output)
  await waitFor(() => t.notes.length === 1, { what: "the note" })
  const lines = t.notes[0]!.text.split("\n")
  // The command on one line.
  expect(lines[0]).toBe("shell 1: `make many make more` ended, exit 0")
  expect(lines.slice(2)).toEqual([
    ...Array.from({ length: 20 }, (_, i) => `line ${i + 31}`),
    `[You haven't read its output before these lines: call terminal_read on shell 1 from ${reply.next}.]`,
  ])
  // Long lines: as many of the last as fit in 2 KiB, and one longer line's end.
  const wide = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(150, "x")).join("\n") + "\n"
  await t.call("run", { command: "make wide", why: "x", wait: 0, shell: "shell 1" })
  fake.end("make wide", 0, wide)
  await waitFor(() => t.notes.length === 2, { what: "the wide note" })
  await t.call("run", { command: "make huge", why: "x", wait: 0, shell: "shell 1" })
  fake.end("make huge", 0, "y".repeat(5000))
  await waitFor(() => t.notes.length === 3, { what: "the huge note" })
  const shown = (text: string) => text.split("\n").slice(2).filter((line) => !line.startsWith("["))
  expect(shown(t.notes[1]!.text)).toEqual(wide.trimEnd().split("\n").slice(-13))
  expect(shown(t.notes[2]!.text)).toEqual(["y".repeat(2048)])
  // A long command shows its first 200 characters.
  const long = `make ${"z".repeat(300)}`
  await t.call("run", { command: long, why: "x", wait: 0, shell: "shell 1" })
  fake.end(long, 0)
  await waitFor(() => t.notes.length === 4, { what: "the long command's note" })
  expect(headings(t)[3]).toBe(`shell 1: \`${long.slice(0, 200)}…\` ended, exit 0`)
  for (const note of t.notes) expect(Buffer.byteLength(note.text)).toBeLessThanOrEqual(4096)
})

test("with no host for notes, the run tool and its running reply say to read the command later", async () => {
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({
    perms: permissions({ rules: [rule("allow", "command", "make *")] }).perms,
    shells: (dir) => (fake = fakePipes(dir)).shells,
  })
  const { description } = t.terminal.tools().run
  expect(description).toContain("follow it with read from the reply's `next`, with a long wait")
  expect(description).not.toContain("you'll be told")
  expect(json(await t.call("run", { command: "make", why: "x", wait: 0 })).note).toBe(
    "No exit yet: the command is still running.",
  )
  fake.end("make", 0)
  const noted = notedTerminal().t.terminal.tools().run.description
  expect(noted).toContain("you'll be told when it ends, with its exit code and its last lines")
  expect(noted).toContain("if you have nothing else to do, end your reply")
})

test("the host's audit gets a held, a refused and an ended command, with why it ran or the approval's credit", async () => {
  const rules = [rule("allow", "command", "echo *"), rule("deny", "command", "rm *")]
  const { perms, held } = permissions({ mode: "ask", rules })
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({ perms, shells: (dir) => (fake = fakePipes(dir)).shells, audit: true })
  expect(json(await t.call("run", { command: "echo hi", why: "x" }))).toMatchObject({ shell: "shell 1", exit: 0 })
  expect(await t.call("run", { command: "rm x", why: "x", shell: "shell 1" })).toBe("Not run: a deny rule: rm *.")
  expect(isPending(await t.call("run", { command: "make", why: "builds it" }))).toBe(true)
  const approved = t.terminal.runApproved("terminal_run", held[0]!.card.args, new AbortController().signal, "approved by @ngocbh")
  await waitFor(() => fake.running().length === 1, { what: "the approved command" })
  fake.end("make", 2)
  expect(json(await approved)).toMatchObject({ shell: "shell 2", status: "idle", exit: 2 })
  const rows = t.audits.map((row) => ("duration" in row ? { ...row, duration: typeof row.duration } : row))
  expect(rows).toEqual([
    {
      outcome: "ok", tool: "terminal_run", text: "echo hi", shell: "shell 1", exit: 0, duration: "number",
      why: "by an allow rule", stopped: null,
    },
    { outcome: "denied", tool: "terminal_run", text: "rm x", shell: "shell 1", reason: "Not run: a deny rule: rm *." },
    { outcome: "held", tool: "terminal_run", text: "make", shell: null, reason: "Ask mode" },
    {
      outcome: "error", tool: "terminal_run", text: "make", shell: "shell 2", exit: 2, duration: "number",
      why: "approved by @ngocbh", stopped: null,
    },
  ])
})

test("a command that ends after the agent's wait still writes its row when it ends, with its exit", async () => {
  let fake!: ReturnType<typeof fakePipes>
  const check = async () => ({ verdict: "run" as const, reason: "builds the project" })
  const t = openTerminal({ perms: permissions({ check }).perms, shells: (dir) => (fake = fakePipes(dir)).shells, audit: true })
  expect(json(await t.call("run", { command: "make", why: "x", wait: 0 }))).toMatchObject({ status: "running" })
  expect(t.audits).toEqual([])
  fake.end("make", 0)
  await waitFor(() => t.audits.length === 1, { what: "the command's row" })
  expect(t.audits[0]).toMatchObject({
    outcome: "ok", text: "make", shell: "shell 1", exit: 0, why: "by Auto's check: builds the project",
  })
})

test("a call stopped in its check writes no audit row", async () => {
  let answer: ((verdict: Verdict) => void) | undefined
  const check = () => new Promise<Verdict>((resolve) => (answer = resolve))
  const { perms, held, checked } = permissions({ check })
  let fake!: ReturnType<typeof fakePipes>
  const t = openTerminal({ perms, shells: (dir) => (fake = fakePipes(dir)).shells, audit: true })
  const running = t.call("run", { command: "make", why: "x" })
  await waitFor(() => checked.length === 1, { what: "the check" })
  t.terminal.interruptWaits()
  answer!({ verdict: "run", reason: "fine" })
  expect(await running).toBe("Not run: stopped before Auto's check finished.")
  expect([t.audits, held, fake.commands, t.terminal.shells()]).toEqual([[], [], [], []])
})

test("a shell's start reads only the host's base where, never the host's caller", async () => {
  // The base names no folder, as the chat binds it: the terminal takes the profile, folder and writable paths from
  // the shells' sandbox, and only the credentials from the base. Nothing it does reads the caller's where.
  let reads = 0
  const base: Where = { profile: "workspace", cwd: null, writable: [], credentials: ["/creds/key"] }
  const { perms, held } = permissions({ mode: "auto", where: base })
  const counted = { ...perms, where: () => (reads++, base) }
  const t = openTerminal({ perms: counted, shells: (dir) => fakePipes(dir).shells })
  expect(t.terminal.where()).toEqual({ profile: "workspace", cwd: t.dir, writable: [t.dir, "/tmp"], credentials: ["/creds/key"] })
  expect(reads).toBe(1)
  expect(json(await t.call("run", { command: "echo read-only", why: "x" }))).toMatchObject({ exit: 0 })
  expect(isPending(await t.call("run", { command: "cat /creds/key", why: "x", shell: "shell 1" }))).toBe(true)
  expect(held.map((h) => h.card.reason)).toEqual(["it names a credential path: /creds/key"])
})

test("close ends every shell and marks its record ended", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  await t.call("run", { command: "sleep 30", why: "x", wait: 0 })
  await t.terminal.close()
  expect(t.terminal.shells().map(({ state }) => state.status)).toEqual(["ended", "ended"])
  expect([t.record("sh_1").state, t.record("sh_2").state]).toEqual(["ended", "ended"])
  expect(json(await t.call("run", { command: "true", why: "x" }))).toEqual({ refused: "this terminal has closed" })
})

test("a shell that can't start tells the agent what to fix, and the list shows it failed", async () => {
  const t = openTerminal({
    perms: permissions().perms,
    shells: (dir) => ({
      ...plainShells(dir),
      start: () => {
        throw new SandboxUnavailable('no sandbox for platform "plan9"')
      },
    }),
  })
  const reply = json(await t.call("run", { command: "echo hi", why: "x" }))
  expect(reply).toMatchObject({ shell: "shell 1", status: "failed" })
  expect(reply.error).toBe(
    'the shell couldn\'t start: no sandbox for platform "plan9"; the shell needs a sandbox: on Linux, install ' +
      "bubblewrap (bwrap) and allow unprivileged user namespaces; on macOS, sandbox-exec comes with the system",
  )
  expect(t.terminal.shells().map(({ name, state }) => [name, state.status, state.error])).toEqual([
    ["shell 1", "failed", reply.error as string],
  ])
  expect(t.record("sh_1").state).toBe("failed")
})

test("the gate reads the profile from the shells' sandbox: workspace only for a workspace's, and the SSH-only one's credentials", async () => {
  const ask = async () => ({ verdict: "ask" as const, reason: "asked" })
  // No sandbox: strict, though the host's where says workspace and writable everywhere.
  const none = permissions({ check: ask })
  const bare = openTerminal({ perms: none.perms })
  expect(bare.terminal.profile).toBe("none")
  expect(bare.terminal.where()).toEqual({ profile: "ssh", cwd: HOST_WHERE.cwd, writable: [] })
  await bare.call("run", { command: "touch x", why: "x" })
  await bare.call("run", { command: "cat $F", why: "x" })
  expect(none.held.map((h) => h.card.reason)).toEqual(["Auto's check: asked", "it reads a path named by an expansion: $F"])

  // The SSH-only profile: its temp folder, nothing writable, and the credentials it binds marked.
  const ssh = permissions({ check: ask })
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const ticket = path.join(tmp, "krb-ticket")
  const sshPolicy = goldenSshPolicy({ home: "/home/u", hq: "/home/u/.opencorp/hq", tmpdir: tmp, statusFile: "/s", ticket })
  const remote = openTerminal({
    perms: ssh.perms,
    shells: (dir) => ({ ...plainShells(dir), env: { HOME: "/home/u", TMPDIR: tmp }, sandbox: sshPolicy }),
  })
  expect(remote.terminal.profile).toBe("ssh")
  expect(remote.terminal.where()).toEqual({ profile: "ssh", cwd: tmp, writable: [], credentials: [ticket] })
  await remote.call("run", { command: `cat ${ticket}`, why: "x" })
  expect(ssh.held[0]!.card.reason).toBe(`it names a credential path: ${ticket}`)
  fs.rmSync(tmp, { recursive: true, force: true })

  // A workspace's sandbox, pipes or a PTY: the workspace profile, its folder and what it may write.
  for (const kind of ["pipes", "pty"] as const) {
    // Auto's check runs a cd, and asks before anything else it is given.
    const ws = permissions({
      check: async (input) => (input.command.startsWith("cd ") ? { verdict: "run", reason: "moves" } : ask()),
    })
    const t = openTerminal({
      perms: ws.perms,
      shells: (dir) => {
        fs.mkdirSync(path.join(dir, "src"))
        fs.writeFileSync(path.join(dir, "src", "x.ts"), "export {}\n")
        const sandbox = goldenPolicy({ workspace: dir, writable: true, network: false, tmpdir: "/tmp" })
        return kind === "pipes"
          ? { kind, sandbox, run: async () => result(0) }
          : { ...plainShells(dir), env: { ...plainShells(dir).env, HOME: "/tmp", TMPDIR: "/tmp" }, sandbox }
      },
    })
    expect(t.terminal.profile).toBe("workspace")
    expect(t.terminal.where()).toEqual({ profile: "workspace", cwd: t.dir, writable: [t.dir, "/tmp"] })
    expect(json(await t.call("run", { command: "touch x", why: "x" }))).toMatchObject({ status: "idle", exit: 0 })
    expect(json(await t.call("run", { command: "cat $F /dev/null", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    // A cd in the line still runs on the workspace profile.
    expect(json(await t.call("run", { command: "cd src && cat x.ts", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    expect(ws.held).toEqual([])
    expect(t.record("sh_1").profile).toBe("workspace")
  }
})

test("on the SSH-only profile the gate reads a PTY shell's folder as its last command left it", async () => {
  for (const mode of ["auto", "dontAsk"] as const) {
    const { perms, held } = permissions({ mode, check: async () => ({ verdict: "run", reason: "fine" }) })
    const t = openTerminal({ perms, shells: (dir) => sshShells(dir) })
    const answer = (reason: string) => (result: unknown) =>
      mode === "dontAsk"
        ? expect(result).toBe(`Not run: this session doesn't ask (dontAsk mode): ${reason}.`)
        : expect(isPending(result)).toBe(true)
    const holds = "it reads a folder that holds credentials: ."
    // A new shell starts in the profile's temp folder, here in the home.
    expect(t.terminal.where().cwd).toBe("~/work")
    expect(json(await t.call("run", { command: "cd ~", why: "go home" }))).toMatchObject({ shell: "shell 1", exit: 0 })
    expect(t.terminal.where("sh_1").cwd).toBe("~")
    answer(holds)(await t.call("run", { command: "grep -r PRIVATE .", why: "x", shell: "shell 1" }))
    // In one line, before any shell has moved.
    answer(holds)(await t.call("run", { command: "cd ~ && grep -r PRIVATE .", why: "x" }))
    // The owner's command may have moved the shell anywhere: relative reads ask until the agent's next command ends.
    t.terminal.shell("sh_1")!.ownerKeys("cd work\r")
    expect(json(await t.call("read", { shell: "shell 1", wait: 5 }))).toMatchObject({ status: "idle" })
    expect(t.terminal.where("sh_1").cwd).toBeNull()
    const lost = "it reads a relative path where the folder isn't known: ."
    answer(lost)(await t.call("run", { command: "grep -r PRIVATE .", why: "x", shell: "shell 1" }))
    expect(json(await t.call("run", { command: "true", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    expect(t.terminal.where("sh_1").cwd).toBe("~/work")
    expect(held.map((h) => h.card.reason)).toEqual(mode === "dontAsk" ? [] : [holds, holds, lost])
    expect(t.terminal.shells().map((shell) => shell.name)).toEqual(["shell 1"])
  }
})

test("PTY shells whose environment isn't their sandbox's are refused", () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  try {
    const shells = sshShells(dir)
    const host = (env: Record<string, string>) => ({
      shells: { ...shells, env }, driver: "@minh", permissions: permissions().perms,
      shellHost: () => { throw new Error("unused") },
    })
    expect(() => new Terminal(host({ ...shells.env, HOME: "/elsewhere" }))).toThrow(RangeError)
    expect(() => new Terminal(host({ ...shells.env, TMPDIR: "/tmp" }))).toThrow(RangeError)
    expect(new Terminal(host(shells.env)).profile).toBe("ssh")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("an approved command runs only in the folder its card was decided in", async () => {
  const allowed = ["true", "cd *", "echo here"].map((pattern) => rule("allow", "command", pattern))
  const { perms, held } = permissions({ mode: "ask", rules: allowed })
  const t = openTerminal({ perms, shells: (dir) => sshShells(dir) })
  expect(json(await t.call("run", { command: "true", why: "x" }))).toMatchObject({ shell: "shell 1", exit: 0 })
  const tar = "tar cf - . | ssh h 'cat > x'"
  expect(isPending(await t.call("run", { command: tar, why: "x", shell: "shell 1" }))).toBe(true)
  expect(held[0]!.card.args).toEqual({ command: tar, why: "x", wait: 30, shell: "shell 1", cwd: "~/work" })
  // The agent moves the shell while the card waits.
  expect(json(await t.call("run", { command: "cd ~", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
  expect(json(await t.terminal.runApproved("terminal_run", held[0]!.card.args, new AbortController().signal))).toMatchObject({
    shell: "shell 1",
    refused:
      "the shell is in another folder than when this command was approved (~/work, now ~); run it again to have " +
      "it checked there",
  })
  expect(t.record("sh_1").commands.map((c) => c.command)).toEqual(["true", "cd ~"])
  // In the same folder, it runs; a held command for a new shell runs in the folder new shells start in.
  expect(isPending(await t.call("run", { command: "echo there", why: "x", shell: "shell 1" }))).toBe(true)
  expect(json(await t.terminal.runApproved("terminal_run", held[1]!.card.args, new AbortController().signal))).toMatchObject({
    exit: 0, output: "$ echo there\nthere\n",
  })
  expect(isPending(await t.call("run", { command: "echo new", why: "x" }))).toBe(true)
  expect(held[2]!.card.args.cwd).toBe("~/work")
  expect(json(await t.terminal.runApproved("terminal_run", held[2]!.card.args, new AbortController().signal))).toMatchObject({
    shell: "shell 2", exit: 0,
  })
  // A card names its shell by name, and the host reads the shell's folder by it.
  expect(t.terminal.where("shell 1")).toEqual(t.terminal.where("sh_1"))
  expect(t.terminal.where("shell 1").cwd).toBe("~")
})

test("runApproved runs a terminal_run or terminal_type card and refuses any other tool", async () => {
  const { perms, held } = permissions({ mode: "ask", rules: [rule("allow", "command", "cat")] })
  const t = openTerminal({ perms })
  await t.call("run", { command: "cat", why: "x", wait: 0 })
  expect(isPending(await t.call("type", { shell: "shell 1", text: "typed-once", why: "x", wait: 0 }))).toBe(true)
  expect(isPending(await t.call("run", { command: "echo ran-once", why: "x" }))).toBe(true)
  const [typed, ran] = held.map((h) => h.card)
  // A card names its tool as the model called it, and the host passes that name back.
  expect([typed!.tool, ran!.tool]).toEqual(["terminal_type", "terminal_run"])
  const signal = new AbortController().signal
  for (const tool of ["run", "type", "terminal_read", "terminal_interrupt", "terminal_close", "shell"]) {
    expect(json(await t.terminal.runApproved(tool, ran!.args, signal))).toEqual({
      refused: `${tool} never waits for the owner's approval; only terminal_run and terminal_type do`,
    })
  }
  expect(t.terminal.shells().map((s) => s.name)).toEqual(["shell 1"])
  expect(json(await t.terminal.runApproved(typed!.tool, typed!.args, signal)).refused).toBeUndefined()
  await waitFor(() => t.live("sh_1").includes("typed-once\r\ntyped-once"), { what: "cat's echo" })
  expect(json(await t.terminal.runApproved(ran!.tool, ran!.args, signal))).toMatchObject({
    shell: "shell 2", exit: 0, output: "$ echo ran-once\nran-once\n",
  })
  t.terminal.shell("sh_1")!.ownerKeys("\x04")
})

describe.skipIf(!sandboxAvailable())("in the sandbox", () => {
  test("a pipes terminal keeps no folder or variable between commands, and refuses type before the gate", async () => {
    const { perms, held, checked } = permissions({ check: async () => ({ verdict: "run", reason: "ok" }) })
    let policy: ReturnType<ReturnType<typeof makePolicy>["make"]> | undefined
    const t = openTerminal({
      perms,
      shells: () => {
        policy = makePolicy().make()
        return { kind: "pipes", sandbox: policy, run: (argv, options) => run(policy!, argv, options) }
      },
    })
    expect(json(await t.call("run", { command: "cd /tmp && X=1 && echo in", why: "x" }))).toMatchObject({ exit: 0 })
    const after = json(await t.call("run", { command: 'pwd; echo "x=$X"', why: "x", shell: "shell 1" }))
    expect(after.output).toBe(`$ pwd; echo "x=$X"\n${policy!.workspace}\nx=\n`)
    const before = checked.length
    expect(json(await t.call("type", { shell: "shell 1", text: "y", why: "x" }))).toMatchObject({
      shell: "shell 1", refused: "this shell takes no input",
    })
    expect([checked.length, held]).toEqual([before, []])
  })
})
