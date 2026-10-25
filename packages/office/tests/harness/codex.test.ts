/** Starting and stopping one app-server: command, environment, process group, worker record. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { Ajv } from "ajv"
import {
  CodexMissing,
  CodexProcess,
  type CodexProcessOptions,
  CodexSignedOut,
  CodexStartError,
  appServerCommand,
  codexCommand,
  ownerLoad,
} from "../../src/harness/codex.ts"
import { RpcClosed } from "../../src/harness/rpc.ts"
import { killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import type { Store } from "../../src/store/store.ts"
import { reap } from "../../src/worker/reaper.ts"
import { workerEnv } from "../../src/worker/spawn.ts"
import { NO_GROUP, isGone, tempDir, waitFor } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"

setDefaultTimeout(30_000)

const ajv = new Ajv({ strict: false, validateFormats: false })
const CLIENT = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../fixtures/codex/schema/ClientRequest.json"), "utf8")),
)
const FAKE = fileURLToPath(new URL("../../src/testing/fake_codex.ts", import.meta.url))

/** Writes an empty shell script at `file` with `mode`. */
function script(file: string, mode = 0o755) {
  fs.writeFileSync(file, "#!/bin/sh\n")
  fs.chmodSync(file, mode)
}

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (e) {
    return e as Error
  }
  throw new Error("did not throw")
}

test("owner load takes the persons policy", () => {
  expect(ownerLoad("/w", { sandbox: "workspace-write", network: true })).toEqual({
    cwd: "/w",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: { sandbox_workspace_write: { network_access: true } },
  })
  expect(ownerLoad("/w", null).sandbox).toBe("read-only")
  expect(ownerLoad("/w", null).config).toEqual({ sandbox_workspace_write: { network_access: false } })
  // Loads Codex takes.
  for (const policy of [null, { sandbox: "workspace-write" as const, network: true }]) {
    const params = ownerLoad("/w", policy)
    expect(CLIENT({ id: 1, method: "thread/start", params }), ajv.errorsText(CLIENT.errors)).toBe(true)
    const resume = { id: 2, method: "thread/resume", params: { threadId: "t", ...params } }
    expect(CLIENT(resume), ajv.errorsText(CLIENT.errors)).toBe(true)
  }
})

test("codex command finds codex on the office path", () => {
  const dir = tempDir()
  script(path.join(dir, "codex"))
  expect(codexCommand({ PATH: dir }, {})).toEqual([path.join(dir, "codex"), "app-server", "--listen", "stdio://"])
  const e = thrown(() => codexCommand({ PATH: path.join(dir, "empty") }, {}))
  expect(e).toBeInstanceOf(CodexMissing)
  expect(e.message).toContain("isn't installed")
})

test("opencorp codex bin names another codex", () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "bin"))
  const other = path.join(dir, "bin", "codex-dev")
  script(other)
  const empty = { PATH: path.join(dir, "empty") }
  expect(codexCommand(empty, { OPENCORP_CODEX_BIN: other })[0]).toBe(other)
  expect(codexCommand({ PATH: path.join(dir, "bin") }, { OPENCORP_CODEX_BIN: "codex-dev" })[0]).toBe(other)
  const e = thrown(() => codexCommand(empty, { OPENCORP_CODEX_BIN: "codex-dev" }))
  expect(e).toBeInstanceOf(CodexMissing)
  expect(e.message).toContain("OPENCORP_CODEX_BIN names codex-dev, which isn't an executable")
  expect(e.message).toContain("unset it")
  expect(e.message).not.toContain("npm")
})

test("a directory, a file that isnt executable or an empty path is not codex", () => {
  const dirs = tempDir()
  fs.mkdirSync(path.join(dirs, "codex"))
  const files = tempDir()
  script(path.join(files, "codex"), 0o644)
  for (const env of [{ PATH: dirs }, { PATH: files }, { PATH: "" }])
    expect(thrown(() => codexCommand(env, {}))).toBeInstanceOf(CodexMissing)
})

test("the pinned codex makes the app server command", () => {
  expect(appServerCommand("/x/codex")).toEqual(["/x/codex", "app-server", "--listen", "stdio://"])
  const missing = thrown(() => appServerCommand(undefined))
  expect(missing).toBeInstanceOf(CodexMissing)
  expect(missing.message).toContain("isn't installed")
  const override = thrown(() => appServerCommand(undefined, "codex-dev"))
  expect(override).toBeInstanceOf(CodexMissing)
  expect(override.message).toContain("OPENCORP_CODEX_BIN names codex-dev")
})

