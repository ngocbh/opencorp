/** How the office daemon is started: its command, environment and log, and the host it runs on. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { expect, test } from "bun:test"
import { Launch, daemonEnv, launch, officeAnswers, resolveHome, runCommand } from "../../src/install/launch.ts"
import { selfCommand, unsafeEnvName } from "../../src/platform.ts"
import { ps, shortDir, tempDir } from "../helpers.ts"
import { Runner, makeHost } from "./helpers.ts"

// Resolved as `launch` resolves it: on a machine without /Users the path comes back as given.
const HOME = resolveHome("/Users/owner/.opencorp")

test("the launch command is the daemons with absolute paths", () => {
  const got = launch("/Users/owner/.opencorp", {
    command: ["/opt/opencorp/bin/opencorp"],
    environ: { PATH: "/usr/bin" },
    userHome: "/Users/owner",
  })
  expect(got).toEqual(
    new Launch(
      ["/opt/opencorp/bin/opencorp", "daemon", "--home", HOME],
      { PATH: "/usr/bin" },
      path.join(HOME, "office"),
      HOME,
      "office",
    ),
  )
  expect([got.office, got.log, got.socket]).toEqual([
    path.join(HOME, "office"),
    path.join(HOME, "office", "office.log"),
    path.join(HOME, "office", "office.sock"),
  ])
  const checkout = ["/b/bun", "--no-install", "--no-env-file", "--config=/dev/null", "/c/packages/cli/src/main.ts"]
  expect(launch(HOME, { command: checkout, environ: {}, userHome: "/Users/owner" }).argv).toEqual([
    ...checkout,
    "daemon",
    "--home",
    HOME,
  ])
  expect(launch(HOME, { environ: {}, userHome: "/Users/owner" }).argv).toEqual([
    ...selfCommand(),
    "daemon",
    "--home",
    HOME,
  ])
})

test("the home is stored as its realpath", () => {
  const dir = tempDir()
  const real = path.join(dir, "real")
  fs.mkdirSync(real)
  fs.symlinkSync(real, path.join(dir, "link"))
  const got = launch(path.join(dir, "link"), { command: ["/opt/opencorp/bin/opencorp"], environ: {}, userHome: dir })
  expect(got.home).toBe(fs.realpathSync(real))
  expect(got.argv.at(-1)).toBe(got.home)
})

test("another home gets its own service name", () => {
  const other = launch("/tmp/h", { command: ["/opt/opencorp/bin/opencorp"], environ: {}, userHome: "/Users/owner" })
  expect(other.name).toMatch(/^office-[0-9a-f]{8}$/)
  expect(launch("/tmp/h", { command: ["/x"], environ: {}, userHome: "/Users/owner" }).name).toBe(other.name)
})

test("the daemon gets only the worker allowlist never keys", () => {
  const environ = {
    PATH: "/usr/bin",
    HOME: "/Users/owner",
    LC_ALL: "C",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp",
    OPENCORP_HOME: "/x",
    // iTerm's, which change with its version: they'd rewrite the service file for nothing.
    LC_TERMINAL: "iTerm2",
    LC_TERMINAL_VERSION: "3.5.0",
  }
  expect(daemonEnv(environ)).toEqual({ PATH: "/usr/bin", HOME: "/Users/owner", LC_ALL: "C", LANG: "en_US.UTF-8" })
})

test("the daemon keeps which codex to run and its home", () => {
  const environ = {
    PATH: "/usr/bin",
    CODEX_HOME: "/Users/owner/.codex-alt",
    OPENCORP_CODEX_BIN: "/opt/codex",
    OPENAI_API_KEY: "sk-secret",
  }
  expect(daemonEnv(environ)).toEqual({
    PATH: "/usr/bin",
    CODEX_HOME: "/Users/owner/.codex-alt",
    OPENCORP_CODEX_BIN: "/opt/codex",
  })
})

test("the daemon keeps where tls finds ca certificates when set", () => {
  const environ = {
    PATH: "/usr/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
    REQUESTS_CA_BUNDLE: "/ca.pem",
  }
  expect(daemonEnv(environ)).toEqual({
    PATH: "/usr/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
  })
  expect(daemonEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" })
})

test("the daemon path keeps only absolute entries", () => {
  const mixed = { PATH: "/usr/bin::bin:./x:/opt/b/../c:", HOME: "/Users/owner" }
  expect(daemonEnv(mixed)).toEqual({ PATH: "/usr/bin:/opt/b/../c", HOME: "/Users/owner" })
  const relative = { PATH: "bin:.", HOME: "/Users/owner" }
  expect(daemonEnv(relative)).toEqual({ HOME: "/Users/owner" })
  for (const environ of [mixed, relative]) expect(daemonEnv(daemonEnv(environ))).toEqual(daemonEnv(environ))
})

test("the daemon env leaves out every name a self spawn may not carry", () => {
  const environ = {
    PATH: "/usr/bin",
    BUN_OPTIONS: "--preload=/tmp/x.ts",
    NODE_OPTIONS: "--require=/tmp/x.js",
    LD_PRELOAD: "/tmp/x.so",
    DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
    NODE_PATH: "/tmp/mods",
  }
  const env = daemonEnv(environ)
  expect(env).toEqual({ PATH: "/usr/bin" })
  for (const key of Object.keys(env)) expect(unsafeEnvName(key)).toBe(false)
})

test("a missing program is exit 127 not an exception", async () => {
  const out = await runCommand(["/nonexistent/launchctl", "print"])
  expect(out.code).toBe(127)
  expect(out.stderr).toContain("nonexistent")
})

/** Whether a child of this process is still running `args`. Reads only. */
function childRuns(args: string): boolean {
  const lines = execFileSync(ps(), ["-A", "-o", "ppid=,args="], { env: {}, timeout: 5000 }).toString().split("\n")
  return lines.some((line) => {
    const [ppid, ...rest] = line.trim().split(/\s+/)
    return Number(ppid) === process.pid && rest.join(" ") === args
  })
}

