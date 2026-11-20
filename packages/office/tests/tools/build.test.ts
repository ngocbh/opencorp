/** build: the named tool groups, each with the tools a run's ToolContext can support. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { loadRepo } from "../../src/company/loader.ts"
import { Monitor } from "../../src/runtime/permissions/monitor.ts"
import { SecretStore } from "../../src/runtime/secrets.ts"
import { tools as workTools } from "../../src/tools/work.ts"
import { build, type ToolContext } from "../../src/tools/index.ts"
import { tools as toolboxTools } from "../../src/tools/toolbox.ts"
import { tools as workItemsTools } from "../../src/tools/work_items.ts"
import { READ_TOOLS, TOOL_NAMES, tools as workspaceTools } from "../../src/tools/workspace.ts"
import { Terminal } from "../../src/tools/terminal/terminal.ts"
import { TOOLS as TERMINAL_TOOLS } from "../../src/tools/terminal/tools.ts"
import { groupSpecs } from "../../src/runtime/worker/job.ts"
import { goldenPolicy } from "../runtime/sandbox/helpers.ts"
import { company, openStore, session, tempDir, workItem } from "./helpers.ts"

/** The two Monitor methods tools call, recording who each binds to. */
class FakeMonitor {
  readonly seen: unknown[][] = []

  tools(person: string, { runId = null, sessionId = null }: { runId?: string | null; sessionId?: string | null } = {}) {
    this.seen.push(["tools", person, runId, sessionId])
    return { fake__echo: { description: "Echo.", parameters: {}, call: () => "echo" } }
  }

  workspace(
    _tools: unknown,
    person: string,
    runId: string | null,
    { sessionId = null }: { sessionId?: string | null } = {},
  ) {
    this.seen.push(["workspace", person, runId, sessionId])
    return async (name: string) => `${name} ran`
  }
}

/** Stands in for `WorkspaceTools`: building tools never runs the workspace. */
const NO_WORKSPACE = {
  call: (): never => {
    throw new Error("the workspace is never called")
  },
}

/** A terminal of a workspace's pipes, as a main chat's host binds it: building tools runs no command. */
function pipesTerminal(): Terminal {
  const never = (): never => {
    throw new Error("building tools runs nothing")
  }
  const sandbox = goldenPolicy({ workspace: "/w", writable: true, network: false, tmpdir: "/tmp" })
  return new Terminal({
    shells: { kind: "pipes", sandbox, run: never },
    driver: "minh",
    permissions: { mode: () => "auto", rules: () => [], where: () => ({ profile: "workspace", cwd: null, writable: [] }), hold: never },
    shellHost: never,
  })
}

/** A run of minh on a work item they requested, with a recording monitor. */
function ctx(): ToolContext & { monitor: Monitor; session: NonNullable<ToolContext["session"]> } {
  const store = openStore()
  const item = store.createWorkItem(workItem({ requester: "minh" }))
  const s = store.createSession(session({ person: "minh", work_item_id: item.id }))
  return {
    store,
    repo: loadRepo(company()),
    session: s,
    runId: "run-1",
    onQuestion: (q) => q,
    monitor: new FakeMonitor() as unknown as Monitor,
    workspace: NO_WORKSPACE,
  }
}

test("build returns the named groups in order with their tools", () => {
  const c = { ...ctx(), terminal: pipesTerminal() }
  const groups = build(["toolbox", "workspace", "terminal", "company", "work_items"], c)
  expect(Object.entries(groups).map(([g, t]) => [g, Object.keys(t)])).toEqual([
    ["toolbox", ["fake__echo"]],
    ["workspace", [...TOOL_NAMES]],
    ["terminal", [...TERMINAL_TOOLS]],
    ["company", ["ask_manager", "create_work_item", "comment"]],
    ["work_items", ["list_work_items", "read_work_item"]],
  ])
  expect(Object.keys(build(["company", "toolbox"], c))).toEqual(["company", "toolbox"])
})

