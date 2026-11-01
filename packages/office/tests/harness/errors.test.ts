/** Codex that can't start, errors, a dead app-server, an unloaded thread, token counts. */
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { RpcClosed, RpcError } from "../../src/harness/rpc.ts"
import { usageBase } from "../../src/harness/session.ts"
import { sameProcess, startTime } from "../../src/install/proc.ts"
import type { SessionRecord, WorkerRecord } from "../../src/store/store.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { waitFor } from "../helpers.ts"
import { session } from "../store/helpers.ts"
import {
  allGone,
  type Codex,
  codexLog,
  errors,
  makeCodex,
  messages,
  requestsValid,
  restarted,
  start,
  status,
  stored,
  texts,
  turnRunning,
} from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** What Codex answered the spike's thread/resume of a thread another app-server had loaded. */
const WRITER_LOCK = {
  code: -32600,
  message: "thread 01a1456b-695d-7440-bc59-6b401d4bb3ea already has an active writer",
}
/** Real Codex's stderr: several log streams at once, and lines that have nothing to do with the session. */
const STDERR = "ERROR rmcp::transport::auth: OAuth token refresh failed for MCP server jira WARN codex_core: retrying"

/** A JSON object from the fake's log: `any`, since the assertions read whatever was written. */
type Entry = Record<string, any>

/** The params of each request the office sent with `method`. */
function calls(h: Codex, method: string): Entry[] {
  return h.fake.calls(method) as Entry[]
}

/** The keys of the stored worker records. */
function workerKeys(h: Codex): string[] {
  return h.store.listWorkers().map((r) => r.key)
}

/** The error Codex answers a turn/start with for a thread it has unloaded. */
function unloaded(): RpcError {
  return new RpcError(-32600, "thread not found: thr_1")
}

/** A promise and the function that resolves it. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const opened = new Promise<void>((resolve) => (release = resolve))
  return [opened, release]
}

/** Prompts `sid` and waits until its crash is handled: an error shown and the session idle. */
async function crashed(h: Codex, sid: string, text = "go"): Promise<void> {
  await h.sessions.prompt(sid, text)
  await waitFor(() => errors(h, sid).length > 0 && status(h, sid) === "idle", { what: "the crash handled" })
}

test("codex missing fails the session and says what to do", async () => {
  // The daemon pins Codex as one of its tools; this office pins none.
  const h = makeCodex({ command: undefined })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  expect(errors(h, sid)[0]).toContain("isn't installed")
  expect(h.store.listWorkers()).toEqual([])
})

test("a signed out codex fails the session and says to sign in", async () => {
  const h = makeCodex()
  h.fake.script([], { account: null })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  expect(errors(h, sid)[0]).toContain("codex login")
  expect(h.store.listWorkers()).toEqual([])
})

test("an error that codex retries is only logged and one it doesnt is shown", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.error("rate limited, retrying", { willRetry: true }),
      fc.error("stream broke", { willRetry: false }),
      { end: "failed", error: { message: "usage limit reached" } },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => status(h, sid) === "idle" && errors(h, sid).length === 2, { what: "two errors" })
  expect(errors(h, sid)).toEqual(["Codex: stream broke", "Codex's turn failed: usage limit reached"])
})

test("a failed turn repeating the error shown shows it once", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.error("usage limit reached", { willRetry: false }),
      { end: "failed", error: { message: "usage limit reached" } },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => status(h, sid) === "idle" && errors(h, sid).length > 0, { what: "the error" })
  expect(errors(h, sid)).toEqual(["Codex: usage limit reached"])
})

