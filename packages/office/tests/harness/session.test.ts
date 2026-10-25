/** A Codex session the owner drives: load, turns, steers, interrupts, end, office stop. */
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import { type CodexProcess, CodexStartError, ownerLoad } from "../../src/harness/codex.ts"
import { JsonRpc, RpcClosed } from "../../src/harness/rpc.ts"
import { CodexSessions } from "../../src/harness/sessions.ts"
import { killGroup, startTime } from "../../src/install/proc.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { workerEnv } from "../../src/worker/spawn.ts"
import { envNames, waitFor } from "../helpers.ts"
import {
  allGone,
  codexLog,
  errors,
  makeCodex,
  messages,
  requestsValid,
  start,
  startSession,
  status,
  stored,
  texts,
} from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** The error `JsonRpc.request` rejects with when no answer comes in time. */
function timeout(message: string): Error {
  const error = new Error(message)
  error.name = "TimeoutError"
  return error
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error as HarnessError,
  )
}

/** What `CodexSessions.launch` needs of a session. */
function live(sessionId: string, cwd: string, stopped = false) {
  return {
    sessionId,
    cwd,
    stopped,
    launching: null as CodexProcess | null,
    /** Whether the app-server had not spawned yet when it was registered. */
    unspawned: null as boolean | null,
    launchingAs(proc: CodexProcess) {
      this.unspawned = proc.proc === null
      if (!this.stopped) this.launching = proc
      return !this.stopped
    },
    notified() {},
    requested() {},
    exited() {},
  }
}

test("launch registers the app server before it starts and refuses once stopped", async () => {
  const { office, store, hooks, sessions, workspace, fake } = makeCodex()
  const s1 = live("S1", workspace)
  const p = await sessions.launch(s1)
  expect(s1.launching).toBe(p)
  expect(s1.unspawned).toBe(true)
  expect(p.alive).toBe(true)
  expect(store.listWorkers().map((r) => r.key)).toEqual(["harness:S1"])
  expect(fs.statSync(office.paths.runDir("S1")).mode & 0o777).toBe(0o700)
  await p.close(1000)
  const refused = sessions.launch(live("S2", workspace, true))
  await expect(refused).rejects.toBeInstanceOf(CodexStartError)
  await expect(refused).rejects.toThrow("The office is stopping.")
  expect(fs.existsSync(office.paths.runDir("S2"))).toBe(false)
  expect(store.listWorkers()).toEqual([])
  // With no env given, an app-server gets the worker environment and CODEX_HOME, nothing else.
  const plain = new CodexSessions(office, hooks, { command: () => fake.command() })
  const p3 = await plain.launch(live("S3", workspace))
  const allowed = [...Object.keys(workerEnv(process.env)), "CODEX_HOME"]
  const names = envNames(p3.pid)
  expect(names.filter((name) => !allowed.includes(name))).toEqual([])
  expect(names).toContain("PATH")
  await p3.close(1000)
})

test("a codex session starts with an owner load", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const s = h.store.getSession(sid)!
  expect([s.harness, s.kind, s.harness_session_id, s.harness_model]).toEqual(["codex", "main", "thr_1", "gpt-5.5-codex"])
  const inits = h.fake.calls("initialize") as { capabilities: unknown }[]
  expect(inits).toHaveLength(1)
  expect(inits[0]!.capabilities).toEqual({ experimentalApi: true })
  expect(h.fake.calls("thread/start")).toEqual([ownerLoad(s.cwd, { sandbox: "workspace-write", network: false })])
  expect(h.store.listWorkers().map((r) => r.key)).toEqual([`harness:${sid}`])
  requestsValid(h.fake)
})

test("a codex session that cant be set up fails at once", async () => {
  const h = makeCodex()
  const sentinel = new Error("sentinel")
  spyOn(h.sessions, "opener").mockRejectedValue(sentinel)
  // openedBy null: the opener is looked up.
  await expect(startSession(h, "minh", h.workspace)).rejects.toBe(sentinel)
  const [s] = h.store.listSessions()
  expect([s!.status, h.sessions.get(s!.id), h.store.listWorkers()]).toEqual(["starting", undefined, []])
})

