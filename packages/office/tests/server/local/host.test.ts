/** The no-office host: a built-in agent's chat, its flow in a kept worker, its cards, its four modes, Auto's check and
 *  its instruments, as the office runs a chat. Each test runs the fixture flow on the fake model. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspectRun, iterRunRecords } from "@ngocbh/yian/run"
import { isPending } from "@ngocbh/yian/tools"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type Instrument, now } from "@opencorp/protocol"
import { STOPPED } from "../../../src/runtime/permissions/classifier.ts"
import { sessionOption, YES } from "../../../src/runtime/questions/approval.ts"
import type { SessionBinding } from "../../../src/runtime/sessions/builtin.ts"
import type { LiveInstrument } from "../../../src/runtime/sessions/instruments.ts"
import { END_KILL_MS, OWNER, SessionsBusy } from "../../../src/server/local/host.ts"
import { readRecord } from "../../../src/tools/terminal/record.ts"
import { newId } from "../../../src/util/ids.ts"
import { fakeLlm } from "../../features/chat/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { recordFrames } from "../../runtime/worker/helpers.ts"
import { AGENT, CHECK, cards, FLOW, follow, gone, said, startHost, terminalCall, until } from "./helpers.ts"

setDefaultTimeout(90_000)

/** The model's typed verdict for Auto's check. */
const verdict = (verdict: string, reason: string) => ({ name: "Record", arguments: { verdict, reason } })

/** The text of the tool results request `n` (from 0) sent the model for its last calls. */
function results(requests: Record<string, unknown>[], n: number): string[] {
  const messages = requests[n]!.messages as { role: string; content: unknown; tool_calls?: unknown }[]
  const last = messages.findLastIndex((m) => m.role === "assistant" && m.tool_calls !== undefined)
  return messages.slice(last + 1).filter((m) => m.role === "tool").map((m) => String(m.content))
}

/** Waits until the session's last message is the assistant's `text`. */
async function replied(host: Awaited<ReturnType<typeof startHost>>["host"], text: string): Promise<void> {
  await waitFor(async () => (await said(host)).at(-1)?.[1].at(-1) === text, { what: `the reply ${text}` })
}

test("a local session's flow runs in a kept worker, starts in auto and streams the agent's reply", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hello from OpenCorp.", match: AGENT }, { content: "Again.", match: AGENT })
  const { host, folder, spawned } = await startHost(fake)
  const seen = follow(host)
  await until(host, "idle")
  const session = host.session()!
  expect(session).toMatchObject({
    person: "opencorp",
    harness: "yian",
    kind: "main",
    mode: "auto",
    opened_by: "owner",
    office: "local",
    status: "idle",
  })
  expect(session.repo_commit).toBe(createHash("sha256").update(FLOW).digest("hex"))
  expect(fs.readFileSync(path.join(folder, "pin", "local_chat.yaml"), "utf8")).toBe(FLOW)
  expect(fs.statSync(folder).mode & 0o777).toBe(0o700)

  await host.prompt("hi", OWNER)
  await replied(host, "Hello from OpenCorp.")
  await until(host, "idle")
  expect(await said(host)).toEqual([
    ["user", ["hi"]],
    ["assistant", ["Hello from OpenCorp."]],
  ])
  expect((await host.messages())[0]!.author).toBe("owner")
  // The owner's message and the reply went out as they came.
  const shown = seen.live.filter((e) => e.type === "message.updated").map((e) => e.data.role)
  expect(shown).toContain("user")
  expect(shown).toContain("assistant")
  expect(JSON.stringify(seen.live)).toContain("Hello")
  expect(seen.meta.some((e) => e.type === "session.updated" && e.data.status === "busy")).toBe(true)

  // The next turn goes to the same worker, which waited between them.
  await host.prompt("again", OWNER)
  await replied(host, "Again.")
  expect(spawned.filter((s) => s.dir === folder)).toHaveLength(1)
  expect(fs.existsSync(path.join(folder, "runs", session.run_ids[0]!, "log.jsonl"))).toBe(true)
})