test("a relative override or path entry is not codex", () => {
  const bin = tempDir()
  script(path.join(bin, "codex"))
  const relative = path.relative(process.cwd(), bin)
  expect(path.isAbsolute(relative)).toBe(false)
  const override = thrown(() =>
    codexCommand({ PATH: path.join(bin, "empty") }, { OPENCORP_CODEX_BIN: path.join(relative, "codex") }),
  )
  expect(override).toBeInstanceOf(CodexMissing)
  expect(override.message).toContain("OPENCORP_CODEX_BIN names")
  expect(thrown(() => codexCommand({ PATH: relative }, {}))).toBeInstanceOf(CodexMissing)
  // No PATH means no entries, not the test process's own PATH.
  expect(thrown(() => codexCommand({}, {}))).toBeInstanceOf(CodexMissing)
})

/** A JSON object from the fake's log: `any`, since the assertions read whatever was written. */
type Entry = Record<string, any>

/** A process the tests started, and its start time. */
type Spawned = { pid: number; started: number | null }

// Every process any test started, checked gone after the file's last test.
const spawned: Spawned[] = []

afterAll(async () => {
  for (const { pid, started } of spawned)
    await waitFor(() => isGone(pid, started), { timeout: 10_000, what: `process ${pid} to go` })
})

/** The fake app-server's command, on `script` (written to `<dir>/s.json`), logging to `<dir>/log.jsonl`. */
function fake(dir: string, script: object = {}): string[] {
  const where = path.join(dir, "s.json")
  fs.writeFileSync(where, JSON.stringify(script))
  const bun = ["--no-install", "--no-env-file", "--config=/dev/null"]
  return [process.execPath, ...bun, FAKE, "--script", where, "--log", path.join(dir, "log.jsonl")]
}