test("a load codex refuses fails the session with why", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_error: { code: -32600, message: "nope" }, stderr: "config.toml: bad key" })
  const ended: string[] = []
  h.hooks.sessionEnded.push((s) => ended.push(s.status))
  const { id: sid } = await startSession(h, "minh", h.workspace)
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  const errs = errors(h, sid)
  expect(errs).toHaveLength(1)
  expect(errs[0]).toContain("nope")
  expect(errs[0]).toContain("opencorp doctor")
  expect(errs[0]).toContain(path.join(h.office.paths.runDir(sid), "codex.log"))
  expect(stored(h, sid)).not.toContain("config.toml: bad key")
  expect(codexLog(h, sid)).toContain("config.toml: bad key")
  expect(h.store.listWorkers()).toEqual([])
  expect(ended).toEqual(["failed"])
})

test("office stop kills app servers stops their threads and keeps statuses", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const pid = h.store.listWorkers()[0]!.pid
  const live = h.sessions.get(sid)!
  await h.sessions.closeAll()
  expect(startTime(pid)).toBeNull()
  expect(h.store.listWorkers()).toEqual([])
  expect(status(h, sid)).toBe("idle")
  await waitFor(() => !live.busy, { what: "the session's queue to stop" })
})

test("office stop during a load kills the starting app server and writes nothing", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_delay: 1.5 })
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  const [record] = await waitFor(() => (h.store.listWorkers().length ? h.store.listWorkers() : null), {
    what: "the app-server to spawn",
  })
  await h.sessions.closeAll()
  expect(h.store.listWorkers()).toEqual([])
  expect(startTime(record!.pid)).toBeNull()
  await sleep(2000) // past the end of the handshake the fake was holding
  expect([status(h, sid), h.store.listWorkers(), errors(h, sid)]).toEqual(["starting", [], []])
})

test("a codex chat started after office stop starts nothing", async () => {
  const h = makeCodex()
  await h.sessions.closeAll()
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  await sleep(1000)
  expect([status(h, sid), h.store.listWorkers(), h.fake.messages()]).toEqual(["starting", [], []])
})

test("a message is a turn whose reply streams into the transcript", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Hello there")])
  const sid = await start(h, h.workspace)
  expect(await h.sessions.prompt(sid, "hi", { by: "ngocbh" })).toBe("turn")
  await waitFor(() => texts(h, sid).join() === "Hello there" && status(h, sid) === "idle", { what: "the reply" })
  const users = messages(h, sid).filter((m) => m.role === "user")
  expect(users.map((m) => m.author)).toEqual(["ngocbh"])
  // Only the thread and the input: permissions come with the thread's load, never with a turn.
  expect(h.fake.calls("turn/start")).toEqual([
    { threadId: "thr_1", input: [{ type: "text", text: "hi", text_elements: [] }] },
  ])
  requestsValid(h.fake)
})

test("a message with no sender is the openers", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace, "lan")
  await h.sessions.prompt(sid, "hi")
  const users = messages(h, sid).filter((m) => m.role === "user")
  expect(users.map((m) => m.author)).toEqual(["lan"])
})

test("a message during a turn steers it", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 3 }, ...fc.agentMessage("m1", "Done")]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "count")
  await waitFor(() => status(h, sid) === "busy", { what: "the turn to start" })
  expect(await h.sessions.prompt(sid, "and stop at 5")).toBe("steer")
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  expect(h.fake.calls("turn/start")).toHaveLength(2)
  expect(h.fake.messages("out").filter((m) => m.method === "turn/started")).toHaveLength(1)
})

test("a steer while a command runs keeps the command in its message", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.commandStarted("c1", "sleep 3"),
      { sleep: 3 },
      fc.command("c1", "sleep 3")[1],
      ...fc.agentMessage("m1", "Slept, and stopping."),
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sleep", { by: "ngocbh" })
  await waitFor(() => messages(h, sid).some((m) => m.parts.some((p) => p.type === "tool")), {
    what: "the running command",
  })
  expect(await h.sessions.prompt(sid, "then stop", { by: "ngocbh" })).toBe("steer")
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  const got = messages(h, sid).map((m) => [
    m.role,
    m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool" ? p.state : p.type)),
  ])
  expect(got).toEqual([
    ["user", ["sleep"]],
    ["assistant", ["completed"]],
    ["user", ["then stop"]],
    ["assistant", ["Slept, and stopping."]],
  ])
})

test("a message a prompt check refuses is 422", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.hooks.promptCheck.push((_session, text) => (text.includes("sk-") ? "no secrets" : null))
  const e = await rejection(h.sessions.prompt(sid, "sk-123"))
  expect(e).toBeInstanceOf(HarnessError)
  expect([e.status, e.code]).toEqual([422, "refused"])
  expect(h.fake.calls("turn/start")).toEqual([])
})

