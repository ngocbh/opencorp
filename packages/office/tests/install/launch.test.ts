/** How the office daemon is started: its command, environment and log, and the host it runs on. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import {
  Launch,
  type PinOptions,
  daemonArgs,
  daemonEnv,
  launch,
  officeAnswers,
  pinDaemon,
  resolveHome,
  runCommand,
  which,
} from "../../src/install/launch.ts"
import { sameProcess, startTime } from "../../src/install/proc.ts"
import { selfCommand, unsafeEnvName } from "../../src/platform.ts"
import { ps, shortDir, tempDir, waitFor } from "../helpers.ts"
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
  const checkout: [string, ...string[]] = [
    "/b/bun",
    "--no-install",
    "--no-env-file",
    "--config=/dev/null",
    "/c/packages/cli/src/main.ts",
  ]
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

test("the daemon parser takes home and reexeced and nothing else", () => {
  expect(daemonArgs(["--home", "/h", "--reexeced"])).toEqual({ home: "/h", reexeced: true })
  expect(daemonArgs([])).toEqual({ home: undefined, reexeced: false })
  for (const argv of [["--reexeced=x"], ["--bogus"], ["pos"]]) expect(() => daemonArgs(argv)).toThrow()
  // An empty home would resolve to the cwd.
  expect(() => daemonArgs(["--home="])).toThrow("the home can't be empty")
})

const COMMAND: [string] = ["/opt/opencorp/bin/opencorp"]

/** A `pinDaemon` run on `argv` with a stub re-exec that records its calls and returns, and a `write` that keeps
 *  the text. */
function pin(argv: string[], options: Omit<PinOptions, "exec" | "write" | "command"> = {}, exec?: PinOptions["exec"]) {
  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = []
  let text = ""
  const code = pinDaemon(argv, {
    command: COMMAND,
    exec:
      exec ??
      ((argv, env, cwd) => {
        calls.push({ argv, env, cwd })
        return undefined as never
      }),
    write: (t) => void (text += t),
    ...options,
  })
  return { code, calls, text }
}

/** A clean caller env for `home`. */
function clean(home: string): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: home, LANG: "en_US.UTF-8" }
}

test("a daemon already in the office env and folder runs on", () => {
  const home = tempDir()
  const office = path.join(home, "office")
  const got = pin(["--home", home], { environ: daemonEnv(clean(home)), cwd: () => office })
  expect(got.code).toBeUndefined()
  expect(got.calls).toEqual([])
  expect(got.text).toBe("")
  expect(fs.statSync(office).mode & 0o777).toBe(0o700)
})

test("a daemon with another env re-execs into the office env and folder", () => {
  const home = tempDir()
  const office = path.join(home, "office")
  const argv = [...COMMAND, "daemon", "--home", home, "--reexeced"]
  const reexec = (env: Record<string, string>) => ({ argv, env, cwd: office })
  const poisoned = { ...clean(home), OPENAI_API_KEY: "sk-live-0000", BUN_OPTIONS: "--preload x" }
  const shell = pin(["--home", home], { environ: poisoned, cwd: () => office })
  expect(shell.code).toBe(1)
  expect(shell.calls).toEqual([reexec(daemonEnv(poisoned))])
  expect(shell.calls[0]!.env).toEqual(clean(home))
  expect(shell.text).toBe("opencorp office: can't re-exec into the office's env: returned\n")
  const elsewhere = pin(["--home", home], { environ: clean(home), cwd: () => tempDir() })
  expect(elsewhere.code).toBe(1)
  expect(elsewhere.calls).toEqual([reexec(clean(home))])
  const link = path.join(tempDir(), "link")
  fs.symlinkSync(home, link)
  const linked = pin(["--home", link], { environ: { ...poisoned, HOME: link }, cwd: () => office })
  expect(linked.code).toBe(1)
  expect(linked.calls.map((c) => [c.argv, c.cwd])).toEqual([[argv, office]])
  const deleted = pin(["--home", home], {
    environ: clean(home),
    cwd: () => {
      throw Object.assign(new Error("deleted"), { code: "ENOENT" })
    },
  })
  expect(deleted.code).toBe(1)
  expect(deleted.calls).toEqual([reexec(clean(home))])
})

test("a daemon that still differs after its re-exec exits 1 naming variables not values", () => {
  const home = tempDir()
  const environ = { ...clean(home), OPENAI_API_KEY: "sk-live-0000" }
  const got = pin(["--home", home, "--reexeced"], { environ, cwd: () => tempDir() })
  expect(got.code).toBe(1)
  expect(got.text).toBe("opencorp office: still not in the office's env after a re-exec: OPENAI_API_KEY, cwd\n")
  expect(got.text).not.toContain("sk-live-0000")
  expect(got.calls).toEqual([])
})

test("bad arguments exit 2 before any re-exec", () => {
  const home = path.join(tempDir(), "h")
  for (const argv of [["--bogus"], ["--home", home, "--bogus"]]) {
    const got = pin(argv, { environ: { OPENAI_API_KEY: "sk-live-0000" } })
    expect(got.code).toBe(2)
    expect(got.text).toStartWith("opencorp office: ")
    expect(got.calls).toEqual([])
  }
  expect(fs.existsSync(home)).toBe(false)
})

test("a refused office dir exits 1 before any re-exec", () => {
  const home = tempDir()
  const office = path.join(home, "office")
  fs.symlinkSync(tempDir(), office)
  const got = pin(["--home", home], { environ: clean(home), cwd: () => tempDir() })
  expect(got.code).toBe(1)
  expect(got.text).toBe(`opencorp office: the office directory ${office} is a symlink\n`)
  expect(got.calls).toEqual([])
})

