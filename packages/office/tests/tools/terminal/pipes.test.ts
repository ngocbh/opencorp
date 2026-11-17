/** The terminal's pipes shell: each command its own sandboxed call, streamed, with stdout and stderr as one stream,
 *  the PTY shell's states, replies and record, and no typed input. The sandboxed tests skip where no sandbox runs; the
 *  last two give the shell a call of their own. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { now } from "@opencorp/protocol"
import { SandboxPolicy } from "../../../src/runtime/sandbox/policy.ts"
import { type Result, run, SandboxUnavailable } from "../../../src/runtime/sandbox/run.ts"
import { PAGE_SIZE } from "../../../src/tools/terminal/output.ts"
import { type PipeHost, PipeShell } from "../../../src/tools/terminal/pipes.ts"
import { InstrumentRecord, readRecord } from "../../../src/tools/terminal/record.ts"
import type { ShellState } from "../../../src/tools/terminal/shell.ts"
import { waitFor } from "../../helpers.ts"
import { gone, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"

setDefaultTimeout(30_000)

/** A pipes shell over a fresh folder's writable workspace `<dir>/ws`, with its record in `<dir>/record`, its calls
 *  sandboxed unless `call` stands in for them. The test's end closes the shell, then removes the folder. */
function openShell(call?: PipeHost["run"]) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-pipes-")))
  const ws = path.join(dir, "ws")
  const tmp = path.join(dir, "tmp")
  fs.mkdirSync(ws)
  fs.mkdirSync(tmp)
  let shell: PipeShell | undefined
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
  const states: ShellState[] = []
  const live: Uint8Array[] = []
  let sandboxed = call
  if (sandboxed === undefined) {
    const policy = new SandboxPolicy({ workspace: ws, writable: true, network: false, tmpdir: tmp })
    sandboxed = (argv, options) => run(policy, argv, options)
  }
  const host: PipeHost = {
    run: sandboxed,
    record,
    driver: "@minh",
    changed: (state) => states.push(state),
    output: (chunk) => live.push(chunk),
  }
  shell = PipeShell.open("sh_1", "shell 1", host)
  return {
    shell,
    dir,
    ws,
    recordDir,
    states,
    /** The owner's live view so far, decoded. */
    live: () => new TextDecoder().decode(Buffer.concat(live)),
    /** The record's output.log. */
    log: () => fs.readFileSync(path.join(recordDir, "output.log"), "utf8"),
  }
}

/** A call's result, as `run` gives it, with `exit`. */
function result(exit: number | null): Result {
  const empty = Buffer.alloc(0)
  return {
    exit,
    stdout: empty,
    stderr: empty,
    stdoutTail: empty,
    stderrTail: empty,
    stdoutBytes: 0,
    stderrBytes: 0,
    timedOut: false,
    interrupted: false,
    truncated: false,
    duration: 0,
    refused: false,
  }
}

