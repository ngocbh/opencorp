/** The SSH plumbing: generated configs and the wrapper, the child runner, the node master, mux and control commands,
 *  and the watcher. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import {
  CONTROL_HOST,
  cleanOutput,
  control,
  controlArgv,
  configText,
  defaultIncludes,
  descendants,
  findSsh,
  forward,
  forwardArgv,
  isSocket,
  LIMITS,
  type ReachContext,
  KEEP_CHARS,
  killTree,
  lastStderr,
  masterArgv,
  mux,
  muxArgv,
  readStatuses,
  resetStatus,
  runChild,
  sshEnv,
  startMaster,
  waitForSocket,
  wrapperText,
  writeSshFiles,
} from "../../src/reach/ssh.ts"
import { isGone, shortDir, waitFor } from "../helpers.ts"
import { fakeHome, reachCtx } from "./helpers.ts"
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

test("writeSshFiles writes the configs 0600 and the wrapper 0700", async () => {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  await writeSshFiles(paths, "/usr/bin/ssh", ["/i/one"])
  expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.batchConfig).mode & 0o777).toBe(0o600)
  expect(fs.statSync(paths.wrapper).mode & 0o777).toBe(0o700)
  expect(fs.readFileSync(paths.config, "utf8")).toBe(configText(paths.cm, { includes: ["/i/one"] }))
  expect(fs.readFileSync(paths.batchConfig, "utf8")).toBe(configText(paths.cm, { batch: true, includes: ["/i/one"] }))
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
    "-J", "a,b:2222",
    "-p", "2200",
    "--", "u@n",
    "cat >/dev/null",
  ])
  expect(masterArgv("/usr/bin/ssh", { host: "n", opencorp: "/o/opencorp" }, { config: "/c", socket: "/s" })).toEqual([
    "/usr/bin/ssh", "-F", "/c", "-M", "-S", "/s",
    "-o", "ControlPersist=no", "-o", "ClearAllForwardings=yes", "-o", "RequestTTY=no",
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
    "-o", "ControlMaster=no", "-o", "ProxyCommand=false",
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