test("the terminal group is the session's terminal's tools, and empty without one", () => {
  expect(build(["terminal"], ctx())).toEqual({ terminal: {} })
  const terminal = pipesTerminal()
  const { terminal: tools } = build(["terminal"], { terminal })
  expect(Object.keys(tools!)).toEqual(["run", "type", "read", "interrupt", "close"])
  expect(tools!.run!.description).toBe(terminal.tools().run.description)
})

test("tools are bound to the runs person run and session", async () => {
  const c = ctx()
  const groups = build(["toolbox", "workspace"], c)
  expect(await groups.workspace!.read_file!.call({ path: "a.py" })).toBe("read_file ran")
  expect((c.monitor as unknown as FakeMonitor).seen).toEqual([
    ["tools", "minh", "run-1", c.session.id],
    ["workspace", "minh", "run-1", c.session.id],
  ])
})

test("a read only run gets only the read tools", () => {
  expect(Object.keys(build(["workspace"], { ...ctx(), readOnly: true }).workspace!)).toEqual([...READ_TOOLS])
})

type Field = keyof ToolContext

// Each topic's gate: the fields its builder needs to bind its tools. A field a tool needs only
// when it is called (ask_manager's onQuestion) is not part of the gate.
const GATES: Record<string, [(ctx: ToolContext) => Record<string, unknown>, Field[]]> = {
  toolbox: [toolboxTools, ["monitor", "session"]],
  workspace: [workspaceTools, ["monitor", "workspace", "session"]],
  "company.work": [workTools, ["store", "repo", "session", "runId"]],
  work_items: [workItemsTools, ["store", "session"]],
}
const FIELDS: Field[] = [
  "store",
  "repo",
  "session",
  "runId",
  "onQuestion",
  "carried",
  "monitor",
  "workspace",
  "question",
  "terminal",
]

test.each(Object.keys(GATES))("a topic has its tools with only what it needs [%s]", (name) => {
  const [topic, needs] = GATES[name]!
  const unset = Object.fromEntries(FIELDS.filter((f) => !needs.includes(f)).map((f) => [f, undefined]))
  expect(Object.keys(topic({ ...ctx(), ...unset })).length).toBeGreaterThan(0)
})

/** Each topic with each field its gate needs, labelled `<topic>-<field>`. */
const MISSING: [string, string, Field][] = Object.entries(GATES).flatMap(([name, [, needs]]) =>
  [...needs].sort().map((field): [string, string, Field] => [`${name}-${field}`, name, field]),
)

test.each(MISSING)("a topic without a field it needs has no tools [%s]", (_label, name, field) => {
  const [topic] = GATES[name]!
  expect(topic({ ...ctx(), [field]: undefined })).toEqual({})
})

test("a named group ctx cant support is empty not missing", () => {
  expect(build(["company", "workspace"], {})).toEqual({ company: {}, workspace: {} })
})

test("an unknown group raises", () => {
  const c = ctx()
  expect(() => build(["company", "nope"], c)).toThrow(RangeError)
  expect(() => build(["company", "nope"], c)).toThrow("unknown tool group 'nope'")
  expect(() => build(["toString"], c)).toThrow("unknown tool group")
})

test("the office tool specs equal the saved copy", () => {
  // The base company grants minh (group eng) the fake asset's echo, so toolbox lists the built-in kind through
  // a real Monitor.
  const root = company()
  const store = openStore()
  const item = store.createWorkItem(workItem({ requester: "minh" }))
  const s = store.createSession(session({ person: "minh", work_item_id: item.id }))
  const monitor = new Monitor(root, store, new SecretStore(path.join(tempDir(), "office", "secrets")))
  const c: ToolContext = {
    store,
    repo: loadRepo(root),
    session: s,
    runId: "run-1",
    onQuestion: (q) => q,
    monitor,
    workspace: NO_WORKSPACE,
    terminal: pipesTerminal(),
  }
  const specs = groupSpecs(build(["toolbox", "workspace", "terminal", "company", "work_items"], c))
  const golden = fs.readFileSync(new URL("../fixtures/tool_specs.json", import.meta.url), "utf8")
  expect(JSON.stringify(specs, null, 2) + "\n").toBe(golden)
})
