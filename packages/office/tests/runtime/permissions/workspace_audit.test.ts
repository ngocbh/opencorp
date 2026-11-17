/** Every workspace call goes through the monitor for its audit row. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { isPending, pending } from "@ngocbh/yian/tools"
import { NO_PERMISSIONS, type ToolOutcome } from "../../../src/runtime/permissions/monitor.ts"
import type { ApprovalCard, Mode, Permissions, Rule, Verdict } from "../../../src/runtime/permissions/policy.ts"
import { DETAIL_CHARS } from "../../../src/util/redact.ts"
import { workspaceToolFunctions, WorkspaceTools } from "../../../src/tools/workspace.ts"
import { tempDir } from "../../helpers.ts"
import { makePolicy, sandboxAvailable } from "../sandbox/helpers.ts"
import { makeMonitor } from "./helpers.ts"

setDefaultTimeout(30_000)

/** The error Python's test raises, named as Python names it. */
class OSError extends Error {
  override name = "OSError"
}

class StubTools {
  readonly calls: [string, Record<string, unknown>][] = []
  /** The controllers tracked now, which `interrupt` aborts. */
  readonly tracked = new Set<AbortController>()

  constructor(
    readonly outcome: ToolOutcome | null = null,
    readonly error: Error | null = null,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push([name, args])
    if (this.error) throw this.error
    return this.outcome!
  }

  track(controller: AbortController): () => void {
    this.tracked.add(controller)
    return () => this.tracked.delete(controller)
  }

  interrupt(): void {
    for (const controller of this.tracked) controller.abort()
  }
}

function stubReturning(output: string, tool: string, argsSummary: string, exit: number | null, duration: number) {
  return new StubTools({ output, audit: { tool, argsSummary, exit, duration } })
}

test("each call writes one row and returns the output", async () => {
  const { monitor, store } = await makeMonitor()
  const call = monitor.workspace(stubReturning("x = 1\n", "read_file", "path=a.py", 0, 0.012), "minh", "r1", {
    sessionId: "s1",
  })
  expect(await workspaceToolFunctions(call).read_file!.call({ path: "a.py" })).toBe("x = 1\n")
  const rows = store.listAudit()
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect([row.kind, row.tool, row.args, row.outcome, row.detail, row.runId, row.sessionId]).toEqual([
    "workspace",
    "read_file",
    { summary: "path=a.py" },
    "ok",
    "exit=0 duration=0.012s",
    "r1",
    "s1",
  ])
})

test("failed and killed calls are errors and killed ones say why", async () => {
  const { monitor, store } = await makeMonitor()
  const cases: [string, number | null, number][] = [
    ["boom\n[exit 1]", 1, 0.1],
    ["partial\n[timed out after 5s]", null, 5],
    ["[interrupted]", null, 0.5],
    ["error: shell: missing a required argument: 'command'", null, 0],
  ]
  for (const [output, exit, duration] of cases) {
    const tools = stubReturning(output, "shell", "command=x", exit, duration)
    await monitor.workspace(tools, "minh", "r1", { permissions: bound() })("shell", {})
  }
  expect(store.listAudit().map((r) => [r.outcome, r.detail])).toEqual([
    ["error", "exit=1 duration=0.100s"],
    ["error", "exit=None duration=5.000s: [timed out after 5s]"],
    ["error", "exit=None duration=0.500s: [interrupted]"],
    ["error", "exit=None duration=0.000s: error: shell: missing a required argument: 'command'"],
  ])
})

test("a call that raises is audited then raised", async () => {
  const { monitor, store } = await makeMonitor()
  const error = new OSError("sandbox-exec missing")
  const call = monitor.workspace(new StubTools(null, error), "minh", "r1", { permissions: bound() })
  await expect(call("shell", { command: "ls" })).rejects.toBe(error)
  const rows = store.listAudit()
  expect(rows).toHaveLength(1)
  expect([rows[0]!.outcome, rows[0]!.detail]).toEqual(["error", "OSError: sandbox-exec missing"])
})

test.skipIf(!sandboxAvailable())("real sandboxed calls are audited", async () => {
  const { monitor, store } = await makeMonitor()
  const { make } = makePolicy()
  const tools = new WorkspaceTools(make(), { officeHome: tempDir(), store })
  const fns = workspaceToolFunctions(monitor.workspace(tools, "minh", "r1", { permissions: bound() }))
  expect(await fns.write_file!.call({ path: "a.txt", content: "hi\n" })).toBe("wrote 3 bytes to a.txt")
  expect(await fns.shell!.call({ command: "cat a.txt" })).toContain("hi")
  expect(store.listAudit().map((r) => [r.tool, r.outcome])).toEqual([
    ["write_file", "ok"],
    ["shell", "ok"],
  ])
})