test("a program that outlives the timeout is exit 124", async () => {
  const started = performance.now()
  const out = await runCommand(["/bin/sleep", "5"], { timeoutMs: 200 })
  expect(performance.now() - started).toBeLessThan(3000)
  expect(out).toEqual({ code: 124, stdout: "", stderr: "/bin/sleep timed out" })
  expect(childRuns("/bin/sleep 5")).toBe(false)
})

test("office answers is false without a server, for a non 200 and for one that never replies", async () => {
  const dir = shortDir()
  expect(await officeAnswers(path.join(dir, "missing.sock"))).toBe(false)

  const failing = http.createServer((_, res) => res.writeHead(503).end())
  const silent = new Set<net.Socket>()
  const mute = net.createServer((conn) => silent.add(conn))
  try {
    await new Promise<void>((resolve) => failing.listen(path.join(dir, "503.sock"), resolve))
    expect(await officeAnswers(path.join(dir, "503.sock"))).toBe(false)

    await new Promise<void>((resolve) => mute.listen(path.join(dir, "mute.sock"), resolve))
    const started = performance.now()
    expect(await officeAnswers(path.join(dir, "mute.sock"), 300)).toBe(false)
    expect(performance.now() - started).toBeLessThan(2000)
  } finally {
    for (const conn of silent) conn.destroy()
    failing.closeAllConnections()
    await Promise.all([failing, mute].map((s) => new Promise((resolve) => s.close(resolve))))
  }
})

test("the install test host runs nothing real and its clock moves only when it sleeps", async () => {
  const runner = new Runner([[["launchctl", "print"], 113, "no such service"]])
  const host = makeHost("/Users/owner", runner)
  expect(await host.run(["launchctl", "print", "gui/501/office"])).toEqual({
    code: 113,
    stdout: "",
    stderr: "no such service",
  })
  expect(await host.run(["launchctl", "bootout"])).toEqual({ code: 0, stdout: "", stderr: "" })
  expect(runner.calls).toEqual([["launchctl", "print", "gui/501/office"], ["launchctl", "bootout"]])
  expect([host.userHome, host.uid, host.which("tmux"), await host.answers("/x.sock")]).toEqual([
    "/Users/owner",
    501,
    null,
    false,
  ])
  expect(() => host.spawn(["/bin/true"], {})).toThrow("tests never spawn without a stand-in")
  const before = host.clock()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(host.clock()).toBe(before)
  await host.sleep(250)
  expect(host.clock()).toBe(before + 250)
})