describe.skipIf(!sandboxAvailable())("in the sandbox", () => {
  test("a pipes shell runs each command sandboxed, streams it, and refuses typed input", async () => {
    const t = openShell()
    expect(t.shell.state()).toEqual({ status: "idle", waiting: null, command: null, exit: null, error: null })
    expect(t.states.map((state) => state.status)).toEqual(["idle"])
    // It starts in the workspace, and the folder around it is out of its reach.
    const outside = path.join(t.dir, "outside")
    fs.writeFileSync(outside, "x")
    const command = `pwd; test -e '${outside}' && echo seen || echo hidden; false`
    const reply = await t.shell.run(command, 10_000)
    const output = `$ ${command}\n${t.ws}\nhidden\n`
    const next = output.length
    expect(reply).toEqual({ shell: "sh_1", status: "idle", exit: 1, waiting: null, output, next, more: false })
    expect(t.shell.state()).toEqual({ status: "idle", waiting: null, command: null, exit: 1, error: null })
    expect(t.states.map((state) => [state.status, state.command])).toEqual([
      ["idle", null],
      ["running", command],
      ["idle", null],
    ])
    // The owner sees the same bytes, `$ <command>` first.
    expect(t.live()).toBe(output)

    // Output streams while the command runs.
    const slow = "echo first; sleep 2; echo second"
    const started = await t.shell.run(slow, 100)
    expect(started.status).toBe("running")
    await waitFor(() => t.live().endsWith("first\n"), { timeout: 10_000, what: "the first line" })
    expect(t.shell.state()).toMatchObject({ status: "running", command: slow })
    const rest = await t.shell.read({ waitMs: 10_000 })
    expect(rest).toMatchObject({ status: "idle", exit: 0 })
    expect(started.output + rest.output).toBe(`$ ${slow}\nfirst\nsecond\n`)

    // Each command is its own call: no folder or variable carries over.
    expect((await t.shell.run("cd /; X=1; export X", 10_000)).exit).toBe(0)
    const after = 'pwd; echo "x=$X"'
    expect((await t.shell.run(after, 10_000)).output).toBe(`$ ${after}\n${t.ws}\nx=\n`)

    // Its input is empty: a read ends at once.
    const reads = 'read x; echo "read=$? x=$x"'
    expect(await t.shell.run(reads, 10_000)).toMatchObject({ status: "idle", output: `$ ${reads}\nread=1 x=\n` })

    // Typed input is refused, idle or running, with nothing done.
    const before = t.live()
    expect(await t.shell.type("yes", { enter: true, waitMs: 1000 })).toEqual({
      shell: "sh_1",
      status: "idle",
      exit: 0,
      waiting: null,
      output: "",
      next: before.length,
      more: false,
      refused: "this shell takes no input",
    })
    expect(t.shell.pendingLine()).toBe("")
    expect((await t.shell.run("sleep 1", 50)).status).toBe("running")
    expect((await t.shell.type("yes", { enter: false, waitMs: 1000 })).refused).toBe("this shell takes no input")
    expect(await t.shell.read({ waitMs: 10_000 })).toMatchObject({ status: "idle", exit: 0, output: "" })
    expect(t.live()).toBe(`${before}$ sleep 1\n`)
  })

  test("a pipes command's stdout and stderr reach the view in the order they were written", async () => {
    const t = openShell()
    const command = "echo a; echo b >&2; echo c"
    expect((await t.shell.run(command, 10_000)).output).toBe(`$ ${command}\na\nb\nc\n`)
    // Lines in turn, as two pipes read apart would reorder them.
    const many = "for i in $(seq 50); do echo out$i; echo err$i >&2; done"
    const lines = Array.from({ length: 50 }, (_, i) => `out${i + 1}\nerr${i + 1}\n`).join("")
    expect((await t.shell.run(many, 10_000)).output).toBe(`$ ${many}\n${lines}`)
    // The owner's live view and the record hold the same order.
    const all = `$ ${command}\na\nb\nc\n$ ${many}\n${lines}`
    expect(t.live()).toBe(all)
    await t.shell.close()
    expect(t.log()).toBe(all)
  })

  test("the owner's interrupt stops a pipes command", async () => {
    const t = openShell()
    expect(t.shell.interrupt().refused).toBe("nothing is running")
    const command = "sleep 3737 & sleep 3838"
    expect((await t.shell.run(command, 300)).status).toBe("running")
    const at = performance.now()
    const interrupted = t.shell.interrupt()
    expect(interrupted.refused).toBeUndefined()
    expect(interrupted.status).toBe("running")
    expect(await t.shell.read({ waitMs: 10_000 })).toMatchObject({ status: "idle", exit: null })
    expect(performance.now() - at).toBeLessThan(5_000)
    // The command and what it left in the background are gone.
    expect(await gone("3737")).toBe(true)
    expect(await gone("3838")).toBe(true)
    expect(readRecord(t.recordDir)!.commands).toMatchObject([{ command, by: "@minh", exit: null }])
    expect(t.states.map((state) => [state.status, state.exit])).toEqual([
      ["idle", null],
      ["running", null],
      ["idle", null],
    ])
    // The shell runs on.
    const again = await t.shell.run("echo again", 10_000)
    expect(again).toMatchObject({ status: "idle", exit: 0, output: "$ echo again\nagain\n" })
    // Closing it stops a running command too, and ends its record.
    expect((await t.shell.run("sleep 3939", 300)).status).toBe("running")
    await t.shell.close()
    expect(t.shell.state()).toEqual({ status: "ended", waiting: null, command: null, exit: null, error: null })
    expect(await gone("3939")).toBe(true)
    expect(readRecord(t.recordDir)).toMatchObject({
      state: "ended",
      commands: [{ exit: null }, { command: "echo again", exit: 0 }, { command: "sleep 3939", exit: null }],
    })
    expect((await t.shell.run("true", 1000)).refused).toBe("the shell has ended; start a new one")
    expect(t.shell.interrupt().refused).toBe("nothing is running")
  })

  test("a pipes command's record holds its exit, and its output is paged like a PTY shell's", async () => {
    const t = openShell()
    const replies = [await t.shell.run("echo hi; exit 3", 10_000)]
    expect(replies[0]).toMatchObject({ status: "idle", exit: 3, output: "$ echo hi; exit 3\nhi\n" })
    // The view reads as a terminal shows it: CR-LF ends a line, a lone CR redraws it, and escapes go.
    const drawn = "printf 'a\\r\\nb\\rB\\n\\033[31mred\\033[0m\\n'"
    replies.push(await t.shell.run(drawn, 10_000))
    expect(replies[1]!.output).toBe(`$ ${drawn}\na\nB\nred\n`)
    // Output over a page comes a page at a time, and the agent reads on from each page's `next`.
    const many = "seq 1 20000"
    const lines = `${Array.from({ length: 20_000 }, (_, i) => i + 1).join("\n")}\n`
    const first = await t.shell.run(many, 10_000)
    expect(first).toMatchObject({ status: "idle", exit: 0, more: true, next: replies[1]!.next + PAGE_SIZE })
    expect(first.output.length).toBe(PAGE_SIZE)
    const second = await t.shell.read({ waitMs: 0 })
    expect(second).toMatchObject({ status: "idle", exit: 0, more: false })
    expect(first.output + second.output).toBe(`$ ${many}\n${lines}`)
    // An earlier page reads again from its offset.
    expect((await t.shell.read({ waitMs: 0, from: 0 })).output).toStartWith("$ echo hi; exit 3\nhi\n$ printf")
    await t.shell.close()
    expect(readRecord(t.recordDir)).toMatchObject({
      state: "ended",
      commands: [
        { command: "echo hi; exit 3", by: "@minh", exit: 3 },
        { command: drawn, exit: 0 },
        { command: many, exit: 0 },
      ],
    })
    expect(t.log()).toBe(`${replies[0]!.output}${replies[1]!.output}$ ${many}\n${lines}`)
  })
})