test("killed reasons and raised details are capped", async () => {
  const { monitor, store } = await makeMonitor()
  const line = "😀" + "x".repeat(499)
  const cut = stubReturning(`partial\n${line}`, "shell", "command=x", null, 1)
  await monitor.workspace(cut, "minh", "r1", { permissions: bound() })("shell", {})
  const huge = new Error("e".repeat(5000))
  const raising = monitor.workspace(new StubTools(null, huge), "minh", "r1", { permissions: bound() })
  await expect(raising("shell", {})).rejects.toBe(huge)
  const [killed, raised] = store.listAudit()
  const reason = killed!.detail!.slice(killed!.detail!.indexOf(": ") + 2)
  expect(reason).toBe([...line].slice(0, 200).join(""))
  expect(raised!.detail!.length).toBeLessThanOrEqual(DETAIL_CHARS)
  expect(raised!.detail!.startsWith("Error: e")).toBe(true)
})

/** A session's permissions as a host binds them, in `mode` with `rules`, Auto's check `check` if given; `held` gets
 *  each card the gate holds, with its call id, and the hold replies pending. */
function permissions({ mode = "default", rules = [], check }: { mode?: Mode; rules?: Rule[]; check?: Permissions["check"] } = {}) {
  const held: { card: ApprovalCard; callId: string }[] = []
  const perms: Permissions = {
    mode: () => mode,
    rules: () => rules,
    where: () => ({ profile: "workspace", cwd: "/w", writable: ["/w"] }),
    hold: (card, callId) => {
      held.push({ card, callId })
      return pending()
    },
    ...(check === undefined ? {} : { check }),
  }
  return { perms, held }
}

/** Permissions in auto that hold nothing and check nothing: a shell call with no command never reaches them. */
function bound(): Permissions {
  return permissions({ mode: "auto" }).perms
}

/** Permissions that ask for everything and must never hold or check. */
function neverAsked(): Permissions {
  return {
    mode: () => "ask",
    rules: () => [],
    where: () => ({ profile: "workspace", cwd: "/w", writable: ["/w"] }),
    hold: () => {
      throw new Error("nothing is held")
    },
    check: () => {
      throw new Error("nothing is checked")
    },
  }
}

const CALL = "r1/chat#0/reply/0/0"

test("a gated shell call runs when its permissions allow it, audited ok with why it ran", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("a.py\n[exit 0]", "shell", "command='ls'", 0, 0.012)
  const { perms, held } = permissions()
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: perms })
  expect(await call("shell", { command: "ls", timeout: null }, { callId: CALL })).toBe("a.py\n[exit 0]")
  expect(tools.calls).toEqual([["shell", { command: "ls", timeout: null }]])
  expect(held).toEqual([])
  expect(store.listAudit().map((r) => [r.kind, r.tool, r.outcome, r.detail])).toEqual([
    ["workspace", "shell", "ok", "exit=0 duration=0.012s by read-only"],
  ])
  expect(tools.tracked.size).toBe(0)
})

test("a refused shell call never runs, and its audit row says denied with the rule", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("", "shell", "", 0, 0)
  const { perms, held } = permissions({ mode: "auto", rules: [{ effect: "deny", kind: "command", pattern: "rm *" }] })
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: perms })
  expect(await call("shell", { command: "rm -rf build", timeout: null }, { callId: CALL })).toBe(
    "Not run: a deny rule: rm *.",
  )
  expect(tools.calls).toEqual([])
  expect(held).toEqual([])
  const rows = store.listAudit()
  expect(rows.map((r) => [r.kind, r.tool, r.args, r.outcome])).toEqual([
    ["workspace", "shell", { summary: "command='rm -rf build'" }, "denied"],
  ])
  expect(rows[0]!.detail).toContain("a deny rule: rm *")
})

test("a call the check judges gets a check row with its verdict and reason, then its own row", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("built\n[exit 0]", "shell", "command='make'", 0, 1.5)
  const judged: string[] = []
  // The host's check records its verdict before it answers, as the office's does.
  const check = async (input: { command: string }): Promise<Verdict> => {
    judged.push(input.command)
    store.recordAudit({ person: "minh", kind: "check", tool: "classify_command", args: {}, outcome: "run", detail: "builds" })
    return { verdict: "run", reason: "builds the project" }
  }
  const { perms } = permissions({ mode: "auto", check })
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: perms })
  expect(await call("shell", { command: "make", timeout: null }, { callId: CALL })).toBe("built\n[exit 0]")
  expect(judged).toEqual(["make"])
  expect(store.listAudit().map((r) => [r.kind, r.outcome, r.detail])).toEqual([
    ["check", "run", "builds"],
    ["workspace", "ok", "exit=0 duration=1.500s by Auto's check: builds the project"],
  ])
})

