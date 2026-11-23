/** OpenCorp's connection shell: the chain test's replay and node master run in a PTY OpenCorp drives, where ssh's
 *  prompts reach the owner; the shell outlives its listing and closes at the visit's end. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { Connection } from "../../../src/features/reach/connect.ts"
import { chainTest, CONNECTION, ConnectionShell } from "../../../src/features/reach/connection.ts"
import type { Spec } from "../../../src/features/reach/spec.ts"
import { control, exitAll, isSocket } from "../../../src/features/reach/ssh.ts"
import type { LiveInstrument } from "../../../src/runtime/sessions/instruments.ts"
import type { FakeSshBehavior } from "../../../src/testing/fake_ssh.ts"
import { readRecord } from "../../../src/tools/terminal/record.ts"
import { waitFor } from "../../helpers.ts"
import { fakeHome, fakeRemote, freePort, reachCtx } from "./helpers.ts"

setDefaultTimeout(60_000)

/** reach.sh for `spec`: log in to login1, leaving its master, then print the spec. */
const scriptFor = (spec: Spec) => `set -eu\nssh login1 true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`

/** A visit's context over the fake ssh with `behavior`, HQ's machine faked as node1 through login1, and OpenCorp's
 *  connection shell for a session folder in hq/sessions, listed in `listed`. The test's end closes the shell. */
async function setUp(behavior: FakeSshBehavior = {}) {
  const { dir, fake } = fakeHome(behavior)
  const ctx = await reachCtx(dir, fake)
  const remote = await fakeRemote(dir)
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  const folder = path.join(ctx.paths.sessions, "01JDCONNECTION000000000000")
  const listed = new Map<string, LiveInstrument>()
  const events: string[] = []
  const shell = new ConnectionShell({
    ctx,
    folder,
    sessionId: "01JDSESSION000000000000000",
    instruments: {
      add: (instrument) => void listed.set(instrument.id, instrument),
      updated: (id) => void events.push(`updated ${id}`),
      output: (id) => void events.push(`output ${id}`),
      remove: (id) => void listed.delete(id),
    },
  })
  onTestFinished(async () => {
    await exitAll(ctx)
    await shell.close()
  })
  return { dir, fake, ctx, remote, spec, folder, listed, events, shell, port: await freePort() }
}

test("the chain test runs the replay and the node master in OpenCorp's connection shell with the visit config", async () => {
  const t = await setUp({ hosts: { login1: { login: "tty" } } })
  const tested = chainTest(t.shell, Buffer.from(scriptFor(t.spec)), t.port, t.ctx)
  // The replay's ssh asks in the shell, which the session lists as OpenCorp's connection, waiting for the owner.
  await waitFor(() => t.shell.shell?.state().waiting === "secret", { what: "the password prompt" })
  const [listing] = [...t.listed.values()]
  expect(listing!.info()).toMatchObject({ name: CONNECTION, driver: "opencorp", profile: "none", interactive: true, status: "waiting" })
  listing!.keys("hunter2\r")
  const conn = (await tested) as Connection
  expect(typeof conn).toBe("object")
  expect(conn.spec).toEqual(t.spec)
  expect(conn.socket).toBe(t.remote.socket)
  // One login: the node's hop rode login1's master, which reach.sh's ssh left in its hq/cm-<id>.
  expect(t.fake.tty()).toEqual(["hunter2"])
  expect(t.fake.logins()).toEqual(["login1", "node1"])
  // Both ran with the visit's config; the master is OpenCorp's own, on hq/cm-<id>/node, as the shell's running command.
  const calls = t.fake.calls()
  const master = calls.find((argv) => argv.includes("-M"))!
  expect(master.slice(0, 4)).toEqual(["-F", t.ctx.paths.config, "-M", "-S"])
  expect(master[4]).toBe(t.ctx.paths.node)
  expect(calls[0]!.slice(0, 2)).toEqual(["-F", t.ctx.paths.config])
  expect(isSocket(t.ctx.paths.node)).toBe(true)
  expect(t.shell.shell!.state()).toMatchObject({ status: "running", waiting: null })
  // Its record is in the session's folder: both commands, by OpenCorp, and the prompt as the screen showed it, never
  // the password.
  const record = readRecord(path.join(t.folder, "terminal", listing!.id))!
  expect([record.name, record.driver, record.profile]).toEqual([CONNECTION, "opencorp", "none"])
  expect(record.commands.map((c) => [c.by, c.command.split(" ")[0]])).toEqual([
    ["opencorp", "sh"],
    ["opencorp", `'${t.ctx.ssh}'`],
  ])
  const log = fs.readFileSync(path.join(t.folder, "terminal", listing!.id, "output.log"), "utf8")
  expect(log).toContain("fake password for login1:")
  expect(log).not.toContain("hunter2")
  // The spec went to the shell's temp folder, never to its screen.
  expect(log).not.toContain('"opencorp"')
  expect(fs.readdirSync(t.ctx.paths.dir).filter((name) => name.startsWith(".reach-"))).toEqual([])
})

