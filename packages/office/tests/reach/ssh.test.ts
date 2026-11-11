/** The SSH plumbing: generated configs and the wrapper, the child runner, the node master, mux and control commands,
 *  and the watcher. */
import { execFileSync, spawn } from "node:child_process"
import { PassThrough } from "node:stream"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import {
  CONTROL_HOST,
  CONTROL_MS,
  cleanOutput,
  control,
  controlArgv,
  configText,
  defaultIncludes,
  descendants,
  endNode,
  exitAll,
  findSsh,
  forward,
  forwardArgv,
  isSocket,
  knowsSessionOptions,
  LIMITS,
  type ReachContext,
  KEEP_CHARS,
  killTree,
  lastStderr,
  masterArgv,
  mux,
  muxArgv,
  quietStdin,
  readStatuses,
  resetStatus,
  runChild,
  sshEnv,
  startMaster,
  startWatcher,
  waitForSocket,
  wrapperText,
  writeSshFiles,
} from "../../src/reach/ssh.ts"
import { isGone, shortDir, waitFor } from "../helpers.ts"
import { fakeHome, freePort, holdConnection, holdingServer, reachCtx, staleSocket } from "./helpers.ts"
import { fakeControlName } from "../../src/testing/fake_ssh.ts"
import { startTime } from "../../src/install/proc.ts"

setDefaultTimeout(30_000)

test("the generated config puts our options before the includes, since ssh keeps the first value", () => {
  expect(configText("/h/hq/cm", { includes: ["/t/a b/cfg"] })).toBe(
    [
      "# Written by opencorp hq on each visit; edits are lost.",
      "ControlMaster auto",
      "ControlPath /h/hq/cm/%C",
      "ControlPersist 60",
      "ServerAliveInterval 15",
      "ServerAliveCountMax 3",
      'Include "/t/a b/cfg"',
      "",
    ].join("\n"),
  )
  const batch = configText("/h/hq/cm", { batch: true, includes: [] }).split("\n")
  expect(batch.slice(0, 3)).toEqual([
    "# Written by opencorp hq on each visit; edits are lost.",
    "BatchMode yes",
    "ControlMaster auto",
  ])
  expect(batch.some((line) => line.startsWith("Include"))).toBe(false)
  expect(() => configText("/h/hq/cm", { includes: ['/t/a"b'] })).toThrow()
  expect(() => configText("/h/hq/cm", { includes: ["/t/a\nProxyCommand x"] })).toThrow()
  expect(defaultIncludes("/u")).toEqual(["/u/.ssh/config", "/etc/ssh/ssh_config"])
})

test("where ssh knows them, the config pins the session options the owner's could use to defeat the lifeline", () => {
  const lines = configText("/h/hq/cm", { includes: ["/i"], sessionOptions: true }).split("\n")
  const pinned = ["SessionType default", "StdinNull no", "ForkAfterAuthentication no"]
  for (const line of pinned) expect(lines.indexOf(line)).toBeGreaterThan(0)
  for (const line of pinned) expect(lines.indexOf(line)).toBeLessThan(lines.indexOf('Include "/i"'))
  // No IgnoreUnknown: the first one read wins, so ours would void the owner's (say, for UseKeychain).
  expect(lines.some((line) => line.startsWith("IgnoreUnknown"))).toBe(false)
  expect(configText("/h/hq/cm", { includes: [] })).not.toContain("SessionType")
})

test("knowsSessionOptions asks the ssh itself, and agrees with its version", () => {
  const dir = shortDir()
  const old = path.join(dir, "old-ssh")
  fs.writeFileSync(old, '#!/bin/sh\ncase "$*" in *SessionType*) echo "Bad configuration option: sessiontype" >&2; exit 255;; esac\nexit 0\n', { mode: 0o700 })
  expect(knowsSessionOptions(old)).toBe(false)
  expect(knowsSessionOptions(path.join(dir, "missing"))).toBe(false)
  const version = execFileSync("/usr/bin/ssh", ["-V"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] })
  const [major, minor] = (/OpenSSH_([0-9]+)\.([0-9]+)/.exec(version) ?? []).slice(1).map(Number)
  expect(knowsSessionOptions("/usr/bin/ssh")).toBe(major! > 8 || (major === 8 && minor! >= 7))
})

