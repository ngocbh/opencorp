/** The macOS escapee sweep: its canary directories, and finding a process by its profile. */
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { listAllPids, sandboxCheck } from "../../src/platform.ts"
import { Canary, killEscaped } from "../../src/sandbox/escapees.ts"
import { profile } from "../../src/sandbox/seatbelt.ts"
import { waitFor } from "../helpers.ts"
import { makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

// The run tests cover the sweep itself (a setsid child dies with the call).
const macOnly = test.skipIf(process.platform !== "darwin")

macOnly("canary directories exist until closed", () => {
  const canary = new Canary()
  try {
    expect(fs.statSync(canary.allowed).isDirectory() && fs.statSync(canary.denied).isDirectory()).toBe(true)
    expect(path.dirname(canary.allowed)).toBe(canary.root)
    expect(path.dirname(canary.denied)).toBe(canary.root)
  } finally {
    canary.close()
  }
  expect(fs.existsSync(canary.root)).toBe(false)
})

macOnly("canary is created outside writable paths", () => {
  // Under a writable path, `denied` would be writable too and nothing would match.
  const tmp = fs.realpathSync(os.tmpdir())
  const canary = new Canary([tmp])
  try {
    expect(canary.root === tmp || canary.root.startsWith(tmp + path.sep)).toBe(false)
  } finally {
    canary.close()
  }
})

const sandboxedMac = test.skipIf(process.platform !== "darwin" || !sandboxAvailable())

/** SIGKILLs `child` when the test finishes, whatever happened to it. */
function killAtEnd(child: ChildProcess): void {
  onTestFinished(() => {
    child.kill("SIGKILL")
  })
}

/** A canary and a detached `sleep 30` running under the canary profile, ready once it returns. */
async function underCanary(): Promise<{ canary: Canary; pid: number; exited: Promise<void> }> {
  const policy = makePolicy().make()
  const canary = new Canary([policy.tmpdir, policy.workspace])
  onTestFinished(() => canary.close())
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", profile(policy, { canary: canary.allowed }), "/bin/sh", "-c", "echo ready; exec /bin/sleep 30"],
    { cwd: policy.workspace, detached: true, stdio: ["ignore", "pipe", "ignore"] },
  )
  killAtEnd(child)
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  let out = ""
  child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()))
  // The profile is applied before the shell prints.
  await waitFor(() => out.includes("ready"), { timeout: 10_000, what: "the sandboxed child" })
  return { canary, pid: child.pid!, exited }
}

sandboxedMac("a process under the canary profile is found and killed", async () => {
  const { canary, pid, exited } = await underCanary()
  const plain = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
  killAtEnd(plain)
  expect(listAllPids()).toContain(plain.pid!)
  const killed = killEscaped(canary)
  expect(killed).toEqual([pid])
  await exited
})

sandboxedMac("sandboxCheck tells the canary pair apart", async () => {
  const { canary, pid } = await underCanary()
  expect(sandboxCheck(pid, "file-write-data", canary.allowed)).toBe(0)
  expect(sandboxCheck(pid, "file-write-data", canary.denied)).toBe(1)
  expect(sandboxCheck(pid, null)).toBe(1)
})
