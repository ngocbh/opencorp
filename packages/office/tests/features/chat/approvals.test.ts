/** A chat's approvals: the employee's shell runs, holds on an approval card or is refused as the session's mode,
 *  its rules and Auto's check decide, and the office runs a held call once the approver says Yes. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { inspectRun } from "@ngocbh/yian/run"
import type { ToolPart } from "@opencorp/protocol"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { sessionOption, YES } from "../../../src/runtime/questions/approval.ts"
import { INTERRUPTED } from "../../../src/runtime/questions/format.ts"
import type { QuestionRecord } from "../../../src/runtime/store/store.ts"
import { CEO } from "../../server/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { gone, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import {
  fakeLlm,
  type HarnessOffice,
  makeHarness,
  noWorkersLeft,
  running,
  session,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Words only the chat's requests hold, from its system prompt: the employee's replies match on them, so a check's
 *  request never takes one. */
const CHAT = "You work in the office alongside"

/** Commands run only where a sandbox can start. */
const sandboxed = test.if(sandboxAvailable())

type Mode = "auto" | "default" | "ask" | "dontAsk"

/** The employee's reply that runs each of `commands` in the workspace's shell. */
function shell(...commands: string[]): ScriptedReply {
  return { match: CHAT, tool_calls: commands.map((command) => ({ name: "workspace_shell", arguments: { command } })) }
}

/** The employee's reply saying `content`, to a request holding `after`: by default any of the chat's, else what
 *  only the chat's last tool result holds. */
function says(content: string, after = CHAT): ScriptedReply {
  return { match: after, content }
}

/** Auto's check's typed answer on `command`, whose request's `<command>` block holds it. */
function verdict(command: string, answer: "run" | "ask", reason: string, extra: Partial<ScriptedReply> = {}): ScriptedReply {
  return { match: check(command), tool_calls: [{ name: "Record", arguments: { verdict: answer, reason } }], ...extra }
}

/** What a check's request on `command` holds, as the fake reads it (the messages as JSON). */
function check(command: string): string {
  return `<command>\\n${command}\\n</command>`
}

/** The requests the fake model got from Auto's check. */
function checks(fake: Awaited<ReturnType<typeof fakeLlm>>): string[] {
  return fake.requests().map((r) => JSON.stringify(r.messages)).filter((text) => text.includes("<command>"))
}

/** The requests the fake model got from the chat, as text. */
function chats(fake: Awaited<ReturnType<typeof fakeLlm>>): string[] {
  return fake.requests().map((r) => JSON.stringify(r.messages)).filter((text) => text.includes(CHAT))
}

/** Starts minh's chat in `h.folder`, opened by the CEO, waits for its first turn and puts it in `mode`; returns its
 *  id. */
async function chat(h: HarnessOffice, mode?: Mode): Promise<string> {
  const { id } = await h.harness.startSession("minh", h.folder, { openedBy: CEO })
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  if (mode !== undefined) h.store.updateSession(id, { mode })
  return id
}

/** Sends `text` to session `id`, then waits for its `n` open approval cards and for its run to rest on them with no
 *  worker running it; returns the cards. */
async function held(h: HarnessOffice, id: string, text: string, n = 1): Promise<QuestionRecord[]> {
  await h.harness.prompt(id, text)
  const open = () => h.store.listQuestions({ sessionId: id, status: "open", source: "approval" })
  await waitFor(() => open().length === n && status(h, id) === "waiting" && !running(h.registry, id), {
    what: `${n} approval cards`,
  })
  return open()
}

/** The audit rows of session `id`'s shell calls (`kind` workspace) and of its checks (`kind` check). */
function rows(h: HarnessOffice, id: string, kind = "workspace") {
  return h.store.listAudit({ sessionId: id }).filter((row) => row.kind === kind)
}

/** Waits until session `id` is idle with `text` among its replies. */
async function replied(h: HarnessOffice, id: string, text: string): Promise<void> {
  await waitFor(() => texts(h, id).includes(text) && status(h, id) === "idle", { what: `the reply ${text}` })
}

/** The tool parts of session `id`'s messages. */
async function tools(h: HarnessOffice, id: string): Promise<ToolPart[]> {
  return (await h.harness.messages(id)).flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"))
}