test("the wrapper runs the real ssh with our config and records each exit status, even inside a pipeline", () => {
  const dir = shortDir()
  const expected = path.join(dir, "the config")
  fs.mkdirSync(path.join(dir, "real"))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(
    path.join(dir, "real", "ssh"),
    '#!/bin/sh\n[ "$1" = -F ] && [ "$2" = "$EXPECT" ] || exit 9; [ "$3" = bad ] && exit 255; exit 0\n',
    { mode: 0o700 },
  )
  fs.writeFileSync(path.join(dir, "bin", "ssh"), wrapperText(path.join(dir, "real", "ssh")), { mode: 0o700 })
  const env = {
    PATH: `${dir}/bin:/usr/bin:/bin`,
    OPENCORP_SSH_CONFIG: expected,
    OPENCORP_SSH_STATUS: path.join(dir, "status"),
    EXPECT: expected,
  }
  execFileSync("/bin/sh", ["-c", "ssh bad | cat; ssh good; exit 0"], { env, timeout: 10_000 })
  expect(fs.readFileSync(path.join(dir, "status"), "utf8")).toBe("255\n0\n")
  // With no status file named, it records nothing and still passes the exit through.
  const run = () =>
    execFileSync("/bin/sh", ["-c", "ssh bad; echo $?"], {
      env: { PATH: env.PATH, OPENCORP_SSH_CONFIG: expected, EXPECT: expected },
      timeout: 10_000,
    })
  expect(run().toString()).toBe("255\n")
  expect(() => wrapperText("/a/it's/ssh")).toThrow()
})

test("the wrapper records no status for a control command, which opens no connection", () => {
  const dir = shortDir()
  fs.mkdirSync(path.join(dir, "real"))
  fs.mkdirSync(path.join(dir, "bin"))
  // Every call fails as ssh does when it can't connect, or finds no master for -O.
  fs.writeFileSync(path.join(dir, "real", "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "bin", "ssh"), wrapperText(path.join(dir, "real", "ssh")), { mode: 0o700 })
  const status = path.join(dir, "status")
  const env = { PATH: `${dir}/bin:/usr/bin:/bin`, OPENCORP_SSH_CONFIG: "/c", OPENCORP_SSH_STATUS: status }
  const calls = [
    "ssh -O check login1",
    "ssh -p 22 -Ocheck login1",
    "ssh -S /s/sock -O exit login1",
    "ssh -o BatchMode=yes h1",
    "ssh -l -O h2",
    "ssh h3 ls -O",
    "ssh -- -O",
  ]
  execFileSync("/bin/sh", ["-c", calls.map((c) => `${c} || true`).join("\n")], { env, timeout: 10_000 })
  // Connections: the -o one, the one whose user is "-O", the one whose remote command holds -O, and the last.
  expect(fs.readFileSync(status, "utf8")).toBe("255\n255\n255\n255\n")
})

test("writeSshFiles writes the configs 0600 and the wrapper 0700", async () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  await writeSshFiles(paths, "/usr/bin/ssh", ["/i/one"])
  expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.batchConfig).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.wrapper).mode & 0o777).toBe(0o700)
  const sessionOptions = knowsSessionOptions("/usr/bin/ssh")
  expect(fs.readFileSync(paths.config, "utf8")).toBe(configText(paths.cm, { includes: ["/i/one"], sessionOptions }))
  expect(fs.readFileSync(paths.batchConfig, "utf8")).toBe(
    configText(paths.cm, { batch: true, includes: ["/i/one"], sessionOptions }),
  )
  expect(fs.readFileSync(paths.wrapper, "utf8")).toBe(wrapperText("/usr/bin/ssh"))
})

/** An executable `ssh` in `dir`. */
function anSsh(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  return path.join(dir, "ssh")
}

/** A context over `paths` with `env`, for the steps that only read it. */
function context(paths: ReachPaths, env: Record<string, string | undefined>, batch = false): ReachContext {
  return { paths, ssh: "/usr/bin/ssh", env, batch, echo: () => {}, limits: LIMITS }
}

test("findSsh takes the first ssh on PATH that isn't our wrapper", () => {
  const dir = shortDir()
  const paths = new ReachPaths(path.join(dir, "h"))
  makeDirs(paths)
  anSsh(paths.bin)
  const a = anSsh(path.join(dir, "a"))
  anSsh(path.join(dir, "b"))
  fs.mkdirSync(path.join(dir, "empty"))
  fs.mkdirSync(path.join(dir, "notexec"))
  fs.writeFileSync(path.join(dir, "notexec", "ssh"), "", { mode: 0o600 })
  fs.mkdirSync(path.join(dir, "adir", "ssh"), { recursive: true })
  const pathVar = [paths.bin, "rel", "", `${dir}/empty`, `${dir}/notexec`, `${dir}/adir`, `${dir}/a`, `${dir}/b`]
  expect(findSsh(pathVar.join(":"), paths.bin)).toBe(a)
  // A second name for our bin folder is still ours.
  fs.symlinkSync(paths.bin, path.join(dir, "link"))
  expect(findSsh(`${dir}/link:${dir}/b`, paths.bin)).toBe(path.join(dir, "b", "ssh"))
  // A relative entry is never taken, even one that holds an ssh.
  expect(findSsh(path.relative(process.cwd(), path.join(dir, "a")), paths.bin)).toBeNull()
  expect(findSsh(`${paths.bin}:${dir}/empty`, paths.bin)).toBeNull()
  expect(findSsh(undefined, paths.bin)).toBeNull()
})