test("a dead app server leaves the session idle and the next message reloads the thread", async () => {
  const h = makeCodex()
  h.fake.script(
    [
      [
        ...fc.agentMessage("m1", "Working").slice(0, 2),
        fc.commandApproval(1, "c1", "x", { wait: false }),
        { sleep: 0.3 },
        { spawn: 300 },
        { exit: 1 },
      ],
      fc.agentMessage("m2", "Back again"),
    ],
    { stderr: STDERR },
  )
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => errors(h, sid).some((e) => e.includes("Codex stopped")) && status(h, sid) === "idle", {
    what: "the crash handled",
  })
  expect(errors(h, sid)).toEqual(["Codex stopped unexpectedly. Send a message to start it again."])
  expect(h.store.listQuestions({ sessionId: sid }).map((q) => q.status)).toEqual(["stale"])
  expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
  expect(h.store.getSession(sid)!.harness_turn_id).toBeNull()
  const [child] = h.fake.spawned() // a command the dead app-server left running
  await waitFor(() => startTime(child!) === null, { what: "the command child killed with the group" })
  expect(h.store.listWorkers()).toEqual([])
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  await waitFor(() => texts(h, sid).includes("Back again"), { what: "the reloaded turn" })
  const resumes = calls(h, "thread/resume")
  expect(resumes).toHaveLength(1)
  expect(resumes[0]!.threadId).toBe("thr_1")
  expect(resumes[0]!.approvalPolicy).toBe("on-request")
  expect(resumes[0]!.excludeTurns).toBeTruthy()
  expect(calls(h, "initialize")).toHaveLength(2)
  expect(workerKeys(h)).toEqual([`harness:${sid}`]) // the new one's record
  requestsValid(h.fake)
})

test("a crash leaves codex stderr in its codex log and the office log points there", async () => {
  const h = makeCodex()
  h.fake.script([[{ exit: 1 }]], { stderr: STDERR })
  const sid = await start(h, h.workspace)
  await crashed(h, sid)
  expect(stored(h, sid)).not.toContain(STDERR)
  expect(codexLog(h, sid)).toContain(STDERR)
  const notes = h.lines.filter((l) => l.includes("exited unexpectedly"))
  expect(notes).toHaveLength(1)
  const [note] = notes
  expect(note).toContain(sid)
  expect(note).toContain(`Codex's output is in ${path.join(h.office.paths.runDir(sid), "codex.log")}`)
  expect(note).not.toContain(STDERR)
})

test("codex that dies before the handshake says what to do and where its output is", async () => {
  // stderr is codex.log's file descriptor, so the write is synchronous.
  const script = `process.stderr.write(${JSON.stringify(`${STDERR}\n`)}); process.exit(1)`
  const h = makeCodex({
    command: () => [process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", script],
  })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  const log = path.join(h.office.paths.runDir(sid), "codex.log")
  const shown = errors(h, sid)
  expect(shown).toHaveLength(1)
  expect(shown[0]).toContain("Codex didn't start")
  expect(shown[0]).toContain("opencorp doctor")
  expect(shown[0]).toContain(`Codex's output is in ${log}`)
  expect(stored(h, sid)).not.toContain(STDERR)
  expect(codexLog(h, sid)).toContain(STDERR)
  const notes = h.lines.filter((l) => l.includes(sid))
  expect(notes).toHaveLength(1)
  expect(notes[0]!.split(log)).toHaveLength(2)
  expect(notes[0]).not.toContain(STDERR)
})

test("codex that dies while loading the thread says what to do and where its output is", async () => {
  const h = makeCodex()
  h.fake.script([], { load_exit: 1, stderr: STDERR })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  const log = path.join(h.office.paths.runDir(sid), "codex.log")
  const shown = errors(h, sid)
  expect(shown).toHaveLength(1)
  expect(shown[0]).toContain("Codex didn't start")
  expect(shown[0]).toContain("opencorp doctor")
  expect(shown[0]).toContain(`Codex's output is in ${log}`)
  expect(stored(h, sid)).not.toContain(STDERR)
  expect(codexLog(h, sid)).toContain(STDERR)
  const notes = h.lines.filter((l) => l.includes(sid))
  expect(notes).toHaveLength(1)
  expect(notes[0]).not.toContain("\n") // an expected failure, not a stack
  expect(notes[0]!.split(log)).toHaveLength(2)
  expect(notes[0]).not.toContain(STDERR)
  expect(h.store.listWorkers()).toEqual([])
})

test("ending after a crash without a reload leaves no record or children", async () => {
  const h = makeCodex()
  h.fake.script([[{ spawn: 300 }, { exit: 1 }]])
  const sid = await start(h, h.workspace)
  const seen: WorkerRecord[][] = []
  h.hooks.endStatus.push(() => {
    seen.push(h.store.listWorkers())
    return undefined
  })
  await crashed(h, sid)
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "the end" })
  const [child] = h.fake.spawned()
  expect(seen).toEqual([[]])
  expect(h.store.listWorkers()).toEqual([])
  expect(startTime(child!)).toBeNull()
})

