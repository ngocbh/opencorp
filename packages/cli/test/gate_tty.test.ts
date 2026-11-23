// The gate on an employee's tool calls, end to end: a real office on a temp home, the TUI on a real terminal in a tmux
// server of its own, and the scripted model as the office's connection (so Auto's check runs on it too). An ask-mode
// Yes runs a command once; a card left open survives an office restart, and Yes then runs the call once; Esc on a card
// refuses the call and nothing runs later; a module tool in auto goes to Auto's check; and a granted flow that calls a
// module tool runs with no card in ask, while a deny rule on the tool refuses it. The sandbox may be missing here, so
// a command's effect is checked only where it runs.
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createOfficeClient } from "@opencorp/client"
import type { Question } from "@opencorp/protocol"
import type { ScriptedReply } from "@opencorp/office/testing/fake_llm"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { sandboxRuns } from "@opencorp/office/testing/sandbox"
import { type Terminal, TMUX, terminal } from "./tmux"

setDefaultTimeout(180_000)

/** Words only the chat's requests hold, so a check's request never takes Minh's reply. */
const CHAT = "You work in the office alongside"
/** The approval card's choices, once it has been read. */
const CHOICES = "enter confirm"

/** Minh's reply that makes call `id` of `tool` with `args`. */
function calls(id: string, tool: string, args: Record<string, unknown>): ScriptedReply {
  return { match: CHAT, tool_calls: [{ id, name: tool, arguments: args }] }
}

/** Minh's reply that runs `command` in a new shell, as call `id`. */
const shell = (id: string, command: string) => calls(id, "terminal_run", { command, why: "as asked" })

/** Minh's reply once call `id`'s result reached him, whatever it was. */
function after(id: string, content: string): ScriptedReply {
  return { match: `"tool_call_id":"${id}"`, content }
}

/** Waits until `done()`, at most `ms`. */
async function until(done: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
  for (const deadline = performance.now() + ms; !(await done()); await Bun.sleep(100))
    if (performance.now() > deadline) throw new Error(`never: ${what}`)
}

/** Whether process `pid` still runs `opencorp -s <sid>`. */
function running(pid: number, sid: string) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(sid)
  } catch {
    return false
  }
}

/** What a test reads of `office`: its client, and the model's requests and results. */
function reading(office: TestOffice) {
  const client = createOfficeClient({ socket: office.socket })
  /** Call `id`'s results, as each request that holds one gave it to the model. */
  const results = (id: string): string[] =>
    office.llm
      .requests()
      .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
      .filter((m) => m.role === "tool" && m.tool_call_id === id)
      .map((m) => String(m.content))
  /** Auto's check's requests, as text. */
  const checks = () => office.llm.requests().map((r) => JSON.stringify(r)).filter((r) => r.includes("<input>"))
  /** Session `sid`'s open approval card, once it is up. */
  const card = async (sid: string): Promise<Question> => {
    let found: Question | undefined
    await until(async () => {
      found = (await client.questions.list({ session: sid, status: "open" })).find((q) => q.source === "approval")
      return found !== undefined
    }, "the approval card")
    return found!
  }
  return { client, results, checks, card }
}

/** Opens a chat with @minh in a fresh folder as the CEO, and `opencorp -s` on it in a tmux server of its own, with an
 *  empty env but a temp home, `PATH` and the office's home, in `mode`. The test's end closes the TUI, then removes the
 *  home; every scripted reply must have been used by then. */
