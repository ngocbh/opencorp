/** The no-office host under yian's gate (`beforeToolCall`), as a chat session is: each call decided by the session's
 *  mode and rules, a held call's card made once yian holds it, a Yes that releases the call where yian holds it, a No
 *  that completes it, Auto's check as a hold, and a terminal call that acts only on what was decided. */
import fs from "node:fs"
import path from "node:path"
import { iterRunRecords } from "@ngocbh/yian/run"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { sessionOption, YES } from "../../../src/runtime/questions/approval.ts"
import { END_STOP_MS, OWNER } from "../../../src/server/local/host.ts"
import { fakeLlm } from "../../features/chat/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { AGENT, CHECK, cards, open, said, startHost, terminalCall, until } from "./helpers.ts"

setDefaultTimeout(90_000)

/** The model's typed verdict for Auto's check. */
const verdict = (verdict: string, reason: string) => ({ name: "Record", arguments: { verdict, reason } })

/** The text of the tool results request `n` (from 0) sent the model for its last calls. */
function results(requests: Record<string, unknown>[], n: number): string[] {
  const messages = requests[n]!.messages as { role: string; content: unknown; tool_calls?: unknown }[]
  const last = messages.findLastIndex((m) => m.role === "assistant" && m.tool_calls !== undefined)
  return messages.slice(last + 1).filter((m) => m.role === "tool").map((m) => String(m.content))
}

/** The requests of the agent (never Auto's check's), in order. */
const agentRequests = (requests: Record<string, unknown>[]) => requests.filter((r) => JSON.stringify(r).includes(AGENT))

/** Waits until the session's last message is the assistant's `text`. */
async function replied(host: Awaited<ReturnType<typeof startHost>>["host"], text: string): Promise<void> {
  await waitFor(async () => (await said(host)).at(-1)?.[1].at(-1) === text, { what: `the reply ${text}` })
}

/** The `released` steps of the session's run log: each call let run, and its note. */
function releases(folder: string, runId: string): { call_id: string; note: string | null }[] {
  const log = path.join(folder, "runs", runId, "log.jsonl")
  return [...iterRunRecords(log, { kinds: ["node_step"] })].flatMap((entry) => {
    const step = (entry.envelope!.record as unknown as { step: { kind: string; call_id?: string; note?: string } }).step
    return step.kind === "released" ? [{ call_id: step.call_id!, note: step.note ?? null }] : []
  })
}

test("a held command's card comes once yian holds it; only the owner's Yes releases it, once, noting who approved it", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "echo x >> count", why: "count" })], match: AGENT },
    { content: "Counted.", match: AGENT },
  )
  const { host, folder, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("count", OWNER)
  const [card] = await cards(host, 1)
  expect(card).toMatchObject({ source: "approval", question: "echo x >> count", approval: { tool: "terminal_run" } })
  expect(() => host.answer(card!.id, YES, "option", "mallory")).toThrow("only @owner may answer")
  expect(host.question(card!.id)).toMatchObject({ status: "open", answered_by: null })
  host.answer(card!.id, YES, "option", OWNER)
  await replied(host, "Counted.")
  expect(fs.readFileSync(path.join(work, "count"), "utf8")).toBe("x\n")
  const runId = host.session()!.run_ids[0]!
  expect(releases(folder, runId)).toEqual([{ call_id: card!.call_id!, note: "approved by @owner" }])
  await waitFor(() => host.question(card!.id)?.status === "consumed", { what: "the card consumed" })
})

test("a No completes the call with the owner's words, and settles the reply's later calls that would ask; a later reply asks again", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      tool_calls: [
        terminalCall("run", { command: "touch a", why: "a" }, "call_a"),
        terminalCall("run", { command: "touch b", why: "b" }, "call_b"),
      ],
      match: AGENT,
    },
    { content: "Stopped.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "touch c", why: "c" })], match: AGENT },
    { content: "Asked.", match: AGENT },
  )
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("two", OWNER)
  // One card at a time: yian decides the reply's later calls once the card is answered.
  const [first] = await cards(host, 1)
  host.answer(first!.id, "use make instead", "text", OWNER)
  await replied(host, "Stopped.")
  expect(results(agentRequests(fake.requests()), 1)).toEqual([
    "Not run: the user said no: use make instead",
    "Not run: the user said no: use make instead",
  ])
  expect(host.questions({})).toHaveLength(1)

  await host.prompt("one more", OWNER)
  const [next] = await cards(host, 1)
  expect(next).toMatchObject({ question: "touch c", status: "open" })
  host.answer(next!.id, YES, "option", OWNER)
  await replied(host, "Asked.")
  expect(["a", "b", "c"].map((f) => fs.existsSync(path.join(work, f)))).toEqual([false, false, true])
})