test("a reload codex refuses leaves the session idle with why", async () => {
  const h = makeCodex()
  h.fake.script([[{ exit: 1 }]])
  const sid = await start(h, h.workspace)
  await crashed(h, sid)
  h.fake.script([], { resume_error: { code: -32600, message: "no rollout found" } })
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  await waitFor(() => errors(h, sid).length === 2, { what: "the refused reload" })
  expect(errors(h, sid)[1]).toContain("no rollout found")
  expect(status(h, sid)).toBe("idle")
  expect(h.store.listWorkers()).toEqual([])
  h.fake.script([[], fc.agentMessage("m1", "Third time")]) // the fake's turn count goes on: this is turn 2
  expect(await h.sessions.prompt(sid, "and again")).toBe("queued")
  await waitFor(() => texts(h, sid).includes("Third time"), { what: "the next reload's turn" })
})

test("an unloaded thread is reloaded by the next message", async () => {
  const h = makeCodex()
  h.fake.script([[fc.threadClosed()], fc.agentMessage("m1", "Reloaded")])
  const sid = await start(h, h.workspace)
  const old = h.sessions.get(sid)!.process!
  await h.sessions.prompt(sid, "go")
  await waitFor(() => status(h, sid) === "idle" && h.store.listWorkers().length === 0, { what: "the unload" })
  expect(errors(h, sid)).toEqual([])
  expect(old.proc!.exitCode).toBe(0) // closed through its stdin, as Codex exits then; not killed
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  await waitFor(() => texts(h, sid).includes("Reloaded"), { what: "the reloaded turn" })
  expect(calls(h, "thread/resume")[0]!.threadId).toBe("thr_1")
})

test("a message codex says has no thread reloads it first", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Reloaded")])
  const sid = await start(h, h.workspace)
  const old = h.sessions.get(sid)!.process!
  const oldPid = old.pid
  spyOn(old.rpc!, "request").mockRejectedValue(unloaded())
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  await waitFor(() => texts(h, sid).includes("Reloaded"), { what: "the reloaded turn" })
  expect(calls(h, "thread/resume")[0]!.threadId).toBe("thr_1")
  expect(workerKeys(h)).toEqual([`harness:${sid}`])
  expect(startTime(oldPid)).toBeNull()
  expect(errors(h, sid)).toEqual([])
  expect(texts(h, sid, "user")).toEqual(["again"])
})

test("a message another message is reloading for waits for that reload", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Both read")])
  const sid = await start(h, h.workspace)
  const old = h.sessions.get(sid)!.process!
  const [opened, release] = gate()
  const entered: string[] = []
  spyOn(old.rpc!, "request").mockImplementation(async (method) => {
    entered.push(method)
    await opened // both messages are inside turn/start on the old app-server before either hears back
    throw unloaded()
  })
  const got = Promise.all([h.sessions.prompt(sid, "one"), h.sessions.prompt(sid, "two")])
  await waitFor(() => entered.length === 2, { what: "both messages sent" })
  release()
  expect(await got).toEqual(["queued", "queued"])
  await waitFor(() => texts(h, sid).includes("Both read") && status(h, sid) === "idle", { what: "the reloaded turn" })
  // The old app-server's mocked calls never reach the fake's log.
  const turns = calls(h, "turn/start")
  expect(turns).toHaveLength(1)
  expect((turns[0]!.input[0].text as string).split("\n\n").sort()).toEqual(["one", "two"])
})

test("an esc while codex says the thread is unloaded drops the message", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Reloaded")])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const [opened, release] = gate()
  let entered = false
  spyOn(live.process!.rpc!, "request").mockImplementation(async () => {
    entered = true
    await opened
    throw unloaded()
  })
  const sending = h.sessions.prompt(sid, "go")
  await waitFor(() => entered, { what: "turn/start sent" })
  await h.sessions.interrupt(sid)
  release()
  expect(await sending).toBe("queued")
  await waitFor(() => calls(h, "thread/resume").length === 1 && !live.loading && status(h, sid) === "idle", {
    what: "the reload",
  })
  expect(calls(h, "turn/start")).toEqual([])
  expect(texts(h, sid)).toEqual(["[interrupted]"])
  expect(await h.sessions.prompt(sid, "again")).toBe("turn")
  await waitFor(() => texts(h, sid).includes("Reloaded") && status(h, sid) === "idle", { what: "the next turn" })
  expect(calls(h, "turn/interrupt")).toEqual([])
})

