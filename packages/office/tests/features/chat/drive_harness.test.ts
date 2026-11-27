/** The template's SOP "drive a harness" (`shared/flows/drive_harness.yaml`): an employee hands a task to Codex or
 *  Claude Code, the chat's instrument, and sees it through; an interrupt of the run stops the harness turn it waits
 *  on; a resume replays what the harness did, and never starts a second session or sends a message again, after an
 *  office restart too. Each runs in an in-process worker on the fake model, with the fake Codex app-server or the fake
 *  Claude Code behind the employee's instrument. */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { iterRunRecords, type RunLogEntry } from "@ngocbh/yian/run"
import { EmployeeClaude } from "../../../src/features/chat/claude.ts"
import { EmployeeCodex } from "../../../src/features/chat/codex.ts"
import type { EmployeeInstrument } from "../../../src/features/chat/instrument.ts"
import { readFlow } from "../../../src/company/flow_yaml.ts"
import { loadConfined } from "../../../src/company/flows.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { speakers } from "../../../src/runtime/sessions/speakers.ts"
import type { OfficeTool } from "../../../src/runtime/worker/rpc.ts"
import type { SessionRecord } from "../../../src/runtime/store/store.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import type { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"
import { tempDir, waitFor } from "../../helpers.ts"
import { advanceJob, inProcessWorker, makeJob, Recorder, run } from "../../runtime/worker/helpers.ts"
import { allGone as claudesGone, makeClaude, reopened as reopenedClaude } from "../claude/helpers.ts"
import { allGone as codexesGone, makeCodex, reopened as reopenedCodex } from "../codex/helpers.ts"
import { fakeLlm, ROOT } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(async () => {
  await codexesGone()
  await claudesGone()
})

const SOP = "shared/flows/drive_harness.yaml"
const TASK = "Fix the failing build in packages/app."

type Kind = "codex" | "claude"

/** minh's main chat, opened by ngocbh, with the instrument of `kind` an SOP run's host binds: on the fake app-server
 *  or the fake Claude Code, whose scripted turns answer "The build is fixed.", then "The tests pass too." (with `long`,
 *  one turn that says "Reading the build files." and runs on for 30 s). `sessions` counts the harness sessions
 *  started, `resumes` the starts that resumed one, `messages` the messages sent to them, and `interrupts` the
 *  interrupts of their turns. `restart` is an office restart between two of the run's calls: the harness sessions
 *  stop, the instrument keeps them, the next office's sessions restore theirs, and the chat's next instrument takes the
 *  calls. */
async function rig(kind: Kind, { long = false }: { long?: boolean } = {}) {
  if (kind === "codex") {
    const h = makeCodex()
    h.fake.script(
      long
        ? [[...fc.agentMessage("a1", "Reading the build files."), { sleep: 30 }]]
        : [fc.agentMessage("a1", "The build is fixed."), fc.agentMessage("a2", "The tests pass too.")],
    )
    const cwd = fs.realpathSync(h.workspace)
    const make = (o: ConstructorParameters<typeof EmployeeCodex>[0]) => new EmployeeCodex(o)
    const { chat, instrument } = await employee(h, cwd, make)
    const r = {
      h, chat, instrument,
      sessions: () => h.fake.calls("thread/start").length,
      resumes: () => h.fake.calls("thread/resume").length,
      messages: () => h.fake.calls("turn/start").length + h.fake.calls("turn/steer").length,
      interrupts: () => h.fake.calls("turn/interrupt").length,
      async restart() {
        await r.h.sessions.closeAll()
        await r.instrument.suspend()
        r.h = reopenedCodex(r.h)
        await r.h.sessions.restore()
        r.instrument = (await employee(r.h, cwd, make, chat)).instrument
      },
    }
    return r
  }
  const turns = long
    ? [[{ say: "Reading the build files." }, { sleep: 30 }]]
    : [[{ say: "The build is fixed." }], [{ say: "The tests pass too." }]]
  const h = makeClaude({ script: { turns } })
  const make = (o: ConstructorParameters<typeof EmployeeClaude>[0]) => new EmployeeClaude(o)
  const { chat, instrument } = await employee(h, h.workspace, make)
  const log = () => h.fake.log()
  const r = {
    h, chat, instrument,
    sessions: () => log().filter((e) => e.dir === "start" && e.flags?.["session-id"] !== undefined).length,
    resumes: () => log().filter((e) => e.dir === "start" && e.flags?.resume !== undefined).length,
    messages: () => log().filter((e) => e.dir === "in" && e.msg?.type === "user").length,
    interrupts: () => log().filter((e) => e.dir === "in" && e.msg?.request?.subtype === "interrupt").length,
    async restart() {
      await r.h.sessions.closeAll()
      await r.instrument.suspend()
      r.h = reopenedClaude(r.h)
      await r.h.sessions.restore()
      r.instrument = (await employee(r.h, h.workspace, make, chat)).instrument
    },
  }
  return r
}