test("don't ask again adds a session rule that lets the reply's later call run, with no card of its own", async () => {
  const fake = await fakeLlm()
  fake.script(
    {
      tool_calls: [
        terminalCall("run", { command: "touch a", why: "a" }, "call_a"),
        terminalCall("run", { command: "touch b", why: "b" }, "call_b"),
      ],
      match: AGENT,
    },
    { content: "Both.", match: AGENT },
  )
  const { host, folder, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("default", OWNER)
  await host.prompt("touch a and b", OWNER)
  const [card] = await cards(host, 1)
  expect(card!.options).toEqual([YES, sessionOption(["touch *"])])
  host.answer(card!.id, sessionOption(["touch *"]), "option", OWNER)
  await replied(host, "Both.")
  expect(["a", "b"].map((f) => fs.existsSync(path.join(work, f)))).toEqual([true, true])
  expect(host.questions({})).toHaveLength(1)
  expect(releases(folder, host.session()!.run_ids[0]!)).toEqual([{ call_id: card!.call_id!, note: "approved by @owner" }])
})

test("Auto's check is a hold: its run verdict releases the call with its reason, and it never reads the model's key", async () => {
  const key = "sk-local-model-key-0123456789"
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: `printf ${key} > k`, why: "k" })], match: AGENT },
    { tool_calls: [verdict("run", "it writes one file")], match: CHECK },
    { content: "Wrote it.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "touch held", why: "h", shell: "shell 1" })], match: AGENT },
    { tool_calls: [verdict("ask", "the owner may want a say")], match: CHECK },
    { content: "Held.", match: AGENT },
  )
  const { host, folder, work } = await startHost(fake, { llm: { api_key: key } })
  await until(host, "idle")
  await host.prompt("write k", OWNER)
  await replied(host, "Wrote it.")
  expect(fs.readFileSync(path.join(work, "k"), "utf8")).toBe(key)
  const runId = host.session()!.run_ids[0]!
  const [note] = releases(folder, runId).map((r) => r.note)
  // The note cites the check's own run, whose log is in the session's checks/ folder.
  const run = /^Auto's check: it writes one file \(run ([0-9a-f-]{36})\)$/.exec(note ?? "")?.[1]
  expect(run).toBeString()
  expect(fs.existsSync(path.join(folder, "checks", `${run}.jsonl`))).toBe(true)
  // The check's model read the command with the key redacted, and so does its record.
  const checks = fake.requests().filter((r) => JSON.stringify(r).includes(CHECK))
  expect(checks).toHaveLength(1)
  expect(JSON.stringify(checks)).not.toContain(key)
  expect(fs.readFileSync(path.join(folder, "checks", "verdicts.jsonl"), "utf8")).not.toContain(key)

  await host.prompt("touch held", OWNER)
  const [card] = await cards(host, 1)
  expect(card!.approval).toMatchObject({ action: "touch held", reason: "Auto's check: the owner may want a say" })
  expect(fs.existsSync(path.join(work, "held"))).toBe(false)
  host.answer(card!.id, YES, "option", OWNER)
  await replied(host, "Held.")
  expect(fs.existsSync(path.join(work, "held"))).toBe(true)
})

test("a check's verdict that lands after a switch to ask is decided again: the call asks, and runs nothing until Yes", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch late", why: "l" })], match: AGENT },
    { tool_calls: [verdict("run", "it makes an empty file")], hold: true, match: CHECK },
    { content: "Made it.", match: AGENT },
  )
  onTestFinished(() => fake.release())
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("touch late", OWNER)
  await waitFor(() => fake.requests().some((r) => JSON.stringify(r).includes(CHECK)), { what: "the check's request" })
  // The check on a held call reads busy.
  await until(host, "busy")
  host.setMode("ask", OWNER)
  fake.release()
  const [card] = await cards(host, 1)
  expect(card!.approval).toMatchObject({ action: "touch late", reason: "Ask mode" })
  expect(fs.existsSync(path.join(work, "late"))).toBe(false)
  host.answer(card!.id, YES, "option", OWNER)
  await replied(host, "Made it.")
  expect(fs.existsSync(path.join(work, "late"))).toBe(true)
})

