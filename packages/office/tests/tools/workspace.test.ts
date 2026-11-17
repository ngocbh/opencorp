/** The workspace tool group: its shell call reaches the gate with its call id, a gate's check is tracked by the
 *  workspace's interrupt, an approved call runs detached from it, and the shell's profile is its sandbox's. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { isPending, pending } from "@ngocbh/yian/tools"
import type { ToolOutcome } from "../../src/runtime/permissions/monitor.ts"
import type { ApprovalCard, Permissions } from "../../src/runtime/permissions/policy.ts"
import type { ToolCallOptions } from "../../src/runtime/worker/rpc.ts"
import { tools as workspaceGroup, WorkspaceTools } from "../../src/tools/workspace.ts"
import { makeMonitor } from "../runtime/permissions/helpers.ts"
import { makePolicy, sandboxAvailable } from "../runtime/sandbox/helpers.ts"
import { openStore, session, tempDir } from "./helpers.ts"
import { waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

/** Workspace tools over a fresh, writable (unless `writable` is false) workspace. */
function workspaceTools({ writable = true }: { writable?: boolean } = {}) {
  const { ws, tmp, make } = makePolicy()
  const store = openStore()
  return { tools: new WorkspaceTools(make({ writable }), { officeHome: tempDir(), store }), ws, tmp, store }
}

test("the model's shell call takes its call id to the gate", async () => {
  const { monitor } = await makeMonitor()
  const held: { card: ApprovalCard; callId: string }[] = []
  const permissions: Permissions = {
    mode: () => "ask",
    rules: () => [],
    where: () => ({ profile: "workspace", cwd: "/w", writable: ["/w"] }),
    hold: (card, callId) => {
      held.push({ card, callId })
      return pending()
    },
  }
  const calls: string[] = []
  const workspace = {
    call: async (name: string): Promise<ToolOutcome> => {
      calls.push(name)
      return { output: "ok", audit: { tool: name, argsSummary: "", exit: 0, duration: 0 } }
    },
    track: () => () => {},
  }
  const group = workspaceGroup({ monitor, workspace, session: session({ person: "minh" }), runId: "r1", permissions })
  const callId = "r1/chat#0/reply/0/0"
  expect(isPending(await group.shell!.call({ command: "ls" }, { callId }))).toBe(true)
  expect(held.map((h) => [h.card.action, h.callId])).toEqual([["ls", callId]])
  expect(calls).toEqual([])
  // A side chat's read-only group is never gated: it has no shell.
  expect(Object.keys(workspaceGroup({ monitor, workspace, session: session(), readOnly: true, permissions }))).toEqual([
    "read_file",
    "list",
    "search",
  ])
})

test("a model's call that carries the options an approved call skips the gate with is still gated", async () => {
  const { monitor } = await makeMonitor()
  const held: string[] = []
  const permissions: Permissions = {
    mode: () => "ask",
    rules: () => [],
    where: () => ({ profile: "workspace", cwd: "/w", writable: ["/w"] }),
    hold: (_card, callId) => (held.push(callId), pending()),
  }
  const calls: string[] = []
  const workspace = {
    call: async (name: string): Promise<ToolOutcome> => {
      calls.push(name)
      return { output: "ok", audit: { tool: name, argsSummary: "", exit: 0, duration: 0 } }
    },
    track: () => () => {},
  }
  const group = workspaceGroup({ monitor, workspace, session: session({ person: "minh" }), runId: "r1", permissions })
  const callId = "r1/chat#0/reply/0/0"
  const smuggled = { callId, approved: "approved by @ngocbh", detached: true } as ToolCallOptions
  expect(isPending(await group.shell!.call({ command: "ls" }, smuggled))).toBe(true)
  expect(held).toEqual([callId])
  expect(calls).toEqual([])
})

test("a tracked controller is aborted by the workspace's interrupt, and untracking removes it", () => {
  const { tools } = workspaceTools()
  const kept = new AbortController()
  tools.track(kept)
  const dropped = new AbortController()
  const untrack = tools.track(dropped)
  untrack()
  tools.interrupt()
  expect(kept.signal.aborted).toBe(true)
  expect(dropped.signal.aborted).toBe(false)
})

test.skipIf(!sandboxAvailable())("a detached call is stopped by its own signal, not by the workspace's interrupt", async () => {
  const { tools, store } = workspaceTools()
  const own = new AbortController()
  let settled = false
  const call = tools.call("shell", { command: "sleep 30.7" }, { signal: own.signal, detached: true })
  void call.then(() => (settled = true))
  try {
    await waitFor(() => store.listWorkers().some((w) => w.key.startsWith("call:")), { what: "the call to run" })
    tools.interrupt()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(settled).toBe(false)
  } finally {
    own.abort()
  }
  const out = await call
  expect(out.output.endsWith("[interrupted]")).toBe(true)
})

test("a workspace's shell runs on the workspace profile, in its folder, writing only what its sandbox lets it", () => {
  const writable = workspaceTools()
  expect(writable.tools.where()).toEqual({ profile: "workspace", cwd: writable.ws, writable: [writable.ws, writable.tmp] })
  const readOnly = workspaceTools({ writable: false })
  expect(readOnly.tools.where()).toEqual({ profile: "workspace", cwd: readOnly.ws, writable: [readOnly.tmp] })
})
