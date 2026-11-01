/** Running one command in the sandbox, in its own process group. */
import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { Helper, SandboxPolicy } from "../../src/sandbox/policy.ts"
import { helperCommand, processLimits } from "../../src/platform.ts"
import * as bwrap from "../../src/sandbox/bwrap.ts"
import {
  capture,
  command,
  fsHelper,
  processCap,
  refusal,
  run,
  type RunOptions,
  SAFE_PATH,
  SandboxUnavailable,
  scrubbedEnv,
} from "../../src/sandbox/run.ts"
import { profile } from "../../src/sandbox/seatbelt.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { envInChild, gone, goldenPolicy, helperTool, makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

function sh(policy: SandboxPolicy, script: string, options?: RunOptions) {
  return run(policy, ["/bin/sh", "-c", script], options)
}

/** Whether no process is left in group `pgid`. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

/** `ps -o <field>= -p <pid>`, trimmed: empty once the pid is gone. */
function psField(field: string, pid: number): string {
  return spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
}

test.skipIf(!sandboxAvailable())("runs in the workspace", async () => {
  const policy = makePolicy().make()
  const result = await sh(policy, "pwd; echo err >&2; exit 3")
  expect(result.exit).toBe(3)
  expect(result.stdout.toString().trim()).toBe(policy.workspace)
  expect(result.stderr.toString()).toBe("err\n")
  expect(result.timedOut || result.interrupted || result.truncated).toBe(false)
  expect(result.duration).toBeGreaterThanOrEqual(0)
})

test.skipIf(!sandboxAvailable())("stdin is passed", async () => {
  expect((await sh(makePolicy().make(), "cat", { stdin: "hello" })).stdout.toString()).toBe("hello")
})

test.skipIf(!sandboxAvailable())("environment is scrubbed", () => {
  const { ws, tmp, make } = makePolicy()
  // The secret is set in a child's env, since a test never changes its own.
  const child = envInChild(ws, tmp, { OPENCORP_TEST_SECRET: "s3cr3t-value" })
  expect(child.stderr).toBe("")
  expect(child.status).toBe(0)
  const out = child.stdout
  expect(out).not.toContain("s3cr3t-value")
  const env = Object.fromEntries(
    out
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
  expect(env.HOME).toBe(tmp)
  expect(env.TMPDIR).toBe(tmp)
  for (const name of Object.keys(scrubbedEnv(make()))) expect(Object.keys(env)).toContain(name)
})

test.skipIf(!sandboxAvailable())("timeout kills the group", async () => {
  const start = performance.now()
  const result = await sh(makePolicy().make(), "sleep 30", { timeout: 1 })
  expect(result.timedOut).toBe(true)
  expect(result.exit).toBeNull()
  expect(performance.now() - start).toBeLessThan(10_000)
})

test.skipIf(!sandboxAvailable())("cancel kills the call", async () => {
  const start = performance.now()
  const result = await sh(makePolicy().make(), "sleep 30", { signal: AbortSignal.timeout(500) })
  expect(result.interrupted).toBe(true)
  expect(result.exit).toBeNull()
  expect(performance.now() - start).toBeLessThan(10_000)
})

// Twenty background steps that each wait on a sleep that can't end within the test, then create a file: one that
// appears means its shell ran on after the sleep was killed. On macOS a group signal reaches members one at a time,
// so a shell could wake from the death of its sleep before its own SIGKILL arrived.
const RACE = 'for i in $(seq 20); do (sleep 30; touch "$TMPDIR/after$i") & done'

/** Runs `script` five times under one policy, each time expecting no `after*` file in its tmpdir 200 ms after the
 *  call returns, and no `done` in its stdout. */
async function nothingAfter(script: string, options: () => RunOptions): Promise<void> {
  const policy = makePolicy().make()
  for (let i = 0; i < 5; i++) {
    const result = await sh(policy, script, options())
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fs.readdirSync(policy.tmpdir).filter((name) => name.startsWith("after"))).toEqual([])
    expect(result.stdout.toString()).not.toContain("done")
  }
}

test.skipIf(!sandboxAvailable())("a timeout runs nothing after the killed step", async () => {
  await nothingAfter(`${RACE}; wait; echo done`, () => ({ timeout: 1 }))
  await nothingAfter('sleep 5; echo done; touch "$TMPDIR/after"', () => ({ timeout: 1 }))
})