test("a message codex refuses leaves the session idle", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  spyOn(live.process!.rpc!, "request").mockRejectedValue(new RpcClosed("the app-server is gone"))
  const e = await rejection(h.sessions.prompt(sid, "hi"))
  expect(e.code).toBe("codex_refused")
  expect(status(h, sid)).toBe("idle")
})

test("office stop never waits on a message codex is slow to take", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  spyOn(h.sessions.get(sid)!.process!.rpc!, "request").mockImplementation(async () => {
    await released
    throw new RpcClosed("the app-server was killed") // what office stop does to a request in flight
  })
  const sent = h.sessions.prompt(sid, "hi").then(
    () => "sent",
    (e: HarnessError) => e.code,
  )
  await waitFor(() => messages(h, sid).filter((m) => m.role === "user").length === 1, { what: "the message" })
  const began = performance.now()
  await h.sessions.closeAll()
  expect(performance.now() - began).toBeLessThan(5000)
  expect(h.store.listWorkers()).toEqual([])
  release()
  expect(await sent).toBe("codex_refused")
})

test("a message while loading waits for the load", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Got it")], { initialize_delay: 1 })
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  expect(await h.sessions.prompt(sid, "early")).toBe("queued")
  expect(await h.sessions.prompt(sid, "and then")).toBe("queued")
  await waitFor(() => texts(h, sid).join() === "Got it", { what: "the queued message's reply" })
  const inputs = h.fake.calls("turn/start") as { input: { text: string }[] }[]
  expect(inputs.map((p) => p.input[0]!.text)).toEqual(["early\n\nand then"])
})

test("a message codex never answers is refused and leaves the session idle", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  spyOn(h.sessions.get(sid)!.process!.rpc!, "request").mockRejectedValue(timeout("turn/start got no answer in 60s"))
  const e = await rejection(h.sessions.prompt(sid, "hi"))
  expect(e.code).toBe("codex_refused")
  expect(status(h, sid)).toBe("idle")
})

test("a queued message codex never answers leaves the session idle", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_delay: 0.5 })
  const real = JsonRpc.prototype.request
  const spy = spyOn(JsonRpc.prototype, "request").mockImplementation(function (this: JsonRpc, method, params, options) {
    if (method === "turn/start") return Promise.reject(timeout("turn/start got no answer in 60s"))
    return real.call(this, method, params, options)
  })
  onTestFinished(() => spy.mockRestore())
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  expect(await h.sessions.prompt(sid, "early")).toBe("queued")
  await waitFor(() => status(h, sid) === "idle" && errors(h, sid).length > 0, { what: "the refusal" })
  expect(errors(h, sid)[0]).toContain("didn't take the message")
})

test("every load of the thread carries the owner load", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const cwd = h.store.getSession(sid)!.cwd
  killGroup(h.store.listWorkers()[0]!.pid)
  await waitFor(() => status(h, sid) === "idle" && errors(h, sid).length > 0, { what: "the app-server's death" })
  expect(await h.sessions.prompt(sid, "hi")).toBe("queued")
  // The queued message's turn, after the resume.
  await waitFor(() => h.fake.calls("turn/start").length === 1 && status(h, sid) === "idle", {
    what: "the queued message's turn",
  })
  expect(h.fake.calls("thread/resume")).toEqual([
    { threadId: "thr_1", excludeTurns: true, ...ownerLoad(cwd, { sandbox: "workspace-write", network: false }) },
  ])
  requestsValid(h.fake)
})

test("a session whose load failed takes no message or end before it is dropped", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_error: { code: -32600, message: "nope" } })
  // The moment before it is dropped.
  spyOn(h.sessions, "finished").mockImplementation(async () => {})
  const { id: sid } = await startSession(h, "minh", h.workspace)
  const live = h.sessions.get(sid)!
  await waitFor(() => live.closed, { what: "the failed load" })
  for (const call of [() => h.sessions.prompt(sid, "hi"), () => h.sessions.end(sid)]) {
    const e = await call().then(
      () => null,
      (error: unknown) => error,
    )
    expect(e).toBeInstanceOf(HarnessError)
    expect([(e as HarnessError).status, (e as HarnessError).code]).toEqual([409, "not_live"])
  }
  // Only the error part.
  expect(messages(h, sid).map((m) => m.role)).toEqual(["assistant"])
})
