/** The workspace tool group: the file tools, each call audited and none gated; and the pipes the terminal runs an
 *  employee's commands through, under the workspace's shell policy, each call tracked for the reaper. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import type { ToolOutcome } from "../../src/runtime/permissions/monitor.ts"
import { helperCommand } from "../../src/platform.ts"
import { TOOL_NAMES, tools as workspaceGroup, WorkspaceTools } from "../../src/tools/workspace.ts"
import { makeMonitor } from "../runtime/permissions/helpers.ts"
import { makePolicy, sandboxAvailable } from "../runtime/sandbox/helpers.ts"
import { openStore, session, tempDir } from "./helpers.ts"
import { waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

/** Workspace tools over a fresh, writable (unless `writable` is false) workspace, `helper` given to its policy. */
function workspaceTools({ writable = true, helper }: { writable?: boolean; helper?: ReturnType<typeof helperCommand>["helper"] } = {}) {
  const { ws, tmp, root, make } = makePolicy()
  const store = openStore()
  return { tools: new WorkspaceTools(make({ writable, helper }), { officeHome: tempDir(), store }), ws, tmp, root, store }
}

test("the workspace group is the file tools, with no shell", async () => {
  const { monitor, store } = await makeMonitor()
  const calls: string[] = []
  const workspace = {
    call: async (name: string): Promise<ToolOutcome> => {
      calls.push(name)
      return { output: "ok", audit: { tool: name, argsSummary: "", exit: 0, duration: 0 } }
    },
  }
  const group = workspaceGroup({ monitor, workspace, session: session({ person: "minh" }), runId: "r1" })
  expect(Object.keys(group)).toEqual(["read_file", "write_file", "edit_file", "list", "search"])
  expect(Object.keys(group)).toEqual([...TOOL_NAMES])
  expect(await group.list!.call({}, { callId: "r1/chat#0/reply/0/0" })).toBe("ok")
  expect(calls).toEqual(["list"])
  expect(store.listAudit().map((r) => [r.tool, r.outcome])).toEqual([["list", "ok"]])
  // A side chat's read-only group.
  expect(Object.keys(workspaceGroup({ monitor, workspace, session: session(), readOnly: true }))).toEqual([
    "read_file",
    "list",
    "search",
  ])
  const { tools } = workspaceTools()
  await expect(tools.call("shell", { command: "ls" })).rejects.toThrow("unknown workspace tool 'shell'")
})

test("pipes are the workspace's sandbox, without the file helper, for the terminal's pipes shell", () => {
  const { helper } = helperCommand()
  const { tools, ws, tmp } = workspaceTools({ writable: false, helper })
  const pipes = tools.pipes()
  expect(pipes.kind).toBe("pipes")
  expect([pipes.sandbox.workspace, pipes.sandbox.tmpdir, pipes.sandbox.writable, pipes.sandbox.helper]).toEqual([
    ws,
    tmp,
    false,
    undefined,
  ])
})

test.skipIf(!sandboxAvailable())("pipes runs each command under the shell policy, tracked for the reaper while it runs", async () => {
  const { helper } = helperCommand()
  const { tools, ws, root, store } = workspaceTools({ helper })
  const pipes = tools.pipes()
  const outside = path.join(root, "escaped.txt")
  const argv = ["/bin/sh", "-c", `echo in > inside.txt; echo out > ${outside}; env`]
  const ran = await pipes.run(argv, { timeout: 30, maxOutput: 64 * 1024 })
  expect(ran.exit).toBe(0)
  expect(fs.readFileSync(path.join(ws, "inside.txt"), "utf8")).toBe("in\n")
  expect(fs.existsSync(outside)).toBe(false)
  // The shell policy: none of the file helper's env.
  expect(ran.stdout.toString()).not.toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH")
  const stop = new AbortController()
  const sleeping = pipes.run(["/bin/sh", "-c", "sleep 30.53"], { timeout: 60, maxOutput: 0, signal: stop.signal })
  let ended
  try {
    const row = await waitFor(() => store.listWorkers().find((w) => w.key.startsWith("call:")), {
      timeout: 10_000,
      what: "a call: row",
    })
    expect(row.pgid).toBe(row.pid)
    expect(row.startTime).toBeGreaterThan(0)
  } finally {
    // Awaited even when a check fails, so the store isn't closed while run() still removes the row.
    stop.abort()
    ended = await sleeping
  }
  expect(ended.interrupted).toBe(true)
  expect(store.listWorkers()).toEqual([])
})
