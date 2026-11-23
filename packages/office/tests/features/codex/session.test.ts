/** A Codex session the owner drives: load, turns, steers, interrupts, end, office stop. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import type { Part } from "@opencorp/protocol"
import { HarnessError } from "../../../src/runtime/sessions/state.ts"
import { speakers } from "../../../src/runtime/sessions/speakers.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { newId } from "../../../src/util/ids.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"
import type { HarnessEvent } from "../../../src/tools/harness/adapter.ts"
import { APP_SERVER_ARGS, type CodexProcess, CodexStartError, nativeCodex } from "../../../src/tools/codex/codex.ts"
import { JsonRpc, RpcClosed, RpcError } from "../../../src/tools/codex/rpc.ts"
import type { CodexSession } from "../../../src/features/codex/session.ts"
import { McpServersAdded, ProjectConfigLoads, harnessTemp } from "../../../src/features/codex/thread.ts"
import { harnessPath } from "../../../src/runtime/sandbox/harness_profile.ts"
import { killGroup, sameProcess, startTime } from "../../../src/util/proc.ts"
import { realPath } from "../../../src/runtime/sandbox/policy.ts"
import * as fc from "../../../src/testing/fake_codex.ts"
import { fakeLlm, makeHarness } from "../chat/helpers.ts"
import { person } from "../../company/helpers.ts"
import { envEntries, isGone, tempDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable, standaloneCodex } from "../../runtime/sandbox/helpers.ts"
import {
  type Codex,
  YES,
  allGone,
  reopened,
  codexLog,
  deltas,
  errors,
  makeCodex,
  messages,
  picked,
  requestsValid,
  restarted,
  start,
  startSession,
  status,
  stored,
  texts,
  turnRunning,
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

/** A promise and the function that resolves it. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const opened = new Promise<void>((resolve) => (release = resolve))
  return [opened, release]
}

/** Holds `live`'s queue with a job of its own until the returned function is called; resolves once the job runs. */
async function hold(live: CodexSession): Promise<() => void> {
  const [began, begin] = gate()
  const [released, release] = gate()
  void live.post("hold", async () => {
    begin()
    await released
  })
  await began
  return release
}

/** The fake's notifications with `method`. */
function notifications(h: Codex, method: string): unknown[] {
  return h.fake.messages("out").filter((m) => m.method === method)
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
  const { office, store, sessions, workspace, fake } = makeCodex()
  const run = { command: fake.command(), env: { PATH: "/usr/bin:/bin", HOME: workspace } }
  const s1 = live("S1", workspace)
  const p = await sessions.launch(s1, run)
  expect(s1.launching).toBe(p)
  expect(s1.unspawned).toBe(true)
  expect(p.alive).toBe(true)
  expect(store.listWorkers().map((r) => r.key)).toEqual(["harness:S1"])
  expect(fs.statSync(office.paths.runDir("S1")).mode & 0o777).toBe(0o700)
  await p.close(1000)
  const refused = sessions.launch(live("S2", workspace, true), run)
  await expect(refused).rejects.toBeInstanceOf(CodexStartError)
  await expect(refused).rejects.toThrow("The office is stopping.")
  expect(fs.existsSync(office.paths.runDir("S2"))).toBe(false)
  expect(store.listWorkers()).toEqual([])
})

/** The features every employee's Codex thread turns off. */
const OFF = { hooks: false, apps: false, plugins: false, memories: false, skill_mcp_dependency_install: false }

test("a codex session's thread starts under its employee's permission and asks nothing", async () => {
  const h = makeCodex()
  h.fake.script([], { mcp_servers: { docs: { command: "docs-mcp" } } })
  const row = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, row.id) === "idle", { what: "the Codex session to load" })
  const s = h.store.getSession(row.id)!
  expect([s.harness, s.kind, s.harness_session_id, s.harness_model]).toEqual(["codex", "main", "thr_1", "gpt-5.5-codex"])
  expect(s.work_item_id).toBeTruthy()
  // The debrief's connection.
  expect(s.connection).toBe("office")
  const inits = h.fake.calls("initialize") as { capabilities: unknown }[]
  expect(inits).toHaveLength(1)
  expect(inits[0]!.capabilities).toEqual({ experimentalApi: true })
  // The owner's MCP servers are read, and nothing written.
  expect(h.fake.calls("config/read")).toEqual([{ cwd: s.cwd, includeLayers: true }])
  const [load, ...more] = h.fake.calls("thread/start") as Record<string, any>[]
  expect(more).toEqual([])
  const id = `opencorp-${row.id}`
  expect(Object.keys(load!).sort()).toEqual(["approvalPolicy", "config", "cwd", "permissions"])
  expect([load!.cwd, load!.approvalPolicy, load!.permissions]).toEqual([s.cwd, "never", id])
  const config = load!.config
  expect(config.default_permissions).toBe(id)
  const filesystem = config.permissions[id].filesystem
  // minh may write the folder, has no network, and the fence is denied.
  expect(filesystem[s.cwd]).toBe("write")
  expect(filesystem[path.join(harnessTemp(h.tmpBase), "fence")]).toBe("deny")
  expect(filesystem[path.join(harnessTemp(h.tmpBase), row.id)]).toBe("write")
  expect(config.permissions[id].network).toEqual({ enabled: false })
  expect(config.projects).toEqual({ [s.cwd]: { trust_level: "untrusted" } })
  expect([config.features, config.notify, config.web_search]).toEqual([OFF, [], "disabled"])
  expect(config.mcp_servers).toEqual({ docs: { enabled: false } })
  expect(h.store.listWorkers().map((r) => r.key)).toEqual([`harness:${row.id}`])
  requestsValid(h.fake)
  expect(s.cwd).toBe(realPath(h.workspace))
  expect(s.repo_commit).toBe(await h.office.git.head())
  expect([s.opened_by, s.model, s.model_note, s.office]).toEqual(["ngocbh", null, null, os.hostname()])
  const item = h.store.getWorkItem(s.work_item_id!)!
  expect([item.status, item.requester, item.assignee, item.title]).toEqual([
    "in_progress",
    "ngocbh",
    "minh",
    `Chat with Minh in ${path.basename(s.cwd)}`,
  ])
  expect(h.store.workedFolders("minh")[0]!.cwd).toBe(s.cwd)
})

test("a codex app server runs with the harness PATH and its own fresh temp folder, removed when the session ends", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const tmp = path.join(harnessTemp(h.tmpBase), sid)
  const env = Object.fromEntries(envEntries(h.store.listWorkers()[0]!.pid))
  const permission = await h.sessions.permission(sid, { gitRoot: null, tmpdir: tmp, fence: path.join(harnessTemp(h.tmpBase), "fence") })
  expect([env.TMPDIR, env.PATH]).toEqual([tmp, harnessPath(permission)])
  expect(env.PATH!.split(":")).toContain("/usr/bin")
  // The rest is the environment the sessions give an app-server.
  expect(env.HOME).toBe(h.home)
  expect(fs.statSync(tmp).mode & 0o777).toBe(0o700)
  // A reload gets it fresh, whatever the last app-server's commands left there.
  fs.writeFileSync(path.join(tmp, "left.txt"), "x")
  killGroup(h.store.listWorkers()[0]!.pid)
  await waitFor(() => status(h, sid) === "idle" && errors(h, sid).length > 0, { what: "the app-server's death" })
  await h.sessions.prompt(sid, "hi")
  await waitFor(() => h.fake.calls("thread/resume").length === 1 && status(h, sid) === "idle", { what: "the reload" })
  expect(fs.readdirSync(tmp)).toEqual([])
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "the end" })
  expect(fs.existsSync(tmp)).toBe(false)
})