type Office = ReturnType<typeof makeCodex> | ReturnType<typeof makeClaude>

/** minh's main chat in `cwd` (`chat`, when given), and its instrument made by `make`. */
async function employee(
  h: Office,
  cwd: string,
  make: (o: ConstructorParameters<typeof EmployeeCodex>[0]) => EmployeeInstrument,
  given?: SessionRecord,
) {
  const head = await h.office.git.head()
  const chat =
    given ?? h.store.createSession(sessionRow({ cwd, repo_commit: head, opened_by: "ngocbh", connection: "office" }))
  const repo = loadRepo(await h.office.git.pin(head))
  const instrument = make({
    chat,
    sessions: h.sessions,
    folder: h.office.paths.sessionDir(chat.id),
    instruments: h.office.instruments,
    speakers: speakers(repo, chat),
  })
  return { chat, instrument }
}

/** Handlers serving the SOP's two groups: `kind`'s the instrument's tools, the other's none. */
function handlers(kind: Kind, instrument: EmployeeInstrument): Recorder {
  const tools = instrument.tools() as unknown as Record<string, OfficeTool>
  return new Recorder({ tools: kind === "codex" ? { codex: tools, claude: {} } : { codex: {}, claude: tools } })
}

/** A temp copy of the template to run the SOP from, and a runs folder. */
function where(): { pin: string; runs: string } {
  const root = tempDir()
  const pin = path.join(root, "pin")
  fs.cpSync(ROOT, pin, { recursive: true })
  return { pin, runs: path.join(root, "runs") }
}

/** A model reply that calls `kind`'s tool `tool` with `args`, as call `id`. */
function calls(kind: Kind, tool: string, args: Record<string, unknown>, id: string) {
  return { content: "", tool_calls: [{ id, name: `${kind}_${tool}`, arguments: args }] }
}

/** The messages of the `index`th model request. */
function request(fake: FakeLLM, index: number): Record<string, any>[] {
  return fake.requests()[index]!.messages as Record<string, any>[]
}

/** The result the model read for its tool call `id` in the `index`th request. */
function toolResult(fake: FakeLLM, index: number, id: string): string {
  return String(request(fake, index).find((m) => m.role === "tool" && m.tool_call_id === id)?.content)
}

/** Whether `entry` is the driver's tool result step for call `id`. */
function resultOf(id: string) {
  return (entry: RunLogEntry): boolean => {
    if (entry.kind !== "node_step") return false
    const { step } = entry.envelope.record as unknown as { step: Record<string, unknown> }
    return step.kind === "tool_result" && step.call_id === id
  }
}

/** The leading records of the run log `log` before the first that `stop` holds for, written under `runs` with the same
 *  run id: what a crash there leaves. Returns the new log's path. */
function cutBefore(log: string, stop: (entry: RunLogEntry) => boolean, runs: string): string {
  let end = 0
  for (const entry of iterRunRecords(log, { payloads: true })) {
    if (stop(entry)) break
    end = entry.end
  }
  const out = path.join(runs, path.basename(path.dirname(log)), "log.jsonl")
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, fs.readFileSync(log).subarray(0, end))
  return out
}

/** The text of the harness session's record conversation in the chat's folder. */
function conversation(r: Awaited<ReturnType<typeof rig>>, kind: Kind): string {
  const [listed] = r.h.office.instruments.list(r.chat.id)
  return fs.readFileSync(path.join(r.h.office.paths.sessionDir(r.chat.id), kind, listed!.id, "conversation.log"), "utf8")
}

test("the SOP routes to one driver per harness, each granting only its instrument and steering from messages", async () => {
  const flow = readFlow(fs.readFileSync(path.join(ROOT, SOP), "utf8")) as Record<string, any>
  expect(flow.description).toBeTruthy()
  expect(Object.keys(flow.input)).toEqual(["task", "harness", "messages"])
  expect(flow.input.messages).toBe("!Inbox(Message)")
  expect(flow.typedefs.Harness).toBe("Literal(codex, claude)")
  expect(flow.nodes.route).toMatchObject({ kind: "case", on: "${input.harness}" })
  expect(flow.nodes.route.cases).toEqual([
    { when: "codex", then: "codex" },
    { when: "claude", then: "claude" },
  ])
  for (const kind of ["codex", "claude"]) {
    const driver = flow.nodes[kind]
    expect([driver.kind, driver.tools, driver.steer_inbox, driver.output]).toEqual([
      "agent",
      [kind],
      "${input.messages}",
      "!Optional(str)",
    ])
  }
  expect(flow.nodes.claude.system_prompt).toBe(flow.nodes.codex.system_prompt)
  expect((await loadConfined(ROOT, path.join(ROOT, SOP))).name).toBe("drive_harness")
})