test("a message during the reply steers it, and Esc interrupts it", async () => {
  const fake = await fakeLlm()
  fake.script(
    { content: "Working", tool_calls: [terminalCall("run", { command: "echo one", why: "say one" })], hold: 30, match: AGENT },
    { content: "Done.", match: AGENT },
    { content: "Long", hold: 30, hold_after: 1, match: AGENT },
  )
  onTestFinished(() => fake.release())
  const { host } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("hi", OWNER)
  await fake.waitForRequests(1)
  await until(host, "busy")
  await host.steer("Also say two.", OWNER)
  fake.release()
  const requests = await fake.waitForRequests(2)
  expect(JSON.stringify(requests[1])).toContain("Also say two.")
  await replied(host, "Done.")
  await until(host, "idle")

  await host.prompt("go on", OWNER)
  await fake.waitForRequests(3)
  await until(host, "busy")
  await host.interrupt()
  // The held reply's call ends; the interrupted reply makes no more.
  fake.release()
  await until(host, "idle")
  const users = (await said(host)).filter(([role]) => role === "user").map(([, texts]) => texts[0])
  expect(users).toEqual(["hi", "Also say two.", "go on"])
  // The interrupted reply asked nothing more of the model.
  expect(fake.requests()).toHaveLength(3)
})

test("a terminal command the mode asks about holds on an approval card; Yes runs it once and completes the call; No completes it with the owner's words and settles the reply's later calls", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "echo x >> count", why: "count" })], match: AGENT },
    { content: "Counted.", match: AGENT },
    {
      tool_calls: [
        terminalCall("run", { command: "echo y >> a", why: "a" }, "call_a"),
        terminalCall("run", { command: "echo z >> b", why: "b" }, "call_b"),
      ],
      match: AGENT,
    },
    { content: "Stopped.", match: AGENT },
  )
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("count", OWNER)
  const [card] = await cards(host, 1)
  expect(card).toMatchObject({
    source: "approval",
    asker: "opencorp",
    question: "echo x >> count",
    approval: { tool: "terminal_run" },
  })
  await until(host, "waiting")
  expect(host.session()!.waiting_on).toEqual(["owner"])
  await host.answer(card!.id, YES, "option", OWNER)
  await replied(host, "Counted.")
  expect(fs.readFileSync(path.join(work, "count"), "utf8")).toBe("x\n")
  expect(results(fake.requests(), 1)).toHaveLength(1)
  expect(JSON.parse(results(fake.requests(), 1)[0]!)).toMatchObject({ status: "idle", exit: 0 })
  await waitFor(() => host.question(card!.id)?.status === "consumed", { what: "the card consumed" })
  await until(host, "idle")

  await host.prompt("two more", OWNER)
  // One card at a time: yian decides the reply's later call once the card is answered, and the No settles it.
  const [first] = await cards(host, 1)
  await host.answer(first!.id, "use make instead", "text", OWNER)
  await replied(host, "Stopped.")
  expect(host.questions({})).toHaveLength(2)
  expect(results(fake.requests(), 3)).toEqual([
    "Not run: the user said no: use make instead",
    "Not run: the user said no: use make instead",
  ])
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
  expect(fs.existsSync(path.join(work, "b"))).toBe(false)
  // Yes ran its command once.
  expect(fs.readFileSync(path.join(work, "count"), "utf8")).toBe("x\n")
})

test("the mode route cycles the four modes; dontAsk refuses the open cards and asks nothing", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT },
    { content: "Refused.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "sudo touch b", why: "b" })], match: AGENT },
    { content: "Refused again.", match: AGENT },
  )
  const { host, work } = await startHost(fake)
  const seen = follow(host)
  await until(host, "idle")
  expect(host.session()!.mode).toBe("auto")
  for (const mode of ["default", "ask", "dontAsk", "auto"] as const) expect(host.setMode(mode, OWNER).mode).toBe(mode)
  // Each switch is published: the modes the session's events carry, each run of one mode counted once.
  const modes = () =>
    seen.meta
      .filter((e) => e.type === "session.updated")
      .map((e) => e.data.mode)
      .filter((mode, i, all) => i === 0 || mode !== all[i - 1])
  await waitFor(() => modes().length === 5, { what: "the mode events" })
  expect(modes()).toEqual(["auto", "default", "ask", "dontAsk", "auto"])

  host.setMode("ask", OWNER)
  await host.prompt("touch a", OWNER)
  const [card] = await cards(host, 1)
  host.setMode("dontAsk", OWNER)
  await replied(host, "Refused.")
  const refusal = "this session is now in dontAsk mode, which doesn't ask: Ask mode"
  expect(host.question(card!.id)).toMatchObject({ answer: refusal, answer_kind: "text", answered_by: "owner" })
  expect(results(fake.requests(), 1)).toEqual([`Not run: the user said no: ${refusal}`])

  await host.prompt("sudo touch b", OWNER)
  await replied(host, "Refused again.")
  expect(results(fake.requests(), 3)).toEqual([
    "Not run: this session doesn't ask (dontAsk mode): it runs as another user.",
  ])
  expect(host.questions({})).toHaveLength(1)
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
  expect(fs.existsSync(path.join(work, "b"))).toBe(false)
})

