/** The SSH plumbing against a real, unprivileged sshd on a high port under a temp folder. Opt-in: set
 *  OPENCORP_TEST_SSHD. The client reads no `~/.ssh` (its config names its own key and known-hosts file, and no agent
 *  socket is passed); the sshd runs the account's login shell for each session, as any sshd does. */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { startTime } from "../../../src/util/proc.ts"
import { makeDirs, ReachPaths } from "../../../src/features/reach/paths.ts"
import type { Spec } from "../../../src/features/reach/spec.ts"
import {
  control,
  controlArgv,
  descendants,
  exitAll,
  forward,
  isSocket,
  knowsSessionOptions,
  LIMITS,
  type Master,
  mux,
  type ReachContext,
  runChild,
  sshEnv,
  startMaster,
  waitForSocket,
  writeSshFiles,
} from "../../../src/features/reach/ssh.ts"
import { writeAccess } from "../../../src/features/reach/state.ts"
import { visit } from "../../../src/features/reach/run.ts"
import { agentPolicy } from "../../../src/features/reach/sandbox.ts"
import { run as sandboxed } from "../../../src/runtime/sandbox/run.ts"
import { startOffice } from "../../../src/testing/office.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { isGone, shortDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import { fakeHome, fakeRemote, freePort, holdConnection, holdingServer, reachCtx, visitDeps } from "./helpers.ts"

setDefaultTimeout(60_000)

const SSHD = "/usr/sbin/sshd"
const SSH = "/usr/bin/ssh"
const REAL = !!process.env.OPENCORP_TEST_SSHD && fs.existsSync(SSHD) && fs.existsSync(SSH)
const DRIVER = fileURLToPath(new URL("./master_driver.ts", import.meta.url))
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../../../..", import.meta.url)))

/** `$1` is sshd, `$2` its config: runs it in the foreground until this shell's stdin ends, then ends it. */
const SSHD_UNDER_LIFELINE = '"$1" -D -e -f "$2" & s=$!\ncat >/dev/null\nkill "$s" 2>/dev/null\nwait "$s"\n'

/** The running sshd: its folder, port, client config, and the shell whose stdin is its lifeline. */
let sshd: { dir: string; port: number; clientConfig: string; child: ChildProcess; stderr: string[] }

/** Runs a key tool to its end, with only a system PATH. */
function run(argv: [string, ...string[]]): void {
  execFileSync(argv[0], argv.slice(1), { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 30_000 })
}

/** How a test runs a control command of its own. */
const RUN = { env: { PATH: "/usr/bin:/bin" }, cwd: "/", timeoutMs: 10_000 }

/** Whether something accepts connections on 127.0.0.1:`port`. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" })
    c.once("connect", () => {
      c.destroy()
      resolve(true)
    })
    c.once("error", () => resolve(false))
  })
}

/** The processes of this user whose command line holds `text`. */
function processesWith(text: string): number[] {
  try {
    return execFileSync("/usr/bin/pgrep", ["-u", String(process.getuid!()), "-f", text], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    })
      .split("\n")
      .filter(Boolean)
      .map(Number)
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
}

/** A fresh short home whose ssh files include the sshd's client config. When the test finishes, every master in its
 *  `cm` is ended, then the folder removed. */