test("children get our wrapper first and only HOME, SSH_AUTH_SOCK and our two variables", () => {
  const paths = new ReachPaths("/h")
  const env = { PATH: "/usr/bin:/bin", HOME: "/home/x", SSH_AUTH_SOCK: "/a/agent", OPENCORP_HOME: "/h", SECRET: "x" }
  const got = sshEnv(context(paths, env))
  expect(Object.keys(got).sort()).toEqual(["HOME", "OPENCORP_SSH_CONFIG", "OPENCORP_SSH_STATUS", "PATH", "SSH_AUTH_SOCK"])
  expect(got).toEqual({
    PATH: `${paths.bin}:/usr/bin:/bin`,
    HOME: "/home/x",
    SSH_AUTH_SOCK: "/a/agent",
    OPENCORP_SSH_CONFIG: paths.config,
    OPENCORP_SSH_STATUS: paths.status(process.pid),
  })
  expect(sshEnv(context(paths, env, true)).OPENCORP_SSH_CONFIG).toBe(paths.batchConfig)
  const bare = sshEnv(context(paths, { HOME: "/home/x" }))
  expect("SSH_AUTH_SOCK" in bare).toBe(false)
  expect(bare.PATH).toBe(`${paths.bin}:/usr/bin:/bin`)
  expect(sshEnv(context(paths, { PATH: "" })).PATH).toBe(`${paths.bin}:/usr/bin:/bin`)
})

test("status files are reset before a run and read as numbers", () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  const ctx = context(paths, {})
  expect(readStatuses(ctx)).toEqual([])
  resetStatus(ctx)
  const file = paths.status(process.pid)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(readStatuses(ctx)).toEqual([])
  fs.appendFileSync(file, "255\n0\nnot a number\n\n1\n")
  expect(readStatuses(ctx)).toEqual([255, 0, 1])
  resetStatus(ctx)
  expect(fs.readFileSync(file, "utf8")).toBe("")
})

test("cleanOutput keeps tabs and newlines and drops every other control character", () => {
  expect(cleanOutput("a\x1b[2Jb\r\tc\n")).toBe("a[2Jb\tc\n")
  expect(cleanOutput("\x00\x07\x7f\x9b31m\u00e9")).toBe("31m\u00e9")
})

/** Kills `pid` when the current test finishes, if it's still the process that started at `started`. */
function killAfter(pid: number): void {
  const started = startTime(pid)
  onTestFinished(() => {
    if (!isGone(pid, started)) process.kill(pid, "SIGKILL")
  })
}

const RUN = { env: { PATH: "/usr/bin:/bin" }, cwd: "/", timeoutMs: 10_000 }

test("a child is done when it exits, even while a grandchild holds its pipes", async () => {
  const dir = shortDir()
  const pidFile = path.join(dir, "pid")
  const started = performance.now()
  const ran = await runChild(
    ["/bin/sh", "-c", 'echo out; (sleep 30 & echo $! >"$0"); echo err >&2', pidFile],
    RUN,
  )
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
  killAfter(grandchild)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(ran).toEqual({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false })
  expect(isGone(grandchild, startTime(grandchild))).toBe(false)
})

test("a program that can't start is exit 127", async () => {
  const ran = await runChild(["/nonexistent/program"], RUN)
  expect([ran.code, ran.stdout, ran.timedOut]).toEqual([127, "", false])
  expect(ran.stderr).not.toBe("")
  expect((await runChild(["/bin/sh", "-c", "exit 3"], RUN)).code).toBe(3)
  expect((await runChild(["/bin/sh", "-c", "kill -TERM $$"], RUN)).code).toBe(143)
})