test("a session on a codex its standalone installer put in ~/.codex loads its thread from the office's copy in the owner's cache, which a later start mends, and which a session on an updated codex removes once unused for a day and nothing runs from it", async () => {
  const h = makeCodex()
  // A native program in Codex's place (bun, which runs the fake), laid out as the standalone installer lays Codex out.
  const release = (version: string) => {
    const at = path.join(h.home, `.codex/packages/standalone/releases/${version}-x86_64-unknown-linux-musl`)
    fs.mkdirSync(path.join(at, "bin"), { recursive: true })
    fs.copyFileSync(process.execPath, path.join(at, "bin/codex"))
    for (let p = path.join(at, "bin/codex"); p !== h.home; p = path.dirname(p)) fs.chmodSync(p, 0o755)
    return path.join(at, "bin/codex")
  }
  let codex = release("0.171.0")
  // The office's environment sets no XDG_CACHE_HOME: the copies go in the owner's ~/.cache.
  const r = reopened(h, { command: () => [codex, ...h.fake.command().slice(1)] })
  const started = async (cwd: string) => {
    const { id } = await r.sessions.startSession("minh", cwd, { openedBy: "ngocbh" })
    await waitFor(() => status(h, id) === "idle", { what: "the Codex session to load" })
    return id
  }
  const sid = await started(h.workspace)
  const folder = path.join(h.home, ".cache/opencorp/codex")
  const copies = () => fs.readdirSync(folder).filter((name) => name.startsWith("install-"))
  expect(copies()).toHaveLength(1)
  const copy = path.join(folder, copies()[0]!)
  expect(fs.readFileSync(path.join(copy, "bin/codex")).equals(fs.readFileSync(process.execPath))).toBe(true)
  const [load] = h.fake.calls("thread/start") as Record<string, any>[]
  const filesystem = load!.config.permissions[`opencorp-${sid}`].filesystem
  expect(filesystem[copy]).toBe("read")
  expect(filesystem[path.dirname(path.dirname(codex))]).toBeUndefined()
  expect(filesystem[path.join(h.home, ".codex")]).toBe("deny")
  // Something took the binary while the session runs: the next session's start puts it back, and both run.
  fs.rmSync(path.join(copy, "bin/codex"))
  const second = await started(fs.realpathSync(tempDir()))
  expect(fs.readFileSync(path.join(copy, "bin/codex")).equals(fs.readFileSync(process.execPath))).toBe(true)
  expect(status(h, sid)).toBe("idle")
  // An update: a session on the new codex gets its own copy, and the old one stays while its sessions run.
  codex = release("0.172.0")
  const third = await started(fs.realpathSync(tempDir()))
  expect(copies()).toHaveLength(2)
  expect(fs.existsSync(copy)).toBe(true)
  for (const id of [sid, second, third]) {
    await r.sessions.end(id)
    await waitFor(() => status(h, id) === "ended", { what: "the end" })
  }
  // Once none has started from it for a day and none runs from it, the next session's start removes it.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000)
  fs.utimesSync(path.join(copy, "last-used"), dayAgo, dayAgo)
  await r.sessions.end(await started(fs.realpathSync(tempDir())))
  expect(copies()).toHaveLength(1)
  expect(fs.existsSync(copy)).toBe(false)
})

test("a codex the employee could change is refused before it runs as the owner", async () => {
  const h = makeCodex()
  const marker = path.join(h.home, "ran")
  // minh may write the session's folder, and the office would run codex from it.
  const planted = path.join(h.workspace, "codex")
  fs.writeFileSync(planted, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  const r = reopened(h, { command: () => [planted, "app-server", "--listen", "stdio://"] })
  const { id: sid } = await r.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  expect(fs.existsSync(marker)).toBe(false)
  expect(errors(h, sid)).toEqual(["Codex can't run under this employee's permission here; the office log says why."])
  // Its install folder holds the session's folder, which minh may write.
  const refusal = `codex session ${sid} can't load its thread: Codex's install folder ${JSON.stringify(path.dirname(path.dirname(planted)))}`
  expect(h.lines.some((l) => l.startsWith(refusal) && l.includes("is writable by the employee or others"))).toBe(true)
  expect(h.store.listWorkers()).toEqual([])
})

test("a load codex answers with another approval policy or profile fails the session, and codex is stopped", async () => {
  const h = makeCodex()
  h.fake.script([], { load_answer: { activePermissionProfile: { id: ":workspace", extends: null } } })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  expect(errors(h, sid)).toEqual(["Codex can't run under this employee's permission here; the office log says why."])
  expect(h.lines.some((l) => l.includes('profile ":workspace", not "never"'))).toBe(true)
  expect(h.store.listWorkers()).toEqual([])
})

test("a project config codex would load, as the owner trusts the project, refuses the session with what to do", async () => {
  const h = makeCodex()
  const cwd = fs.realpathSync(h.workspace)
  h.fake.script([], { project_layers: { [cwd]: [{ dotCodexFolder: path.join(cwd, ".codex") }] } })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  const [shown, ...more] = errors(h, sid)
  expect(more).toEqual([])
  expect(shown).toContain(`Codex would load this project's own config (${path.join(cwd, ".codex/config.toml")})`)
  expect(shown).toContain("Untrust the project in your Codex config.toml")
  expect(h.fake.calls("thread/start")).toEqual([])
})

test("a project the owner trusts while a session runs there refuses the next turn as a refused load does, until untrusted", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const cwd = fs.realpathSync(h.workspace)
  await h.sessions.prompt(sid, "first")
  await waitFor(() => h.fake.calls("turn/start").length === 1 && status(h, sid) === "idle", { what: "the first turn" })
  // The owner trusts the project now, as Codex writes it the first time they run it there.
  h.fake.script([], { project_layers: { [cwd]: [{ dotCodexFolder: path.join(cwd, ".codex") }] } })
  const e = await rejection(h.sessions.prompt(sid, "second"))
  expect(e).toBeInstanceOf(HarnessError)
  expect([e.status, e.code]).toEqual([409, "codex_refused"])
  expect(e.message).toBe(new ProjectConfigLoads([path.join(cwd, ".codex")]).message)
  expect(h.fake.calls("turn/start")).toHaveLength(1)
  expect(status(h, sid)).toBe("idle")
  // Untrusted again, the next message starts a turn. Each turn's check reads the config again; no model runs for it.
  h.fake.script([])
  await h.sessions.prompt(sid, "third")
  await waitFor(() => h.fake.calls("turn/start").length === 2 && status(h, sid) === "idle", { what: "the third turn" })
  expect(h.fake.calls("config/read")).toEqual(Array(4).fill({ cwd, includeLayers: true }))
})