test("don't ask again adds a session rule that lets the reply's later call run, and no card offers always", async () => {
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
    { tool_calls: [terminalCall("run", { command: "touch c", why: "c" })], match: AGENT },
    { content: "Third.", match: AGENT },
  )
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("default", OWNER)
  await host.prompt("touch a and b", OWNER)
  const [held] = await cards(host, 1)
  expect(held!.options).toEqual([YES, sessionOption(["touch *"])])
  await host.answer(held!.id, sessionOption(["touch *"]), "option", OWNER)
  await replied(host, "Both.")
  expect(fs.existsSync(path.join(work, "a"))).toBe(true)
  expect(fs.existsSync(path.join(work, "b"))).toBe(true)
  // The rule let the later call run: it had no card.
  expect(host.questions({})).toHaveLength(1)
  const rule = { effect: "allow", kind: "command", pattern: "touch *" } as const
  expect(host.rules()).toEqual({ rules: [{ ...rule, source: "session", by: null, at: null, note: null }], errors: [] })

  await host.prompt("touch c", OWNER)
  await replied(host, "Third.")
  expect(fs.existsSync(path.join(work, "c"))).toBe(true)
  expect(host.questions({})).toHaveLength(1)
  host.removeRule({ ...rule, source: "session" }, OWNER)
  expect(host.rules().rules).toEqual([])
})

test("Auto's check runs as a classify worker job on the spec's model, its verdicts and run logs in the session's folder, and nothing is priced", async () => {
  const frames = recordFrames()
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT },
    {
      tool_calls: [verdict("run", "it makes an empty file")],
      usage: { prompt_tokens: 40, completion_tokens: 3 },
      match: CHECK,
    },
    { content: "Made it.", match: AGENT },
  )
  const { host, folder, work, spawned } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("make a", OWNER)
  await replied(host, "Made it.")
  expect(fs.existsSync(path.join(work, "a"))).toBe(true)
  expect(host.questions({})).toEqual([])

  const checks = path.join(folder, "checks")
  expect(fs.statSync(checks).mode & 0o777).toBe(0o700)
  expect(fs.statSync(path.join(checks, "verdicts.jsonl")).mode & 0o777).toBe(0o600)
  const lines = fs.readFileSync(path.join(checks, "verdicts.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({
    input: { kind: "command", command: "touch a" },
    verdict: "run",
    reason: "it makes an empty file",
    failed: false,
    cached: false,
    model: "stub",
    usage: { input_tokens: 40, output_tokens: 3 },
  })
  expect(Object.keys(lines[0]).sort()).toEqual(
    ["at", "cached", "failed", "input", "model", "reason", "run_id", "usage", "verdict"].sort(),
  )
  expect(fs.existsSync(path.join(checks, `${lines[0].run_id}.jsonl`))).toBe(true)
  expect(host.session()!.cost).toBe(0)
  // Its own worker, on the spec's model, never the chat's.
  expect(spawned).toHaveLength(2)
  expect(spawned[1]!.dir).not.toBe(folder)
  const starts = frames.filter((f) => f.includes('"type":"start"') && f.includes('"kind":"classify"'))
  expect(starts).toHaveLength(1)
  expect(starts[0]).toContain('"model":"stub"')
  await waitFor(() => gone(spawned[1]!.pid), { what: "the check's worker to end" })
})