test("a failed replay names its step and leaves the shell for the next try", async () => {
  const t = await setUp()
  const failed = await chainTest(t.shell, Buffer.from("echo 'no job here' >&2\nexit 3\n"), t.port, t.ctx)
  expect(failed).toBe("reach.sh failed the test (no_office): no job here")
  expect(t.shell.shell!.state().status).toBe("idle")
  const conn = await chainTest(t.shell, Buffer.from(scriptFor(t.spec)), t.port, t.ctx)
  expect(typeof conn).toBe("object")
  expect(t.listed.size).toBe(1)
})

test("the shell stays when its listing goes, and closes at the visit's end", async () => {
  const t = await setUp()
  const conn = (await chainTest(t.shell, Buffer.from(scriptFor(t.spec)), t.port, t.ctx)) as Connection
  const [id] = [...t.listed.keys()]
  // The session ends: the host takes the listing out, and never closes the shell.
  t.listed.delete(id!)
  await Bun.sleep(300)
  expect(t.shell.shell!.state().status).toBe("running")
  expect((await control(t.ctx, t.ctx.paths.node, "check")).code).toBe(0)
  const health = await fetch(`http://127.0.0.1:${t.port}/api/health`, { headers: { connection: "close" } })
  expect(health.status).toBe(200)
  await health.body?.cancel()
  // The visit's end: its masters exit, so the shell's command ends, and then the shell closes.
  await exitAll(t.ctx)
  expect(await conn.master.exited).toBe(0)
  await t.shell.close()
  expect(t.shell.shell!.state().status).toBe("ended")
  expect(t.fake.masters()).toEqual([])
})

test("the chain test's own stop, the card's Esc, ends its replay at once, even at ssh's password prompt", async () => {
  const t = await setUp({ hosts: { login1: { login: "tty" } } })
  const stop = new AbortController()
  // Five minutes for a login, as a visit gives it: only the stop can end it soon.
  const limits = { ...t.ctx.limits, promptMs: 300_000 }
  const tested = chainTest(t.shell, Buffer.from(scriptFor(t.spec)), t.port, { ...t.ctx, limits, signal: stop.signal })
  await waitFor(() => t.shell.shell?.state().waiting === "secret", { what: "the password prompt" })
  const at = performance.now()
  stop.abort()
  await expect(tested).rejects.toThrow()
  expect(performance.now() - at).toBeLessThan(4000)
  expect(["running", "waiting"]).not.toContain(t.shell.shell!.state().status)
  // The visit's own context goes on: its signal never fired.
  expect(t.ctx.signal?.aborted ?? false).toBe(false)
  expect(t.fake.tty()).toEqual([])
})

test("a node master that a Ctrl-C doesn't end is ended with its shell", async () => {
  const t = await setUp()
  // An ssh that ignores SIGINT, as the node master the shell runs.
  const stubborn = path.join(t.dir, "stubborn-ssh")
  fs.writeFileSync(stubborn, `#!/bin/sh\ncase "$1" in -G) exit 1 ;; esac\ntrap '' INT\nsleep 300\n`, { mode: 0o700 })
  const shell = new ConnectionShell({
    ctx: { ...t.ctx, ssh: stubborn },
    folder: t.folder,
    sessionId: "01JDSESSION000000000000000",
    instruments: { add: () => {}, updated: () => {}, output: () => {}, remove: () => {} },
  })
  onTestFinished(() => shell.close())
  const master = await shell.master(t.spec)
  await Bun.sleep(300)
  const at = performance.now()
  master.kill()
  expect(await master.exited).toBe(255)
  expect(performance.now() - at).toBeLessThan(8000)
  expect(shell.shell!.state().status).toBe("ended")
})