test("a failed re-exec exits 1 with the errors code and never its message", () => {
  const home = tempDir()
  const options = { environ: { ...clean(home), OPENAI_API_KEY: "sk-live-0000" }, cwd: () => tempDir() }
  const coded = pin(["--home", home], options, () => {
    throw Object.assign(new Error("boom sk-live-0000"), { code: "ENOENT" })
  })
  expect(coded.code).toBe(1)
  expect(coded.text).toBe("opencorp office: can't re-exec into the office's env: ENOENT\n")
  const typed = pin(["--home", home], options, () => {
    throw new RangeError("boom sk-live-0000")
  })
  expect(typed.code).toBe(1)
  expect(typed.text).toBe("opencorp office: can't re-exec into the office's env: RangeError\n")
})

const SRC = path.join(import.meta.dir, "../../src")

/** Every module `file` names: static and bare imports, re-exports, `import()` and `require()`, comments left out;
 *  `import type` and `export type` are kept unless `values` is set. */
function specifiers(file: string, { values = false } = {}): string[] {
  const code = fs
    .readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(type\s+)?(?:(?!\b(?:import|export)\b)[^"'`;])*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*()["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*()["']([^"']+)["']/g,
  ]
  for (const pattern of patterns) {
    for (const [, type, name] of code.matchAll(pattern)) if (!(values && type)) found.push(name!)
  }
  return found
}

test("the pre re-exec check imports only node builtins platform and sockets", () => {
  const launchImports = specifiers("install/launch.ts")
  expect(launchImports).toContain("../platform.ts")
  expect(launchImports).toContain("../daemon/sockets.ts")
  for (const name of launchImports) expect(name).toMatch(/^(node:.+|\.\.\/platform\.ts|\.\.\/daemon\/sockets\.ts)$/)
  const socketImports = specifiers("daemon/sockets.ts")
  expect(socketImports.length).toBeGreaterThan(0)
  for (const name of socketImports) expect(name).toMatch(/^node:/)
  const platformImports = specifiers("platform.ts", { values: true })
  expect(platformImports.length).toBeGreaterThan(0)
  for (const name of platformImports) expect(name).toMatch(/^(node|bun):/)
  const main = fs.readFileSync(path.join(SRC, "main.ts"), "utf8")
  const start = main.indexOf("export const daemonMain")
  const body = main.slice(start, main.indexOf("\n}\n", start))
  const pinAt = body.indexOf('import("./install/launch.ts")')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(pinAt).toBeGreaterThanOrEqual(0)
  expect(body.indexOf('import("./daemon/main.ts")')).toBeGreaterThan(pinAt)
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

  // Output written before the kill is kept.
  expect(await runCommand(["/bin/sh", "-c", "echo hi; exec /bin/sleep 5"], { timeoutMs: 1000 })).toEqual({
    code: 124,
    stdout: "hi\n",
    stderr: "/bin/sh timed out",
  })

  // A grandchild holding the pipes doesn't hold the call past its timeout. The grandchild writes its own pid
  // before it becomes the sleep, so the file appears however soon its parent is killed once it has started it;
  // the 1 s timeout leaves time to start it.
  const pidFile = path.join(tempDir(), "pid")
  const again = performance.now()
  const held = await runCommand(
    ["/bin/sh", "-c", `/bin/sh -c 'echo $$ > ${pidFile}; exec /bin/sleep 5' & wait`],
    { timeoutMs: 1000 },
  )
  const took = performance.now() - again
  const grandchild = await waitFor(() => {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""
    return /^\d+\n$/.test(text) ? Number(text) : null
  }, {
    timeout: 5000,
    what: "the grandchild's pid",
  })
  const grandchildStarted = startTime(grandchild)
  onTestFinished(() => {
    if (grandchildStarted !== null && sameProcess(grandchild, grandchildStarted)) process.kill(grandchild, "SIGKILL")
  })
  expect(took).toBeLessThan(3000)
  expect(held.code).toBe(124)
})

test("which finds a runnable program on the absolute path entries only", () => {
  const dir = tempDir()
  const [folder, plain, runnable, second, links] = ["folder", "plain", "runnable", "second", "links"].map((name) =>
    path.join(dir, name),
  )
  for (const entry of [folder, plain, runnable, second, links]) fs.mkdirSync(entry!)
  fs.mkdirSync(path.join(folder!, "prog"))
  fs.writeFileSync(path.join(plain!, "prog"), "#!/bin/sh\n", { mode: 0o644 })
  for (const entry of [runnable, second]) fs.writeFileSync(path.join(entry!, "prog"), "#!/bin/sh\n", { mode: 0o755 })
  fs.symlinkSync(path.join(runnable!, "prog"), path.join(links!, "prog"))

  const searchPath = [path.relative(process.cwd(), runnable!), folder, plain, runnable, second].join(":")
  expect(which("prog", searchPath)).toBe(path.join(runnable!, "prog"))
  expect(which("prog", [folder, plain].join(":"))).toBeNull()
  expect(which("prog", undefined)).toBeNull()
  expect(which("prog", links)).toBe(path.join(links!, "prog"))

  expect(which(path.join(second!, "prog"), "")).toBe(path.join(second!, "prog"))
  expect(which(path.join(plain!, "prog"), runnable)).toBeNull()
  expect(which(path.join(folder!, "prog"), runnable)).toBeNull()
  expect(which("./prog", runnable)).toBeNull()
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