test("Esc while Auto's check runs runs nothing", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT },
    { tool_calls: [verdict("run", "it makes an empty file")], hold: true, match: CHECK },
  )
  onTestFinished(() => fake.release())
  const { host, folder, work, spawned } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("make a", OWNER)
  await waitFor(() => fake.requests().some((r) => JSON.stringify(r).includes(CHECK)), { what: "the check's request" })
  await host.interrupt()
  await until(host, "idle")
  fake.release()
  const verdicts = path.join(folder, "checks", "verdicts.jsonl")
  await waitFor(() => fs.existsSync(verdicts), { what: "the check's record" })
  expect(JSON.parse(fs.readFileSync(verdicts, "utf8"))).toMatchObject({ verdict: "ask", reason: STOPPED, failed: true })
  await waitFor(() => gone(spawned[1]!.pid), { what: "the check's worker to end" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
  expect(host.questions({})).toEqual([])
})

test("ask_user holds a question card the owner answers", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [{ name: "ask_user", arguments: { question: "Which host?", options: ["alpha", "beta"] } }], match: AGENT },
    { content: "Going to beta.", match: AGENT },
  )
  const { host } = await startHost(fake)
  await until(host, "idle")
  await host.prompt("which host?", OWNER)
  const [card] = await cards(host, 1)
  expect(card).toMatchObject({ source: "ask_user", asker: "opencorp", question: "Which host?" })
  expect(card!.options).toContain("beta")
  await until(host, "waiting")
  await host.answer(card!.id, "beta", "option", OWNER)
  await replied(host, "Going to beta.")
  expect(results(fake.requests(), 1)[0]).toContain('The user chose "beta"')
  await waitFor(() => host.question(card!.id)?.status === "consumed", { what: "the answer consumed" })
})

/** An instrument a feature owns, which records every call the host makes on it. */
function owned(sessionId: string): LiveInstrument & { calls: string[] } {
  const id = newId()
  const calls: string[] = []
  const info: Instrument = {
    id,
    session_id: sessionId,
    kind: "terminal",
    name: "connection",
    driver: "opencorp",
    profile: "none",
    interactive: true,
    size: { cols: 80, rows: 24 },
    status: "idle",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  return {
    id,
    interactive: true,
    calls,
    info: () => info,
    keys: () => void calls.push("keys"),
    interrupt: () => void calls.push("interrupt"),
    resize: () => void calls.push("resize"),
  }
}

test("End closes the inbox, the run and its worker end, and the host's instruments end, but not one a feature owns", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "echo hi", why: "hi" })], match: AGENT },
    { content: "Said hi.", match: AGENT },
  )
  const { host, binding, spawned, folder } = await startHost(fake)
  const seen = follow(host)
  await until(host, "idle")
  const feature = owned(host.id)
  binding.instruments.add(feature)
  await host.prompt("say hi", OWNER)
  await replied(host, "Said hi.")
  const [shell] = host.instruments.list(host.id).filter((i) => i.id !== feature.id)
  expect(shell).toMatchObject({ kind: "terminal", driver: "opencorp", profile: "none", interactive: true })
  await host.end()
  await host.ended
  expect(host.session()!.status).toBe("ended")
  await waitFor(() => gone(spawned[0]!.pid), { what: "the worker to end" })
  expect(host.instruments.list(host.id)).toEqual([])
  const removed = seen.live.filter((e) => e.type === "instrument.removed").map((e) => e.data.id)
  expect(removed.sort()).toEqual([shell!.id, feature.id].sort())
  expect(readRecord(path.join(folder, "terminal", shell!.id))?.state).toBe("ended")
  expect(feature.calls).toEqual([])
  await expect(host.prompt("more", OWNER)).rejects.toMatchObject({ status: 409, code: "not_live" })
})

/** The host's chat flow with a second inbox, `queued`, which each turn's take reads beside `messages`. */
const QUEUE_FLOW = [
  ["input:\n  messages: !Inbox(Message)", "input:\n  queued: !Inbox(Message)\n  messages: !Inbox(Message)"],
  ["      messages: !Inbox(Message)\n", "      messages: !Inbox(Message)\n      queued: !Inbox(Message)\n"],
  ["          from: ${input.messages}\n", "          from:\n            - ${input.messages}\n            - ${input.queued}\n"],
  ["said: ${heard.output.events}", "said: ${[e.event for e in heard.output.events]}"],
  ["history + heard.output.events +", "history + [e.event for e in heard.output.events] +"],
  ["      messages: ${input.messages}\n      history: []", "      messages: ${input.messages}\n      queued: ${input.queued}\n      history: []"],
].reduce((flow, [from, to]) => {
  if (flow.split(from!).length !== 2) throw new Error(`the host's flow no longer holds ${JSON.stringify(from)} once`)
  return flow.replace(from!, to!)
}, FLOW)