test("an MCP server the owner adds while a session runs refuses the next turn, which would start it as the owner", async () => {
  const h = makeCodex()
  h.fake.script([], { mcp_servers: { docs: { command: "docs-mcp" } } })
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "first")
  await waitFor(() => h.fake.calls("turn/start").length === 1 && status(h, sid) === "idle", { what: "the first turn" })
  // The load turned docs off; the owner adds lint since, which the thread's override doesn't name.
  h.fake.script([], { mcp_servers: { docs: { command: "docs-mcp" }, lint: { command: "lint-mcp" } } })
  const e = await rejection(h.sessions.prompt(sid, "second"))
  expect([e.status, e.code]).toEqual([409, "codex_refused"])
  expect(e.message).toBe(new McpServersAdded(["lint"]).message)
  expect(e.message).toContain("lint")
  expect(h.fake.calls("turn/start")).toHaveLength(1)
  expect(status(h, sid)).toBe("idle")
  // A server removed since the load is no harm: the next turn goes.
  h.fake.script([], { mcp_servers: {} })
  await h.sessions.prompt(sid, "third")
  await waitFor(() => h.fake.calls("turn/start").length === 2 && status(h, sid) === "idle", { what: "the third turn" })
})

test("a server the employee may use, added while a session runs, is fine if Codex reaches it by URL, and refuses the turn if Codex would start it as a program, which the load didn't place in the office's folder", async () => {
  const policy = { sandbox: "workspace-write", mcp_servers: ["github", "web", "lint", "docs"] }
  const h = makeCodex({
    files: { "people/minh/person.yaml": person("minh", { tools: ["yian", "codex"], harness_policy: policy }) },
  })
  // At the load: github, a program the employee may use (placed), web, one reached by URL (left as it is), and
  // other, which they may not use (off).
  const servers = { github: { command: "gh-mcp" }, web: { url: "https://e.example/mcp" }, other: { command: "o" } }
  h.fake.script([], { mcp_servers: servers })
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "first")
  await waitFor(() => h.fake.calls("turn/start").length === 1 && status(h, sid) === "idle", { what: "the first turn" })
  // Added since: docs, reached by URL and allowed, is fine.
  h.fake.script([], { mcp_servers: { ...servers, docs: { url: "https://d.example/mcp" } } })
  await h.sessions.prompt(sid, "second")
  await waitFor(() => h.fake.calls("turn/start").length === 2 && status(h, sid) === "idle", { what: "the second turn" })
  // lint, allowed but a program, would start in the employee's folder: refused, as one they may not use is.
  for (const added of [{ lint: { command: "lint-mcp" } }, { extra: { url: "https://x.example/mcp" } }]) {
    h.fake.script([], { mcp_servers: { ...servers, ...added } })
    const e = await rejection(h.sessions.prompt(sid, "third"))
    expect([e.status, e.code, e.message]).toEqual([409, "codex_refused", new McpServersAdded(Object.keys(added)).message])
  }
  expect(h.fake.calls("turn/start")).toHaveLength(2)
})

test("an office start sweeps the temp folders a crash left for its own sessions, and no other's", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const root = harnessTemp(h.tmpBase)
  fs.writeFileSync(path.join(root, sid, "left"), "x")
  fs.mkdirSync(path.join(root, "01OTHEROFFICESESSION000000"), { mode: 0o700 })
  // A crash: the app-server dies with the office, and its folder stays.
  killGroup(h.store.listWorkers()[0]!.pid)
  await waitFor(() => errors(h, sid).length > 0, { what: "the app-server's death" })
  const r = reopened(h)
  await r.sessions.restore()
  expect(fs.readdirSync(root).sort()).toEqual(["01OTHEROFFICESESSION000000", "fence"])
})

test("a session whose employee's permission can't be built fails with why, before codex starts", async () => {
  const h = makeCodex({
    files: {
      "people/minh/person.yaml": person("minh", {
        tools: ["yian", "codex"],
        harness_policy: { sandbox: "workspace-write", network: false, folders: [{ path: "relative", access: "read" }] },
      }),
    },
  })
  const { id: sid } = await h.sessions.startSession("minh", h.workspace, { openedBy: "ngocbh" })
  await waitFor(() => status(h, sid) === "failed", { what: "failed" })
  expect(errors(h, sid)).toEqual(["Codex can't run under this employee's permission here; the office log says why."])
  expect(h.fake.calls("initialize")).toEqual([])
  expect(h.lines.some((l) => l.includes(`codex session ${sid} can't load its thread: the harness's listed folder`))).toBe(
    true,
  )
  expect(fs.existsSync(path.join(harnessTemp(h.tmpBase), sid))).toBe(false)
})

test("a codex session that cant be set up fails at once", async () => {
  const h = makeCodex()
  spyOn(h.sessions, "opener").mockRejectedValue(new Error("sentinel"))
  const ended: string[] = []
  h.hooks.sessionEnded.push((s) => ended.push(s.status))
  // openedBy null: the opener is looked up.
  const error = await rejection(h.sessions.startSession("minh", h.workspace))
  expect(error).toBeInstanceOf(HarnessError)
  const [s] = h.store.listSessions()
  expect([error.status, error.code, error.message]).toEqual([
    500,
    "start_failed",
    `session ${s!.id} failed to start; see the office log`,
  ])
  expect([s!.status, h.sessions.get(s!.id), h.store.listWorkers()]).toEqual(["failed", undefined, []])
  expect(ended).toEqual(["failed"])
  expect(h.lines).toContain(`can't start Codex session ${s!.id} (Error)`)
  expect(h.lines.filter((line) => line.includes("sentinel"))).toEqual([])
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
  await waitFor(() => turnRunning(h, sid), { what: "the turn to start" })
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

test("a message while starting leaves the session starting until the load", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Got it")], { initialize_delay: 1 })
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  expect(await h.sessions.prompt(sid, "early")).toBe("queued")
  expect(status(h, sid)).toBe("starting")
  await waitFor(() => texts(h, sid).join() === "Got it" && status(h, sid) === "idle", { what: "the reply" })
})

test("a message waiting for a reload after a restart shows busy", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.fake.script([fc.agentMessage("m1", "Back")], { initialize_delay: 1 })
  const r = await restarted(h)
  expect(status(r, sid)).toBe("idle")
  expect(await r.sessions.prompt(sid, "go")).toBe("queued")
  expect(status(r, sid)).toBe("busy")
  await waitFor(() => texts(r, sid).includes("Back") && status(r, sid) === "idle", { what: "the reloaded turn" })
})

test("a message sent to a loaded session is busy before turn/started", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const release = await hold(live) // turn/started waits behind it
  expect(await h.sessions.prompt(sid, "go")).toBe("turn")
  expect(live.turnId).toBeNull()
  expect(status(h, sid)).toBe("busy")
  release()
  await waitFor(() => live.turnId !== null, { what: "the turn to start" })
  expect(status(h, sid)).toBe("busy")
})