test("echo gets stderr as it comes, and stdout only when asked", async () => {
  const script = "echo one >&2; echo two; sleep 0.3; echo three >&2"
  const echoed: string[] = []
  const times: number[] = []
  const started = performance.now()
  const echo = (text: string) => {
    echoed.push(text)
    times.push(performance.now() - started)
  }
  const ran = await runChild(["/bin/sh", "-c", script], { ...RUN, echo })
  expect(echoed.join("")).toBe("one\nthree\n")
  expect(times[0]).toBeLessThan(250)
  expect(ran.stdout).toBe("two\n")
  const both: string[] = []
  await runChild(["/bin/sh", "-c", script], { ...RUN, echo: (t) => both.push(t), echoStdout: true })
  expect(both.join("").split("\n").sort()).toEqual(["", "one", "three", "two"])
  expect(lastStderr({ code: 1, stdout: "", stderr: "a\n\x1b[31mlast\x1b[0m line\n\n", timedOut: false })).toBe("[31mlast[0m line")
  expect(lastStderr({ code: 1, stdout: "", stderr: "", timedOut: false })).toBe("")
  expect(lastStderr({ code: 1, stdout: "", stderr: "x".repeat(400), timedOut: false })).toHaveLength(300)
})

test("past 64 KiB it keeps the last 64 KiB, so the last line survives", async () => {
  const script = "i=0; while [ $i -lt 3000 ]; do echo line-$i-padding-padding-padding; echo e-$i >&2; i=$((i+1)); done"
  const ran = await runChild(["/bin/sh", "-c", script], RUN)
  expect(ran.code).toBe(0)
  expect(ran.stdout).toHaveLength(KEEP_CHARS)
  expect(ran.stdout.endsWith("line-2999-padding-padding-padding\n")).toBe(true)
  expect(ran.stderr.endsWith("e-2999\n")).toBe(true)
})

/** The pid a script wrote to `file`, once it's there; killed when the test finishes. */
async function pidIn(file: string): Promise<{ pid: number; started: number | null }> {
  const text = await waitFor(() => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : ""), { what: file })
  const pid = Number(text)
  killAfter(pid)
  return { pid, started: startTime(pid) }
}

/** Two sleeps under a shell, their pids written under `dir`. */
const TWO_SLEEPS = 'sleep 30 & echo $! >"$0/s30"; sleep 31 & echo $! >"$0/s31"; wait'

test("a child that runs out of time is ended with its descendants", async () => {
  const dir = shortDir()
  const ran = runChild(["/bin/sh", "-c", TWO_SLEEPS, dir], { ...RUN, timeoutMs: 300 })
  const sleeps = [await pidIn(path.join(dir, "s30")), await pidIn(path.join(dir, "s31"))]
  expect((await ran).timedOut).toBe(true)
  await waitFor(() => sleeps.every((s) => isGone(s.pid, s.started)), { timeout: 5000, what: "both sleeps to end" })
})

test("an aborted signal ends a child as a timeout does", async () => {
  const dir = shortDir()
  const stop = new AbortController()
  const ran = runChild(["/bin/sh", "-c", TWO_SLEEPS, dir], { ...RUN, signal: stop.signal })
  const sleeps = [await pidIn(path.join(dir, "s30")), await pidIn(path.join(dir, "s31"))]
  stop.abort()
  const done = await ran
  expect([done.timedOut, done.code]).toEqual([true, 143])
  await waitFor(() => sleeps.every((s) => isGone(s.pid, s.started)), { timeout: 5000, what: "both sleeps to end" })
})

test("a signal aborted before the start ends the child at once", async () => {
  const started = performance.now()
  const ran = await runChild(["/bin/sh", "-c", "sleep 30"], { ...RUN, signal: AbortSignal.abort() })
  expect(ran.timedOut).toBe(true)
  expect(performance.now() - started).toBeLessThan(2000)
})

test("a child that exits in time isn't timed out while its pipes drain", async () => {
  const ran = await runChild(["/bin/sh", "-c", "sleep 0.25; echo done"], { ...RUN, timeoutMs: 350 })
  expect(ran).toEqual({ code: 0, stdout: "done\n", stderr: "", timedOut: false })
})

test("an abort after the child exits stops nothing", async () => {
  const stop = new AbortController()
  const kill = spyOn(process, "kill")
  onTestFinished(() => kill.mockRestore())
  const ran = runChild(["/bin/sh", "-c", "exit 0"], { ...RUN, signal: stop.signal })
  await Bun.sleep(100)
  stop.abort()
  expect(await ran).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false })
  expect(kill).not.toHaveBeenCalled()
})

