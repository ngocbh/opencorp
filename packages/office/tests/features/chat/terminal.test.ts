/** An employee's terminal, through the chat harness: each command runs in a pipes shell in the session's workspace,
 *  listed as the session's instrument with its record in the session's `terminal/` folder; the owner's Ctrl-C, Esc and
 *  End stop what they should, and a command the agent was told is running goes on. Commands run in the sandbox. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { stringify } from "yaml"
import type { Instrument, ToolPart } from "@opencorp/protocol"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { EmployeeTerminal } from "../../../src/features/chat/terminal.ts"
import { sessionOption } from "../../../src/runtime/questions/approval.ts"
import { readRecord } from "../../../src/tools/terminal/record.ts"
import { decidedFor } from "../../../src/tools/terminal/terminal.ts"
import { Instruments } from "../../../src/runtime/sessions/instruments.ts"
import { CEO } from "../../server/helpers.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { ended, ownSleepers, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import { fakePipes, json, permissions } from "../../tools/terminal/helpers.ts"
import { fakeLlm, type HarnessOffice, makeHarness, noWorkersLeft, running, status, texts, toolResults } from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Commands run only where a sandbox can start. */
const sandboxed = test.if(sandboxAvailable())

/** Words only the chat's requests hold, from its system prompt, so a check's request never takes the employee's. */
const CHAT = "You work in the office alongside"

type Fake = Awaited<ReturnType<typeof fakeLlm>>

/** The employee's call of terminal tool `tool` with `args`, as call `id`, in reply to a request holding `after` (by
 *  default any of the chat's). */
function term(id: string, tool: string, args: Record<string, unknown>, after = CHAT): ScriptedReply {
  return { match: after, tool_calls: [{ id, name: `terminal_${tool}`, arguments: args }] }
}

/** The employee's words once call `id`'s result reached them. */
function said(id: string, content: string): ScriptedReply {
  return { match: `"tool_call_id":"${id}"`, content }
}

/** Auto's check's verdict on `command`. */
function verdict(command: string, answer: "run" | "ask", reason: string): ScriptedReply {
  return { match: `<command>\\n${command}\\n</command>`, tool_calls: [{ name: "Record", arguments: { verdict: answer, reason } }] }
}

/** Call `id`'s result as the model read it: the terminal's JSON reply. */
function result(fake: Fake, id: string): Record<string, unknown> | undefined {
  const content = fake
    .requests()
    .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
    .find((m) => m.role === "tool" && m.tool_call_id === id)?.content
  return content === undefined ? undefined : JSON.parse(content)
}

/** A rules file of minh's allowing each pattern. */
function allowing(...patterns: string[]): Record<string, string> {
  const rules = patterns.map((pattern) => ({ effect: "allow", kind: "command", pattern }))
  return { "people/minh/rules.yaml": stringify({ rules }) }
}

/** Starts minh's chat in `h.folder`, opened by the CEO, and waits for its first turn; returns its id. */
async function chat(h: HarnessOffice): Promise<string> {
  const { id } = await h.harness.startSession("minh", h.folder, { openedBy: CEO })
  await waitFor(() => status(h, id) === "idle", { what: "the first turn" })
  return id
}

/** Waits until session `id` is idle with `text` among its replies. */
async function replied(h: HarnessOffice, id: string, text: string): Promise<void> {
  await waitFor(() => texts(h, id).includes(text) && status(h, id) === "idle", { what: `the reply ${text}` })
}

/** Session `id`'s instruments, as the office lists them. */
function listed(h: HarnessOffice, id: string): Instrument[] {
  return h.office.instruments.list(id)
}

/** The folder of session `id`'s shell `shell`'s record. */
function recordOf(h: HarnessOffice, id: string, shell: string): string {
  return path.join(h.office.paths.sessionDir(id), "terminal", shell)
}

/** Writes a line to fifo `fifo` and closes it, ending a reader's `cat`, once the reader holds it open: until then a
 *  nonblocking open for writing fails with ENXIO. */