test("End closes each inbox its turn's take reads, the chat's first, and the session ends", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "Hi.", match: AGENT })
  const { host, folder } = await startHost(fake, { flow: QUEUE_FLOW })
  await until(host, "idle")
  await host.prompt("hello", OWNER)
  await replied(host, "Hi.")
  await host.end()
  await host.ended
  expect(host.session()!.status).toBe("ended")
  // The take waits on queued once messages is closed; the run ends once both are.
  const runs = fs.readdirSync(path.join(folder, "runs"))
  expect(runs).toHaveLength(1)
  const log = path.join(folder, "runs", runs[0]!, "log.jsonl")
  const closed = [...iterRunRecords(log, { kinds: ["inbox_closed"] })]
    .map((entry) => (entry.envelope.record as unknown as { inbox: string }).inbox)
  expect(closed).toEqual(["messages", "queued"])
  expect(inspectRun(log).status).toBe("succeeded")
})

/** What `call` throws, or null. */
function thrown(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  return null
}

test("a worker killed mid-session fails the session: its cards go stale and every listing is removed", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "echo ready", why: "ready" })], match: AGENT },
    { content: "Ready.", match: AGENT },
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a", shell: "shell 1" })], match: AGENT },
  )
  const { host, binding, spawned, work } = await startHost(fake)
  const seen = follow(host)
  await until(host, "idle")
  const feature = owned(host.id)
  binding.instruments.add(feature)
  await host.prompt("get ready", OWNER)
  await replied(host, "Ready.")
  host.setMode("ask", OWNER)
  await host.prompt("touch a", OWNER)
  const [card] = await cards(host, 1)
  await until(host, "waiting")
  expect(host.instruments.list(host.id)).toHaveLength(2)

  process.kill(spawned[0]!.pid, "SIGKILL")
  await host.ended
  expect(host.session()).toMatchObject({ status: "failed", waiting_on: [] })
  expect(host.question(card!.id)?.status).toBe("stale")
  expect(host.instruments.list(host.id)).toEqual([])
  await waitFor(() => seen.live.filter((e) => e.type === "instrument.removed").length === 2, { what: "the removals" })
  expect(feature.calls).toEqual([])
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
})

test("End ends a worker that stopped answering within its bound", async () => {
  const fake = await fakeLlm()
  const { host, spawned } = await startHost(fake)
  await until(host, "idle")
  const { pid } = spawned[0]!
  process.kill(pid, "SIGSTOP")
  onTestFinished(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })
  const started = performance.now()
  await host.end()
  await host.ended
  expect(performance.now() - started).toBeLessThan(END_KILL_MS + 2_000)
  expect(host.session()!.status).toBe("ended")
  await waitFor(() => gone(pid), { what: "the stopped worker to be gone" })
})

test("shells an earlier session left running read interrupted once a host starts", async () => {
  const sessions = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-sessions-")))
  onTestFinished(() => fs.rmSync(sessions, { recursive: true, force: true }))
  const id = newId()
  const dir = path.join(sessions, newId(), "terminal", id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const meta = { id, name: "shell 1", kind: "terminal", profile: "ssh", driver: "opencorp", started: now() }
  const command = { command: "sleep 100", by: "opencorp", at: now() }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, state: "running", commands: [command] }), {
    mode: 0o600,
  })
  expect(readRecord(dir)?.state).toBe("running")
  const fake = await fakeLlm()
  const { host } = await startHost(fake, { sessions })
  expect(readRecord(dir)).toMatchObject({ state: "interrupted", commands: [command] })
  await host.close()
})

