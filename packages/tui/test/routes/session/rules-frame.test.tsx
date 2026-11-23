// /rules: the chat's rules, each with its source, and the rules files that don't load above them; d removes a session or
// agent rule, and on a company rule says where those change.
import type { Rule, RuleList } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { createFakeOffice, createStub, type FakeOffice } from "../../fixture/fake-office"
import { bootFrame } from "../../fixture/frame"

type App = Awaited<ReturnType<typeof bootFrame>>

const AT = "2026-11-20T10:00:00.000Z"
const SESSION: Rule = { effect: "allow", kind: "command", pattern: "ls *", source: "session", by: null, at: null }
const AGENT: Rule = { effect: "allow", kind: "command", pattern: "git status *", source: "agent", by: "ngocbh", at: AT }
const COMPANY: Rule = { effect: "deny", kind: "command", pattern: "rm -rf *", source: "company", by: null, at: null }
const TOOL: Rule = { effect: "ask", kind: "tool", pattern: "mcp github *", source: "company", by: null, at: null }

/** Boots the fake office's first chat with `list` as its rules, wide enough for a rule's line. */
async function boot(list: RuleList) {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.state.rules[s.id] = list
  const app = await bootFrame(createStub(office), { sessionID: s.id }, { width: 140, height: 30 })
  return { office, s, app }
}

/** Types /rules in the chat's prompt and waits for the dialog. */
async function openRules(app: App) {
  await app.until((f) => f.includes("@minh auto ·"))
  await app.input.typeText("/rules")
  await app.until((f) => f.includes("List the chat's rules"))
  app.input.pressEnter()
  await app.until((f) => f.includes("Rules"))
}

/** The frame with each line's border and padding gone, so a wrapped message reads whole. */
const flat = (f: string) => f.replace(/\s*┃\s*/g, " ").replace(/\s+/g, " ")

const removals = (office: FakeOffice, id: string) =>
  office.requests.filter((r) => r.method === "POST" && r.path === `/sessions/${id}/rules/remove`).map((r) => r.body)

test("/rules lists the chat's rules with their source, and d removes a session or agent one", async () => {
  const { office, s, app } = await boot({ rules: [SESSION, AGENT, COMPANY, TOOL], errors: [] })
  try {
    await openRules(app)
    const frame = await app.until((f) => f.includes("rm -rf *") && f.includes("mcp github *"))
    const row = (pattern: string) => frame.split("\n").find((line) => line.includes(pattern))!
    expect(row("ls *")).toMatch(/allow\s+command\s+ls \*\s+session/)
    expect(row("git status *")).toMatch(/allow\s+command\s+git status \*\s+agent, by @ngocbh/)
    expect(row("rm -rf *")).toMatch(/deny\s+command\s+rm -rf \*\s+company/)
    expect(row("mcp github *")).toMatch(/ask\s+tool\s+mcp github \*\s+company/)
    // The first rule is selected: d removes it, and the list is read again.
    app.input.pressKey("d")
    await app.until((f) => !f.includes("ls *") && f.includes("git status *"))
    app.input.pressKey("d")
    await app.until((f) => !f.includes("git status *") && f.includes("rm -rf *"))
    expect(removals(office, s.id)).toEqual([
      { effect: "allow", kind: "command", pattern: "ls *", source: "session" },
      { effect: "allow", kind: "command", pattern: "git status *", source: "agent" },
    ])
    expect(office.state.rules[s.id]!.rules).toEqual([COMPANY, TOOL])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("d on a company rule says to edit rules.yaml", async () => {
  const { office, s, app } = await boot({ rules: [COMPANY], errors: [] })
  try {
    await openRules(app)
    await app.until((f) => f.includes("rm -rf *"))
    app.input.pressKey("d")
    // The toast wraps its line inside its border.
    await app.until((f) => flat(f).includes("Edit rules.yaml in the company repo to change company rules"))
    expect(removals(office, s.id)).toEqual([])
    expect(office.state.rules[s.id]!.rules).toEqual([COMPANY])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/rules shows a file that doesn't load, and that every command asks until it's fixed", async () => {
  const errors: RuleList["errors"] = [{ source: "company", path: "rules.yaml", message: "isn't valid YAML (line 2)" }]
  const { office, app } = await boot({ rules: [AGENT], errors })
  try {
    await openRules(app)
    const frame = await app.until((f) => f.includes("git status *"))
    const lines = frame.split("\n")
    const error = lines.findIndex((line) =>
      line.includes("rules.yaml doesn't load: isn't valid YAML (line 2). Every command asks until a commit fixes it."),
    )
    expect(error).toBeGreaterThanOrEqual(0)
    expect(error).toBeLessThan(lines.findIndex((line) => line.includes("git status *")))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("d on a deny rule asks first: n keeps it, y removes it", async () => {
  const deny: Rule = { effect: "deny", kind: "command", pattern: "git push --force *", source: "agent", by: "ngocbh", at: AT }
  const { office, s, app } = await boot({ rules: [deny], errors: [] })
  const asked = "Remove the deny rule git push --force *? What it refuses would no longer be refused. y removes it, n keeps it."
  try {
    await openRules(app)
    await app.until((f) => f.includes("git push --force *"))
    app.input.pressKey("d")
    await app.until((f) => flat(f).includes(asked))
    app.input.pressKey("n")
    await app.until((f) => !flat(f).includes(asked) && f.includes("git push --force *"))
    expect(removals(office, s.id)).toEqual([])
    app.input.pressKey("d")
    await app.until((f) => flat(f).includes(asked))
    app.input.pressKey("y")
    await app.until((f) => !f.includes("git push --force *"))
    expect(removals(office, s.id)).toEqual([
      { effect: "deny", kind: "command", pattern: "git push --force *", source: "agent" },
    ])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a session rule an always couldn't save says why above the list", async () => {
  const why = "people/minh/rules.yaml has changes nobody committed; commit or discard them first"
  const { office, app } = await boot({ rules: [{ ...SESSION, note: why }], errors: [] })
  try {
    await openRules(app)
    await app.until((f) => flat(f).includes(`allow ls * applies to this session only: ${why}`))
  } finally {
    await app.stop()
    office.stop()
  }
})