test("a turn that completes as it starts leaves the session idle", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  // Unscripted turns: the fake answers turn/start and sends turn/started and turn/completed at once.
  await h.sessions.prompt(sid, "one")
  await waitFor(() => notifications(h, "turn/completed").length === 1 && status(h, sid) === "idle", {
    what: "the first turn",
  })
  const release = await hold(live)
  await h.sessions.prompt(sid, "two")
  release()
  await waitFor(() => notifications(h, "turn/completed").length === 2 && status(h, sid) === "idle", {
    what: "the second turn",
  })
  await sleep(300)
  expect(status(h, sid)).toBe("idle")
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

test("office stop mid reply stores all its text with the marker", async () => {
  const h = makeCodex()
  h.fake.script([
    [
      fc.agentMessage("m1", "Hello there, friend")[0],
      fc.agentMessageDelta("m1", "Hello "),
      fc.agentMessageDelta("m1", "there, "),
      fc.agentMessageDelta("m1", "friend"),
      { sleep: 30 },
    ],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go", { by: "ngocbh" })
  await waitFor(() => deltas(h).at(-1) === "friend", { what: "the third delta" })
  await h.sessions.closeAll()
  expect(texts(h, sid)).toEqual(["Hello there, friend\n\n[interrupted]"])
  expect(status(h, sid)).toBe("busy")
})

test("office stop leaves the transcript to a thread still busy", async () => {
  const h = makeCodex({ stopWaitMs: 200 })
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  const abort = spyOn(live.translator, "abort")
  let begin!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => (begin = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  // A job that outlasts the stop's wait.
  void live.post("hold", async () => {
    begin()
    await released
  })
  await began // running, so the stop can't skip it
  await h.sessions.closeAll()
  release()
  await waitFor(() => !live.busy, { what: "the held job to finish" })
  expect(abort).not.toHaveBeenCalled()
})

test("esc interrupts the turn and marks it", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 30"), { sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sleep")
  await waitFor(() => status(h, sid) === "busy", { what: "the turn to start" })
  await waitFor(() => messages(h, sid).some((m) => m.parts.some((p) => p.type === "tool")), {
    what: "the running command",
  })
  await h.sessions.interrupt(sid)
  await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
  expect(h.fake.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }])
  // parts[0] is "sleep".
  const parts = messages(h, sid).flatMap((m) => m.parts)
  const tool = parts[1]!
  const last = parts.at(-1)!
  expect(tool.type === "tool" && tool.state).toBe("interrupted")
  expect(last.type === "text" && last.text.endsWith("[interrupted]")).toBe(true)
})

/** The fake's commands by the process id each `spawn` step gave, once that many have started. */
async function spawnedAs(h: Codex, count: number): Promise<Record<string, { pid: number; started: number | null }>> {
  const entries = await waitFor(() => (h.fake.entries("spawn").length >= count ? h.fake.entries("spawn") : undefined), {
    what: "the running commands",
  })
  return Object.fromEntries(entries.map((e) => [e.process, { pid: e.pid, started: startTime(e.pid) }]))
}

test("esc stops the command the interrupted turn runs, after codex stops the turn, and a command an earlier turn left running goes on", async () => {
  const h = makeCodex()
  h.fake.script([
    // A server the model was told is running.
    [fc.commandStarted("c1", "serve", { processId: "p1" }), { spawn: 300, process: "p1" }],
    [fc.commandStarted("c2", "sleep 300", { processId: "p2" }), { spawn: 300, process: "p2" }, { sleep: 30 }],
  ])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "serve")
  await waitFor(() => status(h, sid) === "idle" && h.fake.calls("turn/start").length === 1, { what: "the first turn" })
  await h.sessions.prompt(sid, "sleep")
  const { p1, p2 } = await spawnedAs(h, 2)
  await h.sessions.interrupt(sid)
  await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
  // Codex's interrupt stops the turn and leaves its command running; the terminate after it ends that command.
  const sent = h.fake.messages().filter((m) => "method" in m && "id" in m).map((m) => m.method)
  expect(sent.slice(sent.indexOf("turn/interrupt"))).toEqual(["turn/interrupt", "thread/backgroundTerminals/terminate"])
  expect(h.fake.calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: "thr_1", processId: "p2" }])
  await waitFor(() => isGone(p2!.pid, p2!.started), { what: "the interrupted turn's command to stop" })
  expect(isGone(p1!.pid, p1!.started)).toBe(false)
  requestsValid(h.fake)
})

test("an esc codex refuses still stops the command the turn runs", async () => {
  const h = makeCodex()
  h.fake.script([[fc.commandStarted("c1", "sleep 300", { processId: "p1" }), { spawn: 300, process: "p1" }, { sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "sleep")
  const { p1 } = await spawnedAs(h, 1)
  const rpc = h.sessions.get(sid)!.process!.rpc!
  const real = rpc.request.bind(rpc)
  spyOn(rpc, "request").mockImplementation(async (method, params, options) => {
    if (method === "turn/interrupt") throw new RpcError(-32600, "no active turn to interrupt")
    return real(method, params, options)
  })
  await h.sessions.interrupt(sid)
  expect(h.fake.calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: "thr_1", processId: "p1" }])
  await waitFor(() => isGone(p1!.pid, p1!.started), { what: "the command to stop" })
})

test("a command that ended before the esc isn't stopped again", async () => {
  const h = makeCodex()
  h.fake.script([[...fc.command("c1", "true", { processId: "p1" }), { sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "go")
  await waitFor(() => h.fake.messages("out").some((m) => m.method === "item/completed"), { what: "the command's end" })
  await h.sessions.interrupt(sid)
  await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
  expect(h.fake.calls("thread/backgroundTerminals/terminate")).toEqual([])
})

test("esc with no turn running asks codex nothing", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  await h.sessions.interrupt(sid)
  expect(h.fake.calls("turn/interrupt")).toEqual([])
  expect(status(h, sid)).toBe("idle")
})

test("esc while starting drops the queued message", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Hi")], { initialize_delay: 1 })
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  expect(await h.sessions.prompt(sid, "early")).toBe("queued")
  await h.sessions.interrupt(sid)
  expect(status(h, sid)).toBe("starting")
  await waitFor(() => status(h, sid) === "idle", { what: "the load" })
  expect(h.fake.calls("turn/start")).toEqual([])
  expect(texts(h, sid)).toEqual(["[interrupted]"])
  // The dropped message took no turn of the fake's: the next message gets the first.
  expect(await h.sessions.prompt(sid, "again")).toBe("turn")
  await waitFor(() => texts(h, sid).includes("Hi") && status(h, sid) === "idle", { what: "the next turn" })
})

test("esc during a reload drops the queued message", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.fake.script([], { initialize_delay: 1 })
  const r = await restarted(h)
  const live = r.sessions.get(sid)!
  expect(await r.sessions.prompt(sid, "go")).toBe("queued")
  await r.sessions.interrupt(sid)
  expect(status(r, sid)).toBe("idle")
  await waitFor(() => live.process !== null && !live.loading, { what: "the reload" })
  expect(status(r, sid)).toBe("idle")
  expect(r.fake.calls("thread/resume")).toHaveLength(1)
  expect(r.fake.calls("turn/start")).toEqual([])
  expect(texts(r, sid)).toEqual(["[interrupted]"])
})

test("esc before turn/started interrupts the turn once it starts", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  const release = await hold(h.sessions.get(sid)!) // turn/started waits behind it
  expect(await h.sessions.prompt(sid, "go")).toBe("turn")
  await h.sessions.interrupt(sid)
  release()
  await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
  expect(h.fake.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }])
  expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
})

