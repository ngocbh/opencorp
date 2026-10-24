/** Every workspace call goes through the monitor for its audit row. */
import { expect, setDefaultTimeout, test } from "bun:test"
import { DETAIL_CHARS } from "../../src/perm/redact.ts"
import { type ToolOutcome, workspaceToolFunctions, WorkspaceTools } from "../../src/tools/workspace.ts"
import { tempDir } from "../helpers.ts"
import { makePolicy, sandboxAvailable } from "../sandbox/helpers.ts"
import { makeMonitor } from "./helpers.ts"

setDefaultTimeout(30_000)

/** The error Python's test raises, named as Python names it. */
class OSError extends Error {
  override name = "OSError"
}

class StubTools {
  readonly calls: [string, Record<string, unknown>][] = []

  constructor(
    readonly outcome: ToolOutcome | null = null,
    readonly error: Error | null = null,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push([name, args])
    if (this.error) throw this.error
    return this.outcome!
  }
}

function outcome(output: string, tool: string, argsSummary: string, exit: number | null, duration: number) {
  return new StubTools({ output, audit: { tool, argsSummary, exit, duration } })
}

test("each call writes one row and returns the output", async () => {
  const { monitor, store } = await makeMonitor()
  const call = monitor.workspace(outcome("x = 1\n", "read_file", "path=a.py", 0, 0.012), "minh", "r1", {
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
    await monitor.workspace(outcome(output, "shell", "command=x", exit, duration), "minh", "r1")("shell", {})
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
  const call = monitor.workspace(new StubTools(null, error), "minh", "r1")
  await expect(call("shell", { command: "ls" })).rejects.toBe(error)
  const rows = store.listAudit()
  expect(rows).toHaveLength(1)
  expect([rows[0]!.outcome, rows[0]!.detail]).toEqual(["error", "OSError: sandbox-exec missing"])
})

test.skipIf(!sandboxAvailable())("real sandboxed calls are audited", async () => {
  const { monitor, store } = await makeMonitor()
  const { make } = makePolicy()
  const tools = new WorkspaceTools(make(), { officeHome: tempDir(), store })
  const fns = workspaceToolFunctions(monitor.workspace(tools, "minh", "r1"))
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
  await monitor.workspace(outcome(`partial\n${line}`, "shell", "command=x", null, 1), "minh", "r1")("shell", {})
  const huge = new Error("e".repeat(5000))
  const raising = monitor.workspace(new StubTools(null, huge), "minh", "r1")
  await expect(raising("shell", {})).rejects.toBe(huge)
  const [killed, raised] = store.listAudit()
  const reason = killed!.detail!.slice(killed!.detail!.indexOf(": ") + 2)
  expect(reason).toBe([...line].slice(0, 200).join(""))
  expect(raised!.detail!.length).toBeLessThanOrEqual(DETAIL_CHARS)
  expect(raised!.detail!.startsWith("Error: e")).toBe(true)
})