sandboxed("a new chat starts in auto: a read-only command and a file operation in the workspace run with no card and no check", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), shell("mkdir -p build && touch build/x"), says("Made it."))
  const h = await makeHarness(fake)
  const id = await chat(h)
  expect(session(h, id).mode).toBe("auto")
  await h.harness.prompt(id, "set it up")
  await replied(h, id, "Made it.")
  expect(fs.existsSync(path.join(h.folder, "build", "x"))).toBe(true)
  expect(checks(fake)).toEqual([])
  expect(h.store.listQuestions({ sessionId: id })).toEqual([])
  expect(rows(h, id).map((r) => [r.outcome, r.detail?.replace(/^exit=0 duration=[\d.]+s /, "")])).toEqual([
    ["ok", "by read-only"],
    ["ok", "by a file operation in the workspace"],
  ])
})

sandboxed("in auto a command the check says run runs, and the audit names the check's reason", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), verdict("make", "run", "builds the project"), says("Built."))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "Makefile"), "all:\n\ttouch built.txt\n")
  const id = await chat(h)
  await h.harness.prompt(id, "build it")
  await replied(h, id, "Built.")
  expect(fs.existsSync(path.join(h.folder, "built.txt"))).toBe(true)
  const [judged] = rows(h, id, "check")
  expect(judged).toMatchObject({ tool: "classify_command", outcome: "run", detail: "builds the project" })
  expect(judged!.args).toMatchObject({ command: "make", profile: "workspace", cwd: h.folder, host: "", cached: false })
  const [ran] = rows(h, id)
  expect(ran!.outcome).toBe("ok")
  expect(ran!.detail!).toEndWith(" by Auto's check: builds the project")
  expect(ran!.id).toBeGreaterThan(judged!.id)
  // The check is told the shell runs on the workspace profile, in the session's folder.
  const [asked] = checks(fake)
  expect(asked).toContain("<profile>workspace</profile>")
  expect(asked).toContain(`<folder>${h.folder}</folder>`)
})

test("in auto a command the check says ask holds on a card that shows the check's reason", async () => {
  const fake = await fakeLlm()
  fake.script(shell("scancel 42"), verdict("scancel 42", "ask", "cancels a cluster job"))
  const h = await makeHarness(fake)
  const id = await chat(h)
  const [q] = await held(h, id, "cancel it")
  expect(q!.approval).toMatchObject({ tool: "shell", action: "scancel 42", reason: "Auto's check: cancels a cluster job" })
  expect(q!.options).toEqual([YES, sessionOption(["scancel 42"])])
  expect(rows(h, id).map((r) => [r.outcome, r.detail])).toEqual([["held", "Auto's check: cancels a cluster job"]])
})

test("the check runs on the office's connection, and its cost is the session's", async () => {
  const fake = await fakeLlm()
  fake.script(
    shell("scancel 42"),
    verdict("scancel 42", "ask", "cancels a cluster job", { usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  )
  const h = await makeHarness(fake, { prices: { stub: { input: 1000, output: 2000 } } })
  const id = await chat(h)
  await held(h, id, "cancel it")
  const [judged] = rows(h, id, "check")
  const usage = h.store.listUsage(id)
  const spent = usage.filter((u) => u.runId === judged!.runId)
  expect(spent.map((u) => [u.model, u.usd])).toEqual([["stub", (7 * 1000 + 3 * 2000) / 1_000_000]])
  expect(usage.some((u) => u.runId === session(h, id).run_ids.at(-1))).toBe(true)
  expect(session(h, id).cost).toBeCloseTo(usage.reduce((sum, u) => sum + u.usd, 0), 10)
  // Its run log is the session's.
  expect(fs.existsSync(path.join(h.office.paths.sessionDir(id), "checks", `${judged!.runId}.jsonl`))).toBe(true)
})

sandboxed("the same command twice in one session is judged once", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), verdict("make", "run", "builds the project"), shell("make"), says("Built twice."))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "Makefile"), "all:\n\ttrue\n")
  const id = await chat(h)
  await h.harness.prompt(id, "build it twice")
  await replied(h, id, "Built twice.")
  expect(checks(fake)).toHaveLength(1)
  expect(rows(h, id, "check").map((r) => [r.outcome, (r.args as { cached: boolean }).cached])).toEqual([
    ["run", false],
    ["run", true],
  ])
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["ok", "ok"])
})

