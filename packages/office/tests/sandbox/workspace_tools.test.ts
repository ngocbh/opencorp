/** The workspace tools, each call one sandboxed process (Python's `tests/sandbox/test_workspace_tools.py`). */
import fs from "node:fs"
import path from "node:path"
import { ToolSet } from "@ngocbh/yian/tools"
import { expect, setDefaultTimeout, test } from "bun:test"
import { helperCommand } from "../../src/platform.ts"
import {
  MAX_SHELL_OUTPUT,
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
  expect(await toolset.invoke("list", {})).toBe("ok")
  expect(seen).toEqual([["list", { path: "." }]])
})

test.skipIf(!sandboxAvailable())("tool functions drive workspace tools", async () => {
  const { tools: t } = tools()
  const toolset = await workerToolSet(async (n, a, o) => (await t.call(n, a, o)).output)
  expect(await toolset.invoke("write_file", { path: "n.txt", content: "hi" })).toBe("wrote 2 bytes to n.txt")
  expect(await toolset.invoke("shell", { command: "cat n.txt" })).toBe("hi\n[exit 0]")
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