test("a command approved after its shell moved to another folder runs nothing: the agent is told to run it again", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "pwd", why: "where" })], match: AGENT },
    { content: "Here.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "touch moved", why: "m", shell: "shell 1" })], match: AGENT },
    { content: "Refused.", match: AGENT },
  )
  const { host, work, terminal } = await startHost(fake)
  fs.mkdirSync(path.join(work, "sub"))
  await until(host, "idle")
  await host.prompt("where", OWNER)
  await replied(host, "Here.")
  host.setMode("ask", OWNER)
  await host.prompt("touch it", OWNER)
  const [card] = await cards(host, 1)
  expect(card!.approval!.args).toMatchObject({ cwd: "~" })
  // The owner moves the shell while the card waits: where the owner's own command left it, the gate can't know.
  const id = terminal.shells()[0]!.id
  terminal.shell(id)!.ownerKeys("cd sub\r")
  await waitFor(() => terminal.where(id).cwd !== "~", { what: "the shell moved" })
  host.answer(card!.id, YES, "option", OWNER)
  await replied(host, "Refused.")
  const [result] = results(agentRequests(fake.requests()), 3)
  expect(JSON.parse(result!).refused).toBe(
    "the shell is in another folder than when this command was approved (~, now unknown); run it again to have " +
      "it checked there",
  )
  expect(fs.existsSync(path.join(work, "moved"))).toBe(false)
  expect(fs.existsSync(path.join(work, "sub", "moved"))).toBe(false)
})

test("Esc closes a held call: its card is answered interrupted, a later Yes is refused, and nothing runs", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT })
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("touch a", OWNER)
  const [card] = await cards(host, 1)
  await host.interrupt()
  await waitFor(() => host.question(card!.id)?.answer_kind === "interrupted", { what: "the card interrupted" })
  expect(open(host)).toEqual([])
  expect(() => host.answer(card!.id, YES, "option", OWNER)).toThrow("is not open")
  await until(host, "idle")
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
})

test("Esc while Auto's check judges a held call stops the check: no card, nothing runs, and the session goes idle", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch esc", why: "e" })], match: AGENT },
    { tool_calls: [verdict("run", "it makes an empty file")], hold: true, match: CHECK },
  )
  onTestFinished(() => fake.release())
  const { host, folder, work } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("touch esc", OWNER)
  await waitFor(() => fake.requests().some((r) => JSON.stringify(r).includes(CHECK)), { what: "the check's request" })
  await until(host, "busy")
  await host.interrupt()
  await until(host, "idle")
  fake.release()
  const verdicts = path.join(folder, "checks", "verdicts.jsonl")
  await waitFor(() => fs.existsSync(verdicts), { what: "the check's record" })
  expect(JSON.parse(fs.readFileSync(verdicts, "utf8"))).toMatchObject({ verdict: "ask", failed: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(host.questions({})).toEqual([])
  expect(fs.existsSync(path.join(work, "esc"))).toBe(false)
})

test("End while Auto's check judges a held call ends the session at once: no card, and nothing runs", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch end", why: "e" })], match: AGENT },
    { tool_calls: [verdict("run", "it makes an empty file")], hold: true, match: CHECK },
  )
  onTestFinished(() => fake.release())
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("touch end", OWNER)
  await waitFor(() => fake.requests().some((r) => JSON.stringify(r).includes(CHECK)), { what: "the check's request" })
  await until(host, "busy")
  const started = performance.now()
  await host.end()
  await host.ended
  // Well under the wait End gives a busy run before it asks the worker to stop.
  expect(performance.now() - started).toBeLessThan(END_STOP_MS - 1_000)
  fake.release()
  expect(host.session()!.status).toBe("ended")
  expect(host.questions({})).toEqual([])
  expect(fs.existsSync(path.join(work, "end"))).toBe(false)
})
