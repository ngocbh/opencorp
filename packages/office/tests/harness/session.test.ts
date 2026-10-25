/** A Codex session the owner drives: load, turns, steers, interrupts, end, office stop. */
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { HarnessError } from "../../src/chat/state.ts"
import { type CodexProcess, CodexStartError, ownerLoad } from "../../src/harness/codex.ts"
import { CodexSessions } from "../../src/harness/sessions.ts"
import { startTime } from "../../src/install/proc.ts"
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
} from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

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
