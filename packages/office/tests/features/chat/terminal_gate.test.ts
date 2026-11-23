/** A chat's terminal under the office's gate: each command is decided before it starts, a held one waits on its card
 *  as yian's hold, Yes runs it once where yian held it, and yian's at-most-once covers a command a crash cut off. The
 *  terminal is real, over the chat office's pipes stand-in. */
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import type { GatedCall } from "@ngocbh/yian/tools"
import { ChatApprovals } from "../../../src/features/chat/approvals.ts"
import type { CheckRunner } from "../../../src/runtime/permissions/classifier.ts"
import type { CheckInput } from "../../../src/runtime/permissions/policy.ts"
import { YES } from "../../../src/runtime/questions/approval.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { Terminal } from "../../../src/tools/terminal/terminal.ts"
import { CEO } from "../../server/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { card, chatOffice, fakeLlm, makeActor, newSession, noWorkersLeft, status, texts } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Yian's text for a call a stop or crash cut off after it may have started. */
const UNKNOWN = "The tool call was interrupted; its outcome is unknown."

/** The employee's reply running `command` in a new shell, waiting `wait` seconds when given. */
function shellCall(command: string, wait?: number): ScriptedReply {
  const args = { command, why: "as asked", ...(wait === undefined ? {} : { wait }) }
  return { tool_calls: [{ name: "terminal_run", arguments: args }] }
}

/** What the employee's last request holds. */
function lastAsked(fake: Awaited<ReturnType<typeof fakeLlm>>, text: string): boolean {
  return JSON.stringify(fake.requests().at(-1)?.messages ?? []).includes(text)
}

/** Auto's check that waits for the test: each check waits until `finish` gives it a verdict. */
function heldCheck(): { runCheck: CheckRunner; judged: CheckInput[]; finish(verdict: "run" | "ask"): void } {
  const judged: CheckInput[] = []
  const waiting: ((verdict: "run" | "ask") => void)[] = []
  const runCheck: CheckRunner = async (input, { signal }) => {
    judged.push(input)
    const verdict = await new Promise<"run" | "ask">((resolve, reject) => {
      waiting.push(resolve)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    return { output: { verdict, reason: verdict === "run" ? "builds the project" : "deploys" } }
  }
  return { runCheck, judged, finish: (verdict) => waiting.shift()!(verdict) }
}

/** A chat office on `fake` with a session of minh's in `mode`, its actor started (with `runCheck` as Auto's check)
 *  and idle at its first turn. */
async function chat(fake: Awaited<ReturnType<typeof fakeLlm>>, mode: "auto" | "default" | "ask", runCheck?: CheckRunner) {
  const o = await chatOffice(fake)
  const sid = await newSession(o, { openedBy: CEO })
  const actor = makeActor(o, sid, runCheck === undefined ? {} : { runCheck })
  await actor.start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  o.office.store.updateSession(sid, { mode })
  const rows = () => o.office.store.listAudit({ sessionId: sid }).map((r) => [r.outcome, r.detail])
  return { o, sid, actor, rows }
}

test("an ask-mode command waits on its card; Yes runs it once, where yian held it, and its row names who approved", async () => {
  const fake = await fakeLlm()
  // An integer argument, which yian reads as a bigint, plans as the number the tool gets.
  fake.script(shellCall("ls", 5), { content: "Listed." })
  const c = await chat(fake, "ask")
  c.o.pipes.run = async () => ({ output: "a.txt\n", exit: 0 })
  await c.actor.prompt("list it")
  const q = await card(c.o, c.sid, "approval")
  expect(q.approval).toMatchObject({ kind: "command", tool: "terminal_run", action: "ls", reason: "Ask mode" })
  expect(c.o.pipes.commands).toEqual([])
  await c.actor.answer(q.id, YES, "option", { by: CEO })
  await waitFor(() => texts(c.o, c.sid).includes("Listed.") && status(c.o, c.sid) === "idle", { what: "the reply" })
  expect(c.o.pipes.commands).toEqual(["ls"])
  expect(c.rows()).toEqual([
    ["held", "Ask mode"],
    ["ok", expect.stringMatching(new RegExp(`^exit=0 duration=[\\d.]+s approved by @${CEO}$`))],
  ])
})

test("No runs nothing, and the employee reads the approver's words", async () => {
  const fake = await fakeLlm()
  fake.script(shellCall("rm -rf build"), { match: "the user said no", content: "Left it." })
  const c = await chat(fake, "ask")
  await c.actor.prompt("clean up")
  const q = await card(c.o, c.sid, "approval")
  await c.actor.answer(q.id, "keep the build", "text", { by: CEO })
  await waitFor(() => texts(c.o, c.sid).includes("Left it.") && status(c.o, c.sid) === "idle", { what: "the reply" })
  expect(c.o.pipes.commands).toEqual([])
  expect(lastAsked(fake, "Not run: the user said no: keep the build")).toBe(true)
})

test("a released command a crash cut off as it ran runs once: the employee reads that its outcome is unknown", async () => {
  const fake = await fakeLlm()
  fake.script(shellCall("make deploy"), { match: "its outcome is unknown", content: "I'll check first." })
  const c = await chat(fake, "ask")
  // The command runs until it is stopped.
  c.o.pipes.run = (_command, signal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exit: null }), { once: true }))
  await c.actor.prompt("deploy it")
  const q = await card(c.o, c.sid, "approval")
  await c.actor.answer(q.id, YES, "option", { by: CEO })
  await waitFor(() => c.o.pipes.commands.length === 1, { what: "the command to run" })
  c.o.registry.get(c.sid)!.kill()
  await waitFor(() => texts(c.o, c.sid).includes("I'll check first.") && status(c.o, c.sid) === "idle", {
    what: "the reply",
  })
  expect(c.o.pipes.commands).toEqual(["make deploy"])
  expect(lastAsked(fake, UNKNOWN)).toBe(true)
})

