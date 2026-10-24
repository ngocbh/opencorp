/** Running one command in the sandbox, in its own process group. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { Helper, SandboxPolicy } from "../../src/sandbox/policy.ts"
import { helperCommand } from "../../src/platform.ts"
import {
  command,
  fsHelper,
  refusal,
  run,
  type RunOptions,
  SAFE_PATH,
  SandboxUnavailable,
  scrubbedEnv,
} from "../../src/sandbox/run.ts"
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

test.skipIf(!sandboxAvailable())("on timeout the leader is killed before it is reaped", async () => {
  // The cleanup runs after the kill and before the leader is awaited. `sleep 30` can't exit
  // by itself, so a zombie leader there was killed before it was reaped; blocking the loop is
  // safe, since nothing reaps meanwhile.
  let stat = ""
  const result = await sh(makePolicy().make(), "sleep 30", {
    timeout: 0.5,
    track: (pid) => () => {
      const deadline = performance.now() + 1_000
      do stat = psField("stat", pid)
      while (!stat.startsWith("Z") && performance.now() < deadline)
    },
  })
  expect(result.timedOut).toBe(true)
  expect(stat).toStartWith("Z")
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

test("unsupported platform", () => {
  expect(() => command(makePolicy().make(), ["x"], undefined, "win32")).toThrow(SandboxUnavailable)
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