test("a check that fails or doesn't finish asks, and the card says the check couldn't judge it", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), { match: check("make"), error: 500 })
  const failing = await makeHarness(fake)
  const id = await chat(failing)
  const [q] = await held(failing, id, "build it")
  expect(q!.approval!.reason).toBe("Auto asks: its check couldn't judge this: it couldn't run")

  const slow = await fakeLlm()
  slow.script(shell("make"), verdict("make", "run", "builds the project", { hold: true }))
  const h = await makeHarness(slow, { checkTimeoutMs: 1500 })
  const late = await chat(h)
  const [timed] = await held(h, late, "build it")
  expect(timed!.approval!.reason).toBe("Auto asks: its check couldn't judge this: it didn't finish in 30 s")
  expect(rows(h, late, "check").map((r) => r.outcome)).toEqual(["failed"])
})

sandboxed("in default a build command asks with no check, and a read-only one runs", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), shell("make"))
  const h = await makeHarness(fake)
  const id = await chat(h, "default")
  const [q] = await held(h, id, "build it")
  expect(q!.approval!.reason).toBe("Default mode asks before what it doesn't know: make")
  expect(checks(fake)).toEqual([])
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["ok", "held"])
})

test("in dontAsk a command the check says ask is refused with no card, and the agent reads why", async () => {
  const fake = await fakeLlm()
  const why = "Not run: this session doesn't ask (dontAsk mode): Auto's check: cancels a cluster job."
  fake.script(shell("scancel 42"), verdict("scancel 42", "ask", "cancels a cluster job"), says("I won't.", why))
  const h = await makeHarness(fake)
  const id = await chat(h, "dontAsk")
  await h.harness.prompt(id, "cancel it")
  await replied(h, id, "I won't.")
  expect(h.store.listQuestions({ sessionId: id })).toEqual([])
  expect(rows(h, id).map((r) => [r.outcome, r.detail])).toEqual([["denied", why]])
})

test("in ask mode the employee's shell holds on an approval card, and the run waits", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  const runId = session(h, id).run_ids.at(-1)!
  expect(q).toMatchObject({ status: "open", source: "approval", run_id: runId, asker: "minh", question: "ls" })
  expect(q!.call_id!.startsWith(`${runId}/`)).toBe(true)
  expect(q!.approval).toMatchObject({ kind: "command", tool: "shell", action: "ls", why: "", reason: "Ask mode" })
  expect(q!.options).toEqual([YES, sessionOption(["ls *"])])
  const inspection = inspectRun(path.join(h.office.paths.runs, runId, "log.jsonl"))
  expect(inspection.status).toBe("waiting")
  expect(inspection.waits.map((w) => [w.callId, w.settled])).toEqual([[q!.call_id!, false]])
  expect(running(h.registry, id)).toBe(false)
  expect(session(h, id).waiting_on).toEqual([CEO])
})

sandboxed("Yes runs the command once, and the agent reads its output", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), says("Listed.", "a.txt\\n[exit 0]"))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "a.txt"), "")
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.answer(q!.id, YES, "option", { by: CEO })
  await replied(h, id, "Listed.")
  const ran = rows(h, id).filter((r) => r.outcome !== "held")
  expect(ran.map((r) => [r.outcome, r.detail?.replace(/^exit=0 duration=[\d.]+s /, "")])).toEqual([
    ["ok", "approved by @ngocbh"],
  ])
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answered_by: CEO })
})