test.each(["codex", "claude"] as const)(
  "the SOP hands the task to %s in one session, stops it once done, and reports",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind)
    fake.script(
      calls(kind, "start", { message: TASK, wait: 120 }, "c1"),
      calls(kind, "stop", { [kind]: `${kind} 1` }, "c2"),
      { content: "The build is fixed; nothing is left." },
    )
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    await run(job, rec, { env: fake.env() })
    expect(rec.outcome).toMatchObject({ status: "succeeded", output: "The build is fixed; nothing is left." })
    // The driver is told the task, and how to drive the harness by its own tools.
    const [system, prompt] = request(fake, 0)
    const title = kind === "codex" ? "Codex" : "Claude Code"
    expect(String(system!.content)).toContain(`You hand a task to ${title}`)
    expect(String(system!.content)).toContain(`${kind}_start`)
    expect(String(prompt!.content)).toContain(TASK)
    expect(JSON.parse(toolResult(fake, 1, "c1"))).toMatchObject({ [kind]: `${kind} 1`, status: "idle" })
    expect([r.sessions(), r.messages()]).toEqual([1, 1])
    const [listed] = r.h.office.instruments.list(r.chat.id)
    expect(listed).toMatchObject({ kind, name: `${kind} 1`, driver: "minh", status: "ended" })
    expect(conversation(r, kind)).toContain("The build is fixed.")
  },
)

test.each(["codex", "claude"] as const)(
  "a resumed SOP replays the %s calls it recorded and starts no second session",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind)
    fake.script(calls(kind, "start", { message: TASK, wait: 120 }, "c1"), { content: "Done." })
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    await run(job, rec, { env: fake.env() })
    expect(rec.outcome?.status).toBe("succeeded")
    // The run stopped after the start's result was recorded, before the next model call's.
    const started = [...iterRunRecords(job.log, { payloads: true })].find(resultOf("c1"))!.seq
    const log = cutBefore(job.log, (entry) => entry.seq > started, tempDir())
    fake.script(calls(kind, "stop", { [kind]: `${kind} 1` }, "c2"), { content: "Fixed." })
    // The office ends the dead worker's calls before it resumes the run, as when a run's worker dies.
    r.instrument.cutCalls()
    const resumed = handlers(kind, r.instrument)
    await run(advanceJob(job, { log }), resumed, { env: fake.env() })
    expect(resumed.outcome).toMatchObject({ status: "succeeded", output: "Fixed." })
    // The replayed start is read as recorded: the resumed model call reads the start's reply.
    expect(JSON.parse(toolResult(fake, 2, "c1"))).toMatchObject({ [kind]: `${kind} 1`, status: "idle" })
    expect([r.sessions(), r.messages()]).toEqual([1, 1])
    expect(r.h.office.instruments.list(r.chat.id)).toHaveLength(1)
  },
)

test.each(["codex", "claude"] as const)(
  "a resumed SOP never sends a %s call a crash cut off again; the driver reads its outcome is unknown and checks",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind)
    fake.script(calls(kind, "start", { message: TASK, wait: 120 }, "c1"), { content: "Done." })
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    await run(job, rec, { env: fake.env() })
    expect([r.sessions(), r.messages()]).toEqual([1, 1])
    // A crash while the start waited: its model call is recorded, its result isn't.
    const log = cutBefore(job.log, resultOf("c1"), tempDir())
    fake.script(calls(kind, "history", { [kind]: `${kind} 1`, from: 0 }, "c2"), { content: "It was already fixed." })
    // The office ends the dead worker's calls before it resumes the run, as when a run's worker dies.
    r.instrument.cutCalls()
    const resumed = handlers(kind, r.instrument)
    await run(advanceJob(job, { log }), resumed, { env: fake.env() })
    expect(resumed.outcome).toMatchObject({ status: "succeeded", output: "It was already fixed." })
    expect(toolResult(fake, 2, "c1")).toContain("its outcome is unknown")
    // The driver read the session it had started rather than start another: what the harness did is there.
    expect(toolResult(fake, 3, "c2")).toContain("The build is fixed.")
    expect([r.sessions(), r.messages()]).toEqual([1, 1])
    expect(r.h.office.instruments.list(r.chat.id)).toHaveLength(1)
  },
)

