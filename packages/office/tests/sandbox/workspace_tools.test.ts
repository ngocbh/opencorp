/** The workspace tools, each call one sandboxed process (Python's `tests/sandbox/test_workspace_tools.py`). */
import fs from "node:fs"
import path from "node:path"
import { ToolSet } from "@ngocbh/yian/tools"
import { expect, setDefaultTimeout, test } from "bun:test"
import { helperCommand } from "../../src/platform.ts"
import type { Result } from "../../src/sandbox/run.ts"
import {
  MAX_SHELL_OUTPUT,
  shellOutput,
  TOOL_NAMES,
  type WorkspaceCall,
  workspaceToolFunctions,
  WorkspaceTools,
  type WorkspaceOptions,
} from "../../src/tools/workspace.ts"
import { groupSpecs, toolSpec } from "../../src/worker/job.ts"
import { BaseHandlers, remoteTool } from "../../src/worker/rpc.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { officeEnd } from "../worker/helpers.ts"
import { makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

type MakeOptions = NonNullable<Parameters<ReturnType<typeof makePolicy>["make"]>[0]>

/** Workspace tools over a fresh `ws` (Python's `tools` fixture): `policy` goes to `make`, the rest
 *  overrides the options. */
function tools({ policy, ...over }: { policy?: MakeOptions } & Partial<WorkspaceOptions> = {}) {
  const { ws, make } = makePolicy()
  const store = openStore()
  return { tools: new WorkspaceTools(make(policy), { officeHome: tempDir(), store, ...over }), ws, store }
}

/** The tool functions over `call`, offered through a worker's `remoteTool`s as a yian `ToolSet`. */
async function workerToolSet(call: WorkspaceCall): Promise<ToolSet> {
  const fns = workspaceToolFunctions(call)
  const rpc = await officeEnd(new BaseHandlers({ tools: { workspace: fns } }))
  return new ToolSet({ workspace: TOOL_NAMES.map((n) => remoteTool(rpc, "workspace", toolSpec(n, fns[n]!))) })
}

test.skipIf(!sandboxAvailable())("file tools round trip", async () => {
  const { tools: t, ws } = tools()
  expect((await t.call("write_file", { path: "pkg/a.py", content: "x = 1\n" })).output).toBe(
    "wrote 6 bytes to pkg/a.py",
  )
  expect(fs.readFileSync(path.join(ws, "pkg/a.py"), "utf8")).toBe("x = 1\n")
  expect((await t.call("read_file", { path: "pkg/a.py" })).output).toBe("x = 1\n")
  expect((await t.call("edit_file", { path: "pkg/a.py", old: "x = 1", new: "x = 2" })).output).toBe(
    "replaced 1 occurrence in pkg/a.py at line 1",
  )
  expect((await t.call("list", { path: "." })).output).toBe("pkg/")
  expect((await t.call("search", { pattern: "x = 2" })).output).toBe("pkg/a.py:1:x = 2")
})

test.skipIf(!sandboxAvailable())("errors come back as text", async () => {
  const out = await tools().tools.call("read_file", { path: "missing.txt" })
  expect(out.output.startsWith("error: No such file")).toBe(true)
  expect(out.audit.exit).toBe(1)
})

test.skipIf(!sandboxAvailable())("large non ascii read", async () => {
  // 200k characters of "é" are 1.2 MB as \u00e9 escapes; the reply must still fit.
  const { tools: t, ws } = tools()
  fs.writeFileSync(path.join(ws, "big.txt"), "é".repeat(300_000))
  const out = (await t.call("read_file", { path: "big.txt" })).output
  expect(out.startsWith("é".repeat(200_000) + "\n[truncated at 200000 characters")).toBe(true)
})

test.skipIf(!sandboxAvailable())("oversized reply is an explicit error", async () => {
  const { tools: t, ws } = tools({ fileOutputCap: 1000 })
  fs.writeFileSync(path.join(ws, "f.txt"), "x".repeat(5000))
  const out = await t.call("read_file", { path: "f.txt" })
  expect(out.output.startsWith("error: read_file output too large (over 1000 bytes); ask for less")).toBe(true)
})

test.skipIf(!sandboxAvailable())("shell", async () => {
  const out = await tools().tools.call("shell", { command: "echo hi; echo oops >&2; exit 2" })
  expect(out.output).toBe("hi\n[stderr]\noops\n[exit 2]")
  expect(out.audit.exit).toBe(2)
})

test.skipIf(!sandboxAvailable())("shell output keeps head and tail", async () => {
  const command = "echo START; head -c 200000 /dev/zero | tr '\\0' a; echo; echo END >&2"
  const out = (await tools().tools.call("shell", { command })).output
  const limit = MAX_SHELL_OUTPUT
  const at = out.indexOf("\n[")
  const head = out.slice(0, at)
  const noteAndTail = out.slice(at + 2)
  expect(head.startsWith("START\n")).toBe(true)
  expect(Buffer.byteLength(head)).toBeLessThanOrEqual(Math.floor(limit / 2))
  const cut = 6 + 200001 + "[stderr]\nEND\n".length - 2 * Math.floor(limit / 2)
  expect(noteAndTail.startsWith(`${cut} bytes of output cut]\n`)).toBe(true)
  expect(out.endsWith("a\n[stderr]\nEND\n[exit 0]")).toBe(true)
  expect(Buffer.byteLength(out)).toBeLessThan(limit + 100)
})

const HALF = MAX_SHELL_OUTPUT / 2
// What `seq 1 400000` writes: 2,688,895 bytes.
const SEQ = Buffer.from(Array.from({ length: 400_000 }, (_, i) => `${i + 1}\n`).join(""))

/** The result of a shell call that wrote `stdout` and `stderr` and exited `exit`, as `run` keeps it for the shell
 *  tool: each stream's first and last HALF bytes and its byte count. */
function shellResult(stdout: Buffer, stderr: Buffer, exit = 0): Result {
  const tail = (data: Buffer) => data.subarray(Math.max(HALF, data.length - HALF))
  return {
    exit,
    stdout: stdout.subarray(0, HALF),
    stderr: stderr.subarray(0, HALF),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    timedOut: false,
    interrupted: false,
    truncated: stdout.length > 2 * HALF || stderr.length > 2 * HALF,
    duration: 0,
    refused: false,
  }
}

/** The shell tool's output for the whole of `stdout` and `stderr`: stdout, then `[stderr]` and stderr when there
 *  is any; past MAX_SHELL_OUTPUT bytes only the first and last HALF, with the count cut between; then `[exit 0]`. */
function expected(stdout: Buffer, stderr: Buffer): string {
  let data = stdout
  if (stderr.length > 0) {
    const sep = stdout.length === 0 || stdout.at(-1) === 0x0a ? "" : "\n"
    data = Buffer.concat([stdout, Buffer.from(sep + "[stderr]\n"), stderr])
  }
  const text =
    data.length <= MAX_SHELL_OUTPUT
      ? data.toString()
      : `${data.subarray(0, HALF)}\n[${data.length - 2 * HALF} bytes of output cut]\n${data.subarray(data.length - HALF)}`
  return text + (text === "" || text.endsWith("\n") ? "" : "\n") + "[exit 0]"
}

/** `n` bytes of numbered lines, ending in a newline unless `open`. */
function lines(n: number, open = false): Buffer {
  let text = ""
  for (let i = 0; text.length < n; i++) text += `line ${i}\n`
  return Buffer.from(text.slice(0, n - 1) + (open ? "x" : "\n"))
}

test("shellOutput keeps output under the limit whole", () => {
  for (const [stdout, stderr] of [
    [lines(40 * 1024), Buffer.alloc(0)],
    [lines(MAX_SHELL_OUTPUT), Buffer.alloc(0)],
    [lines(40_000), lines(25_000)],
  ]) {
    const out = shellOutput(shellResult(stdout!, stderr!), 120)
    expect(out).toBe(expected(stdout!, stderr!))
    expect(out).not.toContain("bytes of output cut")
  }
})

test("shellOutput cuts the middle of combined output past the limit, counting exactly", () => {
  const out = shellOutput(shellResult(lines(40 * 1024), lines(40 * 1024)), 120)
  expect(out).toBe(expected(lines(40 * 1024), lines(40 * 1024)))
  expect(out).toContain(`\n[${40 * 1024 + 9 + 40 * 1024 - MAX_SHELL_OUTPUT} bytes of output cut]\n`)
  expect(shellOutput(shellResult(lines(MAX_SHELL_OUTPUT + 1), Buffer.alloc(0)), 120)).toContain(
    "\n[1 bytes of output cut]\n",
  )
})

test("shellOutput starts with [stderr] when only stderr has output", () => {
  const out = shellOutput(shellResult(Buffer.alloc(0), Buffer.from("oops\n"), 1), 120)
  expect(out).toBe("[stderr]\noops\n[exit 1]")
})

test("shellOutput takes the separator from the last byte of stdout, in its tail", () => {
  for (const stdout of [lines(50_000, true), lines(3 * 1024 * 1024, true)]) {
    const out = shellOutput(shellResult(stdout, Buffer.from("E\n")), 120)
    expect(out).toBe(expected(stdout, Buffer.from("E\n")))
    expect(out.endsWith("x\n[stderr]\nE\n[exit 0]")).toBe(true)
  }
})

test("shellOutput marks stderr exactly when the call wrote to it", () => {
  expect(shellOutput(shellResult(Buffer.from("out\n"), Buffer.alloc(0)), 120)).toBe("out\n[exit 0]")
  expect(shellOutput(shellResult(Buffer.from("out\n"), Buffer.from("\n")), 120)).toBe("out\n[stderr]\n\n[exit 0]")
})

test("shellOutput keeps the real end and count of output over 1 MiB", () => {
  expect(SEQ.length).toBe(2_688_895)
  const cases: [string, Buffer, Buffer, number, string][] = [
    // seq 1 400000; echo FINAL_LINE
    ["stdout", Buffer.concat([SEQ, Buffer.from("FINAL_LINE\n")]), Buffer.alloc(0), 2_623_370, "400000\nFINAL_LINE\n[exit 0]"],
    // seq 1 400000 >&2; echo FINAL_ERR >&2
    ["stderr", Buffer.alloc(0), Buffer.concat([SEQ, Buffer.from("FINAL_ERR\n")]), 2_623_378, "400000\nFINAL_ERR\n[exit 0]"],
    // seq 1 400000; seq 1 400000 >&2; echo FINAL_LINE >&2
    ["both", SEQ, Buffer.concat([SEQ, Buffer.from("FINAL_LINE\n")]), 5_312_274, "400000\nFINAL_LINE\n[exit 0]"],
    // seq 1 400000; echo TAIL_ERR >&2
    ["mixed", SEQ, Buffer.from("TAIL_ERR\n"), 2_623_377, "400000\n[stderr]\nTAIL_ERR\n[exit 0]"],
  ]
  for (const [name, stdout, stderr, cut, end] of cases) {
    const out = shellOutput(shellResult(stdout, stderr), 120)
    expect(out, name).toBe(expected(stdout, stderr))
    expect(out, name).toContain(`\n[${cut} bytes of output cut]\n`)
    expect(out.endsWith(end), name).toBe(true)
    expect(out, name).not.toContain("[output truncated]")
  }
})

test.skipIf(!sandboxAvailable())("shell output over 1 MiB keeps its real end and an exact cut count", async () => {
  // `seq 1 400000` writes 2,688,895 bytes; each count is the combined output's length less MAX_SHELL_OUTPUT.
  const cases: [string, number, string][] = [
    ["seq 1 400000; echo FINAL_LINE", 2_623_370, "400000\nFINAL_LINE\n[exit 0]"],
    ["seq 1 400000 >&2; echo FINAL_ERR >&2; exit 3", 2_623_378, "400000\nFINAL_ERR\n[exit 3]"],
    ["seq 1 400000; seq 1 400000 >&2; echo FINAL_LINE >&2", 5_312_274, "400000\nFINAL_LINE\n[exit 0]"],
    ["seq 1 400000; echo TAIL_ERR >&2", 2_623_377, "400000\n[stderr]\nTAIL_ERR\n[exit 0]"],
  ]
  const { tools: t } = tools()
  for (const [command, cut, end] of cases) {
    const out = (await t.call("shell", { command })).output
    expect(out.startsWith(command.startsWith("seq 1 400000 >&2") ? "[stderr]\n1\n2\n" : "1\n2\n"), command).toBe(true)
    expect(out, command).toContain(`\n[${cut} bytes of output cut]\n`)
    expect(out.endsWith(end), command).toBe(true)
    expect(out, command).not.toContain("[output truncated]")
    expect(Buffer.byteLength(out), command).toBeLessThan(MAX_SHELL_OUTPUT + 100)
  }
})

test.skipIf(!sandboxAvailable())("shell timeout", async () => {
  const out = await tools().tools.call("shell", { command: "sleep 30", timeout: 1 })
  expect(out.output.endsWith("[timed out after 1s]")).toBe(true)
  expect(out.audit.exit).toBeNull()
})

test.skipIf(!sandboxAvailable())("interrupt kills a running call", async () => {
  const { tools: t } = tools()
  setTimeout(() => t.interrupt(), 500)
  const start = performance.now()
  const out = await t.call("shell", { command: "sleep 30" })
  expect(out.output.endsWith("[interrupted]")).toBe(true)
  expect(out.audit.exit).toBeNull()
  expect(performance.now() - start).toBeLessThan(10_000)
  // The next call is unaffected.
  expect((await t.call("shell", { command: "echo ok" })).output).toBe("ok\n[exit 0]")
})

test.skipIf(!sandboxAvailable())("read only workspace", async () => {
  const { tools: t, ws } = tools({ policy: { writable: false } })
  fs.writeFileSync(path.join(ws, "f.txt"), "keep")
  expect((await t.call("read_file", { path: "f.txt" })).output).toBe("keep")
  expect((await t.call("write_file", { path: "f.txt", content: "x" })).output.startsWith("error:")).toBe(true)
  expect((await t.call("edit_file", { path: "f.txt", old: "keep", new: "x" })).output.startsWith("error:")).toBe(true)
  expect(fs.readFileSync(path.join(ws, "f.txt"), "utf8")).toBe("keep")
})

test.skipIf(!sandboxAvailable())("every tool returns an audit record", async () => {
  const { tools: t } = tools()
  const calls: Record<string, Record<string, unknown>> = {
    write_file: { path: "f.txt", content: "y".repeat(500) },
    read_file: { path: "f.txt" },
    edit_file: { path: "f.txt", old: "y".repeat(500), new: "z" },
    list: { path: "." },
    search: { pattern: "z" },
    shell: { command: "true" },
  }
  expect(new Set(Object.keys(calls))).toEqual(new Set(TOOL_NAMES))
  for (const [name, args] of Object.entries(calls)) {
    const out = await t.call(name, args)
    expect(typeof out.output).toBe("string")
    expect(out.audit.tool).toBe(name)
    expect(out.audit.exit).toBe(0)
    expect(out.audit.duration).toBeGreaterThan(0)
  }
  const summary = (await t.call("write_file", calls.write_file!)).audit.argsSummary
  expect(summary).toBe("path='f.txt' content=<500 chars>")
})

test("unknown tool", async () => {
  const { tools: t } = tools()
  await expect(t.call("rm", {})).rejects.toThrow(RangeError)
  await expect(t.call("rm", {})).rejects.toThrow(/unknown workspace tool/)
  await expect(t.call("constructor", {})).rejects.toThrow(/unknown workspace tool 'constructor'/)
})

test.each([
  ["missing path", {}, "missing a required argument: 'path'"],
  ["unexpected mode", { path: "f.txt", mode: "x" }, "got an unexpected keyword argument 'mode'"],
])("bad arguments come back as text [%s]", async (_shown, args, message) => {
  const out = await tools().tools.call("read_file", args)
  expect(out.output).toBe(`error: read_file: ${message}`)
  expect(out.audit.tool).toBe("read_file")
  expect(out.audit.exit).toBeNull()
  expect(out.audit.duration).toBe(0)
})

test("composer accepts the tool functions", async () => {
  const seen: [string, Record<string, unknown>][] = []
  const call: WorkspaceCall = async (n, a) => {
    seen.push([n, a])
    return "ok"
  }
  const fns = workspaceToolFunctions(call)
  expect(Object.keys(fns)).toEqual([...TOOL_NAMES])
  // The functions fill defaults themselves.
  expect(await fns.list!.call({})).toBe("ok")
  expect(seen).toEqual([["list", { path: "." }]])
  seen.length = 0
  const toolset = await workerToolSet(call)
  const resolved = toolset.resolve([...TOOL_NAMES])
  const schemas = Object.fromEntries(
    resolved.map((t) => [t.name, new Set(Object.keys(t.parametersJsonSchema.properties as object))]),
  )
  expect(schemas).toEqual({
    read_file: new Set(["path", "offset", "limit"]),
    write_file: new Set(["path", "content"]),
    edit_file: new Set(["path", "old", "new", "replace_all"]),
    list: new Set(["path"]),
    search: new Set(["pattern", "path", "glob"]),
    shell: new Set(["command", "timeout"]),
  })
  expect(resolved.map((t) => t.description)).toEqual(TOOL_NAMES.map((n) => fns[n]!.description))
  expect(await toolset.invoke("list", {}, { callId: "r1/n/1/0" })).toBe("ok")
  expect(seen).toEqual([["list", { path: "." }]])
})

test.skipIf(!sandboxAvailable())("tool functions drive workspace tools", async () => {
  const { tools: t } = tools()
  const toolset = await workerToolSet(async (n, a, o) => (await t.call(n, a, o)).output)
  expect(await toolset.invoke("write_file", { path: "n.txt", content: "hi" }, { callId: "r1/n/1/0" })).toBe(
    "wrote 2 bytes to n.txt",
  )
  expect(await toolset.invoke("shell", { command: "cat n.txt" }, { callId: "r1/n/1/1" })).toBe("hi\n[exit 0]")
})

test.skipIf(!sandboxAvailable())("a call aborted by its signal ends as interrupted", async () => {
  const start = performance.now()
  const out = await tools().tools.call("shell", { command: "sleep 30" }, { signal: AbortSignal.timeout(500) })
  expect(out.output.endsWith("[interrupted]")).toBe(true)
  expect(out.audit.exit).toBeNull()
  expect(performance.now() - start).toBeLessThan(10_000)
})

test.skipIf(!sandboxAvailable())("a running call is recorded in workers until it ends", async () => {
  const { tools: t, store } = tools()
  const call = t.call("shell", { command: "sleep 30" })
  let out
  try {
    const row = await waitFor(() => store.listWorkers().find((w) => w.key.startsWith("call:")), {
      timeout: 10_000,
      what: "a call: row",
    })
    expect(row.pgid).toBe(row.pid)
    expect(row.startTime).toBeGreaterThan(0)
  } finally {
    // Awaited even when a check fails, so the store isn't closed while run() still removes the row.
    t.interrupt()
    out = await call
  }
  expect(out.output.endsWith("[interrupted]")).toBe(true)
  expect(store.listWorkers()).toEqual([])
})

test("shell arguments of the wrong type come back as text", async () => {
  const { tools: t } = tools()
  const cases: [Record<string, unknown>, string][] = [
    [{ command: 1 }, "error: shell: argument 'command' must be a string"],
    [{ command: "true", timeout: "5" }, "error: shell: argument 'timeout' must be a number"],
    [{ command: "true", timeout: NaN }, "error: shell: argument 'timeout' must be a number"],
  ]
  for (const [args, output] of cases) {
    const out = await t.call("shell", args)
    expect(out.output).toBe(output)
    expect(out.audit.exit).toBeNull()
  }
})

test.skipIf(!sandboxAvailable())("shell calls run without the helper profile and env", async () => {
  // The real helper: a stand-in entry would be unreadable anyway and prove nothing.
  const { helper } = helperCommand()
  const { tools: t } = tools({ policy: { helper } })
  const env = (await t.call("shell", { command: "env" })).output
  expect(env.endsWith("[exit 0]")).toBe(true)
  expect(env).not.toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH")
  if ("bun" in helper) {
    // The plain profile doesn't expose the helper's files: Seatbelt denies the read; bwrap doesn't mount them.
    expect(fs.existsSync(helper.entry)).toBe(true)
    const quoted = "'" + helper.entry.replaceAll("'", "'\\''") + "'"
    const cat = (await t.call("shell", { command: `cat ${quoted}` })).output
    expect(cat).toContain(process.platform === "darwin" ? "Operation not permitted" : "No such file or directory")
    expect(cat.endsWith("[exit 0]")).toBe(false)
  }
  // A file op still runs the helper under its own profile.
  const listing = await t.call("list", { path: "." })
  expect(listing.output).toBe("(empty)")
  expect(listing.audit.exit).toBe(0)
})

test("the workspace tool specs equal the saved copy", () => {
  const golden = JSON.parse(fs.readFileSync(new URL("../fixtures/tool_specs.json", import.meta.url), "utf8"))
  const specs = groupSpecs({ workspace: workspaceToolFunctions(async () => "") }).workspace
  expect(JSON.stringify(specs, null, 2)).toBe(JSON.stringify(golden.workspace, null, 2))
})