async function realCtx(): Promise<ReachContext> {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  await writeSshFiles(paths, SSH, [sshd.clientConfig])
  const ctx: ReachContext = { paths, ssh: SSH, env: { PATH: "/usr/bin:/bin", HOME: dir }, batch: false, echo: () => {}, limits: LIMITS }
  onTestFinished(async () => {
    await exitAll(ctx)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return ctx
}

/** A master started in `ctx`, killed with its descendants when the test finishes if it's still running. */
function master(ctx: ReachContext, spec: Spec): Master {
  const started = startMaster(ctx, spec, { quiet: true })
  onTestFinished(() => {
    if (started.child.exitCode === null && started.child.signalCode === null) {
      for (const pid of descendants(started.child.pid!)) process.kill(pid, "SIGKILL")
      started.child.kill("SIGKILL")
    }
  })
  return started
}

/** An executable `opencorp` under `ctx`'s home that prints its arguments, for mux sessions to run. */
function remoteOpencorp(ctx: ReachContext): string {
  const file = path.join(ctx.paths.home, "remote", "opencorp")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\necho "ran $*"\n', { mode: 0o700 })
  return file
}

describe.skipIf(!REAL)("a real sshd", () => {
  beforeAll(async () => {
    const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
    run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "host_key")])
    run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "client_key")])
    fs.copyFileSync(path.join(dir, "client_key.pub"), path.join(dir, "authorized_keys"))
    const port = await freePort()
    const config = path.join(dir, "sshd_config")
    fs.writeFileSync(
      config,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${dir}/host_key`,
        `AuthorizedKeysFile ${dir}/authorized_keys`,
        `PidFile ${dir}/sshd.pid`,
        "StrictModes no",
        "UsePAM no",
        "PasswordAuthentication no",
        "ChallengeResponseAuthentication no",
        "PermitUserRC no",
        "AllowStreamLocalForwarding yes",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    )
    const clientConfig = path.join(dir, "client_config")
    fs.writeFileSync(
      clientConfig,
      [
        "Host *",
        `  Port ${port}`,
        `  IdentityFile ${dir}/client_key`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${dir}/known_hosts`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking accept-new",
        "  LogLevel ERROR",
        "",
      ].join("\n"),
    )
    // Under a lifeline, as the master is: a shell that ends sshd once its stdin, a pipe this process holds, closes,
    // so even a killed test run leaves no sshd listening.
    const child = spawn("/bin/sh", ["-c", SSHD_UNDER_LIFELINE, "oc-sshd", SSHD, config], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "ignore", "pipe"],
    })
    child.stdin!.on("error", () => {})
    const stderr: string[] = []
    child.stderr!.setEncoding("utf8").on("data", (c: string) => stderr.push(c))
    sshd = { dir, port, clientConfig, child, stderr }
    await waitFor(() => accepts(port), { timeout: 10_000, what: `sshd on ${port} (${stderr.join("")})` })
  })

  afterAll(async () => {
    if (sshd === undefined) return
    const tree = descendants(sshd.child.pid!).map((pid) => ({ pid, started: startTime(pid) }))
    const exited = new Promise((resolve) => sshd.child.once("exit", resolve))
    sshd.child.stdin!.end()
    await Promise.race([exited, Bun.sleep(5000)])
    for (const { pid, started } of tree) if (!isGone(pid, started)) process.kill(pid, "SIGKILL")
    sshd.child.kill("SIGKILL")
    fs.rmSync(sshd.dir, { recursive: true, force: true })
  })

  test("a real master logs in, runs mux sessions and a socket forward, and ends on -O exit", async () => {
    const ctx = await realCtx()
    // This ssh takes the generated config, with or without the session options it may not know.
    const parsed = spawnSync(SSH, ["-G", "-F", ctx.paths.config, "127.0.0.1"], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 10_000 })
    expect(parsed.status).toBe(0)
    expect(fs.readFileSync(ctx.paths.config, "utf8").includes("SessionType default")).toBe(knowsSessionOptions(SSH))
    const spec = { host: "127.0.0.1", opencorp: remoteOpencorp(ctx) }
    const node = master(ctx, spec)
    expect(await waitForSocket(node, 20_000)).toBe("up")
    const ran = await mux(ctx, spec, ["hq", "--check", "--json"])
    expect([ran.code, ran.stdout.trim().split("\n").at(-1)]).toEqual([0, "ran hq --check --json"])
    const hq = path.join(ctx.paths.home, "hq.sock")
    const server = await holdingServer(hq)
    const port = await freePort()
    expect((await forward(ctx, spec, port, hq)).code).toBe(0)
    const held = await holdConnection(port)
    held.socket.write("ping")
    const echoed = await new Promise<string>((resolve) => held.socket.once("data", (d) => resolve(d.toString())))
    expect(echoed).toBe("ping")
    expect(server.connections.size).toBe(1)
    expect((await control(ctx, ctx.paths.node, "check")).code).toBe(0)
    expect((await control(ctx, ctx.paths.node, "exit")).code).toBe(0)
    await node.exited
    await held.closed
    await waitFor(() => !fs.existsSync(ctx.paths.node), { timeout: 5000, what: "the control socket to go" })
    expect(await accepts(port)).toBe(false)
  })

  test("a real mux client with no master fails at once with 255", async () => {
    const ctx = await realCtx()
    const started = performance.now()
    const ran = await mux(ctx, { host: "127.0.0.1", opencorp: remoteOpencorp(ctx) }, ["hq"])
    expect(ran.code).toBe(255)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(fs.existsSync(ctx.paths.node)).toBe(false)
  })

  test("a real -J hop rides the login master reach.sh left, and exitAll ends both", async () => {
    const ctx = await realCtx()
    const login = await runChild([ctx.paths.wrapper, "localhost", "true"], { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: 30_000 })
    expect(login.code).toBe(0)
    const before = fs.readdirSync(ctx.paths.cm)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatch(/^[0-9a-f]{40}$/)
    const spec = { host: "127.0.0.1", jump: ["localhost"], opencorp: remoteOpencorp(ctx) }
    const node = master(ctx, spec)
    expect(await waitForSocket(node, 20_000)).toBe("up")
    // The hop rode the login master, so it made no socket of its own.
    expect(fs.readdirSync(ctx.paths.cm).sort()).toEqual([...before, "node"].sort())
    expect((await mux(ctx, spec, ["true"])).code).toBe(0)
    const hq = path.join(ctx.paths.home, "hq.sock")
    await holdingServer(hq)
    const port = await freePort()
    expect((await forward(ctx, spec, port, hq)).code).toBe(0)
    expect(await accepts(port)).toBe(true)
    await exitAll(ctx)
    expect(fs.readdirSync(ctx.paths.cm)).toEqual([])
    await node.exited
    await waitFor(() => processesWith(ctx.paths.cm).length === 0, { timeout: 10_000, what: "every master to end" })
  })

  /** Starts the driver on `ctx`'s home in `mode`; resolves once its master is up, with the sleep it started. */
  async function driver(ctx: ReachContext, mode: "plain" | "watcher" | "jump", port: number) {
    const child = spawn(process.execPath, [...BUN_FLAGS, DRIVER, ctx.paths.home, mode, String(port)], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "inherit"],
    })
    onTestFinished(() => child.kill("SIGKILL"))
    const line = String((await createInterface({ input: child.stdout! })[Symbol.asyncIterator]().next()).value)
    expect(line).toMatch(/^up [0-9]+$/)
    const sleep = Number(line.split(" ")[1])
    const started = startTime(sleep)
    onTestFinished(() => {
      if (!isGone(sleep, started)) process.kill(sleep, "SIGKILL")
    })
    return { child, exited: new Promise((resolve) => child.once("exit", resolve)) }
  }

  test("with no connection open, the remote cat alone ends a real master after its holder's SIGKILL", async () => {
    const ctx = await realCtx()
    const held = await driver(ctx, "plain", 0)
    expect((await control(ctx, ctx.paths.node, "check")).code).toBe(0)
    held.child.kill("SIGKILL")
    await held.exited
    await waitFor(async () => (await control(ctx, ctx.paths.node, "check")).code === 255, { timeout: 10_000, what: "the master to end" })
    await waitFor(() => processesWith(ctx.paths.cm).length === 0, { timeout: 10_000, what: "no process on cm" })
  })

  test("with a connection held through the forward, the watcher ends the real master within seconds of a SIGKILL", async () => {
    const ctx = await realCtx()
    const server = await holdingServer(path.join(ctx.paths.home, "hq.sock"))
    const port = await freePort()
    const held = await driver(ctx, "watcher", port)
    const conn = await holdConnection(port)
    await waitFor(() => server.connections.size === 1, { what: "the forwarded connection" })
    expect(processesWith("opencorp-hq-watch").length).toBeGreaterThan(0)
    const started = performance.now()
    held.child.kill("SIGKILL")
    await held.exited
    await conn.closed
    await waitFor(async () => (await control(ctx, ctx.paths.node, "check")).code === 255, { timeout: 5000, what: "the master to end" })
    expect(await accepts(port)).toBe(false)
    await waitFor(() => fs.readdirSync(ctx.paths.cm).length === 0, { timeout: 5000, what: "cm to empty" })
    expect(performance.now() - started).toBeLessThan(5000)
    await waitFor(() => processesWith(ctx.paths.cm).length === 0, { timeout: 10_000, what: "no process on cm" })
  })

  test("with a -J login master and a connection held, the watcher ends both masters within seconds of a SIGKILL", async () => {
    const ctx = await realCtx()
    const server = await holdingServer(path.join(ctx.paths.home, "hq.sock"))
    const port = await freePort()
    const held = await driver(ctx, "jump", port)
    const names = fs.readdirSync(ctx.paths.cm).sort()
    expect(names).toHaveLength(2)
    expect(names[0]).toMatch(/^[0-9a-f]{40}$/)
    expect(names[1]).toBe("node")
    const login = path.join(ctx.paths.cm, names[0]!)
    const conn = await holdConnection(port)
    await waitFor(() => server.connections.size === 1, { what: "the forwarded connection" })
    const started = performance.now()
    held.child.kill("SIGKILL")
    await held.exited
    await conn.closed
    await waitFor(() => fs.readdirSync(ctx.paths.cm).length === 0, { timeout: 5000, what: "cm to empty" })
    expect(performance.now() - started).toBeLessThan(5000)
    expect((await control(ctx, ctx.paths.node, "check")).code).toBe(255)
    expect((await control(ctx, login, "check")).code).toBe(255)
    expect(await accepts(port)).toBe(false)
    await waitFor(() => server.connections.size === 0, { timeout: 5000, what: "HQ's side of the connection to close" })
    await waitFor(() => processesWith(ctx.paths.cm).length === 0, { timeout: 10_000, what: "no process on cm" })
  })

  test("a visit reaches a real office through sshd, signs in, and Ctrl-C ends every master with HQ's event stream open", async () => {
    const app = shortDir()
    fs.writeFileSync(path.join(app, "index.html"), "<!doctype html><title>HQ</title>\n")
    fs.writeFileSync(path.join(app, "build.json"), JSON.stringify({ build: "b1", api: "x" }))
    const office = await startOffice({ hq: { tcp: false, app_dir: app } })
    onTestFinished(() => office.stop())
    const dir = shortDir()
    const paths = new ReachPaths(dir)
    makeDirs(paths)
    const spec = {
      host: "127.0.0.1",
      jump: ["localhost"],
      opencorp: path.join(CHECKOUT, "packages/cli/bin/opencorp"),
      env: { OPENCORP_HOME: office.home, OPENCORP_BUN: process.execPath },
    }
    const body = `set -eu\nssh localhost true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`
    await writePrivate(paths.script, body)
    await writePrivate(paths.approved, body)
    const port = await freePort()
    await writeAccess(paths, {
      port,
      sha256: createHash("sha256").update(body).digest("hex"),
      learned_at: new Date().toISOString(),
      last_used_at: null,
      signed_in_at: null,
    })
    const v = visitDeps(dir, null, {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      sshIncludes: [sshd.clientConfig],
      limits: LIMITS,
    })
    const done = visit({ signIn: true, open: false }, v.deps)
    await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 0, {
      what: "the visit to connect",
    })
    expect(v.errors).toEqual([])
    const code = new RegExp(`^http://127\\.0\\.0\\.1:${port}/pair#([A-Za-z0-9_-]{22})$`).exec(v.printed[0]!)?.[1]
    expect(code).toBeDefined()
    const origin = `http://127.0.0.1:${port}`
    const res = await fetch(`${origin}/api/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!
    expect(cookie).toStartWith(`opencorp_hq_${port}=`)
    // A tab's event stream: an open channel through the forward that outlasts the remote cat.
    const events = await new Promise<{ first: string; ended: Promise<void> }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie } }, (r) => {
        r.setEncoding("utf8")
        r.on("error", () => {})
        const ended = new Promise<void>((end) => r.once("close", () => end()))
        r.once("data", (chunk: string) => resolve({ first: chunk.split("\n")[0]!, ended }))
      })
      req.on("error", reject)
      onTestFinished(() => req.destroy())
    })
    expect(events.first).toBe(": connected")
    v.sigint()
    expect(await done).toBe(0)
    await events.ended
    expect(fs.readdirSync(paths.cm)).toEqual([])
    await waitFor(() => processesWith(paths.dir).length === 0, { timeout: 10_000, what: "no process on the hq folder" })
  })

  /** A visit through the real sshd to a fake HQ on this machine: reach.sh logs in to localhost (the login node), then
   *  prints a spec for 127.0.0.1 through it. `own` is the client's own ssh config, included before the sshd's; its
   *  ControlPath folder is `<dir>/mine`. Resolves once connected. When the test finishes, the visit is stopped and every
   *  master in `mine` ended. */
  async function realVisit(own: string[]) {
    const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
    const mine = path.join(dir, "mine")
    fs.mkdirSync(mine, { mode: 0o700 })
    let stop = async () => {}
    // One hook, in this order: the visit stops, the client's own masters end, then the folder goes.
    onTestFinished(async () => {
      await stop()
      for (const name of fs.readdirSync(mine)) await runChild([SSH, "-F", "/dev/null", "-S", path.join(mine, name), "-O", "exit", "--", "x"], RUN)
      for (const pid of processesWith(mine)) process.kill(pid, "SIGKILL")
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const paths = new ReachPaths(dir)
    makeDirs(paths)
    const remote = await fakeRemote(dir)
    const spec = { host: "127.0.0.1", jump: ["localhost"], opencorp: remote.opencorp }
    const body = `set -eu\nssh localhost true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`
    await writePrivate(paths.script, body)
    await writePrivate(paths.approved, body)
    const port = await freePort()
    await writeAccess(paths, {
      port,
      sha256: createHash("sha256").update(body).digest("hex"),
      learned_at: new Date().toISOString(),
      last_used_at: null,
      signed_in_at: null,
    })
    const ownConfig = path.join(dir, "own_config")
    fs.writeFileSync(ownConfig, own.map((line) => line.replaceAll("{mine}", mine)).join("\n") + "\n")
    const v = visitDeps(dir, null, {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      sshIncludes: [ownConfig, sshd.clientConfig],
      limits: LIMITS,
    })
    const done = visit({ signIn: false, open: false }, v.deps)
    stop = async () => {
      v.sigint()
      await done
    }
    await waitFor(() => v.printed.some((line) => line.startsWith("Connected.")) || v.errors.length > 0, {
      what: "the visit to connect",
    })
    expect(v.errors).toEqual([])
    return { v, done, paths, port, mine }
  }

  /** The client's own connection sharing for the login node, as the owner keeps it in `~/.ssh/config`. */
  const SHARING = ["Host localhost", "  ControlMaster auto", "  ControlPath {mine}/%C", "  ControlPersist 30"]

  test("with ControlMaster, ControlPath and ControlPersist in the client's config, the visit's login master is in the client's folder and outlives the visit, while the node master in hq/cm ends with it", async () => {
    const { v, done, paths, mine } = await realVisit(SHARING)
    // The node's hop rode the login master in the client's folder: hq/cm holds the node master alone.
    expect(fs.readdirSync(paths.cm)).toEqual(["node"])
    const logins = fs.readdirSync(mine)
    expect(logins).toHaveLength(1)
    v.sigint()
    expect(await done).toBe(0)
    expect(fs.readdirSync(paths.cm)).toEqual([])
    await waitFor(() => processesWith(paths.cm).length === 0, { timeout: 10_000, what: "the node master to end" })
    // The client's own master is theirs to keep: still up, for their terminals to reuse.
    expect((await runChild(controlArgv(SSH, path.join(mine, logins[0]!), "check"), RUN)).code).toBe(0)
  })

  test("with none set, the visit's masters are in hq/cm, one login serves the visit, and they end with it", async () => {
    const { v, done, paths, mine } = await realVisit(["# The client shares nothing."])
    const names = fs.readdirSync(paths.cm).sort()
    // reach.sh's login to localhost left the one master the node's hop rode, beside the node master.
    expect(names).toHaveLength(2)
    expect(names[0]).toMatch(/^[0-9a-f]{40}$/)
    expect(names[1]).toBe("node")
    expect(fs.readdirSync(mine)).toEqual([])
    v.sigint()
    expect(await done).toBe(0)
    expect(fs.readdirSync(paths.cm)).toEqual([])
    await waitFor(() => processesWith(paths.dir).length === 0, { timeout: 10_000, what: "no process on the hq folder" })
  })

  test("HQ's forward is on the node master only", async () => {
    const { v, done, port, mine } = await realVisit(SHARING)
    const login = path.join(mine, fs.readdirSync(mine)[0]!)
    expect(await accepts(port)).toBe(true)
    v.sigint()
    expect(await done).toBe(0)
    // The client's login master outlives the visit, and the port went with the node master.
    expect((await runChild(controlArgv(SSH, login, "check"), RUN)).code).toBe(0)
    expect(await accepts(port)).toBe(false)
  })

  /** A user's home whose `~/.ssh` holds the sshd's client key, a known_hosts and a config that shares connections in
   *  `~/.ssh/tmp`, as the owner keeps one; OpenCorp's home in it with the visit's ssh files; and the agent's policy
   *  over them. When the test finishes, every master in `~/.ssh/tmp` is ended, then the folder removed. */
  async function agentHome() {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
    const home = path.join(root, "home")
    const ssh = path.join(home, ".ssh")
    const tmp = path.join(ssh, "tmp")
    for (const dir of [home, ssh, tmp]) fs.mkdirSync(dir, { mode: 0o700 })
    onTestFinished(async () => {
      for (const name of fs.readdirSync(tmp)) await runChild(controlArgv(SSH, path.join(tmp, name), "exit"), RUN)
      for (const pid of processesWith(root)) process.kill(pid, "SIGKILL")
      fs.rmSync(root, { recursive: true, force: true })
    })
    fs.copyFileSync(path.join(sshd.dir, "client_key"), path.join(ssh, "id_test"))
    fs.chmodSync(path.join(ssh, "id_test"), 0o600)
    const config = path.join(ssh, "config")
    const lines = [
      "Host *",
      `  Port ${sshd.port}`,
      `  IdentityFile ${ssh}/id_test`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${ssh}/known_hosts`,
      "  GlobalKnownHostsFile /dev/null",
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "  LogLevel ERROR",
      "  ControlMaster auto",
      `  ControlPath ${tmp}/%C`,
      "  ControlPersist 30",
    ]
    fs.writeFileSync(config, `${lines.join("\n")}\n`, { mode: 0o600 })
    const paths = new ReachPaths(path.join(home, ".opencorp"))
    makeDirs(paths)
    await writeSshFiles(paths, SSH, [config])
    const tmpdir = path.join(root, "tmp")
    fs.mkdirSync(tmpdir, { mode: 0o700 })
    const policy = await agentPolicy(paths, { home, tmpdir, ssh: SSH, env: {} })
    return { home, ssh, tmp, config, paths, policy }
  }

  /** The last line `argv` printed, run in the agent's sandbox, with its exit and stderr. */
  async function inSandbox(a: Awaited<ReturnType<typeof agentHome>>, argv: string[]) {
    const ran = await sandboxed(a.policy, argv, { timeout: 30 })
    return { exit: ran.exit, last: ran.stdout.toString("utf8").trim().split("\n").at(-1), stderr: ran.stderr.toString("utf8") }
  }

  test.skipIf(!sandboxAvailable())(
    "the agent's ssh in the SSH-only sandbox rides a live master of the user's through the read-only ~/.ssh",
    async () => {
      const a = await agentHome()
      // The user's terminal connects, and its master stays for its ControlPersist.
      const opened = await runChild([SSH, "-F", a.config, "127.0.0.1", "true"], RUN)
      expect(opened.code, opened.stderr).toBe(0)
      const sockets = fs.readdirSync(a.tmp)
      expect(sockets).toHaveLength(1)
      // Without the key, only that connection can let the agent's ssh in.
      fs.rmSync(path.join(a.ssh, "id_test"))
      const rode = await inSandbox(a, [SSH, "-F", a.paths.agentConfig, "127.0.0.1", "echo rode"])
      expect([rode.exit, rode.last], rode.stderr).toEqual([0, "rode"])
      // The user's connection is still up, and the agent's ssh kept none of its own.
      expect(fs.readdirSync(a.tmp)).toEqual(sockets)
      expect((await runChild(controlArgv(SSH, path.join(a.tmp, sockets[0]!), "check"), RUN)).code).toBe(0)
    },
  )

  test.skipIf(!sandboxAvailable())("with none open, it connects directly and runs its command", async () => {
    const a = await agentHome()
    const direct = await inSandbox(a, [SSH, "-F", a.paths.agentConfig, "127.0.0.1", "echo direct"])
    expect([direct.exit, direct.last], direct.stderr).toEqual([0, "direct"])
    expect(fs.readdirSync(a.tmp)).toEqual([])
  })

  test.skipIf(!sandboxAvailable())(
    "without the agent's config, it logs in and exits 255, unable to bind in ~/.ssh",
    async () => {
      const a = await agentHome()
      // The user's own config alone: ControlMaster auto, with no master to ride and ~/.ssh read-only.
      const bound = await inSandbox(a, [SSH, "-F", a.config, "127.0.0.1", "echo ran"])
      expect(bound.exit).toBe(255)
      expect(bound.stderr).toContain("Read-only file system")
      expect(bound.last).not.toBe("ran")
      expect(fs.readdirSync(a.tmp)).toEqual([])
    },
  )

  /** One step run against a context; what it yields is compared between the fake and the real ssh. */
  type Scenario = (ctx: ReachContext) => Promise<[string | number, boolean]>
  const SPEC = { host: "127.0.0.1", opencorp: "/o/opencorp" }

  /** A master up in `ctx`, ended with the context. */
  async function up(ctx: ReachContext): Promise<Master> {
    const started = master(ctx, SPEC)
    expect(await waitForSocket(started, 20_000)).toBe("up")
    return started
  }

  const SCENARIOS: [string, Scenario][] = [
    ["a master logs in", async (ctx) => {
      const started = master(ctx, SPEC)
      const result = await waitForSocket(started, 20_000)
      return [result, isSocket(ctx.paths.node)]
    }],
    ["a mux client with no master", async (ctx) => [(await mux(ctx, SPEC, ["hq"])).code, isSocket(ctx.paths.node)]],
    ["-O forward to a held port", async (ctx) => {
      await up(ctx)
      const taken = net.createServer()
      await new Promise<void>((resolve) => taken.listen({ port: 0, host: "127.0.0.1" }, resolve))
      onTestFinished(() => taken.close())
      const ran = await forward(ctx, SPEC, (taken.address() as net.AddressInfo).port, path.join(ctx.paths.home, "hq.sock"))
      return [ran.code, (await control(ctx, ctx.paths.node, "check")).code === 0]
    }],
    ["-O exit", async (ctx) => {
      const started = await up(ctx)
      const ran = await control(ctx, ctx.paths.node, "exit")
      await started.exited
      return [ran.code, isSocket(ctx.paths.node)]
    }],
    ["-O exit on a gone socket", async (ctx) => [(await control(ctx, ctx.paths.node, "exit")).code, isSocket(ctx.paths.node)]],
  ]

  test.each(SCENARIOS)("the fake and the real ssh agree [%s]", async (_name, scenario) => {
    const real = await scenario(await realCtx())
    const { dir, fake } = fakeHome()
    const ctx = await reachCtx(dir, fake)
    onTestFinished(() => exitAll(ctx))
    expect(await scenario(ctx)).toEqual(real)
  })
})