async function release(fifo: string): Promise<void> {
  const open = (): { fd: number } | null => {
    try {
      return { fd: fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENXIO") return null
      throw error
    }
  }
  const { fd } = await waitFor(open, { what: `a reader of ${path.basename(fifo)}` })
  try {
    fs.writeSync(fd, "go\n")
  } finally {
    fs.closeSync(fd)
  }
}

/** The tool parts of session `id`'s messages. */
async function tools(h: HarnessOffice, id: string): Promise<ToolPart[]> {
  return (await h.harness.messages(id)).flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"))
}

sandboxed("an employee's command runs in a pipes shell listed as the session's instrument, its record in the session's terminal folder", async () => {
  const fake = await fakeLlm()
  fake.script(term("call_echo", "run", { command: "echo hello-there", why: "greets" }), said("call_echo", "Said it."))
  const h = await makeHarness(fake)
  const id = await chat(h)
  await h.harness.prompt(id, "say hello")
  await replied(h, id, "Said it.")
  expect(result(fake, "call_echo")).toMatchObject({ shell: "shell 1", status: "idle", exit: 0, output: "$ echo hello-there\nhello-there\n" })
  const [shell] = listed(h, id)
  expect(shell).toMatchObject({
    session_id: id, kind: "terminal", name: "shell 1", driver: "minh", profile: "workspace", interactive: false,
    size: null, status: "idle", command: null,
  })
  // Its record, in the session's own terminal folder.
  expect(readRecord(recordOf(h, id, shell!.id))).toMatchObject({
    id: shell!.id, name: "shell 1", profile: "workspace", driver: "minh", state: "running",
    commands: [{ command: "echo hello-there", by: "minh", exit: 0 }],
  })
  expect(fs.readFileSync(path.join(recordOf(h, id, shell!.id), "output.log"), "utf8")).toContain("hello-there")
  // The office published it and its output as live events.
  const events = h.lives.filter((e) => e.session_id === id)
  expect(events.some((e) => e.type === "instrument.updated" && (e.data as Instrument).id === shell!.id)).toBe(true)
  expect(events.some((e) => e.type === "instrument.output")).toBe(true)
  // The run's log keeps the call, the gate's note on why it ran, and the reply.
  const [call] = await toolResults(h, id)
  expect(call).toMatchObject({ name: "terminal_run", arguments: { command: "echo hello-there" }, closed: null })
  expect(call!.note).toBeString()
})

sandboxed("the approver's Ctrl-C in the shell stops its command, and the agent reads that it ended", async () => {
  const fake = await fakeLlm()
  fake.script(
    term("call_sleep", "run", { command: "sleep 30.71", why: "waits", wait: 1 }),
    said("call_sleep", "It's running."),
    term("call_read", "read", { shell: "shell 1", wait: 10 }, "is it done"),
    said("call_read", "It ended."),
  )
  const h = await makeHarness(fake, { files: allowing("sleep *") })
  const id = await chat(h)
  await h.harness.prompt(id, "wait a while")
  await replied(h, id, "It's running.")
  expect(result(fake, "call_sleep")).toMatchObject({ status: "running" })
  const [shell] = listed(h, id)
  expect(shell).toMatchObject({ status: "running", command: "sleep 30.71" })
  const sleeping = await ownSleepers("30.71")
  expect(sleeping).toHaveLength(1)
  // The instrument route's Ctrl-C, which only the approver may send.
  h.office.instruments.get(id, shell!.id)!.interrupt()
  expect(await ended(sleeping)).toBe(true)
  await waitFor(() => listed(h, id)[0]?.status === "idle", { what: "the shell idle" })
  await h.harness.prompt(id, "is it done?")
  await replied(h, id, "It ended.")
  expect(result(fake, "call_read")).toMatchObject({ shell: "shell 1", status: "idle", exit: null })
})

sandboxed("Esc stops the agent and the command its call waited on", async () => {
  const fake = await fakeLlm()
  fake.script(term("call_sleep", "run", { command: "sleep 30.72", why: "waits", wait: 120 }))
  const h = await makeHarness(fake, { files: allowing("sleep *") })
  const id = await chat(h)
  await h.harness.prompt(id, "wait a while")
  await waitFor(() => listed(h, id)[0]?.status === "running", { what: "the command" })
  const sleeping = await ownSleepers("30.72")
  expect(sleeping).toHaveLength(1)
  await h.harness.interrupt(id)
  expect(await ended(sleeping)).toBe(true)
  await waitFor(() => status(h, id) === "idle" && !running(h.registry, id), { what: "the turn's end" })
  const [tool] = await tools(h, id)
  expect(tool).toMatchObject({ tool: "terminal_run", state: "completed" })
  expect(JSON.parse(String(tool!.output))).toMatchObject({ shell: "shell 1", status: "idle", exit: null })
  expect(listed(h, id).map((s) => s.status)).toEqual(["idle"])
  expect(fake.requests()).toHaveLength(1)
  // Its record keeps it with no exit; the run's log, what let it run.
  const shell = listed(h, id)[0]!
  expect(readRecord(recordOf(h, id, shell.id))!.commands).toMatchObject([{ exit: null }])
  expect((await toolResults(h, id))[0]!.note).toBe("an allow rule")
})

test("a command that ends after the agent's next turn has begun keeps the run and call it started in", async () => {
  const dir = tempDir()
  const pipes = fakePipes(dir)
  const folder = path.join(dir, "session")
  const terminal = new EmployeeTerminal({
    shells: pipes.shells,
    sessionId: "S1",
    person: "minh",
    folder,
    instruments: new Instruments(() => {}),
    mode: () => "auto",
  })
  // Each run's gate let its command run, as an allow rule does.
  const { perms } = permissions({ mode: "ask" })
  const allowed = (command: string) => {
    const plan = terminal.plan("run", { command, why: "x" })
    if (!plan.decide) throw new Error("the terminal has nothing to decide")
    return decidedFor(plan, false)
  }
  const ledger = new Map([
    ["r1/n/1/0", allowed("make long")],
    ["r2/n/1/0", allowed("echo next")],
  ])
  const gated = { ...perms, decided: (callId: string | undefined) => ledger.get(callId ?? "") ?? null }
  terminal.bind(gated)
  const run = terminal.tools().run
  expect(json(await run.call({ command: "make long", why: "x", wait: 0 }, { callId: "r1/n/1/0" }))).toMatchObject({
    status: "running",
  })
  // The next turn's run is built while the command goes on: what it runs is its own.
  terminal.bind(gated)
  expect(json(await run.call({ command: "echo next", why: "x" }, { callId: "r2/n/1/0" }))).toMatchObject({ exit: 0 })
  pipes.end("make long", 0)
  const records = path.join(folder, "terminal")
  const commands = () =>
    fs.readdirSync(records).flatMap((id) => readRecord(path.join(records, id))!.commands)
      .map(({ command, run, call, exit }) => ({ command, run, call, exit }))
      .sort((a, b) => a.command.localeCompare(b.command))
  await waitFor(() => commands().every((c) => c.exit === 0), { what: "the long command's end" })
  expect(commands()).toEqual([
    { command: "echo next", run: "r2", call: "r2/n/1/0", exit: 0 },
    { command: "make long", run: "r1", call: "r1/n/1/0", exit: 0 },
  ])
  await terminal.close()
})

sandboxed("a command the agent was told is running goes on after Esc, and the agent reads it later", async () => {
  const fake = await fakeLlm()
  // It runs until the test writes to the fifo `gate`.
  const command = "cat gate && echo finished"
  fake.script(
    term("call_run", "run", { command, why: "takes a while", wait: 0 }),
    term("call_wait", "read", { shell: "shell 1", wait: 120 }, `"tool_call_id":"call_run"`),
    term("call_later", "read", { shell: "shell 1", wait: 30 }, "is it done"),
    said("call_later", "It finished."),
  )
  // The order that raced: Esc lands while the agent's read is on its way to the terminal, which holds it until the
  // test releases it, once Esc is done.
  let arrived = false
  let letThrough!: () => void
  const held = new Promise<void>((resolve) => (letThrough = resolve))
  const own = EmployeeTerminal.prototype.tools
  const spy = spyOn(EmployeeTerminal.prototype, "tools").mockImplementation(function (this: EmployeeTerminal) {
    const shells = own.call(this)
    const read = shells.read
    const call: typeof read.call = async (args, options) => {
      if (args.wait === 120) {
        arrived = true
        await held
      }
      return await read.call(args, options)
    }
    return { ...shells, read: { ...read, call } }
  })
  onTestFinished(() => spy.mockRestore())
  const h = await makeHarness(fake, { files: allowing("cat *") })
  const gate = path.join(h.folder, "gate")
  execFileSync("mkfifo", [gate], { env: { PATH: "/usr/bin:/bin" } })
  const id = await chat(h)
  await h.harness.prompt(id, "start it")
  const reading = async () => (await tools(h, id)).some((p) => p.call_id === "call_wait" && p.state === "running")
  await waitFor(reading, { what: "the agent's read" })
  await waitFor(() => arrived, { what: "the agent's read at the office" })
  // Esc cuts off the read, even one that reaches the terminal after it, never the command its run's reply said is
  // running.
  await h.harness.interrupt(id)
  letThrough()
  await waitFor(() => status(h, id) === "idle" && !running(h.registry, id), { what: "the turn's end" })
  expect(listed(h, id)[0]).toMatchObject({ status: "running", command })
  await release(gate)
  await waitFor(() => listed(h, id)[0]?.status === "idle", { timeout: 15_000, what: "the command's end" })
  await h.harness.prompt(id, "is it done?")
  await replied(h, id, "It finished.")
  const later = result(fake, "call_later")!
  expect(later).toMatchObject({ shell: "shell 1", status: "idle", exit: 0 })
  expect(later.output).toContain("finished")
  // Its record got its exit when it ended, after the agent's wait.
  expect(readRecord(recordOf(h, id, listed(h, id)[0]!.id))!.commands).toMatchObject([{ command, exit: 0 }])
})

sandboxed("End closes the session's shells and removes their listings", async () => {
  const fake = await fakeLlm()
  fake.script(term("call_sleep", "run", { command: "sleep 30.75", why: "waits", wait: 0 }), said("call_sleep", "Started."))
  const h = await makeHarness(fake, { files: allowing("sleep *") })
  const id = await chat(h)
  await h.harness.prompt(id, "start it")
  await replied(h, id, "Started.")
  const [shell] = listed(h, id)
  expect(shell).toMatchObject({ status: "running" })
  const sleeping = await ownSleepers("30.75")
  expect(sleeping).toHaveLength(1)
  await h.harness.end(id)
  await waitFor(() => status(h, id) === "ended", { what: "the end" })
  expect(await ended(sleeping)).toBe(true)
  await waitFor(() => listed(h, id).length === 0, { what: "the listing's removal" })
  expect(h.lives.some((e) => e.type === "instrument.removed" && e.session_id === id)).toBe(true)
  expect(readRecord(recordOf(h, id, shell!.id))!.state).toBe("ended")
})

sandboxed("the approvals' re-check reads the terminal's where, and a shell's start doesn't loop through the actor", async () => {
  const fake = await fakeLlm()
  const [a, b] = ["make && touch a.txt", "make && touch b.txt"]
  fake.script(
    { match: CHAT, tool_calls: [a, b].map((command, i) => ({ id: `call_${i}`, name: "terminal_run", arguments: { command, why: "builds" } })) },
    verdict(a, "ask", "runs the build"),
    verdict(b, "ask", "runs the build"),
    { match: `"tool_call_id":"call_1"`, content: "Built both." },
  )
  const h = await makeHarness(fake)
  fs.writeFileSync(path.join(h.folder, "Makefile"), "all:\n\ttrue\n")
  const id = await chat(h)
  await h.harness.prompt(id, "build it twice")
  const open = () => h.store.listQuestions({ sessionId: id, status: "open", source: "approval" })
  // The reply's later call waits behind the open card, as yian holds it.
  await waitFor(() => open().length === 1 && status(h, id) === "waiting", { what: "the first card" })
  // Auto's check was told the shell runs on the workspace profile, in the session's folder.
  const asked = fake.requests().map((r) => JSON.stringify(r.messages)).filter((text) => text.includes("<command>"))
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain("<profile>workspace</profile>")
  expect(asked[0]).toContain(`<folder>${h.folder}</folder>`)
  const first = open().find((q) => q.approval!.action === a)!
  await h.harness.answer(first.id, sessionOption(["make"]), "option", { by: CEO })
  await replied(h, id, "Built both.")
  // With make allowed, b's touch is a file operation in the workspace the terminal's sandbox writes, so the gate let
  // it run once a's card was answered: on the SSH-only reading, which writes nothing, it would have asked.
  expect([fs.existsSync(path.join(h.folder, "a.txt")), fs.existsSync(path.join(h.folder, "b.txt"))]).toEqual([true, true])
  const results = await toolResults(h, id)
  const of = (command: string) => results.find((r) => r.arguments?.command === command)!
  expect([of(a).releaseNote, of(b).note]).toEqual([`approved by @${CEO}`, "an allow rule"])
})

sandboxed("terminal_type into the workspace shell is refused", async () => {
  const fake = await fakeLlm()
  fake.script(
    term("call_echo", "run", { command: "echo ready", why: "starts a shell" }),
    term("call_type", "type", { shell: "shell 1", text: "y", why: "answers" }, `"tool_call_id":"call_echo"`),
    said("call_type", "It takes no input."),
  )
  const h = await makeHarness(fake)
  const id = await chat(h)
  await h.harness.prompt(id, "answer it")
  await replied(h, id, "It takes no input.")
  expect(result(fake, "call_type")).toMatchObject({ shell: "shell 1", refused: "this shell takes no input" })
  expect(h.store.listQuestions({ sessionId: id })).toEqual([])
})
