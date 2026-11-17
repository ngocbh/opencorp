/** A sandboxed program on a terminal of its own: `startOnTerminal`, each test through the real sandbox. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { SandboxPolicy } from "../../../src/runtime/sandbox/policy.ts"
import { startOnTerminal } from "../../../src/runtime/sandbox/run.ts"
import { shortDir, waitFor } from "../../helpers.ts"
import { gone, makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

/** Starts `argv` under `policy` on a new 80 × 24 terminal, collecting what it prints. The test's end kills the
 *  terminal's group (a no-op once its leader exited), closes it and waits for its exit. */
function onTerminal(policy: SandboxPolicy, argv: string[], track?: (pid: number) => () => void) {
  let output = ""
  const decoder = new TextDecoder()
  const pty = startOnTerminal(policy, argv, {
    cols: 80,
    rows: 24,
    onData: (chunk) => {
      output += decoder.decode(chunk, { stream: true })
    },
    track,
  })
  onTestFinished(async () => {
    pty.kill("SIGKILL")
    pty.close()
    await pty.exited
  })
  return {
    pty,
    output: () => output,
    shows: (text: string) => waitFor(() => output.includes(text), { timeout: 10_000, what: JSON.stringify(text) }),
  }
}

test.skipIf(!sandboxAvailable())("a sandboxed shell on a terminal reads a password from /dev/tty", async () => {
  const t = onTerminal(makePolicy().make(), [
    "/bin/sh",
    "-c",
    "printf 'pw: '; stty -echo; read x </dev/tty; stty echo; echo got=$x",
  ])
  await t.shows("pw: ")
  await waitFor(() => !t.pty.modes().echo, { timeout: 2_000, what: "echo off" })
  expect(t.pty.modes()).toEqual({ echo: false, canonical: true })
  t.pty.write("s3cret\n")
  await t.shows("got=s3cret")
  expect(await t.pty.exited).toBe(0)
  expect(t.output().replace("got=s3cret", "")).not.toContain("s3cret")
})

test.skipIf(!sandboxAvailable())("a sandboxed terminal sees no home", async () => {
  const policy = makePolicy().make()
  const home = fs.realpathSync(os.homedir())
  // A decoy key outside every path the policy mounts, as escape.test.ts's fake home holds.
  const key = path.join(shortDir(), "home/.ssh/id_ed25519")
  fs.mkdirSync(path.dirname(key), { recursive: true })
  fs.writeFileSync(key, "decoy-ssh-key")
  const script =
    'ls -1A "$0" 2>/dev/null; echo "[ls $?]"; cat "$1" 2>&1; echo "[key $?]"; cat /etc/shadow 2>&1; echo "[shadow $?]"'
  const t = onTerminal(policy, ["/bin/sh", "-c", script, home, key])
  await t.shows("[shadow ")
  expect(await t.pty.exited).toBe(0)
  const output = t.output()
  const exit = (name: string) => Number(output.match(new RegExp(`\\[${name} (\\d+)\\]`))![1])
  expect(exit("key"), output).not.toBe(0)
  expect(exit("shadow"), output).not.toBe(0)
  expect(output).not.toContain("decoy")
  // bwrap makes the home's folders of mounted paths (here the policy's own, should the temp folder lie in the
  // home) as mount points, so those entries, and only those, may show.
  const mounted = [policy.workspace, policy.tmpdir, ...policy.readOnly].filter((p) => p.startsWith(home + "/"))
  const allowed = new Set(mounted.map((p) => p.slice(home.length + 1).split("/")[0]!))
  const listing = output.slice(0, output.indexOf("[ls ")).split("\r\n").filter(Boolean)
  expect(exit("ls") !== 0 || listing.every((entry) => allowed.has(entry)), output).toBe(true)
})

test.skipIf(!sandboxAvailable())(
  "closing a sandboxed terminal ends everything it started, and its tracking row goes",
  async () => {
    onTestFinished(() => gone("4343"))
    const tracked: number[] = []
    let cleanups = 0
    // The background sleep ignores SIGHUP, so the call's end, not the hangup, is what has to stop it.
    const t = onTerminal(
      makePolicy().make(),
      ["/bin/sh", "-c", "(trap '' HUP; exec sleep 4343) & echo started; wait"],
      (pid) => {
        tracked.push(pid)
        return () => cleanups++
      },
    )
    await t.shows("started")
    expect(tracked).toEqual([t.pty.pid])
    expect(cleanups).toBe(0)
    t.pty.kill("SIGHUP")
    t.pty.close()
    await t.pty.exited
    expect(cleanups).toBe(1)
    expect(await gone("4343")).toBe(true)
  },
)