test("a thread open elsewhere says so and stays idle", async () => {
  const h = makeCodex()
  h.fake.script([[{ exit: 1 }]], { resume_error: WRITER_LOCK })
  const sid = await start(h, h.workspace)
  await crashed(h, sid, "crash")
  await h.sessions.prompt(sid, "again")
  await waitFor(() => errors(h, sid).some((e) => e.includes("open in another Codex window")), {
    what: "the lock message",
  })
  expect(status(h, sid)).toBe("idle")
  expect(h.store.listWorkers()).toEqual([])
})

test("token counts are kept on the session and never priced", async () => {
  const h = makeCodex()
  h.fake.script([[fc.tokenUsage(1200, 800, 90)]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.store.getSession(sid)!.harness_usage, { what: "usage" })
  const s = h.store.getSession(sid)!
  expect(s.harness_usage).toEqual({ input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 })
  expect(s.cost).toBe(0)
  expect(h.store.listUsage(sid)).toEqual([])
})

test("a continued session counts only its own stretch", async () => {
  const h = makeCodex()
  h.fake.script([[fc.tokenUsage(2000, 1000, 150)]])
  const first = await start(h, h.workspace)
  h.store.updateSession(first, { harness_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } })
  await h.sessions.end(first)
  await waitFor(() => status(h, first) === "ended", { what: "ended" })
  const s = h.store.getSession(first)!
  // A continued stretch: a new row on the same thread, with the first as its parent.
  const second = h.store.createSession(
    session({
      person: "minh",
      harness: "codex",
      cwd: s.cwd,
      status: "idle",
      harness_session_id: "thr_1",
      parent_session_id: first,
      repo_commit: s.repo_commit,
    }),
  )
  await h.sessions.start(second, { resume: true })
  await waitFor(() => status(h, second.id) === "idle", { what: "resumed" })
  await h.sessions.prompt(second.id, "go")
  await waitFor(() => h.store.getSession(second.id)!.harness_usage, { what: "usage" })
  expect(h.store.getSession(second.id)!.harness_usage).toEqual({
    input_tokens: 800,
    cached_input_tokens: 200,
    output_tokens: 60,
  })
})

test("the usage before a stretch sums every earlier stretch", () => {
  const h = makeCodex()
  const used = [
    { input_tokens: 100, cached_input_tokens: 10, output_tokens: 1 },
    null, // a stretch Codex reported nothing for
    { input_tokens: 200, cached_input_tokens: 20, output_tokens: 2 },
  ]
  let parent: SessionRecord | undefined
  for (const usage of used)
    parent = h.store.createSession(
      session({
        harness: "codex",
        harness_session_id: "thr_1",
        parent_session_id: parent?.id ?? null,
        harness_usage: usage,
      }),
    )
  const last = h.store.createSession(
    session({ harness: "codex", harness_session_id: "thr_1", parent_session_id: parent!.id }),
  )
  expect(usageBase(h.store, last)).toEqual({ input_tokens: 300, cached_input_tokens: 30, output_tokens: 3 })
  expect(usageBase(h.store, session({ harness: "codex" }))).toEqual({
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
  })
})

test("an office stop while a crash is handled writes nothing after it", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 60"), { sleep: 0.5 }, { exit: 1 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const proc = live.process!
  const kill = proc.kill.bind(proc)
  let at: [number, number] | undefined
  spyOn(proc, "kill").mockImplementation(() => {
    live.stopped = true // as office stop sets it, before this job's writes
    at = [h.events.length, h.storeEvents.length]
    return kill()
  })
  await h.sessions.prompt(sid, "go")
  await waitFor(() => live.stopped, { what: "the crash" })
  await live.post("drain", () => {})
  expect([h.events.length, h.storeEvents.length]).toEqual(at!)
  expect(errors(h, sid)).toEqual([])
  expect(status(h, sid)).toBe("busy") // left for restore
  expect(messages(h, sid).flatMap((m) => m.parts.flatMap((p) => (p.type === "tool" ? [p.state] : [])))).toEqual([
    "running",
  ])
})