test.each(["codex", "claude"] as const)(
  "a resumed SOP whose office restarted between its calls goes on in the %s session it started, and starts no second",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind)
    fake.script(calls(kind, "start", { message: TASK, wait: 120 }, "c1"), { content: "Done." })
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    await run(job, rec, { env: fake.env() })
    // The run stopped after the start's result was recorded, and the office restarted before it resumed.
    const started = [...iterRunRecords(job.log, { payloads: true })].find(resultOf("c1"))!.seq
    const log = cutBefore(job.log, (entry) => entry.seq > started, tempDir())
    await r.restart()
    fake.script(
      calls(kind, "send", { [kind]: `${kind} 1`, message: "Run the tests too.", wait: 120 }, "c2"),
      calls(kind, "stop", { [kind]: `${kind} 1` }, "c3"),
      { content: "Fixed and tested." },
    )
    const resumed = handlers(kind, r.instrument)
    await run(advanceJob(job, { log }), resumed, { env: fake.env() })
    expect(resumed.outcome).toMatchObject({ status: "succeeded", output: "Fixed and tested." })
    const sent = JSON.parse(toolResult(fake, 3, "c2"))
    expect(sent).toMatchObject({ [kind]: `${kind} 1`, status: "idle" })
    expect(sent.output).toContainEqual({ author: kind, text: "The tests pass too." })
    // One session, continued once on the harness's own resume, and each message sent once.
    expect([r.sessions(), r.resumes(), r.messages()]).toEqual([1, 1, 2])
    const listed = r.h.office.instruments.list(r.chat.id)
    expect(listed).toMatchObject([{ kind, name: `${kind} 1`, status: "ended" }])
    expect(conversation(r, kind)).toContain("The build is fixed.")
    expect(conversation(r, kind)).toContain("The tests pass too.")
  },
)

test.each(["codex", "claude"] as const)(
  "a resumed SOP whose office restarted mid-call reads the %s session's record from before the restart, and starts no second",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind)
    fake.script(calls(kind, "start", { message: TASK, wait: 120 }, "c1"), { content: "Done." })
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    await run(job, rec, { env: fake.env() })
    // The office went down while the start waited: its model call is recorded, its result isn't.
    const log = cutBefore(job.log, resultOf("c1"), tempDir())
    await r.restart()
    fake.script(calls(kind, "history", { [kind]: `${kind} 1`, from: 0 }, "c2"), { content: "It was already fixed." })
    const resumed = handlers(kind, r.instrument)
    await run(advanceJob(job, { log }), resumed, { env: fake.env() })
    expect(resumed.outcome).toMatchObject({ status: "succeeded", output: "It was already fixed." })
    expect(toolResult(fake, 2, "c1")).toContain("its outcome is unknown")
    expect(toolResult(fake, 3, "c2")).toContain("The build is fixed.")
    expect([r.sessions(), r.resumes(), r.messages()]).toEqual([1, 0, 1])
  },
)

test.each(["codex", "claude"] as const)(
  "an interrupt of the SOP's run stops the %s turn its driver waits on, and the driver stops with it",
  async (kind) => {
    const fake = await fakeLlm()
    const r = await rig(kind, { long: true })
    fake.script(calls(kind, "start", { message: TASK, wait: 120 }, "c1"), { content: "spare" })
    const rec = handlers(kind, r.instrument)
    const job = makeJob(where(), SOP, { inputs: { task: TASK, harness: kind } }, rec)
    const worker = await inProcessWorker(job, rec, { env: fake.env() })
    await waitFor(() => r.h.office.instruments.list(r.chat.id).find((i) => i.status === "running"), {
      what: `the ${kind} turn`,
    })
    // An interrupt of the run, as the office sends one: the driver's call learns of it while it waits on the turn.
    await worker.deliver({ id: "i1", op: "interrupt", inbox: "messages", standing: false })
    expect(await worker.wait()).not.toBeNull()
    expect(r.interrupts()).toBe(1)
    expect(rec.outcome).toMatchObject({ status: "succeeded", output: null })
    // The call's own reply, with what the harness said before the interrupt, is what the run recorded.
    const log = fs.readFileSync(job.log, "utf8")
    expect(log).toContain("Reading the build files.")
    expect(log).toContain("[interrupted]")
    // The driver ended interrupted: no model call came after the tool's reply, and the session stays to read.
    expect(fake.requests()).toHaveLength(1)
    expect([r.sessions(), r.messages()]).toEqual([1, 1])
    await waitFor(() => r.h.office.instruments.list(r.chat.id)[0]?.status === "idle", { what: "the turn's end" })
  },
)