test("descendants lists children's children", async () => {
  const dir = shortDir()
  const inner = 'sleep 31 & echo $! >"$0/s31"; wait'
  const child = spawn("/bin/sh", ["-c", `sleep 30 & echo $! >"$0/s30"; /bin/sh -c '${inner}' "$0" & echo $! >"$0/sh"; wait`, dir], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: "ignore",
  })
  killAfter(child.pid!)
  const [s30, sh, s31] = [await pidIn(path.join(dir, "s30")), await pidIn(path.join(dir, "sh")), await pidIn(path.join(dir, "s31"))]
  const found = descendants(child.pid!)
  expect([...found].sort()).toEqual([s30.pid, sh.pid, s31.pid].sort())
  // Deepest first: the inner sleep before the shell that started it.
  expect(found.indexOf(s31.pid)).toBeLessThan(found.indexOf(sh.pid))
  expect(descendants(s31.pid)).toEqual([])
  killTree(child.pid!)
  await waitFor(() => [s30, sh, s31].every((s) => isGone(s.pid, s.started)), { timeout: 5000, what: "the tree to end" })
})

const SPEC = { host: "node1", opencorp: "/o/opencorp" }

test("the master runs a remote cat on our pipe, with no ControlPersist and none of the owner's forwards, after --", () => {
  const spec = { host: "u@n", jump: ["a", "b:2222"], port: 2200, opencorp: "/o/opencorp" }
  expect(masterArgv("/usr/bin/ssh", spec, { config: "/c", socket: "/s" })).toEqual([
    "/usr/bin/ssh", "-F", "/c",
    "-M", "-S", "/s",
    "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
    "-J", "a,b:2222",
    "-p", "2200",
    "--", "u@n",
    "cat >/dev/null",
  ])
  expect(masterArgv("/usr/bin/ssh", { host: "n", opencorp: "/o/opencorp" }, { config: "/c", socket: "/s" })).toEqual([
    "/usr/bin/ssh", "-F", "/c", "-M", "-S", "/s",
    "-o", "ControlPersist=no", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
    "--", "n", "cat >/dev/null",
  ])
})

test("waitForSocket is up after login, exited when it's refused, and timed out, killing the master, when it hangs", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const up = startMaster(ctx, SPEC, { quiet: true })
  expect(await waitForSocket(up, 5000)).toBe("up")
  expect(up.socket).toBe(ctx.paths.node)
  expect(isSocket(ctx.paths.node)).toBe(true)
  expect(fake.calls()[0]).toEqual(masterArgv(fake.ssh, SPEC, { config: ctx.paths.config, socket: ctx.paths.node }).slice(1))
  up.lifeline.end()
  expect(await up.exited).toBe(0)

  fake.set({ login: "refuse" })
  const refused = startMaster(ctx, SPEC, { quiet: true })
  expect(await waitForSocket(refused, 5000)).toBe("exited")
  expect(await refused.exited).toBe(255)

  fake.set({ login: "hang" })
  const hangs = startMaster(ctx, SPEC, { quiet: true })
  const started = performance.now()
  expect(await waitForSocket(hangs, 300)).toBe("timed_out")
  expect(performance.now() - started).toBeLessThan(2000)
  expect(await hangs.exited).not.toBe(0)

  const stop = new AbortController()
  const stopped = startMaster(ctx, SPEC, { quiet: true })
  setTimeout(() => stop.abort(), 200)
  expect(await waitForSocket(stopped, 5000, stop.signal)).toBe("timed_out")
  await stopped.exited
  expect(fake.masters()).toEqual([])
})

test("a leftover cm/node never reads as up before the new master has logged in", async () => {
  const { dir, fake } = fakeHome({ login: "hang" })
  const ctx = await reachCtx(dir, fake)
  await staleSocket(ctx.paths.node)
  const master = startMaster(ctx, SPEC, { quiet: true })
  expect(isSocket(ctx.paths.node)).toBe(false)
  expect(await waitForSocket(master, 500)).toBe("timed_out")
  await master.exited
})

test("the master's stderr reaches the owner cleaned, as it comes, and not at all when quiet", async () => {
  const { dir, fake } = fakeHome({ banner: "\x1b]0;owned\x07\x1b[2Jwelcome\r\n" })
  const echoed: string[] = []
  const ctx = await reachCtx(dir, fake, { echo: (t) => echoed.push(t) })
  const master = startMaster(ctx, SPEC)
  expect(await waitForSocket(master, 5000)).toBe("up")
  await waitFor(() => echoed.join("") === "]0;owned[2Jwelcome\n", { timeout: 2000, what: "the banner, cleaned" })
  master.lifeline.end()
  await master.exited
  echoed.length = 0
  const quiet = startMaster(ctx, SPEC, { quiet: true })
  expect(await waitForSocket(quiet, 5000)).toBe("up")
  quiet.lifeline.end()
  await quiet.exited
  await Bun.sleep(300)
  expect(echoed).toEqual([])
})

