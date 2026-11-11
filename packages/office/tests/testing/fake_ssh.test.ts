/** The fake ssh: plain sessions, logins per host, BatchMode, masters, mux clients, `-O` commands, forwards and
 *  `ControlMaster auto`, all on this machine. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type FakeSsh, type FakeSshBehavior, fakeControlName, installFakeSsh } from "../../src/testing/fake_ssh.ts"
import { shortDir, waitFor } from "../helpers.ts"

setDefaultTimeout(30_000)

const ENV = { PATH: "/usr/bin:/bin" }

/** A fake ssh in a fresh short folder. When the test finishes, every master it started is ended, then the folder
 *  removed. */
function fakeSsh(behavior?: FakeSshBehavior): FakeSsh {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const fake = installFakeSsh(dir, behavior)
  onTestFinished(() => {
    for (const pid of fake.masters()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return fake
}

/** Runs the fake with `args` to its end (at most 10 s). */
function run(fake: FakeSsh, args: string[], env: Record<string, string> = ENV) {
  const ran = spawnSync(fake.ssh, args, { env, encoding: "utf8", timeout: 10_000 })
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

/** A config file in `dir` with `lines`. */
function config(dir: string, lines: string[]): string {
  const file = path.join(dir, `config-${lines.length}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, lines.join("\n") + "\n")
  return file
}

test("the fake logs each argv and runs a plain session's command here", () => {
  const fake = fakeSsh()
  expect(run(fake, ["-F", "/x", "-J", "login", "--", "node", "echo hi"])).toEqual({ code: 0, stdout: "hi\n", stderr: "" })
  expect(run(fake, ["node", "exit", "3"]).code).toBe(3)
  expect(run(fake, ["node"]).code).toBe(0)
  expect(fake.calls()).toEqual([["-F", "/x", "-J", "login", "--", "node", "echo hi"], ["node", "exit", "3"], ["node"]])
})

test("a refused login exits 255 with ssh's words", () => {
  const fake = fakeSsh({ login: "refuse" })
  const ran = run(fake, ["u@node", "echo hi"])
  expect([ran.code, ran.stdout]).toEqual([255, ""])
  expect(ran.stderr).toContain("u@node: Permission denied")
})

test("each jump host logs in before the destination, by its own mode", () => {
  const fake = fakeSsh({ hosts: { login: { login: "refuse" }, node: { login: "refuse" } } })
  const viaLogin = run(fake, ["-J", "u@login:2222", "node", "echo hi"])
  expect(viaLogin.code).toBe(255)
  expect(viaLogin.stderr).toContain("u@login: Permission denied")
  expect(viaLogin.stderr).not.toContain("node")
  fake.set({ hosts: { node: { login: "refuse" } } })
  const atNode = run(fake, ["-J", "login", "node", "echo hi"])
  expect(atNode.code).toBe(255)
  expect(atNode.stderr).toContain("node: Permission denied")
  fake.set({ login: "refuse", hosts: { login: { login: "ok" }, gw: { login: "ok" }, node: { login: "ok" } } })
  expect(run(fake, ["-J", "gw,login", "node", "echo hi"]).stdout).toBe("hi\n")
  expect(run(fake, ["-J", "gw,other", "node", "echo hi"]).stderr).toContain("other: Permission denied")
})

test("BatchMode in the -F file uses the host's batch mode and never prompts", () => {
  const dir = shortDir()
  const batch = config(dir, ["# ours", "BatchMode yes"])
  const fake = fakeSsh({ login: "tty", batch: "refuse" })
  const started = performance.now()
  const ran = run(fake, ["-F", batch, "node", "echo hi"])
  expect(ran.code).toBe(255)
  expect(ran.stderr).toContain("Permission denied")
  expect(performance.now() - started).toBeLessThan(5000)
  expect(fake.tty()).toEqual([])
  fake.set({ login: "refuse", batch: "ok" })
  expect(run(fake, ["-F", batch, "node", "echo hi"]).stdout).toBe("hi\n")
  expect(run(fake, ["-F", config(dir, ["BatchMode no"]), "node", "echo hi"]).code).toBe(255)
  // A host's own batch mode wins, and with none set a host that would prompt is refused.
  fake.set({ login: "tty", hosts: { node: { batch: "ok" } } })
  expect(run(fake, ["-F", batch, "node", "echo hi"]).stdout).toBe("hi\n")
  expect(run(fake, ["-F", batch, "other", "echo hi"]).code).toBe(255)
  expect(fake.tty()).toEqual([])
})

test("a hanging login runs until it is killed", async () => {
  const fake = fakeSsh({ login: "hang" })
  const child = spawn(fake.ssh, ["node", "echo hi"], { env: ENV, stdio: "ignore" })
  onTestFinished(() => child.kill("SIGKILL"))
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  const early = await Promise.race([exited, Bun.sleep(1000).then(() => "running")])
  expect(early).toBe("running")
  child.kill("SIGTERM")
  await exited
  expect(fake.calls()).toEqual([["node", "echo hi"]])
})

/** Runs the fake with `args` to its end (at most 10 s), without blocking this process's servers. */
function runAsync(fake: FakeSsh, args: string[], env: Record<string, string> = ENV) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(fake.ssh, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

const isSocket = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isSocket() ?? false

/** A fake master on `sock` to `host` (`args` before it), its stdin a pipe this test holds; killed when the test
 *  finishes. Resolves once its socket is up. */
async function master(fake: FakeSsh, sock: string, args: string[] = [], host = "node") {
  const child = spawn(fake.ssh, [...args, "-M", "-S", sock, "--", host, "cat >/dev/null"], {
    env: ENV,
    stdio: ["pipe", "ignore", "pipe"],
  })
  onTestFinished(() => child.kill("SIGKILL"))
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  await waitFor(() => isSocket(sock), { timeout: 5000, what: "the master's socket" })
  return { child, exited }
}

/** Whether `child` is still running after `ms`. */
async function stillRunning(child: ChildProcess, ms: number): Promise<boolean> {
  await Bun.sleep(ms)
  return child.exitCode === null && child.signalCode === null
}

/** A port free on 127.0.0.1 a moment ago. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** An echo server on the unix socket `file`, closed when the test finishes. */
async function echoServer(file: string): Promise<net.Server> {
  const server = net.createServer((c) => c.pipe(c))
  await new Promise<void>((resolve) => server.listen(file, resolve))
  onTestFinished(() => server.close())
  return server
}

/** Connects to 127.0.0.1:`port`, sends `text`, and resolves to what came back before the connection closed (a reset
 *  too: a closed connection with unread data sends one) or 1 s passed; rejects when it can't connect. */
function talk(port: number, text: string) {
  return new Promise<string>((resolve, reject) => {
    const c = net.connect({ port, host: "127.0.0.1" })
    let got = ""
    c.setEncoding("utf8")
    c.on("connect", () => c.write(text))
    c.on("data", (d: string) => {
      got += d
      if (got.length >= text.length) c.end()
    })
    c.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNRESET" ? resolve(got) : reject(e)))
    c.on("close", () => resolve(got))
    setTimeout(() => c.destroy(), 1000)
  })
}

/** An open connection to 127.0.0.1:`port`, destroyed when the test finishes. */
async function hold(port: number): Promise<net.Socket> {
  const c = net.connect({ port, host: "127.0.0.1" })
  onTestFinished(() => c.destroy())
  await new Promise<void>((resolve, reject) => c.on("connect", resolve).on("error", reject))
  return c
}

test("a master listens on -S after login and ends when its stdin closes", async () => {
  const fake = fakeSsh()
  const sock = path.join(fake.state, "..", "m")
  const m = await master(fake, sock)
  expect(fake.masters()).toEqual([m.child.pid!])
  const ran = await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-o", "ControlMaster=no", "-T", "--", "node", "echo hi; exit 4"])
  expect([ran.code, ran.stdout]).toEqual([4, "hi\n"])
  m.child.stdin!.end()
  expect(await m.exited).toBe(0)
  expect(fs.existsSync(sock)).toBe(false)
  expect(fake.masters()).toEqual([])
  fake.set({ login: "refuse" })
  const refused = await runAsync(fake, ["-M", "-S", sock, "--", "node", "cat >/dev/null"])
  expect(refused.code).toBe(255)
  expect(fs.existsSync(sock)).toBe(false)
})

test("a mux client without a master fails at once with 255", async () => {
  const fake = fakeSsh()
  const sock = path.join(fake.state, "..", "m")
  const started = performance.now()
  const ran = await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-o", "ControlMaster=no", "-o", "ProxyCommand=false", "-T", "--", "node", "echo hi"])
  expect([ran.code, ran.stdout]).toEqual([255, ""])
  expect(ran.stderr).toContain(`Control socket connect(${sock}): No such file or directory`)
  expect(performance.now() - started).toBeLessThan(5000)
})

test("-O check and -O exit", async () => {
  const fake = fakeSsh()
  const sock = path.join(fake.state, "..", "m")
  const m = await master(fake, sock)
  expect((await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "check", "--", "opencorp-hq"])).code).toBe(0)
  // A session running over the master when it's told to exit loses it.
  const session = runAsync(fake, ["-S", sock, "--", "node", "sleep 5"])
  await waitFor(() => fake.calls().length === 3, { what: "the session to start" })
  await Bun.sleep(300)
  const exit = await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "exit", "--", "opencorp-hq"])
  expect(exit.code).toBe(0)
  expect(fs.existsSync(sock)).toBe(false)
  expect(await m.exited).toBe(0)
  expect((await session).code).toBe(255)
  const again = await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "check", "--", "opencorp-hq"])
  expect(again.code).toBe(255)
  expect((await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "exit", "--", "opencorp-hq"])).code).toBe(255)
  expect(fake.masters()).toEqual([])
})

test("a master ends on SIGTERM, removing its socket", async () => {
  const fake = fakeSsh()
  const sock = path.join(fake.state, "..", "m")
  const m = await master(fake, sock)
  m.child.kill("SIGTERM")
  expect(await m.exited).toBe(255)
  expect(fs.existsSync(sock)).toBe(false)
  expect(fake.masters()).toEqual([])
})

test("-O forward forwards 127.0.0.1:P to a unix socket", async () => {
  const fake = fakeSsh()
  const dir = path.join(fake.state, "..")
  await echoServer(path.join(dir, "hq.sock"))
  const sock = path.join(dir, "m")
  const m = await master(fake, sock)
  const port = await freePort()
  const forward = ["-F", "/dev/null", "-S", sock, "-O", "forward", "-L", `127.0.0.1:${port}:${dir}/hq.sock`, "--", "opencorp-hq"]
  expect((await runAsync(fake, forward)).code).toBe(0)
  expect(await talk(port, "hello")).toBe("hello")
  m.child.kill("SIGTERM")
  await m.exited
  await expect(talk(port, "x")).rejects.toThrow()
})

test("a forward to a held port is 255, and the master lives", async () => {
  const fake = fakeSsh()
  const dir = path.join(fake.state, "..")
  const held = net.createServer()
  await new Promise<void>((resolve) => held.listen({ port: 0, host: "127.0.0.1" }, resolve))
  onTestFinished(() => held.close())
  const port = (held.address() as net.AddressInfo).port
  const sock = path.join(dir, "m")
  const m = await master(fake, sock)
  const ran = await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "forward", "-L", `127.0.0.1:${port}:${dir}/hq.sock`, "--", "opencorp-hq"])
  expect(ran.code).toBe(255)
  expect(ran.stderr).toContain("forwarding request failed")
  expect((await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "check", "--", "opencorp-hq"])).code).toBe(0)
  expect(await stillRunning(m.child, 100)).toBe(true)
})

test("like ssh, a master outlives its stdin while a forwarded connection is open", async () => {
  const fake = fakeSsh()
  const dir = path.join(fake.state, "..")
  await echoServer(path.join(dir, "hq.sock"))
  const sock = path.join(dir, "m")
  const m = await master(fake, sock)
  const port = await freePort()
  await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "forward", "-L", `127.0.0.1:${port}:${dir}/hq.sock`, "--", "opencorp-hq"])
  const c = await hold(port)
  m.child.stdin!.end()
  expect(await stillRunning(m.child, 500)).toBe(true)
  c.destroy()
  expect(await m.exited).toBe(0)
  expect(fs.existsSync(sock)).toBe(false)
})

test("refused and blackholed forwards", async () => {
  const fake = fakeSsh({ forward: "refuse" })
  const dir = path.join(fake.state, "..")
  await echoServer(path.join(dir, "hq.sock"))
  const sock = path.join(dir, "m")
  await master(fake, sock)
  const port = await freePort()
  const forward = ["-F", "/dev/null", "-S", sock, "-O", "forward", "-L", `127.0.0.1:${port}:${dir}/hq.sock`, "--", "opencorp-hq"]
  expect((await runAsync(fake, forward)).code).toBe(255)
  fake.set({ forward: "blackhole" })
  expect((await runAsync(fake, forward)).code).toBe(0)
  expect(await talk(port, "hello")).toBe("")
})

/** A config with `ControlMaster auto` and `ControlPath <cm>/%C`, and its cm folder. */
function autoConfig(fake: FakeSsh): { file: string; cm: string } {
  const dir = path.join(fake.state, "..")
  const cm = path.join(dir, "cm")
  fs.mkdirSync(cm)
  return { file: config(dir, ["ControlMaster auto", `ControlPath ${cm}/%C`, "ControlPersist 60"]), cm }
}

test("with ControlMaster auto and no live socket, a plain session leaves a detached master", async () => {
  const fake = fakeSsh()
  const { file, cm } = autoConfig(fake)
  const ran = await runAsync(fake, ["-F", file, "login1", "true"])
  expect(ran.code).toBe(0)
  expect(isSocket(path.join(cm, fakeControlName("login1")))).toBe(true)
  expect(fake.masters()).toHaveLength(1)
})

test("later sessions and a -J hop ride it without logging in", async () => {
  const fake = fakeSsh()
  const { file, cm } = autoConfig(fake)
  expect((await runAsync(fake, ["-F", file, "login1", "true"])).code).toBe(0)
  fake.set({ hosts: { login1: { login: "refuse" } } })
  expect((await runAsync(fake, ["-F", file, "login1", "echo again"])).stdout).toBe("again\n")
  const node = path.join(cm, "node")
  await master(fake, node, ["-F", file, "-J", "login1"])
  expect(fake.masters()).toHaveLength(2)
  expect((await runAsync(fake, ["-F", "/dev/null", "-S", node, "--", "node", "echo there"])).stdout).toBe("there\n")
  // A master of its own through the same hop needs no login either.
  const other = await runAsync(fake, ["-F", file, "-J", "login1", "-M", "-S", path.join(cm, "x"), "--", "node2", "true"])
  expect(other.code).toBe(0)
  // With no master for its hop, a session logs in to it, and is refused.
  fake.set({ hosts: { login2: { login: "refuse" } } })
  const refused = await runAsync(fake, ["-F", file, "-J", "login2", "--", "node3", "true"])
  expect(refused.code).toBe(255)
  expect(refused.stderr).toContain("login2: Permission denied")
})

test("an auto master ends on -O exit, and persistMs after its last connection", async () => {
  const fake = fakeSsh({ persistMs: 300 })
  const { file, cm } = autoConfig(fake)
  const sock = path.join(cm, fakeControlName("login1"))
  expect((await runAsync(fake, ["-F", file, "login1", "true"])).code).toBe(0)
  expect(isSocket(sock)).toBe(true)
  await waitFor(() => !fs.existsSync(sock) && fake.masters().length === 0, { timeout: 3000, what: "the master to persist out" })
  fake.set({ persistMs: 60_000 })
  expect((await runAsync(fake, ["-F", file, "login1", "true"])).code).toBe(0)
  expect((await runAsync(fake, ["-F", "/dev/null", "-S", sock, "-O", "exit", "--", "opencorp-hq"])).code).toBe(0)
  expect(fs.existsSync(sock)).toBe(false)
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "the master to exit" })
})

test("a hop's connection keeps it past persistMs", async () => {
  const fake = fakeSsh({ persistMs: 300 })
  const { file, cm } = autoConfig(fake)
  const login = path.join(cm, fakeControlName("login1"))
  expect((await runAsync(fake, ["-F", file, "login1", "true"])).code).toBe(0)
  const node = await master(fake, path.join(cm, "node"), ["-F", file, "-J", "login1"])
  await Bun.sleep(900)
  expect(isSocket(login)).toBe(true)
  node.child.stdin!.end()
  expect(await node.exited).toBe(0)
  await waitFor(() => !fs.existsSync(login) && fake.masters().length === 0, { timeout: 3000, what: "login1's master to end" })
})