/** The fake's log entries. */
function entries(dir: string): Entry[] {
  return fs
    .readFileSync(path.join(dir, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Watches what `store` records: when the test finishes, each recorded group whose leader still has its start time
 *  is killed, as is each process passed to the returned `track` (by pid and start time, never by name). */
function tracked(store: Store): (pid: number, started: number | null) => void {
  const spy = spyOn(store, "recordWorker")
  const others: Spawned[] = []
  onTestFinished(() => {
    for (const [, { pid, startTime: started }] of spy.mock.calls) {
      spawned.push({ pid, started })
      if (started && sameProcess(pid, started)) killGroup(pid)
    }
    for (const { pid, started } of others) {
      spawned.push({ pid, started })
      if (started !== null && sameProcess(pid, started))
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
    }
  })
  return (pid, started) => others.push({ pid, started })
}

/** The fixed environment every app-server in these tests runs with. */
function env(dir: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: dir }
}

/** A `CodexProcess` under `harness:S1` running the fake in `dir`; `exits` resolves when its `onExit` runs, and `lines`
 *  holds what it logged. */
function proc(dir: string, store: Store, script?: object, over: Partial<CodexProcessOptions> = {}) {
  const lines: string[] = []
  let exited!: () => void
  const exits = new Promise<void>((resolve) => (exited = resolve))
  const p = new CodexProcess(store, "harness:S1", {
    command: fake(dir, script),
    cwd: dir,
    env: env(dir),
    log: path.join(dir, "codex.log"),
    onNotification: () => {},
    onRequest: () => {},
    onExit: () => exited(),
    environ: {},
    logLine: (line) => lines.push(line),
    ...over,
  })
  return { p, exits, lines }
}

/** What `promise` rejected with; throws if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (e) {
    return e as Error
  }
  throw new Error("did not reject")
}

test("start initializes and records the group close removes it", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p, lines } = proc(dir, store)
  await p.start()
  const sent = entries(dir)
    .filter((e) => e.dir === "in")
    .map((e) => e.msg)
  expect(sent.find((m) => m.method === "initialize").params.capabilities).toEqual({ experimentalApi: true })
  expect(sent.some((m) => m.method === "initialized")).toBe(true)
  // What the office sends must be what Codex takes.
  for (const request of sent.filter((m) => "method" in m && "id" in m))
    expect(CLIENT(request), ajv.errorsText(CLIENT.errors)).toBe(true)
  const records = store.listWorkers()
  expect(records).toHaveLength(1)
  const [record] = records
  expect(record!.key).toBe("harness:S1")
  expect(record!.pgid).toBe(p.pid)
  expect(p.alive).toBe(true)
  expect(fs.statSync(path.join(dir, "codex.log")).mode & 0o777).toBe(0o600)
  await p.close(1000)
  expect(p.alive).toBe(false)
  expect(store.listWorkers()).toEqual([])
  expect(isGone(p.pid, record!.startTime)).toBe(true)
  expect(lines).toEqual([])
})

test("a server that dies calls on exit and leaves its stderr in its log", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p, exits } = proc(dir, store, { stderr: "boom: bad config", turns: [[{ exit: 3 }]] })
  await p.start()
  await p.rpc!.request("thread/start", { cwd: dir })
  await p.rpc!.request("turn/start", { threadId: "thr_fake", input: [] })
  await exits
  expect(fs.readFileSync(path.join(dir, "codex.log"), "utf8")).toContain("boom: bad config")
  await p.kill()
})

test("a command that cant be run says to run opencorp doctor and leaves nothing", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const codex = path.join(dir, "codex")
  fs.writeFileSync(codex, "not a program")
  fs.chmodSync(codex, 0o644)
  const { p } = proc(dir, store, undefined, { command: [codex] })
  const e = await rejection(p.start())
  expect(e).toBeInstanceOf(CodexStartError)
  expect(e.message).toContain("Codex couldn't start")
  expect(e.message).toContain("opencorp doctor")
  expect(p.proc).toBeNull()
  expect(store.listWorkers()).toEqual([])
})

test("a refused handshake or sign in raises and leaves nothing", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const log = path.join(dir, "codex.log")
  const refused = proc(dir, store, { initialize_error: { code: -32600, message: "bad" }, stderr: "why" }).p
  const e = await rejection(refused.start())
  expect(e).toBeInstanceOf(CodexStartError)
  expect(e.message).toContain(log)
  expect(e.message).not.toContain("why")
  expect(fs.readFileSync(log, "utf8")).toContain("why")
  expect(store.listWorkers()).toEqual([])
  expect(refused.alive).toBe(false)
  const signedOut = proc(dir, store, { account: null }).p
  expect(await rejection(signedOut.start())).toBeInstanceOf(CodexSignedOut)
  expect(store.listWorkers()).toEqual([])
})

test("a process killed before it starts never spawns", async () => {
  // Office stop can kill a session's app-server while the session is still about to start it.
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p } = proc(dir, store)
  await p.kill()
  expect(await rejection(p.start())).toBeInstanceOf(CodexStartError)
  expect(p.proc).toBeNull()
  expect(store.listWorkers()).toEqual([])
})

test("killing an old app server again leaves the new ones record", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const old = proc(dir, store).p
  await old.start()
  await old.kill()
  const fresh = proc(dir, store).p // a reload: the same key
  await fresh.start()
  await old.kill()
  expect(store.listWorkers().map((r) => r.pid)).toEqual([fresh.pid])
  await fresh.close(1000)
  expect(store.listWorkers()).toEqual([])
})

test("an old app server that died by itself leaves its replacements record", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p: old, exits } = proc(dir, store, { turns: [[{ exit: 1 }]] })
  await old.start()
  await old.rpc!.request("thread/start", { cwd: dir })
  await old.rpc!.request("turn/start", { threadId: "thr_fake", input: [] })
  await exits
  const fresh = proc(dir, store).p // restarted under the same key before the old one was cleaned up
  await fresh.start()
  await old.kill()
  expect(store.listWorkers().map((r) => r.pid)).toEqual([fresh.pid])
  expect(fresh.alive).toBe(true)
  await fresh.close(1000)
})

test("close kills the commands left in its group", async () => {
  const dir = tempDir()
  const store = openStore()
  const track = tracked(store)
  const { p } = proc(dir, store, { turns: [[{ spawn: 300 }, { sleep: 30 }]] })
  await p.start()
  await p.rpc!.request("thread/start", { cwd: dir })
  await p.rpc!.request("turn/start", { threadId: "thr_fake", input: [] })
  const child: number = await waitFor(() => entries(dir).find((e) => e.dir === "spawn")?.pid, {
    what: "the command",
  })
  const childStarted = startTime(child)
  track(child, childStarted)
  await p.close(1000)
  await waitFor(() => isGone(child, childStarted), { timeout: 5000, what: "the command to die" })
})

test("reaping a session never touches its app server", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p } = proc(dir, store)
  await p.start()
  store.recordWorker("S1", { pid: process.pid, pgid: NO_GROUP, startTime: 0 }) // a stale debrief record
  reap(store, "S1") // what the worker spawn does before the debrief worker starts
  expect(store.listWorkers().map((r) => r.key)).toEqual(["harness:S1"])
  expect(p.alive).toBe(true)
  await p.close(1000)
})

test("the app server gets the offices codex home when it is set", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const seen = path.join(dir, "codex_home.txt")
  // A shell in front of the fake writes down the CODEX_HOME the app-server was given.
  const command = ["/bin/sh", "-c", `printf %s "\${CODEX_HOME-unset}" > "${seen}"; exec "$0" "$@"`, ...fake(dir)]
  const home = path.join(dir, "codex-home")
  for (const [environ, expected] of [
    [{ CODEX_HOME: home }, home],
    [{}, "unset"],
  ] as const) {
    const { p } = proc(dir, store, undefined, { command, environ })
    await p.start()
    expect(fs.readFileSync(seen, "utf8")).toBe(expected)
    await p.close(1000)
  }
})

test("the app server keeps where tls finds ca certificates only when set", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const seen = path.join(dir, "certs.txt")
  // A shell in front of the fake writes down the certificate settings the app-server was given.
  const command = [
    "/bin/sh",
    "-c",
    `printf "%s %s" "\${SSL_CERT_FILE-unset}" "\${SSL_CERT_DIR-unset}" > "${seen}"; exec "$0" "$@"`,
    ...fake(dir),
  ]
  for (const [certs, expected] of [
    [{ SSL_CERT_FILE: "/etc/pki/ca.crt", SSL_CERT_DIR: "/etc/pki/certs" }, "/etc/pki/ca.crt /etc/pki/certs"],
    [{}, "unset unset"],
  ] as const) {
    // workerEnv() is the environment the Codex sessions give each app-server.
    const { p } = proc(dir, store, undefined, { command, env: workerEnv({ ...env(dir), ...certs }) })
    await p.start()
    expect(fs.readFileSync(seen, "utf8")).toBe(expected)
    await p.close(1000)
  }
})

test("a kill during the handshake says codex was stopped", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p } = proc(dir, store, { initialize_delay: 2 })
  const starting = p.start()
  // start() spawns before its first await.
  expect(p.proc).not.toBeNull()
  const [started, killed] = await Promise.allSettled([starting, p.kill()])
  expect(started.status).toBe("rejected")
  expect((started as PromiseRejectedResult).reason.message).toBe("Codex was stopped before it started.")
  expect(killed.status).toBe("fulfilled")
  expect(store.listWorkers()).toEqual([])
})

test("only the first kill signals the group", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p, lines } = proc(dir, store)
  await p.start()
  const kill = spyOn(process, "kill")
  try {
    await p.close(1000) // stdin closed: the fake exits by itself
    await p.kill()
    expect(kill.mock.calls.filter(([pid]) => pid === -p.pid)).toHaveLength(1)
  } finally {
    kill.mockRestore()
  }
  expect(lines).toEqual([])
})

test("a closed app server leaves no open pipes", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const { p, exits } = proc(dir, store)
  await p.start()
  await p.close(1000)
  await exits
  expect(p.proc!.stdin!.destroyed).toBe(true)
  expect(p.proc!.stdout!.destroyed).toBe(true)
  expect(await rejection(p.rpc!.request("x"))).toBeInstanceOf(RpcClosed)
})

test("a line over the cap signals the group once", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const command = ["/bin/sh", "-c", "head -c 17000000 /dev/zero | tr '\\0' a; exec sleep 30"]
  const { p, lines } = proc(dir, store, undefined, { command })
  const kill = spyOn(process, "kill")
  try {
    expect((await rejection(p.start())).message).toContain("Codex didn't start")
    await p.close(1000)
    await p.kill()
    expect(kill.mock.calls.filter(([pid]) => pid === -p.pid)).toHaveLength(1)
  } finally {
    kill.mockRestore()
  }
  expect(store.listWorkers()).toEqual([])
  expect(lines).toEqual(["codex: a line over the 16 MiB limit; stopping the app-server"])
})

test("a linked codex log refuses to start", async () => {
  const dir = tempDir()
  const store = openStore()
  tracked(store)
  const outside = path.join(tempDir(), "notes.txt")
  fs.writeFileSync(outside, "keep\n")
  fs.symlinkSync(outside, path.join(dir, "codex.log"))
  const { p } = proc(dir, store)
  expect((await rejection(p.start())).message).toContain("Codex couldn't start")
  expect(fs.readFileSync(outside, "utf8")).toBe("keep\n")
  expect(p.proc).toBeNull()
  expect(store.listWorkers()).toEqual([])
})