test("a held shell call returns pending, never runs, and its audit row says held", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("", "shell", "", 0, 0)
  const { perms, held } = permissions({ mode: "ask" })
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: perms })
  expect(isPending(await call("shell", { command: "ls", timeout: null }, { callId: CALL }))).toBe(true)
  expect(tools.calls).toEqual([])
  expect(held.map(({ card, callId }) => [card.tool, card.action, card.args, card.why, card.reason, callId])).toEqual([
    ["shell", "ls", { command: "ls", timeout: null }, "", "Ask mode", CALL],
  ])
  expect(store.listAudit().map((r) => [r.tool, r.args, r.outcome, r.detail, r.runId, r.sessionId])).toEqual([
    ["shell", { summary: "command='ls'" }, "held", "Ask mode", "r1", "s1"],
  ])
})

test("an approved run skips the gate, and its audit row names who approved it", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("a.py\n[exit 0]", "shell", "command='ls'", 0, 0.012)
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: neverAsked() })
  const out = await call("shell", { command: "ls", timeout: null }, { approved: "approved by @ngocbh", detached: true })
  expect(out).toBe("a.py\n[exit 0]")
  expect(tools.calls).toHaveLength(1)
  expect(store.listAudit().map((r) => [r.outcome, r.detail])).toEqual([
    ["ok", "exit=0 duration=0.012s approved by @ngocbh"],
  ])
})

test("the gate's signal is the workspace's: an interrupt while Auto's check runs aborts the check, and the command never starts", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("built\n[exit 0]", "shell", "command='make'", 0, 1)
  let entered!: () => void
  const checking = new Promise<void>((resolve) => (entered = resolve))
  let aborted = false
  const check = (_input: unknown, signal: AbortSignal) =>
    new Promise<Verdict>((_resolve, reject) => {
      entered()
      signal.addEventListener("abort", () => {
        aborted = true
        reject(signal.reason)
      })
    })
  const { perms, held } = permissions({ mode: "auto", check })
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1", permissions: perms })
  const result = call("shell", { command: "make", timeout: null }, { callId: CALL })
  await checking
  expect(tools.tracked.size).toBe(1)
  tools.interrupt()
  expect(await result).toBe("Not run: stopped before Auto's check finished.")
  expect(aborted).toBe(true)
  expect(tools.calls).toEqual([])
  expect(held).toEqual([])
  expect(store.listAudit()).toEqual([])
  expect(tools.tracked.size).toBe(0)
})

test("a shell call with no permissions bound is refused, never run ungated", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("ok", "read_file", "path='a.py'", 0, 0)
  const call = monitor.workspace(tools, "minh", "r1", { sessionId: "s1" })
  expect(await call("shell", { command: "ls", timeout: null }, { callId: CALL })).toBe(NO_PERMISSIONS)
  expect(await call("shell", {}, { callId: CALL })).toBe(NO_PERMISSIONS)
  expect(tools.calls).toEqual([])
  expect(store.listAudit().map((r) => [r.tool, r.outcome, r.detail])).toEqual([
    ["shell", "denied", NO_PERMISSIONS],
    ["shell", "denied", NO_PERMISSIONS],
  ])
  // The file tools need none.
  expect(await call("read_file", { path: "a.py" })).toBe("ok")
})

test("the file tools never ask", async () => {
  const { monitor, store } = await makeMonitor()
  const tools = stubReturning("ok", "read_file", "path='a.py'", 0, 0)
  const fns = workspaceToolFunctions(monitor.workspace(tools, "minh", "r1", { permissions: neverAsked() }))
  await fns.read_file!.call({ path: "a.py" }, { callId: CALL })
  await fns.write_file!.call({ path: "a.py", content: "x" }, { callId: CALL })
  await fns.edit_file!.call({ path: "a.py", old: "x", new: "y" }, { callId: CALL })
  await fns.list!.call({}, { callId: CALL })
  await fns.search!.call({ pattern: "x" }, { callId: CALL })
  expect(tools.calls.map(([name]) => name)).toEqual(["read_file", "write_file", "edit_file", "list", "search"])
  expect(store.listAudit().map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "ok", "ok"])
})