test("a message codex says has no thread after another reloaded it goes to the new app server", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "First"), fc.agentMessage("m2", "Second")])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  const [entered, enter] = gate()
  const [opened, release] = gate()
  spyOn(old.rpc!, "request").mockImplementation(async (_method, params) => {
    if ((params as Entry).input[0].text === "two") {
      enter()
      await opened // Codex answers this one only after the reload the other message started is done
    }
    throw unloaded()
  })
  const late = h.sessions.prompt(sid, "two")
  await entered
  expect(await h.sessions.prompt(sid, "one")).toBe("queued")
  await waitFor(() => texts(h, sid).includes("First") && live.turnId === null && !live.loading, {
    what: "the reload and its turn",
  })
  expect(status(h, sid)).toBe("busy") // "two" still waits for the old app-server's answer
  release()
  await late
  await waitFor(() => texts(h, sid).includes("Second"), { what: "the late message's turn" })
  expect(calls(h, "turn/start").map((c) => c.input[0].text)).toEqual(["one", "two"])
  expect(calls(h, "initialize")).toHaveLength(2)
})

test("esc with a turn running, a message being sent and one queued marks the turn once", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  const [entered, enter] = gate()
  const [opened, release] = gate()
  spyOn(old.rpc!, "request").mockImplementation(async (_method, params) => {
    if ((params as Entry).input[0].text === "two") {
      enter()
      await opened // answered once the reload's turn runs
    }
    throw unloaded()
  })
  const late = h.sessions.prompt(sid, "two")
  await entered
  expect(await h.sessions.prompt(sid, "one")).toBe("queued")
  await waitFor(() => live.turnId !== null && !live.loading, { what: "the reload and its turn" })
  const rpc = live.process!.rpc!
  const real = rpc.request.bind(rpc)
  const [steered, steer] = gate()
  const [answered, answer] = gate()
  spyOn(rpc, "request").mockImplementation(async (method, params, options) => {
    const res = await real(method, params, options)
    if (method === "turn/start") {
      steer()
      await answered // Codex took "two" as a steer of the running turn; its answer comes after the Esc
    }
    return res
  })
  release() // "two" goes to the new app-server, behind which "three" waits
  await steered
  expect(await h.sessions.prompt(sid, "three")).toBe("queued")
  await h.sessions.interrupt(sid)
  answer()
  expect(await late).toBe("queued")
  await waitFor(() => live.turnId === null && !live.loading && status(h, sid) === "idle", {
    what: "the interrupted turn's end",
  })
  expect(calls(h, "turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }])
  expect(texts(h, sid).join("\n").match(/\[interrupted\]/g)).toHaveLength(1)
})

test("esc with a message queued behind a load that fails writes the marker before the error", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  const [entered, enter] = gate()
  const [opened, release] = gate()
  spyOn(old.rpc!, "request").mockImplementation(async (_method, params) => {
    if ((params as Entry).input[0].text === "two") {
      enter()
      await opened // still waiting on Codex when the reload fails
      throw new RpcError(-32600, "busy")
    }
    throw unloaded()
  })
  const late = h.sessions.prompt(sid, "two")
  await entered
  h.fake.script([], { initialize_delay: 0.5, resume_error: { code: -32600, message: "no rollout found" } })
  expect(await h.sessions.prompt(sid, "one")).toBe("queued")
  await h.sessions.interrupt(sid) // drops "one"; the marker waits for the turn "two" may start
  await waitFor(() => errors(h, sid).length > 0, { what: "the failed reload" })
  release()
  await expect(late).rejects.toThrow("didn't take the message")
  await waitFor(() => status(h, sid) === "idle", { what: "the refusal" })
  const parts = messages(h, sid).flatMap((m) => m.parts)
  expect(parts.at(-1)!.type).toBe("error")
  expect(errors(h, sid)).toHaveLength(1)
  expect(texts(h, sid).join("\n").match(/\[interrupted\]/g)).toHaveLength(1)
})

test("a message codex says has no thread while the session ends starts no load", async () => {
  const h = makeCodex({ endWaitMs: 1000 })
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "work")
  await waitFor(() => turnRunning(h, sid), { what: "busy" })
  const old = h.sessions.get(sid)!.process!
  const [entered, enter] = gate()
  const [opened, release] = gate()
  const real = old.rpc!.request.bind(old.rpc!)
  spyOn(old.rpc!, "request").mockImplementation(async (method, params, options) => {
    if (method === "turn/interrupt") return {} // taken, but the turn runs on until the end wait closes the app-server
    if (method !== "turn/start") return real(method, params, options)
    enter()
    await opened
    throw unloaded()
  })
  const steer = h.sessions.prompt(sid, "steer")
  await entered
  await h.sessions.end(sid)
  release()
  await steer
  await waitFor(() => status(h, sid) === "ended", { timeout: 10_000, what: "the end" })
  expect(calls(h, "initialize")).toHaveLength(1)
  expect(h.store.listWorkers()).toEqual([])
})

