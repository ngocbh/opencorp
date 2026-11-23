/** The gate's policy for each tool call an agent's model makes: by its source, the session's mode, its `tool` rules
 *  and whether a rules file doesn't load; what a card for it holds, and what Auto's check's verdict on it decides. */
import { expect, test } from "bun:test"
import type { ToolSource } from "@ngocbh/yian/tools"
import {
  afterCheck, type CallDecision, decideCall, MAX_CHECK_BYTES, type ToolCall, toolCard,
} from "../../../src/runtime/permissions/gate.ts"
import { type Mode, MODES, type Rule } from "../../../src/runtime/permissions/policy.ts"

const host = (group: string | null, tool: string): ToolSource => ({ kind: "host", group, tool })
const MCP: ToolSource = { kind: "mcp", server: "github", tool: "create_issue" }
const MODULE: ToolSource = { kind: "module", alias: "crm", ref: "./crm.ts", export: "quote" }
const MEMORY: ToolSource = { kind: "memory", input: "profile", tool: "append" }
const FLOW: ToolSource = { kind: "flow", flow: "drive_harness", library: null }

/** A first call of `source`, by the name the model sees, with `args`. */
const call = (source: ToolSource, args: Record<string, unknown> = { title: "Fix" }, attempt = 1): ToolCall => ({
  tool: "the_tool",
  source,
  arguments: args,
  attempt,
})
const rule = (effect: Rule["effect"], pattern: string): Rule => ({ effect, kind: "tool", pattern })
const decide = (source: ToolSource, mode: Mode, rules: Rule[] = [], blocked: string | null = null) =>
  decideCall(call(source), { mode, rules, blocked })

const run = (note: string | null = null): CallDecision => ({ verdict: "run", note })
const DONT = (reason: string): CallDecision => ({
  verdict: "refuse",
  reason: `Not run: this session doesn't ask (dontAsk mode): ${reason}.`,
})

test("host tools run in every mode, each with its note, but a harness session starts only after a card in ask mode", () => {
  const rows: [ToolSource, string | null][] = [
    [host("workspace", "read_file"), "read-only"],
    [host("workspace", "list"), "read-only"],
    [host("workspace", "search"), "read-only"],
    [host("workspace", "write_file"), "a file operation in the workspace"],
    [host("workspace", "edit_file"), "a file operation in the workspace"],
    [host("terminal", "read"), null],
    [host("terminal", "interrupt"), null],
    [host("terminal", "close"), null],
    [host("codex", "send"), null],
    [host("codex", "history"), null],
    [host("claude", "stop"), null],
    [host("company", "ask_manager"), null],
    [host("toolbox", "send_mail"), null],
    [host(null, "propose_company"), null],
  ]
  for (const mode of MODES) {
    for (const [source, note] of rows) expect([source, decide(source, mode)]).toEqual([source, run(note)])
  }
  for (const harness of ["codex", "claude"]) {
    const start = host(harness, "start")
    for (const mode of ["auto", "default", "dontAsk"] as const) {
      expect(decide(start, mode)).toEqual(run("a harness session in its profile"))
    }
    expect(decide(start, "ask")).toEqual({ verdict: "ask", reason: "Ask mode", rules: [`host ${harness} start`] })
  }
})

test("memory and flow tools run in every mode; the calls a flow's agents make are gated on their own", () => {
  for (const mode of MODES) {
    expect(decide(MEMORY, mode)).toEqual(run())
    expect(decide(FLOW, mode)).toEqual(run())
  }
})

test("an MCP or module tool goes to Auto's check in auto, asks in default and ask, and is refused in dontAsk", () => {
  for (const [source, words, what] of [
    [MCP, "mcp github create_issue", "an MCP tool"],
    [MODULE, "module crm quote", "a tool module's tool"],
  ] as const) {
    expect(decide(source, "auto")).toEqual({
      verdict: "check",
      input: { kind: "tool", command: `${words} {"title":"Fix"}`, profile: "none", cwd: "", host: "" },
      rules: [words],
    })
    const reason = `Default mode asks before ${what}`
    expect(decide(source, "default")).toEqual({ verdict: "ask", reason, rules: [words] })
    expect(decide(source, "ask")).toEqual({ verdict: "ask", reason: "Ask mode", rules: [words] })
    expect(decide(source, "dontAsk")).toEqual(DONT(`Default mode asks before ${what}`))
  }
})

test("deny rules refuse first, then ask rules ask with no rule to offer, then allow rules run, in every mode", () => {
  for (const mode of MODES) {
    for (const source of [MCP, MODULE, MEMORY, FLOW, host("company", "ask_manager"), host("codex", "start")]) {
      const all = [rule("allow", "*"), rule("ask", "*"), rule("deny", "*")]
      expect(decide(source, mode, all)).toEqual({ verdict: "refuse", reason: "Not run: a deny rule: *." })
      const asked = decide(source, mode, [rule("allow", "*"), rule("ask", "*")])
      const ask: CallDecision = { verdict: "ask", reason: "an ask rule: *", rules: [] }
      expect(asked).toEqual(mode === "dontAsk" ? DONT("an ask rule: *") : ask)
      expect(decide(source, mode, [rule("allow", "*")])).toEqual(run("an allow rule"))
    }
  }
  // A rule names a call by its words; one that doesn't match leaves the call to its row.
  expect(decide(MCP, "default", [rule("allow", "mcp github *")])).toEqual(run("an allow rule"))
  expect(decide(MCP, "default", [rule("deny", "mcp gitlab *")]).verdict).toBe("ask")
  expect(decide(host("codex", "start"), "ask", [rule("allow", "host codex start")])).toEqual(run("an allow rule"))
  expect(decide(host("codex", "start"), "auto", [rule("deny", "host codex *")])).toEqual({
    verdict: "refuse",
    reason: "Not run: a deny rule: host codex *.",
  })
  // Rules on commands or typed lines never decide a tool call.
  const command: Rule = { effect: "deny", kind: "command", pattern: "*" }
  expect(decide(MCP, "default", [command, { ...command, kind: "input" }]).verdict).toBe("ask")
})

