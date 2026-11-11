/** The fake ssh: plain sessions, logins per host, BatchMode, masters, mux clients, `-O` commands, forwards and
 *  `ControlMaster auto`, all on this machine. */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../src/testing/fake_ssh.ts"
import { shortDir } from "../helpers.ts"

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