test("runChild echoes output cleaned and keeps it as it came", async () => {
  const echoed: string[] = []
  const ran = await runChild(["/bin/sh", "-c", "printf 'a\\033[2Jb\\n' >&2"], { ...RUN, echo: (t) => echoed.push(t) })
  expect(echoed.join("")).toBe("a[2Jb\n")
  expect(ran.stderr).toBe("a\x1b[2Jb\n")
})

test("a batch context's master reads config.batch", async () => {
  const { dir, fake } = fakeHome({ login: "tty", batch: "refuse" })
  const ctx = await reachCtx(dir, fake, { batch: true })
  const master = startMaster(ctx, SPEC, { quiet: true })
  expect(await waitForSocket(master, 5000)).toBe("exited")
  expect(fake.calls()[0]!.slice(0, 2)).toEqual(["-F", ctx.paths.batchConfig])
  expect(fake.tty()).toEqual([])
})

test("closing our pipe ends the master when no connection is open", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const master = startMaster(ctx, SPEC, { quiet: true })
  expect(await waitForSocket(master, 5000)).toBe("up")
  expect(fake.masters()).toEqual([master.child.pid!])
  master.lifeline.end()
  expect(await master.exited).toBe(0)
  expect(isSocket(ctx.paths.node)).toBe(false)
  expect(fake.masters()).toEqual([])
})

test("mux steps never log in again and never pass -J", () => {
  expect(muxArgv("/usr/bin/ssh", "/s", "u@n", "'/o/opencorp' 'hq'")).toEqual([
    "/usr/bin/ssh", "-F", "/dev/null", "-S", "/s",
    "-o", "ControlMaster=no", "-o", "ProxyCommand=/usr/bin/false", "-o", "IdentityFile=none",
    "-T", "--", "u@n", "'/o/opencorp' 'hq'",
  ])
})

test("-O forward binds 127.0.0.1 only and names the socket as given", () => {
  expect(forwardArgv("/usr/bin/ssh", "/s", "u@n", 49381, "/h/office/hq.sock")).toEqual([
    "/usr/bin/ssh", "-F", "/dev/null", "-S", "/s",
    "-O", "forward", "-L", "127.0.0.1:49381:/h/office/hq.sock",
    "--", "u@n",
  ])
})

test("control commands name a placeholder host", () => {
  expect(CONTROL_HOST).toBe("opencorp-hq")
  for (const op of ["check", "exit"] as const)
    expect(controlArgv("/usr/bin/ssh", "/s", op)).toEqual(["/usr/bin/ssh", "-F", "/dev/null", "-S", "/s", "-O", op, "--", "opencorp-hq"])
})

test("mux runs the remote command over the master and returns its output", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  fs.mkdirSync(path.join(dir, "remote"))
  const opencorp = path.join(dir, "remote", "opencorp")
  fs.writeFileSync(opencorp, '#!/bin/sh\necho "home=$OPENCORP_HOME args=$*"; echo warn >&2; exit 5\n', { mode: 0o700 })
  const spec = { host: "node1", opencorp, env: { OPENCORP_HOME: "/the/home" } }
  const master = startMaster(ctx, spec, { quiet: true })
  expect(await waitForSocket(master, 5000)).toBe("up")
  const echoed: string[] = []
  const ran = await mux({ ...ctx, echo: (t) => echoed.push(t) }, spec, ["hq", "--check", "--json"])
  expect(ran).toEqual({ code: 5, stdout: "home=/the/home args=hq --check --json\n", stderr: "warn\n", timedOut: false })
  expect(echoed).toEqual([])
  expect(fake.calls().at(-1)).toEqual(muxArgv(fake.ssh, ctx.paths.node, "node1", "env 'OPENCORP_HOME=/the/home' " + `'${opencorp}' 'hq' '--check' '--json'`).slice(1))
  expect((await control(ctx, ctx.paths.node, "check")).code).toBe(0)
  master.lifeline.end()
  await master.exited
  const started = performance.now()
  expect((await mux(ctx, spec, ["hq"])).code).toBe(255)
  expect(performance.now() - started).toBeLessThan(2000)
  expect((await forward(ctx, spec, 49381, "/h/hq.sock")).code).toBe(255)
  expect((await control(ctx, ctx.paths.node, "check")).code).toBe(255)
})