test("closing the app server of an unloaded thread never holds the message or outlives office stop", async () => {
  const h = makeCodex({ stopWaitMs: 200 })
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  const oldPid = old.pid
  const [closing, closingResolve] = gate()
  const [released, release] = gate()
  const realClose = old.close.bind(old)
  spyOn(old, "close").mockImplementation(async (grace) => {
    closingResolve()
    await released
    await realClose(grace)
  })
  spyOn(old.rpc!, "request").mockRejectedValue(unloaded())
  const began = performance.now()
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  expect(performance.now() - began).toBeLessThan(2000) // the close runs on the session's queue, not the request's
  await closing
  await h.sessions.closeAll() // while the old app-server is still being closed
  expect(h.store.listWorkers()).toEqual([])
  expect(startTime(oldPid)).toBeNull()
  release()
  await live.post("drain", () => {})
  expect(h.store.listWorkers()).toEqual([])
  expect(calls(h, "initialize")).toHaveLength(1)
})

test("office stop while an unloaded thread's app server closes mid turn still restores the marker", async () => {
  const h = makeCodex()
  h.fake.script([
    [fc.urlElicitation(8, "gh", "Sign in", "https://e.com/l", { wait: false }), { sleep: 0.3 }, fc.threadClosed()],
  ])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  const [closing, closingResolve] = gate()
  const [released, release] = gate()
  const realClose = old.close.bind(old)
  spyOn(old, "close").mockImplementation(async (grace) => {
    closingResolve()
    await released
    await realClose(grace)
  })
  await h.sessions.prompt(sid, "sign in")
  await closing // a turnless card was open mid turn, then Codex unloaded the thread
  await h.sessions.closeAll() // while the app-server is still being closed
  release()
  await live.post("drain", () => {})
  const r = await restarted(h)
  expect(status(r, sid)).toBe("idle")
  expect(texts(r, sid).at(-1)).toEndWith("[interrupted]")
  expect(r.store.getSession(sid)!.harness_turn_id).toBeNull()
})

test("a reload whose app server dies before taking the message says so once", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const [w] = h.store.listWorkers()
  expect(sameProcess(w!.pid, w!.startTime)).toBe(true)
  process.kill(w!.pid, "SIGKILL")
  await waitFor(() => errors(h, sid).length > 0 && status(h, sid) === "idle", { what: "the first crash handled" })
  const realLaunch = h.sessions.launch.bind(h.sessions)
  // The reloaded app-server dies as the queued message reaches it.
  spyOn(h.sessions, "launch").mockImplementation(async (live) => {
    const p = await realLaunch(live)
    const realRequest = p.rpc!.request.bind(p.rpc!)
    spyOn(p.rpc!, "request").mockImplementation(async (method, params, options) => {
      if (method !== "turn/start") return realRequest(method, params, options)
      expect(p.alive).toBe(true)
      process.kill(-p.pid, "SIGKILL")
      await waitFor(() => !p.alive, { what: "the group gone" })
      throw new RpcClosed("the app-server closed before answering turn/start")
    })
    return p
  })
  expect(await h.sessions.prompt(sid, "again")).toBe("queued")
  await waitFor(() => errors(h, sid).length === 2 && status(h, sid) === "idle", { what: "the second crash" })
  await sleep(300) // an error part written late would show here
  expect(errors(h, sid)).toHaveLength(2)
  for (const e of errors(h, sid)) expect(e).toContain("Codex stopped unexpectedly")
})

test("what an earlier app server sent is dropped", async () => {
  const h = makeCodex()
  h.fake.script([[{ exit: 1 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const old = live.process!
  await crashed(h, sid)
  await h.sessions.prompt(sid, "again")
  const fresh = await waitFor(() => live.process, { what: "the reload" })
  live.notified(old, "thread/closed", { threadId: "thr_1" }) // late, from the app-server that died
  await live.post("check", () => {})
  expect(live.process).toBe(fresh)
  expect(fresh.alive).toBe(true)
  expect(workerKeys(h)).toEqual([`harness:${sid}`])
})