test("an answer once End has begun is refused, and its command never runs", async () => {
  const fake = await fakeLlm()
  fake.script({ tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT })
  const { host, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("touch a", OWNER)
  const [card] = await cards(host, 1)
  const ending = host.end()
  expect(thrown(() => host.answer(card!.id, YES, "option", OWNER))).toMatchObject({ status: 409, code: "ending" })
  await ending
  await host.ended
  expect(thrown(() => host.answer(card!.id, YES, "option", OWNER))).toMatchObject({ status: 409, code: "not_live" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(fs.existsSync(path.join(work, "a"))).toBe(false)
})

test("a feature's question card is never answered by a session rule", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "touch a", why: "a" })], match: AGENT },
    { content: "Made a.", match: AGENT },
  )
  const { host, binding, work } = await startHost(fake)
  await until(host, "idle")
  host.setMode("default", OWNER)
  // The feature's own card, for what the session rule below would allow.
  const card = { title: "Save it?", question: "touch b", options: ["Save", "Don't"], reason: "saving asks in every mode" }
  const ran: string[] = []
  const runId = host.session()!.run_ids[0]!
  const act = async () => {
    ran.push("save")
    return "saved"
  }
  expect(isPending(binding.ask(card, `${runId}/feature/1`, act))).toBe(true)
  await host.prompt("touch a", OWNER)
  const [own, gated] = await cards(host, 2)
  expect(own).toMatchObject({ question: "touch b", source: "ask_user" })
  await host.answer(gated!.id, sessionOption(["touch *"]), "option", OWNER)
  await replied(host, "Made a.")
  expect(fs.existsSync(path.join(work, "a"))).toBe(true)
  expect(host.question(own!.id)).toMatchObject({ status: "open", answer: null, answered_by: null })
  expect(ran).toEqual([])
})

test("a second host on the same sessions folder is refused while the first runs, and never marks its shells interrupted", async () => {
  const fake = await fakeLlm()
  fake.script(
    { tool_calls: [terminalCall("run", { command: "sleep 30", why: "wait", wait: 1 })], match: AGENT },
    { content: "Waiting.", match: AGENT },
  )
  const first = await startHost(fake)
  await until(first.host, "idle")
  await first.host.prompt("wait", OWNER)
  await replied(first.host, "Waiting.")
  const [shell] = first.host.instruments.list(first.host.id)
  const record = path.join(first.folder, "terminal", shell!.id)
  expect(readRecord(record)?.state).toBe("running")
  const sessions = path.dirname(first.folder)
  await expect(startHost(fake, { sessions })).rejects.toThrow(SessionsBusy)
  await expect(startHost(fake, { sessions })).rejects.toThrow(`another host is running the sessions in ${sessions}`)
  // The second spawned no worker, and the first's shell runs on, its record as it was.
  expect(readRecord(record)?.state).toBe("running")
  expect(first.terminal.shells()[0]!.state.status).toBe("running")
  // Once the first has closed, the next host on the folder starts.
  await first.host.close()
  const next = await startHost(fake, { sessions })
  await until(next.host, "idle")
  expect(readRecord(record)?.state).not.toBe("running")
})

test("the owner's first message is sent from them as the session opens", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "On it.", match: AGENT })
  const { host } = await startHost(fake, { first: "Learn how this machine reaches HQ" })
  await replied(host, "On it.")
  expect(await said(host)).toEqual([
    ["user", ["Learn how this machine reaches HQ"]],
    ["assistant", ["On it."]],
  ])
  expect((await host.messages())[0]!.author).toBe("owner")
})

/** The fixture flow with a feature's `card` group granted too. */
const CARD_FLOW = FLOW.replace("tools: [terminal, ask_user]", "tools: [terminal, ask_user, card]")

/** A feature's tool, a group of one, that holds its call on a question card; its act gets the answer and says what it
 *  got. */
function cardGroup(acts: { value: string; typed: boolean }[]) {
  return (binding: SessionBinding) => ({
    card: {
      card: {
        description: "Ask the owner to save it.",
        parameters: { type: "object", properties: {} },
        call: (_args: Record<string, unknown>, options?: { callId?: string }) =>
          binding.ask(
            { title: "OpenCorp wants to save it", question: "1  the file", options: ["Save it", "Don't"], reason: "saving always asks" },
            options!.callId!,
            async (answer) => {
              acts.push(answer)
              return `the owner said ${answer.value}`
            },
          ),
      },
    },
  })
}