async function chat(office: TestOffice, mode: "auto" | "ask") {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-gate."))
  const cwd = path.join(root, "project")
  fs.mkdirSync(cwd)
  office.llm.forget()
  const { client } = reading(office)
  const session = await client.sessions.create({ person: "minh", cwd })
  const env = { HOME: root, PATH: "/usr/bin:/bin", OPENCORP_HOME: office.home, OPENCORP_BUN: process.execPath }
  const t = terminal({ env, root }, ["-s", session.id])
  let tui: number | undefined
  onTestFinished(async () => {
    for (const deadline = performance.now() + 5000; tui !== undefined && running(tui, session.id); ) {
      if (performance.now() > deadline) process.kill(tui, "SIGKILL")
      else await Bun.sleep(50)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  onTestFinished(() => expect(office.llm.pending()).toEqual([]))
  await t.see("@minh auto")
  tui = t.pid()
  if (mode === "ask") await cycle(t, office, session.id, ["default", "ask"])
  return { t, sid: session.id, cwd }
}

/** Shift+Tab once for each of `modes`, until the pane and the office's session show it. */
async function cycle(t: Terminal, office: TestOffice, sid: string, modes: string[]) {
  const { client } = reading(office)
  for (const mode of modes) {
    t.keys("BTab")
    await t.see(`@minh ${mode}`)
    await until(async () => (await client.sessions.get(sid)).mode === mode, `the office's session in ${mode}`)
  }
}

/** Commits `files` (repo path to text) to the company repo of `office`, which the office reads at HEAD. */
function commit(office: TestOffice, files: Record<string, string>, message: string) {
  const company = path.join(office.home, "company")
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(company, rel)), { recursive: true })
    fs.writeFileSync(path.join(company, rel), text)
  }
  const who = ["-c", "user.name=Gate Test", "-c", "user.email=gate-test@example.invalid"]
  const git = (...argv: string[]) => execFileSync("git", [...who, ...argv], { cwd: company, env: office.env, stdio: "pipe" })
  git("add", "-A")
  git("commit", "-qm", message)
}

describe.skipIf(!TMUX)("the gate on a real office, in the TUI", () => {
  let office: TestOffice
  beforeAll(async () => {
    office = await startOffice()
  }, 180_000)
  afterAll(async () => {
    await office?.stop()
  })

  test("an ask-mode Yes runs the employee's command once", async () => {
    const { t, sid, cwd } = await chat(office, "ask")
    const { results, card, client } = reading(office)
    office.llm.script(shell("call_once", "echo once >> once.txt"), after("call_once", "Appended."))
    t.type("Append a line")
    await t.see(CHOICES)
    const held = await card(sid)
    t.keys("1")
    t.keys("Enter")
    await t.see("Appended.")
    await Bun.sleep(1000)
    expect(results("call_once")).toHaveLength(1)
    expect((await client.questions.get(held.id)).answer).toBe("Yes")
    if (sandboxRuns()) expect(fs.readFileSync(path.join(cwd, "once.txt"), "utf8")).toBe("once\n")
  })

  test("Esc on a card refuses the call and ends the reply, and the call never runs later", async () => {
    const { t, sid, cwd } = await chat(office, "ask")
    const { results, card, client } = reading(office)
    office.llm.script(shell("call_late", "touch late.txt"), { match: "Are you there?", content: "Still here." })
    t.type("Touch a file")
    await t.see(CHOICES)
    const held = await card(sid)
    t.keys("Escape")
    await t.see("Stop @minh? y/N")
    t.keys("y")
    await until(async () => (await client.questions.get(held.id)).answer_kind === "interrupted", "the card interrupted")
    await until(async () => (await client.sessions.get(sid)).status === "idle", "the chat idle")
    // The next turn runs nothing of the old one: the call stays closed.
    t.type("Are you there?")
    await t.see("Still here.")
    expect(results("call_late").every((text) => !text.includes('"exit"'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, "late.txt"))).toBe(false)
    expect(await client.questions.list({ session: sid, status: "open" })).toEqual([])
  })
})

describe.skipIf(!TMUX)("a card across an office restart, in the TUI", () => {
  let office: TestOffice
  beforeAll(async () => {
    office = await startOffice()
  }, 180_000)
  afterAll(async () => {
    await office?.stop()
  })

  test("a card left open survives the office's restart, and Yes after it runs the call once", async () => {
    const { t, sid, cwd } = await chat(office, "ask")
    const { results, card, client } = reading(office)
    office.llm.script(shell("call_kept", "echo kept >> kept.txt"), after("call_kept", "Kept it."))
    t.type("Keep a line")
    await t.see(CHOICES)
    const held = await card(sid)
    const restarted = await office.opencorp(["restart"])
    expect(restarted.code, restarted.stderr).toBe(0)
    await until(async () => {
      try {
        return (await client.questions.get(held.id)).status === "open" && (await client.sessions.get(sid)).status === "waiting"
      } catch {
        return false // the office is still starting
      }
    }, "the restored card")
    // The TUI reads the card again once it reconnects; Yes on it runs the call once.
    await t.see(CHOICES)
    t.keys("1")
    t.keys("Enter")
    await t.see("Kept it.")
    await Bun.sleep(1000)
    expect(results("call_kept")).toHaveLength(1)
    expect((await client.questions.get(held.id)).status).toBe("consumed")
    if (sandboxRuns()) expect(fs.readFileSync(path.join(cwd, "kept.txt"), "utf8")).toBe("kept\n")
  })
})