test("esc while turn/start waits for codex interrupts the turn once it starts", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  const rpc = h.sessions.get(sid)!.process!.rpc!
  const real = rpc.request.bind(rpc)
  const [opened, open] = gate()
  let entered = false
  spyOn(rpc, "request").mockImplementation(async (method, params, options) => {
    if (method === "turn/start") {
      entered = true
      await opened
    }
    return real(method, params, options)
  })
  const sending = h.sessions.prompt(sid, "go")
  await waitFor(() => entered, { what: "turn/start sent" })
  expect(status(h, sid)).toBe("busy")
  await h.sessions.interrupt(sid)
  open()
  expect(await sending).toBe("turn")
  await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
  expect(h.fake.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }])
  expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
})

test("esc with a turn/start in flight and a message queued behind it stops both", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]], { initialize_delay: 0.5 })
  const real = JsonRpc.prototype.request
  const [opened, open] = gate()
  let entered = false
  const spy = spyOn(JsonRpc.prototype, "request").mockImplementation(async function (
    this: JsonRpc,
    method,
    params,
    options,
  ) {
    if (method === "turn/start") {
      entered = true
      await opened
    }
    return real.call(this, method, params, options)
  })
  onTestFinished(() => spy.mockRestore())
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  const live = h.sessions.get(sid)!
  expect(await h.sessions.prompt(sid, "A")).toBe("queued")
  await waitFor(() => entered, { timeout: 10_000, what: "the queued message's turn/start" })
  expect(await h.sessions.prompt(sid, "B")).toBe("queued") // still loading: it waits behind A
  await h.sessions.interrupt(sid)
  open()
  const interrupted = () => h.fake.calls("turn/interrupt").length === 1 && live.turnId === null
  await waitFor(() => interrupted() && status(h, sid) === "idle" && !live.loading, {
    what: "the interrupted turn's end",
  })
  expect((h.fake.calls("turn/start") as { input: { text: string }[] }[]).map((p) => p.input[0]!.text)).toEqual(["A"])
  expect(h.fake.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }])
  expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
})

test("esc with a refused turn/start in flight and a message queued behind it marks the dropped message", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_delay: 0.5 })
  const real = JsonRpc.prototype.request
  const [opened, open] = gate()
  let entered = false
  const spy = spyOn(JsonRpc.prototype, "request").mockImplementation(async function (
    this: JsonRpc,
    method,
    params,
    options,
  ) {
    if (method === "turn/start") {
      entered = true
      await opened
      throw new RpcError(-32600, "busy")
    }
    return real.call(this, method, params, options)
  })
  onTestFinished(() => spy.mockRestore())
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  const live = h.sessions.get(sid)!
  expect(await h.sessions.prompt(sid, "A")).toBe("queued")
  await waitFor(() => entered, { timeout: 10_000, what: "the queued message's turn/start" })
  expect(await h.sessions.prompt(sid, "B")).toBe("queued") // still loading: it waits behind A
  await h.sessions.interrupt(sid)
  open()
  await waitFor(() => status(h, sid) === "idle" && !live.loading && errors(h, sid).length > 0, {
    what: "the refusal",
  })
  expect(h.fake.calls("turn/start")).toEqual([])
  expect(h.fake.calls("turn/interrupt")).toEqual([])
  expect(errors(h, sid)[0]).toContain("didn't take the message")
  expect(texts(h, sid).filter((t) => t.endsWith("[interrupted]"))).toHaveLength(1)
})

test("esc after a turn ends while a steer is in flight interrupts the turn codex started from it", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 0.3 }], [{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  expect(await h.sessions.prompt(sid, "one")).toBe("turn")
  await waitFor(() => status(h, sid) === "busy" && live.turnId !== null, { what: "the first turn" })
  const rpc = live.process!.rpc!
  const real = rpc.request.bind(rpc)
  const [ended, end] = gate()
  spyOn(rpc, "request").mockImplementation(async (method, params, options) => {
    // Codex takes the message only once the first turn ended, so it starts a new turn from it.
    if (method === "turn/start") await ended
    return real(method, params, options)
  })
  const sending = h.sessions.prompt(sid, "two") // a steer of turn_1 as far as the office knows
  await waitFor(() => live.turnId === null, { what: "the first turn's end" })
  const release = await hold(live) // turn_2's turn/started waits behind it
  end()
  expect(await sending).toBe("steer")
  expect(status(h, sid)).toBe("busy")
  await h.sessions.interrupt(sid)
  release()
  await waitFor(() => h.fake.calls("turn/interrupt").length === 1 && status(h, sid) === "idle", {
    what: "the interrupted turn's end",
  })
  expect(h.fake.calls("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_2" }])
  expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
})

test("a steer answered after its turn and a later one ended leaves the session idle", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 1 }], fc.agentMessage("m2", "Three")])
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  expect(await h.sessions.prompt(sid, "one")).toBe("turn")
  await waitFor(() => live.turnId !== null, { what: "the first turn" })
  const rpc = live.process!.rpc!
  const real = rpc.request.bind(rpc)
  const [steered, steer] = gate()
  const [answered, answer] = gate()
  spyOn(rpc, "request").mockImplementation(async (method, params, options) => {
    const res = await real(method, params, options)
    if (method === "turn/start" && (params as { input: { text: string }[] }).input[0]!.text === "two") {
      steer()
      await answered // Codex steered turn_1 with it; the answer comes after turn_2 ended too
    }
    return res
  })
  const sending = h.sessions.prompt(sid, "two")
  await steered
  await waitFor(() => live.turnId === null, { what: "the first turn's end" })
  expect(await h.sessions.prompt(sid, "three")).toBe("turn")
  await waitFor(() => texts(h, sid).includes("Three") && live.turnId === null, { what: "the second turn's end" })
  answer()
  expect(await sending).toBe("steer")
  expect(status(h, sid)).toBe("idle")
})

test("office stop during a reload with a message queued stores busy and restore marks it", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  h.fake.script([], { initialize_delay: 5 })
  const r = await restarted(h)
  expect(await r.sessions.prompt(sid, "go")).toBe("queued")
  expect(status(r, sid)).toBe("busy")
  const r2 = await restarted(r)
  expect(status(r2, sid)).toBe("idle")
  expect(texts(r2, sid).at(-1)).toEndWith("[interrupted]")
})

test("an esc during a refused turn/start doesnt interrupt the next turn", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Two")])
  const sid = await start(h, h.workspace)
  const rpc = h.sessions.get(sid)!.process!.rpc!
  const [opened, open] = gate()
  let entered = false
  const spy = spyOn(rpc, "request").mockImplementation(async () => {
    entered = true
    await opened
    throw new RpcError(-32600, "busy")
  })
  const refused = rejection(h.sessions.prompt(sid, "one"))
  await waitFor(() => entered, { what: "turn/start sent" })
  await h.sessions.interrupt(sid)
  open()
  expect((await refused).code).toBe("codex_refused")
  expect(status(h, sid)).toBe("idle")
  spy.mockRestore()
  expect(await h.sessions.prompt(sid, "two")).toBe("turn")
  await waitFor(() => texts(h, sid).includes("Two") && status(h, sid) === "idle", { what: "the next turn" })
  expect(h.fake.calls("turn/interrupt")).toEqual([])
})