test("a command a crash cut off while the gate decided it never runs", async () => {
  const fake = await fakeLlm()
  fake.script(shellCall("make deploy"), { match: "its outcome is unknown", content: "I'll ask again." })
  // The office hasn't answered the gate when the worker dies.
  const original = ChatApprovals.prototype.gate
  let held = 0
  const spy = spyOn(ChatApprovals.prototype, "gate").mockImplementation(function (
    this: ChatApprovals,
    runId: string,
    call: GatedCall,
  ) {
    if (call.tool === "terminal_run" && held++ === 0) return new Promise(() => {}) as never
    return original.call(this, runId, call)
  })
  onTestFinished(() => spy.mockRestore())
  const c = await chat(fake, "auto")
  await c.actor.prompt("deploy it")
  await waitFor(() => held === 1, { what: "the held decision" })
  c.o.registry.get(c.sid)!.kill()
  await waitFor(() => texts(c.o, c.sid).includes("I'll ask again.") && status(c.o, c.sid) === "idle", {
    what: "the reply",
  })
  expect(c.o.pipes.commands).toEqual([])
})

test("a shell that moved after the gate decided its command runs nothing: the command is to be run and checked again", async () => {
  const fake = await fakeLlm()
  fake.script(shellCall("ls"), { match: "run it again to have it checked there", content: "I'll run it again." })
  const c = await chat(fake, "auto")
  // The gate's plan reads the shell's folder first; by the time the command acts, the shell is elsewhere.
  const where = Terminal.prototype.where
  let reads = 0
  const spy = spyOn(Terminal.prototype, "where").mockImplementation(function (this: Terminal, shell?: string) {
    const read = where.call(this, shell)
    return ++reads === 1 ? read : { ...read, cwd: "/elsewhere" }
  })
  onTestFinished(() => spy.mockRestore())
  await c.actor.prompt("list it")
  await waitFor(() => texts(c.o, c.sid).includes("I'll run it again.") && status(c.o, c.sid) === "idle", {
    what: "the reply",
  })
  expect(c.o.pipes.commands).toEqual([])
})

test("Auto's check on a command holds it; its run releases the command, and a switch to ask while it runs makes a card", async () => {
  const fake = await fakeLlm()
  fake.script(shellCall("make"), { content: "Built." }, shellCall("make deploy"), { content: "Waiting." })
  const check = heldCheck()
  const c = await chat(fake, "auto", check.runCheck)
  await c.actor.prompt("build it")
  await waitFor(() => check.judged.length === 1, { what: "the check" })
  expect(check.judged[0]).toMatchObject({ kind: "command", command: "make", profile: "workspace" })
  expect(c.o.pipes.commands).toEqual([])
  check.finish("run")
  await waitFor(() => texts(c.o, c.sid).includes("Built.") && status(c.o, c.sid) === "idle", { what: "the reply" })
  expect(c.o.pipes.commands).toEqual(["make"])
  expect(c.rows().at(-1)).toEqual([
    "ok", expect.stringMatching(/^exit=0 duration=[\d.]+s by Auto's check: builds the project$/),
  ])
  // A switch to ask while the check runs wins over its verdict.
  await c.actor.prompt("deploy it")
  await waitFor(() => check.judged.length === 2, { what: "the second check" })
  c.o.office.store.updateSession(c.sid, { mode: "ask" })
  check.finish("run")
  const q = await card(c.o, c.sid, "approval")
  expect(q.approval).toMatchObject({ kind: "command", action: "make deploy", reason: "Ask mode" })
  expect(c.o.pipes.commands).toEqual(["make"])
})