sandboxed("a Yes completes the held call exactly once, after the command runs", async () => {
  const fake = await fakeLlm()
  fake.script(shell("echo once"), says("Done.", "once\\n[exit 0]"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "say it")
  await h.harness.answer(q!.id, YES, "option", { by: CEO })
  await replied(h, id, "Done.")
  const runId = session(h, id).run_ids.at(-1)!
  const records = fs.readFileSync(path.join(h.office.paths.runs, runId, "log.jsonl"), "utf8").split("\n").filter(Boolean)
  const steps = records
    .map((line) => JSON.parse(line) as { kind: string; payload: { step?: Record<string, unknown> } })
    .flatMap((record) => (record.kind === "node_step" && record.payload.step ? [record.payload.step] : []))
  const pendingStep = steps.find((step) => step.kind === "pending" && step.call_id === q!.call_id)!
  const results = steps.filter((step) => step.kind === "tool_result" && step.call_id === pendingStep.tool_call_id)
  // Its one result is the command's own output: the answer's generic completion never ran before it.
  expect(results.map((step) => step.output)).toEqual(["once\n[exit 0]"])
  expect(h.logs.filter((line) => line.includes("refused"))).toEqual([])
})

test("No reaches the agent as the approver's words, and nothing runs", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), says("I'll clean first.", "Not run: the user said no: use make clean"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "build it")
  await h.harness.answer(q!.id, "use make clean", "text", { by: CEO })
  await replied(h, id, "I'll clean first.")
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held"])
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answer: "use make clean" })
})

sandboxed("don't ask again lets the next matching command run without a card", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls -l"), shell("ls -a"), says("Listed both."))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.answer(q!.id, sessionOption(["ls *"]), "option", { by: CEO })
  await replied(h, id, "Listed both.")
  expect(h.store.listQuestions({ sessionId: id }).map((c) => c.id)).toEqual([q!.id])
  expect(rows(h, id).map((r) => [r.outcome, r.detail?.replace(/^exit=0 duration=[\d.]+s /, "")])).toEqual([
    ["held", "Ask mode"],
    ["ok", "approved by @ngocbh"],
    ["ok", "by an allow rule"],
  ])
})

test("Esc while Auto's check runs stops the call with nothing run and no card", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), verdict("make", "run", "builds the project", { hold: true }))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "Makefile"), "all:\n\ttouch built.txt\n")
  const id = await chat(h)
  await h.harness.prompt(id, "build it")
  await waitFor(() => checks(fake).length === 1, { what: "the check's request" })
  await h.harness.interrupt(id)
  const stopped = await waitFor(() => rows(h, id, "check")[0], { what: "the stopped check's row" })
  expect([stopped.outcome, stopped.detail]).toEqual(["failed", "it was stopped"])
  await waitFor(() => h.registry.get(`classify-${stopped.runId}`) === undefined, { what: "the check's worker to go" })
  // Its verdict comes after the stop: the command still never starts.
  fake.release()
  await waitFor(() => status(h, id) === "idle", { what: "the turn's end" })
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(fs.existsSync(path.join(h.folder, "built.txt"))).toBe(false)
  expect(rows(h, id)).toEqual([])
  expect(h.store.listQuestions({ sessionId: id })).toEqual([])
})

test("End while Auto's check runs runs nothing", async () => {
  const fake = await fakeLlm()
  fake.script(shell("make"), verdict("make", "run", "builds the project", { hold: true }))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "Makefile"), "all:\n\ttouch built.txt\n")
  const id = await chat(h)
  await h.harness.prompt(id, "build it")
  await waitFor(() => checks(fake).length === 1, { what: "the check's request" })
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  const stopped = await waitFor(() => rows(h, id, "check")[0], { what: "the stopped check's row" })
  await waitFor(() => h.registry.get(`classify-${stopped.runId}`) === undefined, { what: "the check's worker to go" })
  fake.release()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(fs.existsSync(path.join(h.folder, "built.txt"))).toBe(false)
  expect(rows(h, id)).toEqual([])
})

test("No answers the session's other open approval cards with the same words", async () => {
  const fake = await fakeLlm()
  const no = "Not run: the user said no: use make clean"
  fake.script(shell("make", "make test"), says("Cleaning first.", no))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [first, second] = await held(h, id, "build and test", 2)
  await h.harness.answer(first!.id, "use make clean", "text", { by: CEO })
  await replied(h, id, "Cleaning first.")
  for (const q of [first!, second!]) {
    expect(h.store.getQuestion(q.id)).toMatchObject({ status: "consumed", answer: "use make clean", answered_by: CEO })
  }
  expect(chats(fake).at(-1)!.split(no)).toHaveLength(3)
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held", "held"])
})