test("while a rules file doesn't load, every call but a read asks with no rule to offer, and deny rules still refuse", () => {
  const blocked = "rules.yaml doesn't load: isn't valid YAML"
  for (const mode of MODES) {
    const reads: ToolSource[] = [host("workspace", "read_file"), host("terminal", "read"), { ...MEMORY, tool: "read" }]
    for (const source of reads) {
      expect(decide(source, mode, [], blocked).verdict).toBe("run")
    }
    for (const source of [host("workspace", "write_file"), host("company", "ask_manager"), MCP, MEMORY, FLOW]) {
      const asked = decide(source, mode, [rule("allow", "*")], blocked)
      expect(asked).toEqual(mode === "dontAsk" ? DONT(blocked) : { verdict: "ask", reason: blocked, rules: [] })
      expect(decide(source, mode, [rule("deny", "*")], blocked).verdict).toBe("refuse")
    }
  }
})

test("a tool whose name no rule can write asks in every mode, offering nothing, and dontAsk refuses it", () => {
  const spaced: ToolSource = { kind: "mcp", server: "github", tool: "create issue" }
  const why = "its name can't be written in a rule, so no rule covers it"
  for (const mode of MODES) {
    expect(decide(spaced, mode, [rule("allow", "*")])).toEqual(
      mode === "dontAsk" ? DONT(why) : { verdict: "ask", reason: why, rules: [] },
    )
  }
})

test("the terminal's run and type pass: the terminal still decides its own commands", () => {
  for (const mode of MODES) {
    for (const tool of ["run", "type"]) {
      expect(decide(host("terminal", tool), mode, [rule("deny", "*")], "blocked")).toEqual(run())
    }
  }
})

test("a call sent again after a crash, which may have run, is never held: only a deny rule refuses it", () => {
  const again = (source: ToolSource, mode: Mode, rules: Rule[] = []) =>
    decideCall(call(source, {}, 2), { mode, rules, blocked: "a file doesn't load" })
  for (const mode of MODES) {
    expect(again(MCP, mode, [rule("ask", "*")])).toEqual(run("sent again after a crash; its first try was let run"))
    expect(again(host("company", "ask_manager"), mode, [rule("deny", "*")]).verdict).toBe("refuse")
  }
})

test("in auto, a call whose arguments are too long for Auto's check asks", () => {
  const long = decideCall(call(MCP, { body: "x".repeat(MAX_CHECK_BYTES) }), { mode: "auto", rules: [], blocked: null })
  expect(long).toEqual({
    verdict: "ask",
    reason: "its arguments are too long for Auto's check: read all of them before you say Yes",
    rules: ["mcp github create_issue"],
  })
  // A big integer the model sent is written out whole.
  const big = decideCall(call(MCP, { n: 2n ** 60n }), { mode: "auto", rules: [], blocked: null })
  expect(big.verdict === "check" && big.input.command).toBe('mcp github create_issue {"n":1152921504606846976}')
})

test("a tool card shows the call as the model made it, why it asks, and the exact words it may allow", () => {
  const card = toolCard(call(MCP, { title: "Fix", n: 3n }), { reason: "Ask mode", rules: ["mcp github create_issue"] })
  expect(card).toEqual({
    kind: "tool",
    tool: "the_tool",
    action: 'the_tool {"title":"Fix","n":3}',
    args: { title: "Fix", n: "3" },
    why: "",
    reason: "Ask mode",
    rules: ["mcp github create_issue"],
    partial: false,
    into: null,
  })
})

test("Auto's check's verdict runs the call with its reason, or asks, or is refused once the session doesn't ask", () => {
  const rules = ["mcp github create_issue"]
  expect(afterCheck({ verdict: "run", reason: "harmless" }, rules, "auto")).toEqual(run("Auto's check: harmless"))
  expect(afterCheck({ verdict: "ask", reason: "posts data" }, rules, "auto")).toEqual({
    verdict: "ask",
    reason: "Auto's check: posts data",
    rules,
  })
  expect(afterCheck({ verdict: "ask", reason: "it failed", failed: true }, rules, "auto")).toEqual({
    verdict: "ask",
    reason: "Auto asks: its check couldn't judge this: it failed",
    rules,
  })
  // A run that failed is no run.
  expect(afterCheck({ verdict: "run", reason: "x", failed: true }, rules, "auto").verdict).toBe("ask")
  const refused = afterCheck({ verdict: "ask", reason: "posts data" }, rules, "dontAsk")
  expect(refused).toEqual(DONT("Auto's check: posts data"))
  expect(afterCheck({ verdict: "run", reason: "harmless" }, rules, "dontAsk")).toEqual(run("Auto's check: harmless"))
})
