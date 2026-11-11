/** The SSH plumbing against a real, unprivileged sshd on a high port under a temp folder. Opt-in: set
 *  OPENCORP_TEST_SSHD. The client reads no `~/.ssh` (its config names its own key and known-hosts file, and no agent
 *  socket is passed); the sshd runs the account's login shell for each session, as any sshd does. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { startTime } from "../../src/install/proc.ts"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import type { Spec } from "../../src/reach/spec.ts"
import {
  control,
  descendants,
  exitAll,
  forward,
  isSocket,
  LIMITS,
  type Master,
  mux,
  type ReachContext,
  runChild,
  sshEnv,
  startMaster,
  waitForSocket,
  writeSshFiles,
} from "../../src/reach/ssh.ts"
import { isGone, waitFor } from "../helpers.ts"
import { fakeHome, freePort, holdConnection, holdingServer, reachCtx } from "./helpers.ts"

setDefaultTimeout(60_000)

const SSHD = "/usr/sbin/sshd"
const SSH = "/usr/bin/ssh"
const REAL = !!process.env.OPENCORP_TEST_SSHD && fs.existsSync(SSHD) && fs.existsSync(SSH)
const DRIVER = fileURLToPath(new URL("./master_driver.ts", import.meta.url))
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

/** The running sshd: its folder, port, client config, and the `timeout` that bounds it. */
let sshd: { dir: string; port: number; clientConfig: string; child: ChildProcess; stderr: string[] }

/** Runs a key tool to its end, with only a system PATH. */
function run(argv: [string, ...string[]]): void {
  execFileSync(argv[0], argv.slice(1), { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 30_000 })
}

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
    // Bounded, so a crashed run can't leave it listening.
    const child = spawn("/usr/bin/timeout", ["600", SSHD, "-D", "-e", "-f", config], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "pipe"],
    })
    const stderr: string[] = []
    child.stderr!.setEncoding("utf8").on("data", (c: string) => stderr.push(c))
    sshd = { dir, port, clientConfig, child, stderr }
    await waitFor(() => accepts(port), { timeout: 10_000, what: `sshd on ${port} (${stderr.join("")})` })
  })

  afterAll(async () => {
    if (sshd === undefined) return
    const tree = descendants(sshd.child.pid!).map((pid) => ({ pid, started: startTime(pid) }))
    const exited = new Promise((resolve) => sshd.child.once("exit", resolve))
    sshd.child.kill("SIGTERM")
    await Promise.race([exited, Bun.sleep(5000)])
    for (const { pid, started } of tree) if (!isGone(pid, started)) process.kill(pid, "SIGKILL")
    sshd.child.kill("SIGKILL")
    fs.rmSync(sshd.dir, { recursive: true, force: true })
  })

  test("a real master logs in, runs mux sessions and a socket forward, and ends on -O exit", async () => {
    const ctx = await realCtx()
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
  async function driver(ctx: ReachContext, mode: "plain" | "watcher", port: number) {
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