/** The company's tool module: `quote` says what it quoted. */
const CRM = `export const quote = {
  name: "quote",
  description: "Quote a price.",
  parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"] },
  execute: async (args) => \`quoted \${args.amount}\`,
}
`

/** A flow def that prices an order by calling the module's `quote` itself. */
const PRICED = "  priced:\n    description: Price an order.\n    input:\n      amount: !int\n    nodes:\n      quoted:\n"
  + "        kind: call\n        call: {crm: quote}\n        input:\n          amount: ${input.amount}\n"
  + "    output: ${quoted.output}\n"

describe.skipIf(!TMUX)("tool modules in a company flow, in the TUI", () => {
  let office: TestOffice
  beforeAll(async () => {
    office = await startOffice()
    // Minh's chat flow grants the module, as `crm`, and `priced`, a flow that calls it.
    const flow = path.join(office.home, "company", "shared/flows/chat.yaml")
    const text = fs.readFileSync(flow, "utf8")
    const granted = text
      .replace("uses:\n  compact_history: compact_history", "uses:\n  crm: ./crm.ts\n  compact_history: compact_history")
      .replace("\ndefs:\n", `\ndefs:\n${PRICED}`)
      .replace("tools: [toolbox, workspace, terminal, codex, claude, company, ask_user]",
        "tools: [toolbox, workspace, terminal, codex, claude, company, ask_user, crm, priced]")
    expect(granted).toContain("ask_user, crm, priced]")
    commit(office, { "shared/flows/chat.yaml": granted, "shared/flows/crm.ts": CRM }, "minh may quote")
  }, 180_000)
  afterAll(async () => {
    await office?.stop()
  })

  test("in auto Auto's check judges a model call of a module tool, and its run runs it", async () => {
    const { t, sid } = await chat(office, "auto")
    const { results, checks, client } = reading(office)
    office.llm.script(
      calls("call_quote", "crm_quote", { amount: 5 }),
      {
        match: "<command>\\nmodule crm quote",
        tool_calls: [{ name: "Record", arguments: { verdict: "run", reason: "it only prices an order" } }],
      },
      after("call_quote", "Quoted."),
    )
    t.type("Quote 5")
    await t.see("Quoted.")
    expect(checks()).toHaveLength(1)
    expect(results("call_quote")).toEqual(["quoted 5"])
    expect(await client.questions.list({ session: sid })).toEqual([])
  })

  test("in ask a granted flow that calls a module tool runs with no card; a deny rule on the tool refuses it", async () => {
    const first = await chat(office, "ask")
    const { results, client } = reading(office)
    office.llm.script(calls("call_priced", "priced", { amount: 7 }), after("call_priced", "Priced."))
    first.t.type("Price 7")
    await first.t.see("Priced.")
    expect(results("call_priced")).toEqual(["quoted 7"])
    expect(first.t.screen()).not.toContain(CHOICES)
    expect(await client.questions.list({ session: first.sid })).toEqual([])

    commit(office, { "rules.yaml": "rules:\n  - {effect: deny, kind: tool, pattern: module crm quote}\n" }, "no quotes")
    const second = await chat(office, "ask")
    office.llm.script(calls("call_denied", "priced", { amount: 8 }), after("call_denied", "Refused."))
    second.t.type("Price 8")
    await second.t.see("Refused.")
    expect(results("call_denied")).toEqual(["Not run: a deny rule: module crm quote, on module crm quote, which this flow calls."])
  })
})