sandboxed("a new rule runs the other open cards it now allows, and leaves the rest open", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls -l", "ls -a", "rm x"), says("Kept x.", "Not run: the user said no: keep x"))
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "x"), "")
  const id = await chat(h, "ask")
  const cards = await held(h, id, "list and clean", 3)
  const byAction = (action: string) => cards.find((c) => c.approval!.action === action)!
  await h.harness.answer(byAction("ls -l").id, sessionOption(["ls *"]), "option", { by: CEO })
  const approved = () => rows(h, id).filter((r) => r.outcome === "ok")
  await waitFor(() => approved().length === 2, { what: "both listings" })
  expect(approved().map((r) => r.detail?.replace(/^exit=0 duration=[\d.]+s /, ""))).toEqual([
    "approved by @ngocbh",
    "approved by @ngocbh",
  ])
  expect(h.store.getQuestion(byAction("ls -a").id)).toMatchObject({ answer: YES, answered_by: CEO })
  const rm = byAction("rm x")
  expect(h.store.getQuestion(rm.id)!.status).toBe("open")
  expect(fs.existsSync(path.join(h.folder, "x"))).toBe(true)
  await h.harness.answer(rm.id, "keep x", "text", { by: CEO })
  await replied(h, id, "Kept x.")
})

test("a switch to dontAsk answers the open approval cards with its refusal", async () => {
  const fake = await fakeLlm()
  const refusal = "Not run: the user said no: this session is now in dontAsk mode, which doesn't ask: Ask mode"
  fake.script(shell("ls"), says("Understood.", refusal))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.setMode(id, "dontAsk", { by: CEO })
  await replied(h, id, "Understood.")
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answered_by: CEO, answer_kind: "text" })
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held"])
})

test("Esc closes an open approval card as interrupted, and nothing runs", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.interrupt(id)
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answer: INTERRUPTED, answer_kind: "interrupted" })
  await waitFor(() => status(h, id) === "idle", { what: "the turn's end" })
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held"])
})

test("the card's stop does what Esc does", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.interrupt(id, { question: q!.id })
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answer: INTERRUPTED, answer_kind: "interrupted" })
  await waitFor(() => status(h, id) === "idle", { what: "the turn's end" })
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held"])
})

test("End while an approval card is open ends the session, closes the card, and runs nothing", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  expect(h.store.getQuestion(q!.id)).toMatchObject({ status: "consumed", answer_kind: "interrupted" })
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held"])
})

sandboxed("Esc while an approved command runs stops it, and the agent's turn ends interrupted", async () => {
  const fake = await fakeLlm()
  fake.script(shell("sleep 30.9"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "wait")
  await h.harness.answer(q!.id, YES, "option", { by: CEO })
  await waitFor(() => h.store.listWorkers().some((w) => w.key.startsWith("call:")), { what: "the command to run" })
  expect(status(h, id)).toBe("busy")
  await h.harness.interrupt(id)
  expect(await gone("30.9")).toBe(true)
  await waitFor(() => status(h, id) === "idle", { what: "the turn's end" })
  await waitFor(async () => (await tools(h, id))[0]?.state === "interrupted", { what: "the call shown interrupted" })
  await waitFor(() => rows(h, id).length === 2, { what: "the command's row" })
  expect(rows(h, id).map((r) => r.outcome)).toEqual(["held", "error"])
  expect(fake.requests()).toHaveLength(1)
})

sandboxed("a message sent while an approval card is open leaves the card open; the agent reads it after the card is answered", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), says("Listed, and noted.", "check the README too"))
  const h = await makeHarness(fake)
  const id = await chat(h, "ask")
  const [q] = await held(h, id, "list it")
  expect(await h.harness.prompt(id, "check the README too")).toBe("queued")
  await waitFor(() => !running(h.registry, id), { what: "the message to reach the run" })
  expect(h.store.getQuestion(q!.id)!.status).toBe("open")
  expect(fake.requests()).toHaveLength(1)
  await h.harness.answer(q!.id, YES, "option", { by: CEO })
  await replied(h, id, "Listed, and noted.")
  const last = chats(fake).at(-1)!
  expect(last).toContain("[exit 0]")
  expect(last).toContain("check the README too")
})