test("esc on a codex that doesnt answer returns", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "work")
  await waitFor(() => status(h, sid) === "busy", { what: "the turn to start" })
  spyOn(h.sessions.get(sid)!.process!.rpc!, "request").mockRejectedValue(timeout("turn/interrupt got no answer in 60s"))
  // No 500: ending the session or office stop kills a Codex that hangs.
  await h.sessions.interrupt(sid)
})

test("ending closes the group and removes its record before end status", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Hi")])
  const sid = await start(h, h.workspace)
  const pid = h.store.listWorkers()[0]!.pid
  const seen: unknown[] = []
  const runs: unknown[] = []
  h.hooks.endStatus.push(() => {
    seen.push(h.store.listWorkers())
    return "debriefing"
  })
  h.hooks.sessionEnded.push((s) => seen.push(s.status))
  h.hooks.runStarted.push((...a) => runs.push(a))
  h.hooks.runFinished.push((...a) => runs.push(a))
  await h.sessions.prompt(sid, "hi")
  await waitFor(() => texts(h, sid).join() === "Hi" && status(h, sid) === "idle", { what: "the reply" })
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "debriefing", { what: "the end" })
  expect(seen).toEqual([[], "debriefing"])
  expect(startTime(pid)).toBeNull()
  // Codex turns are not office runs.
  expect(runs).toEqual([])
  expect(h.store.getWorkItem(h.store.getSession(sid)!.work_item_id!)!.status).toBe("done")
  const e = await rejection(h.sessions.prompt(sid, "again"))
  expect([e.status, e.code]).toEqual([409, "not_live"])
})

test("ending a busy session interrupts its turn first", async () => {
  const h = makeCodex()
  h.fake.script([[{ sleep: 30 }]])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "work")
  await waitFor(() => turnRunning(h, sid), { what: "busy" })
  await h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ended", { what: "the end" })
  expect(h.fake.calls("turn/interrupt").length).toBeGreaterThan(0)
})

test("model and cost cap are refused on a codex session", async () => {
  const { harness, codex: h } = await makeHarness(await fakeLlm(), { codex: true })
  const sid = await start(h!, h!.workspace)
  for (const call of [() => harness.setModel(sid, "office", "gpt-4o"), () => harness.setCostCap(sid, 50)]) {
    const e = await rejection(call())
    expect(e).toBeInstanceOf(HarnessError)
    expect([e.status, e.code]).toEqual([422, "not_supported"])
  }
})

test("a message refused because the session ended meanwhile leaves it ended", async () => {
  const h = makeCodex()
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  spyOn(live.process!.rpc!, "request").mockImplementation(async () => {
    await live.end()
    await waitFor(() => status(h, sid) === "ended", { what: "the end" })
    throw new RpcClosed("the app-server closed before answering turn/start")
  })
  const e = await rejection(h.sessions.prompt(sid, "hi"))
  expect(e).toBeInstanceOf(HarnessError)
  expect(status(h, sid)).toBe("ended")
  expect(live.timer).toBeNull()
})

test("ending on a codex that never answers the interrupt returns and ends after end wait", async () => {
  const h = makeCodex({ endWaitMs: 1000 })
  h.fake.script([[{ sleep: 30 }]], { interrupt_hangs: true })
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "work")
  await waitFor(() => turnRunning(h, sid), { what: "busy" })
  const began = performance.now()
  // The interrupt Codex never answers fails once the end wait closes the app-server.
  await h.sessions.end(sid)
  expect(performance.now() - began).toBeLessThan(5000)
  await waitFor(() => status(h, sid) === "ended", { timeout: 5000, what: "the end after the end wait" })
  expect(h.store.listWorkers()).toEqual([])
  expect(h.store.getSession(sid)!.harness_turn_id).toBeNull()
})