test.skipIf(!sandboxAvailable())("an abort runs nothing after the killed step", async () => {
  await nothingAfter(`${RACE}; wait; echo done`, () => ({ signal: AbortSignal.timeout(500) }))
})

test.skipIf(!sandboxAvailable())("a natural exit runs nothing after its background steps are killed", async () => {
  await nothingAfter(`${RACE}; exit 0`, () => ({}))
})

test.skipIf(!sandboxAvailable())("background process dies with the call", async () => {
  // Kills a leftover even when an earlier assertion fails.
  onTestFinished(() => gone("4242"))
  const start = performance.now()
  const result = await sh(makePolicy().make(), "sleep 4242 & echo started")
  expect(result.stdout.toString()).toBe("started\n")
  // The background sleep holds the output pipes; the call must not wait for it.
  expect(performance.now() - start).toBeLessThan(10_000)
  expect(await gone("4242")).toBe(true)
})

test.skipIf(!sandboxAvailable())("std streams by path", async () => {
  const script = "echo out > /dev/stdout; echo err > /dev/stderr; echo fd > /dev/fd/1; cat /dev/fd/0"
  const result = await sh(makePolicy().make(), script, { stdin: "in" })
  expect(result.exit, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe("out\nfd\nin")
  expect(result.stderr.toString()).toBe("err\n")
})

test.skipIf(!sandboxAvailable())("a call leaves no fd open", async () => {
  const policy = makePolicy().make()
  // Runtime fds opened lazily on the first spawn aren't the call's.
  await sh(policy, "true")
  const count = () => fs.readdirSync("/dev/fd").length
  const before = count()
  const done = await sh(policy, "echo out; echo err >&2; cat", { stdin: "in" })
  expect(done.stdout.toString()).toBe("out\nin")
  expect(done.stderr.toString()).toBe("err\n")
  // The child never reads its stdin.
  expect((await sh(policy, "sleep 30", { stdin: Buffer.alloc(1 << 20), timeout: 0.5 })).timedOut).toBe(true)
  expect((await sh(policy, "sleep 30", { stdin: "in", signal: AbortSignal.timeout(300) })).interrupted).toBe(true)
  // The spawn throws at once.
  await expect(run(policy, ["/bin/sh", "-c", "a\0b"], { stdin: "in" })).rejects.toMatchObject({
    code: "ERR_INVALID_ARG_VALUE",
  })
  // The spawn emits `error` and has no pid.
  const removed = makePolicy()
  const noWorkspace = removed.make()
  fs.rmSync(removed.ws, { recursive: true })
  await expect(sh(noWorkspace, "exit 0", { stdin: "in" })).rejects.toMatchObject({ code: "ENOENT" })
  const tracked = sh(policy, "sleep 30", {
    stdin: "in",
    track: () => {
      throw new Error("tracking failed")
    },
  })
  await expect(tracked).rejects.toThrow("tracking failed")
  // `<=`: every test file shares this process, and an fd an earlier test left may close meanwhile.
  await waitFor(() => count() <= before, { timeout: 5_000, what: "the call's fds to close" })
})

test.skipIf(!sandboxAvailable())("quiet calls leave the others their output", async () => {
  const policy = makePolicy().make()
  const small = path.join(tempDir(), "small")
  fs.writeFileSync(small, "small")
  const stop = new AbortController()
  onTestFinished(() => stop.abort())
  // More quiet calls than the runtime's fs thread pool has threads (one per core), each with stdin it never
  // reads, so the reads and the writes each would use up the pool on their own.
  const count = os.availableParallelism() + 2
  let started = 0
  const quiet = Array.from({ length: count }, () =>
    sh(policy, "sleep 30", {
      stdin: Buffer.alloc(1 << 20),
      signal: stop.signal,
      track: () => {
        started++
        return () => {}
      },
    }),
  )
  await waitFor(() => started === count, { timeout: 10_000, what: "the quiet calls to start" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const start = performance.now()
  // More than a pipe buffer, so a writer nobody reads blocks until the timeout.
  const busy = await sh(policy, "head -c 200000 /dev/zero | wc -c; head -c 200000 /dev/zero; echo err >&2", {
    timeout: 10,
  })
  expect(performance.now() - start).toBeLessThan(5_000)
  expect(busy.exit, busy.stderr.toString()).toBe(0)
  // macOS's wc pads the count.
  const head = busy.stdout.subarray(0, Math.max(0, busy.stdout.length - 200_000))
  expect(head.toString().trim()).toBe("200000")
  expect(busy.stdout.subarray(head.length).equals(Buffer.alloc(200_000))).toBe(true)
  expect(busy.stderr.toString()).toBe("err\n")
  const read = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const content = await Promise.race([
    fs.promises.readFile(small, "utf8"),
    new Promise((resolve) => (timer = setTimeout(() => resolve("still reading after 1 s"), 1_000))),
  ])
  clearTimeout(timer)
  expect(content).toBe("small")
  expect(performance.now() - read).toBeLessThan(1_000)
  stop.abort()
  for (const result of await Promise.all(quiet)) expect(result.interrupted).toBe(true)
})

test.skipIf(process.platform !== "linux" || !sandboxAvailable())("a call sees no pipe of another call", async () => {
  const policy = makePolicy().make()
  let leader = 0
  const stop = new AbortController()
  onTestFinished(() => stop.abort())
  const first = sh(policy, "cat; sleep 30", {
    stdin: "a",
    signal: stop.signal,
    track: (pid) => {
      leader = pid
      return () => {}
    },
  })
  await waitFor(() => leader, { timeout: 10_000, what: "the first call to start" })
  const second = await sh(policy, "ls -l /proc/self/fd")
  const listing = second.stdout.toString()
  expect(second.exit, second.stderr.toString()).toBe(0)
  // Each line ends `<fd> -> <target>`. On Misha (RHEL 8, bwrap) the listing was 0 -> /dev/null, 1 and 2 -> pipe:[…],
  // and 3 -> /proc/2/fd (ls's own directory), nothing else.
  const leaked = listing
    .split("\n")
    .map((line) => line.match(/\s(\d+) -> (.*)$/))
    .filter((m) => m !== null && !["0", "1", "2"].includes(m[1]!) && /^(pipe|socket):/.test(m[2]!))
  expect(leaked, listing).toEqual([])
  stop.abort()
  const done = await first
  expect(done.stdout.toString()).toBe("a")
  expect(done.interrupted).toBe(true)
})

test.skipIf(!sandboxAvailable())("the group is killed after a leader that exits by itself", async () => {
  // The runtime reaps the leader before the group kill, so its pid (the group id) could in
  // theory be reused by then: the documented window.
  onTestFinished(() => gone("4646"))
  let reaped: string | undefined
  const start = performance.now()
  const result = await sh(makePolicy().make(), "sleep 4646 & exit 0", {
    track: (pid) => () => {
      try {
        process.kill(pid, 0)
        reaped = "alive"
      } catch (error) {
        reaped = (error as NodeJS.ErrnoException).code
      }
    },
  })
  expect(result.exit).toBe(0)
  expect(performance.now() - start).toBeLessThan(10_000)
  expect(await gone("4646")).toBe(true)
  expect(reaped).toBe("ESRCH")
})

/** Whether this runtime leaves a killed child it hasn't awaited as a zombie. Bun reaps on its own thread where
 *  the kernel has no pidfd_open (RHEL 8), so there a killed child is gone at once. */
async function zombiesLinger(): Promise<boolean> {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  process.kill(child.pid!, "SIGKILL")
  // Blocks the loop, so only a runtime that reaps on its own thread can reap meanwhile.
  const until = performance.now() + 300
  while (performance.now() < until);
  const stat = psField("stat", child.pid!)
  await exited
  // A runtime that reaps on its own thread may show Z for an instant, never after 300 ms.
  return stat.startsWith("Z")
}

test.skipIf(!sandboxAvailable())("on timeout the leader is killed before it is reaped", async () => {
  // The cleanup runs after the kill and before the leader is awaited. `sleep 30` can't exit by itself, so a
  // leader dead at cleanup was killed while alive; one still alive fails. Where the runtime reaps on its own
  // thread, the test can't tell kill, await, cleanup from kill, cleanup, await: the macOS run pins that order.
  const lingers = await zombiesLinger()
  let stat = ""
  const result = await sh(makePolicy().make(), "sleep 30", {
    timeout: 0.5,
    track: (pid) => () => {
      // Where the runtime reaps on its own thread, polls through a brief Z until the leader is gone.
      const deadline = performance.now() + 1_000
      do stat = psField("stat", pid)
      while ((lingers ? !stat.startsWith("Z") : stat !== "") && performance.now() < deadline)
    },
  })
  expect(result.timedOut).toBe(true)
  if (lingers) expect(stat).toStartWith("Z")
  else expect(stat).toBe("")
})

test.skipIf(!sandboxAvailable())("setsid child dies with the call", async () => {
  // setsid leaves the process group, so killing the group misses it; the child also
  // holds the output pipes, and the call doesn't wait for the escapee.
  onTestFinished(() => gone("4545"))
  const policy = makePolicy().make({ readOnly: [fs.realpathSync(process.execPath)] })
  const start = performance.now()
  const result = await setsidCall(policy, "4545")
  // A failed spawn still prints "parent done" before the runtime dies of it, so the exit shows the
  // escapee started.
  expect(result.exit, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe("parent done\n")
  expect(performance.now() - start).toBeLessThan(10_000)
  expect(await gone("4545")).toBe(true)
})

test.skipIf(!sandboxAvailable())("escape cleanup spares concurrent calls", async () => {
  onTestFinished(() => gone("4546"))
  const policy = makePolicy().make({ readOnly: [fs.realpathSync(process.execPath)] })
  // TMPDIR in the sandbox is the policy's tmpdir. The timeout ends the sibling if the test fails
  // before it says go.
  const script = ': > "$TMPDIR/up"; while [ ! -e "$TMPDIR/go" ]; do sleep 0.05; done; echo alive'
  const sibling = sh(policy, script, { timeout: 20 })
  await waitFor(() => fs.existsSync(path.join(policy.tmpdir, "up")), { timeout: 10_000, what: "sibling up" })
  const escaper = await setsidCall(policy, "4546")
  expect(escaper.exit, escaper.stderr.toString()).toBe(0)
  expect(escaper.stdout.toString()).toBe("parent done\n")
  fs.writeFileSync(path.join(policy.tmpdir, "go"), "")
  const result = await sibling
  expect(result.exit).toBe(0)
  expect(result.stdout.toString()).toBe("alive\n")
  expect(await gone("4546")).toBe(true)
})

/** Runs this runtime in the sandbox, starting a `sleep <marker>` in a new session that holds the
 *  call's pipes (`argv0` makes it show as `sleep <marker>`), then printing `parent done`. */
function setsidCall(policy: SandboxPolicy, marker: string) {
  const code =
    `require("node:child_process").spawn("/bin/sleep", ["${marker}"], ` +
    `{ argv0: "sleep", detached: true, stdio: "inherit" }).unref()\n` +
    `console.log("parent done")\n`
  return run(policy, [process.execPath, ...BUN_FLAGS, "-e", code])
}

test.skipIf(!sandboxAvailable())("output is capped", async () => {
  const result = await sh(makePolicy().make(), "head -c 100000 /dev/zero", { maxOutput: 1000 })
  expect(result.stdout.length).toBe(1000)
  expect(result.truncated).toBe(true)
})

/** What `capture(limit, tail)` keeps of a stream of `chunks`: its head, tail, byte count and whether it dropped any. */
async function captured(chunks: Buffer[], limit: number, tail: number) {
  const state = capture(Readable.from(chunks), limit, tail)
  await state.closed
  return state.kept()
}

test("capture keeps the first limit and the last tail bytes, and counts every byte", async () => {
  const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))
  const cases: [string, Buffer[], number, number][] = [
    ["one chunk past both", [data], 100, 200],
    ["one byte a chunk", [...data].map((byte) => Buffer.from([byte])), 100, 200],
    ["a chunk across the head", [data.subarray(0, 90), data.subarray(90, 4000), data.subarray(4000)], 100, 200],
    ["exactly head and tail", [data.subarray(0, 300)], 100, 200],
    ["one byte more", [data.subarray(0, 150), data.subarray(150, 301)], 100, 200],
    ["shorter than the head", [data.subarray(0, 60)], 100, 200],
    ["no tail", [data.subarray(0, 70), data.subarray(70)], 100, 0],
  ]
  for (const [name, chunks, limit, tail] of cases) {
    const whole = Buffer.concat(chunks)
    const kept = await captured(chunks, limit, tail)
    const head = whole.subarray(0, limit)
    expect(kept.head.equals(head), name).toBe(true)
    expect(kept.tail.equals(whole.subarray(Math.max(head.length, whole.length - tail))), name).toBe(true)
    expect(kept.bytes, name).toBe(whole.length)
    expect(kept.truncated, name).toBe(whole.length > limit + tail)
  }
})

test.skipIf(!sandboxAvailable())("output keeps its end and counts every byte", async () => {
  const result = await sh(makePolicy().make(), "head -c 3000000 /dev/zero; printf END", {
    maxOutput: 1000,
    tailOutput: 1000,
  })
  expect(result.stdout.length).toBe(1000)
  expect(result.stdoutTail.length).toBe(1000)
  expect(result.stdoutTail.subarray(-3).toString()).toBe("END")
  expect(result.stdoutBytes).toBe(3_000_003)
  expect(result.truncated).toBe(true)
  const short = await sh(makePolicy().make(), "printf abc", { maxOutput: 2, tailOutput: 1000 })
  expect([short.stdout.toString(), short.stdoutTail.toString(), short.stdoutBytes, short.truncated]).toEqual([
    "ab",
    "c",
    3,
    false,
  ])
})

test("a tailOutput that isn't a byte count is refused before anything starts", async () => {
  for (const tailOutput of [-1, 1.5, NaN]) {
    await expect(sh(makePolicy().make(), "exit 0", { tailOutput })).rejects.toThrow(RangeError)
  }
})

test("unsupported platform", () => {
  expect(() => command(makePolicy().make(), ["x"], undefined, "win32")).toThrow(SandboxUnavailable)
})

test("the office's process limits are read from the kernel", () => {
  const shell = spawnSync("/bin/sh", ["-c", "ulimit -S -u 2>/dev/null || ulimit -S -p"], { encoding: "utf8" })
  const soft = shell.stdout.trim()
  const limits = processLimits()
  expect(limits.soft).toBe(soft === "unlimited" ? null : Number(soft))
  if (process.platform === "darwin") {
    const perUser = spawnSync("/usr/sbin/sysctl", ["-n", "kern.maxprocperuid"], { encoding: "utf8" }).stdout.trim()
    expect(limits.perUser).toBe(Number(perUser))
  } else {
    expect(limits.perUser).toBeNull()
  }
})

test("a call's process cap is the office's limit less an eighth", () => {
  expect(processCap({ soft: 8000, perUser: 8000 }, "darwin")).toBe(7000)
  expect(processCap({ soft: 12000, perUser: 8000 }, "darwin")).toBe(7000)
  expect(processCap({ soft: null, perUser: 4000 }, "darwin")).toBe(3500)
  expect(processCap({ soft: 2000, perUser: null }, "darwin")).toBe(1750)
  expect(processCap({ soft: 709, perUser: 266 }, "darwin")).toBe(232)
  expect(processCap({ soft: null, perUser: null }, "darwin")).toBeNull()
  expect(processCap({ soft: 63000, perUser: null }, "linux")).toBe(55125)
  expect(processCap({ soft: null, perUser: null }, "linux")).toBeNull()
  // A cap below 1 means no wrapper at all.
  expect(processCap({ soft: 1, perUser: null }, "linux")).toBeNull()
  expect(processCap({ soft: 8000, perUser: null }, "win32")).toBeNull()
})

const NPROC_SCRIPT =
  'n=$1; shift; { ulimit -S -u "$n" && ulimit -H -u "$n"; } 2>/dev/null || ' +
  '{ ulimit -S -p "$n" && ulimit -H -p "$n"; } 2>/dev/null; exec "$@"'

test("the call argv is pinned with a process cap and without one", () => {
  const policy = goldenPolicy({ workspace: "/w", writable: true, network: false, tmpdir: "/private/tmp/call" })
  const seatbelt = ["/usr/bin/sandbox-exec", "-p", profile(policy, { canary: "/c" }), "x"]
  const wrapper = ["/bin/sh", "-c", NPROC_SCRIPT, "sh", "7000"]
  expect(command(policy, ["x"], "/c", "darwin", 7000)).toEqual([...wrapper, ...seatbelt])
  expect(command(policy, ["x"], "/c", "darwin", null)).toEqual(seatbelt)
  expect(command(policy, ["x"], undefined, "linux", 7000)).toEqual([...wrapper, ...bwrap.command(policy, ["x"])])
  expect(command(policy, ["x"], undefined, "linux", null)).toEqual(bwrap.command(policy, ["x"]))
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    expect(() => command(policy, ["x"], undefined, "darwin", bad), String(bad)).toThrow(RangeError)
  }
})

// null when the limits can't be read (say, no libc.so.6 on a musl Linux), so the test skips instead of the file failing.
function officeCap(): number | null {
  try {
    return processCap(processLimits())
  } catch {
    return null
  }
}

test.skipIf(!sandboxAvailable() || officeCap() === null)(
  "a call's soft and hard process limits are the cap and can't be raised",
  async () => {
    const cap = officeCap()!
    const script =
      "ulimit -S -u 2>/dev/null || ulimit -S -p; ulimit -H -u 2>/dev/null || ulimit -H -p; " +
      `if (ulimit -S -u ${cap + 1} || ulimit -S -p ${cap + 1}) 2>/dev/null; then echo raised; else echo held; fi`
    const result = await sh(makePolicy().make(), script)
    expect(result.exit).toBe(0)
    expect(result.stdout.toString()).toBe(`${cap}\n${cap}\nheld\n`)
  },
)

const PERL_FORK =
  'defined(my $p = fork) or do { print "refused\\n"; exit 0 }; if (!$p) { exit 0 } waitpid($p, 0); print "forked\\n"'

test.skipIf(!sandboxAvailable() || !fs.existsSync("/usr/bin/perl"))("a call over its process cap can't fork", () => {
  // One fork, never a loop; perl, because bash retries a fork that fails with EAGAIN for about 15 s.
  const policy = makePolicy().make()
  const [file, ...args] = command(policy, ["/usr/bin/perl", "-e", PERL_FORK], undefined, process.platform, 1)
  const r = spawnSync(file!, args, { cwd: policy.workspace, env: scrubbedEnv(policy), timeout: 30_000, encoding: "utf8" })
  expect(r.stdout).not.toContain("forked")
  if (process.platform === "darwin") {
    expect(r.status).toBe(0)
    expect(r.stdout).toBe("refused\n")
  } else {
    // bwrap's own clone fails first unless bwrap is setuid-root (exempt), in which case perl's fork fails.
    const perlRefused = r.status === 0 && r.stdout === "refused\n"
    const bwrapRefused = r.status !== 0 && /Resource temporarily unavailable|EAGAIN/.test(r.stderr)
    expect(perlRefused || bwrapRefused, r.stderr).toBe(true)
  }
})

test.skipIf(!sandboxAvailable())("the tracking hook sees the leader while it runs and is cleaned up after the kill", async () => {
  const policy = makePolicy().make()
  const cases: [string, RunOptions][] = [
    ["sleep 0.3", {}],
    ["sleep 30", { timeout: 0.5 }],
    ["sleep 30", { signal: AbortSignal.timeout(500) }],
  ]
  for (const [script, options] of cases) {
    const seen: { pid: number; pgid: string; alive: boolean }[] = []
    let cleanups = 0
    await sh(policy, script, {
      ...options,
      track: (pid) => {
        seen.push({ pid, pgid: psField("pgid", pid), alive: !groupGone(pid) })
        return () => cleanups++
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.alive).toBe(true)
    expect(seen[0]!.pgid).toBe(String(seen[0]!.pid))
    expect(cleanups).toBe(1)
  }
})

test.skipIf(!sandboxAvailable())("a throwing tracking hook still kills the call", async () => {
  let leader = 0
  const call = sh(makePolicy().make(), "sleep 30", {
    track: (pid) => {
      leader = pid
      throw new Error("tracking failed")
    },
  })
  await expect(call).rejects.toThrow("tracking failed")
  expect(leader).toBeGreaterThan(0)
  await waitFor(() => groupGone(leader), { timeout: 5_000, what: "the call's group to die" })
})

test.skipIf(!sandboxAvailable())("stdin is ignored unless given", async () => {
  const start = performance.now()
  const result = await sh(makePolicy().make(), "cat")
  expect(result.exit).toBe(0)
  expect(result.stdout.length + result.stderr.length).toBe(0)
  expect(performance.now() - start).toBeLessThan(10_000)
})

test("a call that cannot start rejects at once", async () => {
  const { ws, make } = makePolicy()
  const policy = make()
  fs.rmSync(ws, { recursive: true })
  // The first canary root: no canary may be left behind there.
  const root = fs.realpathSync(os.tmpdir())
  const canaries = () => fs.readdirSync(root).filter((name) => name.startsWith("opencorp-call-")).sort()
  const before = canaries()
  await expect(run(policy, ["/bin/sh", "-c", "exit 0"], { timeout: Infinity })).rejects.toThrow(RangeError)
  let tracked = false
  const start = performance.now()
  const call = run(policy, ["/bin/sh", "-c", "exit 0"], {
    track: () => {
      tracked = true
      return () => {}
    },
  })
  await expect(call).rejects.toMatchObject({ code: "ENOENT" })
  expect(performance.now() - start).toBeLessThan(5_000)
  expect(tracked).toBe(false)
  expect(canaries()).toEqual(before)
})

test("a sandbox refusal is labelled", () => {
  const seatbelt = Buffer.from("sandbox-exec: sandbox_apply: Operation not permitted\n")
  const bwrap = Buffer.from("bwrap: Can't mount proc on /newroot/proc\n")
  expect(refusal("darwin", 71, seatbelt)).toBe(true)
  expect(refusal("linux", 1, bwrap)).toBe(true)
  expect(refusal("darwin", 0, seatbelt)).toBe(false)
  expect(refusal("linux", 1, Buffer.from("cat: x: No such file or directory\n"))).toBe(false)
  expect(refusal("darwin", 71, bwrap)).toBe(false)
  expect(refusal("linux", 1, seatbelt)).toBe(false)
  expect(refusal("darwin", null, seatbelt)).toBe(false)
})

test("the helper is refused inside the office home", () => {
  const checkout = fs.realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)))
  const link = path.join(tempDir(), "home")
  fs.symlinkSync(checkout, link)
  for (const home of [checkout, link, `${checkout}/x/..`]) {
    expect(() => fsHelper(home), home).toThrow(SandboxUnavailable)
  }
  const { argv, helper } = helperCommand()
  expect(fsHelper(tempDir())).toEqual({ argv, helper })
})