/** Runs `ssh <args>` through the wrapper with the context's env, as reach.sh would. */
function viaWrapper(ctx: ReachContext, args: string[]) {
  return runChild([ctx.paths.wrapper, ...args], { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: 10_000 })
}

/** The `-S` socket of each `-O exit` the fake was run with, in order. */
const exits = (calls: string[][]) =>
  calls.filter((argv) => argv.includes("-O") && argv[argv.indexOf("-O") + 1] === "exit").map((argv) => argv[argv.indexOf("-S") + 1])

/** login1's auto master, left by reach.sh's first ssh, and a node master whose hop rides it. */
async function twoMasters(ctx: ReachContext) {
  expect((await viaWrapper(ctx, ["login1", "true"])).code).toBe(0)
  const login = path.join(ctx.paths.cm, fakeControlName("login1"))
  expect(isSocket(login)).toBe(true)
  const node = startMaster(ctx, { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }, { quiet: true })
  expect(await waitForSocket(node, 5000)).toBe("up")
  return { login, node }
}

test("exitAll ends each master in cm with -O exit, the node's first, and removes what's left", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const { login, node } = await twoMasters(ctx)
  await staleSocket(path.join(ctx.paths.cm, "0dead"))
  fs.writeFileSync(path.join(ctx.paths.cm, "junk"), "")
  fs.symlinkSync(login, path.join(ctx.paths.cm, "alias"))
  expect(fake.masters()).toHaveLength(2)
  await exitAll(ctx)
  expect(fs.readdirSync(ctx.paths.cm)).toEqual([])
  expect(await node.exited).toBe(0)
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "every master to end" })
  // Node first, then the rest by name; never through the symlink.
  expect(exits(fake.calls())).toEqual([ctx.paths.node, path.join(ctx.paths.cm, "0dead"), login])
  await exitAll(ctx)
})

test("exitAll signals no process", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  await twoMasters(ctx)
  const kill = spyOn(process, "kill")
  onTestFinished(() => kill.mockRestore())
  const stop = new AbortController()
  stop.abort()
  await exitAll({ ...ctx, signal: stop.signal })
  expect(kill).not.toHaveBeenCalled()
  expect(fs.readdirSync(ctx.paths.cm)).toEqual([])
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "every master to end" })
})

test("endNode ends only the node master", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const { login, node } = await twoMasters(ctx)
  await endNode(ctx, node)
  expect(await node.exited).toBe(0)
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
  expect(isSocket(login)).toBe(true)
  expect((await control(ctx, login, "check")).code).toBe(0)
  expect(fake.masters()).toHaveLength(1)
  // A master that ignores -O exit is ended by its own process.
  fake.set({})
  const stubborn = startMaster(ctx, { host: "node2", opencorp: "/o/opencorp" }, { quiet: true })
  expect(await waitForSocket(stubborn, 5000)).toBe("up")
  fs.renameSync(ctx.paths.node, path.join(dir, "elsewhere"))
  await staleSocket(ctx.paths.node)
  await endNode({ ...ctx, limits: ctx.limits }, stubborn)
  expect(await stubborn.exited).not.toBe(0)
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
})

/** Whether `pid` still runs `ms` from now. */
async function stillThere(pid: number, ms: number): Promise<boolean> {
  const started = startTime(pid)
  await Bun.sleep(ms)
  return !isGone(pid, started)
}

test("once its pipe closes, the watcher ends every master in cm, even one holding a forwarded connection", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const watcher = startWatcher(ctx)
  onTestFinished(() => watcher.child.kill("SIGKILL"))
  const exited = new Promise<number | null>((resolve) => watcher.child.on("exit", (code) => resolve(code)))
  const { login, node } = await twoMasters(ctx)
  const hq = path.join(dir, "hq.sock")
  const server = await holdingServer(hq)
  const port = await freePort()
  const spec = { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }
  expect((await forward(ctx, spec, port, hq)).code).toBe(0)
  const held = await holdConnection(port)
  await waitFor(() => server.connections.size === 1, { what: "the forwarded connection" })
  // Our pipe to the master closes too, as it would when this process dies.
  node.lifeline.end()
  expect(await stillThere(node.child.pid!, 300)).toBe(true)
  const started = performance.now()
  watcher.child.stdin!.end()
  await held.closed
  expect(await node.exited).toBe(0)
  expect(await exited).toBe(0)
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "every master to end" })
  expect(performance.now() - started).toBeLessThan(3000)
  expect(isSocket(ctx.paths.node) || isSocket(login)).toBe(false)
  expect(exits(fake.calls())).toEqual([ctx.paths.node, login])
})