test("every load of the thread runs under the employee's permission", async () => {
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
  const [first] = h.fake.calls("thread/start") as Record<string, any>[]
  const [resume, ...more] = h.fake.calls("thread/resume") as Record<string, any>[]
  expect(more).toEqual([])
  // The same profile and override, under the same id, with no sandbox mode.
  expect(resume).toEqual({ threadId: "thr_1", excludeTurns: true, ...first })
  expect([resume!.cwd, resume!.approvalPolicy, resume!.permissions, "sandbox" in resume!]).toEqual([
    cwd,
    "never",
    `opencorp-${sid}`,
    false,
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

test("a queued message failing because the office stopped stores no refusal", async () => {
  const h = makeCodex()
  h.fake.script([], { initialize_delay: 0.5 })
  const real = JsonRpc.prototype.request
  let sending = false
  let live: CodexSession | undefined
  const spy = spyOn(JsonRpc.prototype, "request").mockImplementation(async function (
    this: JsonRpc,
    method,
    params,
    options,
  ) {
    if (method !== "turn/start") return real.call(this, method, params, options)
    sending = true
    await waitFor(() => live?.stopped, { timeout: 5000, what: "office stop" })
    throw new RpcClosed("the app-server closed before answering turn/start")
  })
  onTestFinished(() => spy.mockRestore())
  const { id: sid } = await startSession(h, "minh", h.workspace, { openedBy: "ngocbh" })
  live = h.sessions.get(sid)!
  expect(await h.sessions.prompt(sid, "early")).toBe("queued")
  await waitFor(() => sending, { timeout: 10_000, what: "the queued message's turn/start" })
  await h.sessions.closeAll()
  expect(errors(h, sid)).toEqual([])
})

test("a turn starting after the end leaves the end timer running", async () => {
  const h = makeCodex({ endWaitMs: 1000 })
  h.fake.script([[{ sleep: 30 }]], { interrupt_hangs: true })
  const sid = await start(h, h.workspace)
  const live = h.sessions.get(sid)!
  await h.sessions.prompt(sid, "work")
  await waitFor(() => turnRunning(h, sid), { what: "busy" })
  // Waits on the interrupt Codex never answers.
  const ending = h.sessions.end(sid)
  await waitFor(() => status(h, sid) === "ending" && live.timer, { what: "the end timer" })
  // A message's turn that Codex starts after the end, as a queued message's would.
  live.notified(live.process!, "turn/started", {
    threadId: "thr_1",
    turn: { id: "turn_2", items: [], status: "inProgress" },
  })
  await waitFor(() => status(h, sid) === "ended", { timeout: 5000, what: "the end after the end wait" })
  await ending
})

test("an idle codex session arms no timer", async () => {
  const h = makeCodex()
  h.fake.script([fc.agentMessage("m1", "Hi")])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "hi")
  await waitFor(() => texts(h, sid).join() === "Hi" && status(h, sid) === "idle", { what: "the reply" })
  const live = h.sessions.get(sid)!
  expect(live.timer).toBeNull()
  expect("idleAfter" in live).toBe(false)
  expect("idleSeconds" in h.sessions).toBe(false)
  expect("idleEnd" in live).toBe(false)
  expect("idleEndAfterRestore" in live).toBe(false)
})

/** The `request` events of every Codex session, as `sessions.event` gets them from now on. */
function requests(h: Codex): () => Extract<HarnessEvent, { type: "request" }>[] {
  const spy = spyOn(h.sessions, "event")
  return () => spy.mock.calls.flatMap(([, e]) => (e.type === "request" ? [e] : []))
}

/** A turn with a command Codex asks a question about (request 7) and then runs. */
function questionTurn() {
  const cmd = "rm -rf build"
  return [fc.commandStarted("c1", cmd), fc.choice(7, "c1"), fc.command("c1", cmd)[1]]
}

/** Starts a session whose turn asks about a command, and returns its id, its live session and the card. */
async function waitingCard(h: Codex) {
  const seen = requests(h)
  h.fake.script([questionTurn()])
  const sid = await start(h, h.workspace)
  await h.sessions.prompt(sid, "clean up", { by: "ngocbh" })
  const [card] = await waitFor(() => (seen().length ? seen() : null), { timeout: 10_000, what: "the request" })
  await waitFor(() => status(h, sid) === "waiting", { what: "waiting on the card" })
  return { sid, live: h.sessions.get(sid)!, card: card!, seen }
}

test("a server request is a request event and the session waits on its card", async () => {
  const h = makeCodex()
  const { sid, card, seen } = await waitingCard(h)
  expect(seen()).toHaveLength(1)
  expect([card.runId, card.nodeId, card.card.kind]).toEqual(["turn_1", "7", "question"])
  const s = h.store.getSession(sid)!
  expect([s.status, s.waiting_on]).toEqual(["waiting", ["ngocbh"]])
})

test("a reply is written before the messages it causes are handled", async () => {
  const h = makeCodex()
  const { sid, live, card } = await waitingCard(h)
  expect(await live.reply(card.key, YES, "ngocbh")).toBe(true)
  // The fake logs what it read once it reads it.
  await waitFor(() => 7 in h.fake.replies(), { what: "the reply" })
  expect(h.fake.replies()[7]).toEqual(picked("Yes"))
  await waitFor(() => status(h, sid) === "idle", { what: "the turn's end" })
  const parts = h.events.flatMap((e) => (e.type === "part.updated" ? [e.data.part as Part] : []))
  const decided = parts.findIndex(
    (p) => p.type === "tool" && (p.input as Record<string, any>).approval?.decision === "answer",
  )
  const completed = parts.findIndex((p) => p.type === "tool" && p.state === "completed")
  expect(decided).toBeGreaterThan(-1)
  expect(decided).toBeLessThan(completed)
})

test("office stop makes a reply not yet written give up at once", async () => {
  const h = makeCodex({ stopWaitMs: 5000 })
  const { live, card } = await waitingCard(h)
  let begin!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => (begin = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  // A job the stop can't wait out, with the reply's job queued behind it.
  void live.post("hold", async () => {
    begin()
    await released
  })
  await began
  const replying = live.reply(card.key, YES, "ngocbh")
  const closing = h.sessions.closeAll()
  expect(await Promise.race([replying, sleep(1000).then(() => "late")])).toBe(false)
  release()
  await closing
  expect(7 in h.fake.replies()).toBe(false)
})

/** The real Codex the opt-in test runs, named by `OPENCORP_TEST_CODEX` (a wrapper, npm's launcher or the native
 *  binary). Unset, it skips; under `OPENCORP_TEST_SANDBOX` it runs, and fails without it. Codex's sandbox needs what
 *  the office's does, so it also skips where that can't start. */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined ? !process.env.OPENCORP_TEST_SANDBOX : !sandboxAvailable()

/** What the stand-in model answers one call with: a command for Codex's `exec_command`, which the call waits on for
 *  `waitMs`, or a text. */
type Answer = { run: string; waitMs: number } | { say: string }

/** A stand-in for the model on 127.0.0.1, which Codex's Responses API calls reach: each call gets the next of
 *  `answers`, and every call after them says "done". No model, network or sign-in is used. */
async function standInModel(answers: Answer[]): Promise<{ url: string; calls: () => number }> {
  let calls = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) return void res.writeHead(404).end()
      const answer = answers[calls] ?? { say: "done" }
      calls += 1
      const id = `resp-${calls}`
      const item =
        "run" in answer
          ? { type: "function_call", call_id: `call-${calls}`, name: "exec_command",
              arguments: JSON.stringify({ cmd: answer.run, yield_time_ms: answer.waitMs }) }
          : { type: "message", role: "assistant", id: `msg-${calls}`, content: [{ type: "output_text", text: answer.say }] }
      const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 }
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage } },
      ]
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  onTestFinished(() => void server.close())
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, calls: () => calls }
}

/** This user's processes whose command line is exactly `args`. */
function processesOf(args: string): number[] {
  return fs
    .readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d) && fs.statSync(`/proc/${d}`, { throwIfNoEntry: false })?.uid === process.getuid!())
    .filter((d) => {
      try {
        return fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").join(" ").trim() === args
      } catch {
        return false // gone meanwhile
      }
    })
    .map(Number)
}

/** A command line no other process runs, `sleep 30.<n>`, so the command is found by its arguments alone. */
function uniqueSleep(n: number): string {
  return `sleep 30.${process.pid}${n}`
}

/** Codex sessions on the real Codex, under minh's permission with a temp home and `CODEX_HOME`, whose model is the
 *  stand-in answering `answers`; `options` start a restarted office's sessions the same way. */
async function realCodex(answers: Answer[]) {
  if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
  const model = await standInModel(answers)
  const codexHome = fs.realpathSync(tempDir())
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `model = "stand-in"\nmodel_provider = "stand_in"\n\n[model_providers.stand_in]\nname = "stand-in"\n` +
      `base_url = "${model.url}"\nwire_api = "responses"\n`,
  )
  const real = nativeCodex(CODEX)
  const options = { command: () => [real.run, ...APP_SERVER_ARGS], environ: { CODEX_HOME: codexHome } }
  return { h: makeCodex(options), model, options, codexHome }
}

/** A session on the real Codex (`realCodex`). */
async function realSession(answers: Answer[]) {
  const { h, model, codexHome } = await realCodex(answers)
  const sid = await start(h, h.workspace)
  return { h, sid, model, codexHome }
}

/** The process running `args`, once Codex holds it among the thread's terminals (an Esc before that drops it with
 *  the tool call); `gone` once it has stopped. */
async function runningCommand(h: Codex, sid: string, args: string) {
  const [pid] = await waitFor(() => (processesOf(args).length > 0 ? processesOf(args) : undefined), {
    timeout: 20_000,
    what: `Codex to run ${args}`,
  })
  const started = startTime(pid!)
  onTestFinished(() => {
    if (started !== null && sameProcess(pid!, started)) process.kill(pid!, "SIGKILL")
  })
  const live = h.sessions.get(sid)!
  const listed = async () => {
    const list = (await live.process!.rpc!.request("thread/backgroundTerminals/list", { threadId: live.threadId })) as {
      data: { command: string }[]
    }
    return list.data.some((t) => t.command.includes(args))
  }
  for (const deadline = Date.now() + 10_000; !(await listed()); await sleep(100)) {
    if (Date.now() > deadline) throw new Error("Codex never listed the command among the thread's terminals")
  }
  return { gone: () => isGone(pid!, started) }
}