test("scrubbed env is pinned and only the checkout helper adds the transpiler cache switch", () => {
  const tmp = "/private/tmp/call"
  const fixed = { PATH: SAFE_PATH, HOME: tmp, TMPDIR: tmp, LANG: "en_US.UTF-8", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1" }
  const policy = (helper?: Helper) =>
    goldenPolicy({ workspace: "/w", writable: true, network: false, tmpdir: tmp, helper })
  expect(scrubbedEnv(policy())).toEqual(fixed)
  expect(scrubbedEnv(policy({ binary: "/opt/opencorp/bin/opencorp" }))).toEqual(fixed)
  const checkout = scrubbedEnv(policy({ bun: "/opt/bun", entry: "/c/packages/office/src/sandbox/fs_helper.ts" }))
  expect(checkout).toEqual({ ...fixed, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" })
  expect(Object.keys(checkout)).toEqual([...Object.keys(fixed), "BUN_RUNTIME_TRANSPILER_CACHE_PATH"])
})

test.skipIf(!sandboxAvailable() || "binary" in helperCommand().helper)(
  "a checkout helper call leaves no transpiled copy under HOME",
  async () => {
    const { make, tmp } = makePolicy()
    await helperTool(make(), { op: "list", path: "." })
    // Bun caches transpiled code under HOME: Library/Caches/bun on macOS, .cache/bun on Linux.
    const entries = fs.readdirSync(tmp, { recursive: true }).map(String)
    expect(entries.filter((entry) => entry.includes("bun"))).toEqual([])
  },
)