test("the watcher and its cat ignore INT and HUP", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const watcher = startWatcher(ctx)
  onTestFinished(() => watcher.child.kill("SIGKILL"))
  await waitFor(() => descendants(watcher.child.pid!).length > 0, { what: "the watcher's cat" })
  const tree = [watcher.child.pid!, ...descendants(watcher.child.pid!)]
  for (const pid of tree) for (const sig of ["SIGINT", "SIGHUP"] as const) process.kill(pid, sig)
  for (const pid of tree) expect(await stillThere(pid, 300)).toBe(true)
  await watcher.release()
  expect(watcher.child.exitCode).toBe(0)
})

test("released after exitAll, it exits at once", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const watcher = startWatcher(ctx)
  onTestFinished(() => watcher.child.kill("SIGKILL"))
  await twoMasters(ctx)
  await exitAll(ctx)
  const started = performance.now()
  await watcher.release()
  expect(performance.now() - started).toBeLessThan(2000)
  expect(watcher.child.exitCode).toBe(0)
  await watcher.release()
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "every master to end" })
})

/** A server on `file` that takes each control request and answers `answer`, or never answers when it's null; closed
 *  when the test finishes. */
async function controlServer(file: string, answer: string | null): Promise<void> {
  const server = net.createServer((c) => {
    c.on("error", () => {})
    c.once("data", () => {
      if (answer !== null) c.end(`${answer}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(file, resolve))
  onTestFinished(() => {
    server.close()
    fs.rmSync(file, { force: true })
  })
}

test("exitAll keeps a socket whose -O exit failed while something still listens there", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const refusing = path.join(ctx.paths.cm, "refusing")
  await controlServer(refusing, "error no")
  await staleSocket(path.join(ctx.paths.cm, "dead"))
  await exitAll(ctx)
  expect(fs.readdirSync(ctx.paths.cm)).toEqual(["refusing"])
  expect(exits(fake.calls())).toEqual([path.join(ctx.paths.cm, "dead"), refusing])
})

test("the watcher leaves alone a symlink in cm, even at cm/node, to a socket outside it", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const outside = path.join(dir, "owner.sock")
  const owner = spawn(fake.ssh, ["-M", "-S", outside, "--", "owner", "cat >/dev/null"], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "ignore"] })
  onTestFinished(() => owner.kill("SIGKILL"))
  await waitFor(() => isSocket(outside), { what: "the owner's master" })
  fs.symlinkSync(outside, ctx.paths.node)
  fs.symlinkSync(outside, path.join(ctx.paths.cm, "alias"))
  const watcher = startWatcher(ctx)
  onTestFinished(() => watcher.child.kill("SIGKILL"))
  await watcher.release()
  expect(watcher.child.exitCode).toBe(0)
  expect(exits(fake.calls())).toEqual([])
  expect((await control(ctx, outside, "check")).code).toBe(0)
  await exitAll(ctx)
  expect((await control(ctx, outside, "check")).code).toBe(0)
  expect(fs.readdirSync(ctx.paths.cm)).toEqual([])
})

test("the watcher gives up on a master that never answers its -O exit", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  await controlServer(path.join(ctx.paths.cm, "stuck"), null)
  const watcher = startWatcher(ctx)
  onTestFinished(() => watcher.child.kill("SIGKILL"))
  await waitFor(() => descendants(watcher.child.pid!).length > 0, { what: "the watcher's cat" })
  const started = performance.now()
  await watcher.release()
  const took = performance.now() - started
  expect(watcher.child.exitCode).toBe(0)
  expect(took).toBeGreaterThan(CONTROL_MS - 500)
  expect(took).toBeLessThan(CONTROL_MS + 3000)
  expect(exits(fake.calls())).toEqual([path.join(ctx.paths.cm, "stuck")])
})

test("quietStdin pauses stdin", () => {
  const plain = new PassThrough()
  plain.resume()
  quietStdin(plain)
  expect(plain.isPaused()).toBe(true)
  // A terminal also leaves raw mode, so ssh's /dev/tty prompt reads a line as typed.
  const tty = Object.assign(new PassThrough(), { isTTY: true, modes: [] as boolean[] })
  const raw = Object.assign(tty, { setRawMode: (on: boolean) => void tty.modes.push(on) })
  raw.resume()
  quietStdin(raw)
  expect(raw.isPaused()).toBe(true)
  expect(raw.modes).toEqual([false])
})