test("a pipes command a signal ends exits as a shell shows it, 128 and the signal", async () => {
  const t = openShell(async (_argv, options) => {
    options.onOutput?.("stdout", Buffer.from("killed\n"))
    return result(-9)
  })
  const reply = await t.shell.run("kill -9 $$", 5_000)
  expect(reply).toMatchObject({ status: "idle", exit: 137, output: "$ kill -9 $$\nkilled\n" })
  expect(readRecord(t.recordDir)!.commands).toMatchObject([{ command: "kill -9 $$", exit: 137 }])
})

test("a command the pipes shell can't take is refused with nothing run", async () => {
  let calls = 0
  const t = openShell(async () => {
    calls += 1
    return result(0)
  })
  const refusals: [string, string][] = [
    [" \n", "the command is empty"],
    ["echo \x1b[31mred", "a command can't hold a control character other than newline and tab"],
    ["echo \x00", "a command can't hold a control character other than newline and tab"],
    [`echo ${"x".repeat(64 * 1024)}`, "this command is over 64 KiB: write a script with the file tools and run it"],
  ]
  for (const [command, why] of refusals) {
    expect(await t.shell.run(command, 1_000)).toMatchObject({ status: "idle", output: "", refused: why })
  }
  expect(calls).toBe(0)
  expect(t.live()).toBe("")
  expect(readRecord(t.recordDir)!.commands).toEqual([])
  // Newlines and tabs are a command's own, and a long one that fits runs.
  const fits = `echo\t'a\nb' ${"y".repeat(60 * 1024)}`
  expect((await t.shell.run(fits, 1_000)).refused).toBeUndefined()
  expect(calls).toBe(1)
})

test("a pipes shell whose call can't run fails, saying why", async () => {
  const calls: (readonly string[])[] = []
  const t = openShell(async (argv) => {
    calls.push(argv)
    throw new SandboxUnavailable('no sandbox for platform "plan9"')
  })
  const reply = await t.shell.run("echo hi", 5_000)
  expect(reply).toMatchObject({ status: "failed", exit: null, output: "$ echo hi\n" })
  // The command went as one `/bin/sh -c` whose stderr is its stdout.
  expect(calls).toEqual([["/bin/sh", "-c", "exec 2>&1; echo hi"]])
  const error = `the sandbox couldn't run a command: no sandbox for platform "plan9"`
  expect(t.shell.state()).toEqual({ status: "failed", waiting: null, command: null, exit: null, error })
  expect((await t.shell.run("true", 1_000)).refused).toBe(`the shell failed: ${error}`)
  expect(readRecord(t.recordDir)).toMatchObject({ state: "failed", error, commands: [{ command: "echo hi" }] })
})