test("a feature's question card asks in every mode but dontAsk; the owner's answer, chosen or typed, goes to its act, whose output the agent gets", async () => {
  const fake = await fakeLlm()
  const save = { tool_calls: [{ name: "card", arguments: {} }], match: AGENT }
  // The first turn holds the card beside a command the mode asks about.
  const both = {
    tool_calls: [
      { name: "card", arguments: {}, id: "call_card" },
      terminalCall("run", { command: "touch a", why: "a" }, "call_touch"),
    ],
    match: AGENT,
  }
  fake.script(both, { content: "Saved.", match: AGENT }, save, { content: "Changed.", match: AGENT }, save, {
    content: "Refused.",
    match: AGENT,
  })
  const acts: { value: string; typed: boolean }[] = []
  const { host, work } = await startHost(fake, { flow: CARD_FLOW, groups: cardGroup(acts) })
  await until(host, "idle")
  host.setMode("default", OWNER)
  await host.prompt("save", OWNER)
  const held = await cards(host, 2)
  const card = held.find((q) => q.source === "ask_user")
  const touch = held.find((q) => q.source === "approval")
  // A rule the owner adds while it is open decides the command's card, and never the save card.
  host.answer(touch!.id, sessionOption(["touch *"]), "option", OWNER)
  await waitFor(() => fs.existsSync(path.join(work, "a")), { what: "touch a to run" })
  expect(host.rules().rules.map((rule) => rule.pattern)).toEqual(["touch *"])
  expect(host.question(card!.id)?.status).toBe("open")
  expect(acts).toEqual([])
  expect(card).toMatchObject({
    source: "ask_user",
    asker: "opencorp",
    title: "OpenCorp wants to save it",
    question: "1  the file",
    options: ["Save it", "Don't"],
  })
  host.answer(card!.id, "Save it", "option", OWNER)
  await replied(host, "Saved.")
  expect(results(fake.requests(), 1)[0]).toBe("the owner said Save it")
  await until(host, "idle")
  host.setMode("ask", OWNER)
  await host.prompt("save again", OWNER)
  const [typed] = await cards(host, 1)
  host.answer(typed!.id, "use node2", "text", OWNER)
  await replied(host, "Changed.")
  expect(acts).toEqual([
    { value: "Save it", typed: false },
    { value: "use node2", typed: true },
  ])
  await until(host, "idle")
  // dontAsk refuses it before any card, and its act never runs.
  host.setMode("dontAsk", OWNER)
  await host.prompt("and again", OWNER)
  await replied(host, "Refused.")
  expect(results(fake.requests(), 5)).toEqual(["Not run: this session doesn't ask (dontAsk mode): saving always asks."])
  expect(acts).toHaveLength(2)
  // The two save cards and the command's: none for the refused one.
  expect(host.questions({})).toHaveLength(3)
})

test("switching to dontAsk refuses an open question card, and Esc answers one interrupted; neither runs its act", async () => {
  const fake = await fakeLlm()
  const save = { tool_calls: [{ name: "card", arguments: {} }], match: AGENT }
  fake.script(save, { content: "Refused.", match: AGENT }, save, { content: "Stopped.", hold: 30, match: AGENT })
  onTestFinished(() => fake.release())
  const acts: { value: string; typed: boolean }[] = []
  const { host } = await startHost(fake, { flow: CARD_FLOW, groups: cardGroup(acts) })
  await until(host, "idle")
  await host.prompt("save", OWNER)
  const [card] = await cards(host, 1)
  host.setMode("dontAsk", OWNER)
  await replied(host, "Refused.")
  expect(results(fake.requests(), 1)).toEqual(["Not run: this session doesn't ask (dontAsk mode): saving always asks."])
  expect(host.question(card!.id)).toMatchObject({ answered_by: "owner", answer_kind: "text" })
  await until(host, "idle")
  host.setMode("auto", OWNER)
  await host.prompt("save", OWNER)
  const [second] = await cards(host, 1)
  await host.interrupt()
  await waitFor(() => host.question(second!.id)?.answer_kind === "interrupted", { what: "the card interrupted" })
  expect(acts).toEqual([])
})

test("a run that fails ends the session failed, and keeps why, as the run said it", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 400, match: AGENT })
  const { host } = await startHost(fake, { first: "hi" })
  await host.ended
  expect(host.session()!.status).toBe("failed")
  expect(host.failure).toContain("scripted error 400")
})

test("a session that ends as asked keeps no failure", async () => {
  const fake = await fakeLlm()
  const { host } = await startHost(fake)
  await until(host, "idle")
  await host.end()
  await host.ended
  expect([host.session()!.status, host.failure]).toEqual(["ended", null])
})