test.skipIf(NO_CODEX)(
  "on a real codex, esc stops the command its turn waits on, a command an earlier turn left running goes on, and ending the session stops that one",
  async () => {
    const [server, waited] = [uniqueSleep(1), uniqueSleep(2)]
    const { h, sid, model } = await realSession([
      // The first turn starts a server and is told it runs on; the second waits on a command.
      { run: server, waitMs: 1000 },
      { say: "The server runs." },
      { run: waited, waitMs: 30_000 },
    ])
    await h.sessions.prompt(sid, "Start the server.")
    const first = await runningCommand(h, sid, server)
    await waitFor(() => status(h, sid) === "idle" && model.calls() === 2, { what: "the first turn's end" })
    await h.sessions.prompt(sid, "Run the command.")
    const second = await runningCommand(h, sid, waited)
    expect(model.calls()).toBe(3) // the call still waits on the command
    await h.sessions.interrupt(sid)
    await waitFor(() => status(h, sid) === "idle", { what: "the interrupted turn's end" })
    expect(texts(h, sid).at(-1)).toEndWith("[interrupted]")
    await waitFor(second.gone, { timeout: 5_000, what: "the interrupted turn's command to stop" })
    await sleep(1000)
    expect(first.gone()).toBe(false)
    // Ending an idle session closes its app-server, which stops every command the thread runs.
    await h.sessions.end(sid)
    await waitFor(() => status(h, sid) === "ended", { what: "the end" })
    await waitFor(first.gone, { timeout: 5_000, what: "the server to stop with the session" })
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "on a real codex its standalone installer put in ~/.codex, a session's command runs in its sandbox, from the office's copy",
  async () => {
    if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
    const model = await standInModel([{ run: "echo ran > ran.txt", waitMs: 10_000 }, { say: "It ran." }])
    const codexHome = fs.realpathSync(tempDir())
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `model = "stand-in"\nmodel_provider = "stand_in"\n\n[model_providers.stand_in]\nname = "stand-in"\n` +
        `base_url = "${model.url}"\nwire_api = "responses"\n`,
    )
    let found = ""
    const h = makeCodex({ command: () => [nativeCodex(found).run, ...APP_SERVER_ARGS], environ: { CODEX_HOME: codexHome } })
    found = standaloneCodex(h.home, nativeCodex(CODEX).install)
    const folder = path.join(h.home, ".cache/opencorp/codex")
    const sid = await start(h, h.workspace)
    await h.sessions.prompt(sid, "Run it.")
    await waitFor(() => texts(h, sid).includes("It ran.") && status(h, sid) === "idle", {
      timeout: 60_000,
      what: "the turn",
    })
    expect(fs.readFileSync(path.join(h.workspace, "ran.txt"), "utf8")).toBe("ran\n")
    expect(fs.readdirSync(folder).filter((name) => name.startsWith("install-"))).toHaveLength(1)
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "on a real codex, ending the session stops the command its turn waits on",
  async () => {
    const args = uniqueSleep(3)
    const { h, sid } = await realSession([{ run: args, waitMs: 30_000 }])
    await h.sessions.prompt(sid, "Run the command.")
    const command = await runningCommand(h, sid, args)
    await h.sessions.end(sid)
    await waitFor(() => status(h, sid) === "ended", { what: "the end" })
    await waitFor(command.gone, { timeout: 5_000, what: "the command to stop" })
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "on a real codex, an employee's instrument session goes on in its thread in a new app-server after an office restart",
  async () => {
    const { h, model, options } = await realCodex([{ say: "The build is fixed." }, { say: "The tests pass." }])
    const head = await h.office.git.head()
    const chat = h.store.createSession(
      sessionRow({ cwd: fs.realpathSync(h.workspace), repo_commit: head, opened_by: "ngocbh", connection: "office" }),
    )
    const said = speakers(loadRepo(await h.office.git.pin(head)), chat)
    const heard = { event: () => {}, state: () => {} }
    const of = { observer: heard, label: said.label, owner: said.owner }
    const { id } = await h.sessions.startInstrument(chat, newId(), of)
    await h.sessions.prompt(id, "Fix the build.", { by: "minh" })
    await waitFor(() => model.calls() === 1 && texts(h, id).includes("The build is fixed.") && status(h, id) === "idle", {
      timeout: 60_000,
      what: "the first turn",
    })
    const thread = h.store.getSession(id)!.harness_session_id!
    const r = await restarted(h, options)
    await r.sessions.resumeInstrument(chat, id, thread, of)
    await r.sessions.prompt(id, "Run the tests.", { by: "minh" })
    await waitFor(() => texts(r, id).includes("The tests pass.") && status(r, id) === "idle", {
      timeout: 60_000,
      what: "the resumed turn",
    })
    expect(r.store.getSession(id)!.harness_session_id).toBe(thread)
    // Only the restore's own word that it stopped: Codex took the thread back with no error.
    expect(errors(r, id)).toEqual(["The office restarted, so this Codex session stopped; its employee's next message continues it."])
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "on a real codex, a project the owner trusts while a session runs there refuses the next message before any model call",
  async () => {
    const { h, sid, model, codexHome } = await realSession([])
    const cwd = fs.realpathSync(h.workspace)
    const marker = path.join(fs.realpathSync(tempDir()), "project-mcp-ran")
    expect(spawnSync("git", ["init", "-q", cwd], { env: { PATH: "/usr/bin:/bin", HOME: h.home } }).status).toBe(0)
    fs.mkdirSync(path.join(cwd, ".codex"))
    const project = `[mcp_servers.project_probe]\ncommand = "sh"\nargs = ["-c", "touch ${marker}; exec sleep 3"]\n`
    fs.writeFileSync(path.join(cwd, ".codex/config.toml"), project)
    // As Codex itself writes it the first time the owner runs Codex there.
    fs.appendFileSync(path.join(codexHome, "config.toml"), `\n[projects."${cwd}"]\ntrust_level = "trusted"\n`)
    const e = await rejection(h.sessions.prompt(sid, "Hello."))
    expect([e.code, e.message]).toEqual(["codex_refused", new ProjectConfigLoads([path.join(cwd, ".codex")]).message])
    await sleep(1000)
    expect(model.calls()).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "on a real codex, an MCP server the owner adds while a session runs refuses the next message before it starts",
  async () => {
    const { h, sid, model, codexHome } = await realSession([])
    const marker = path.join(fs.realpathSync(tempDir()), "owner-mcp-ran")
    const server = `\n[mcp_servers.added]\ncommand = "sh"\nargs = ["-c", "touch ${marker}; exec sleep 3"]\n`
    fs.appendFileSync(path.join(codexHome, "config.toml"), server)
    const e = await rejection(h.sessions.prompt(sid, "Hello."))
    expect([e.code, e.message]).toEqual(["codex_refused", new McpServersAdded(["added"]).message])
    await sleep(1000)
    expect(model.calls()).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  },
  120_000,
)
