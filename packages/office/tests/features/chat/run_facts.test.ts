/** What happened in a chat lives where yian, the questions and the terminal records keep it, with no audit table:
 *  why each call ran (its note), what the gate refused, who answered a card (the release's note or the call's
 *  result), Auto's check (its own run log, cited in the note), a command's end (its result and the terminal's
 *  meta.json), and a file call with its result; all of it read back once the office has stopped and started again. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { agentCall, agentCalls, type AgentToolResult } from "@ngocbh/yian/run"
import { stringify } from "yaml"
import { YES } from "../../../src/runtime/questions/approval.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { readRecord } from "../../../src/tools/terminal/record.ts"
import { CEO } from "../../server/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { card, chatOffice, fakeLlm, makeActor, newSession, noWorkersLeft, reopen, status, texts } from "./helpers.ts"

setDefaultTimeout(90_000)
afterAll(noWorkersLeft)

/** Words only the chat's requests hold, so a check's request never takes an employee's reply. */
const CHAT = "You work in the office alongside"

/** The employee's reply making each of `calls` (`[tool, arguments]`). */
function calls(...made: [string, Record<string, unknown>][]): ScriptedReply {
  return { match: CHAT, tool_calls: made.map(([name, args]) => ({ name, arguments: args })) }
}

/** The employee's reply running `command` in a new shell. */
const run = (command: string): [string, Record<string, unknown>] => ["terminal_run", { command, why: "as asked" }]

/** Auto's check's typed answer on `command`. */
function verdict(command: string, answer: "run" | "ask", reason: string): ScriptedReply {
  return { match: `<command>\\n${command}\\n</command>`, tool_calls: [{ name: "Record", arguments: { verdict: answer, reason } }] }
}

/** Each tool call of every model call run `log` records, with its result, in order, as yian reads them back. */
async function toolResults(log: string): Promise<AgentToolResult[]> {
  const found: AgentToolResult[] = []
  for (const call of agentCalls(log)) found.push(...(await agentCall(log, call, { env: () => undefined })).toolResults)
  return found
}

test("each fact of a run is read back from the run log, the questions and the terminal records, after a restart too", async () => {
  const fake = await fakeLlm()
  fake.script(
    calls(run("ls"), run("rm -rf build")),
    { match: CHAT, content: "Looked." },
    calls(run("make")),
    verdict("make", "run", "builds the project"),
    { match: CHAT, content: "Built." },
    calls(run("touch a")),
    { match: CHAT, content: "Touched." },
    calls(run("touch b")),
    { match: CHAT, content: "Stopped." },
    calls(["workspace_read_file", { path: "notes.txt" }]),
    { match: CHAT, content: "Read." },
  )
  const rules = stringify({ rules: [{ effect: "deny", kind: "command", pattern: "rm *" }] })
  const o = await chatOffice(fake, { files: { "rules.yaml": rules } })
  o.workspace.run = async (tool) => (tool === "read_file" ? "hello from notes" : "ok")
  const sid = await newSession(o, { openedBy: CEO })
  let actor = makeActor(o, sid)
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const replied = async (text: string, prompt: string) => {
    await actor.prompt(prompt)
    await waitFor(() => texts(o, sid).includes(text) && status(o, sid) === "idle", { what: `the reply ${text}` })
  }
  await replied("Looked.", "look")
  await replied("Built.", "build")
  o.office.store.updateSession(sid, { mode: "ask" })
  await actor.prompt("touch a")
  const yes = await card(o, sid, "approval")
  await actor.answer(yes.id, YES, "option", { by: CEO })
  await waitFor(() => texts(o, sid).includes("Touched.") && status(o, sid) === "idle", { what: "the reply Touched." })
  await actor.prompt("touch b")
  const no = await card(o, sid, "approval")
  await actor.answer(no.id, "use make instead", "text", { by: CEO })
  await waitFor(() => texts(o, sid).includes("Stopped.") && status(o, sid) === "idle", { what: "the reply Stopped." })
  o.office.store.updateSession(sid, { mode: "auto" })
  await replied("Read.", "read the notes")

  // The office stops and starts again: nothing below is read from memory.
  actor = await reopen(o, actor)
  const session = o.office.store.getSession(sid)!
  const log = path.join(o.office.paths.runs, session.run_ids.at(-1)!, "log.jsonl")
  const results = await toolResults(log)
  const of = (command: string) => results.find((r) => r.arguments?.command === command)!
  // Why a call ran: the gate's note on the call's first record.
  expect(of("ls")).toMatchObject({ note: "read-only", held: false, closed: null })
  expect(JSON.parse(of("ls").output!)).toMatchObject({ exit: 0 })
  // A refusal: closed as refused, with the text the model read.
  expect(of("rm -rf build")).toMatchObject({ closed: "refused", output: "Not run: a deny rule: rm *." })
  // Auto's check: a hold its run released, the note citing the check's own run log.
  const checked = of("make")
  expect(checked.held).toBe(true)
  const cited = /^Auto's check: builds the project \(run ([0-9a-f-]{36})\)$/.exec(checked.releaseNote ?? "")
  expect(cited).not.toBeNull()
  const checkLog = path.join(o.office.paths.sessionDir(sid), "checks", `${cited![1]}.jsonl`)
  expect(fs.readFileSync(checkLog, "utf8")).toContain("builds the project")
  // Who answered: the release's note for a Yes, the call's result for a No, and each card's record.
  expect(of("touch a")).toMatchObject({ held: true, releaseNote: `approved by @${CEO}` })
  expect(of("touch b")).toMatchObject({ held: true, releaseNote: null, output: "Not run: the user said no: use make instead" })
  expect(o.office.store.getQuestion(yes.id)).toMatchObject({ answer: YES, answered_by: CEO, status: "consumed" })
  expect(o.office.store.getQuestion(no.id)).toMatchObject({ answer: "use make instead", answered_by: CEO })
  // A file call and its result.
  expect(results.find((r) => r.name === "workspace_read_file")).toMatchObject({
    arguments: { path: "notes.txt" }, output: "hello from notes", closed: null,
  })
  // A command's end: the terminal's record, each command with who ran it, when, and its exit.
  const terminal = path.join(o.office.paths.sessionDir(sid), "terminal")
  const commands = fs.readdirSync(terminal)
    .flatMap((id) => readRecord(path.join(terminal, id))?.commands ?? [])
    .sort((a, b) => a.at.localeCompare(b.at))
  expect(commands.map(({ command, by, exit }) => ({ command, by, exit }))).toEqual(
    ["ls", "make", "touch a"].map((command) => ({ command, by: session.person, exit: 0 })),
  )
})
