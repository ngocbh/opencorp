/** Connecting to HQ's machine: the remote check, the master, the forward and the health through it, and sign-in. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { HqStatus } from "@opencorp/protocol"
import { classifyCheck, connect, type FailureKind, portFree, ReachFailure, signIn } from "../../src/reach/connect.ts"
import { control, exitAll, isSocket, type ReachContext, type Ran, runChild, sshEnv } from "../../src/reach/ssh.ts"
import type { Spec } from "../../src/reach/spec.ts"
import { type FakeSsh, fakeControlName } from "../../src/testing/fake_ssh.ts"
import { fakeHome, fakeRemote, freePort, reachCtx } from "./helpers.ts"

setDefaultTimeout(30_000)

const ran = (over: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over })
const HEALTH = { ok: true as const, office: { api: "1" }, app: { build: "b", api: "1" } }
const STATUS: HqStatus = {
  socket: "/h/o/office/hq.sock",
  tcp: { enabled: false, port: 49380, listening: false, error: null, next_retry_at: null },
  url: null,
  health: HEALTH,
  socket_error: null,
  warnings: [],
}
const json = (over: Record<string, unknown> = {}) => JSON.stringify({ ...STATUS, ...over })

const ROWS: [string, Ran, FailureKind, string][] = [
  ["out of time", ran({ code: 143, timedOut: true }), "unreachable", "`opencorp hq --check` there didn't answer within 60 s"],
  ["255", ran({ code: 255, stderr: "Control socket connect(x): No such file\n" }), "unreachable", "Control socket connect(x): No such file"],
  ["3", ran({ code: 3, stderr: "The office isn't running\n" }), "no_office", "The office isn't running"],
  ["127", ran({ code: 127 }), "broken", "no opencorp at the saved path, or no bun for it (exit 127; see env.OPENCORP_BUN)"],
  ["2, an opencorp without --check", ran({ code: 2 }), "not_ready", "`opencorp` there has no `hq --check`; update that checkout"],
  ["1", ran({ code: 1, stderr: "opencorp hq: this office has no HQ yet\n" }), "not_ready", "opencorp hq: this office has no HQ yet"],
  ["5", ran({ code: 5 }), "broken", "`opencorp hq --check` exited 5"],
  ["0 with no JSON", ran({ stdout: "hello\n" }), "broken", "`opencorp hq --check --json` there printed no status JSON"],
  ["a socket path that can't be forwarded", ran({ stdout: json({ socket: "/h/o:x/hq.sock" }) }), "broken", "HQ's socket path there can't be forwarded as is"],
  ["a socket that isn't hq.sock", ran({ stdout: json({ socket: "/h/o/office.sock" }) }), "broken", "HQ's socket path there can't be forwarded as is"],
  ["hq.sock not listening", ran({ stdout: json({ socket_error: "ENOENT\x1b[2J" }) }), "not_ready", "hq.sock isn't listening (ENOENT[2J)"],
  ["the app not built", ran({ stdout: json({ health: { ...HEALTH, app: null } }) }), "not_ready", "HQ's web app isn't built"],
]

test.each(ROWS)("the remote check is classified [%s]", (_label, r, kind, message) => {
  let thrown: unknown
  try {
    classifyCheck(r)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ReachFailure)
  expect((thrown as ReachFailure).kind).toBe(kind)
  expect((thrown as ReachFailure).message).toBe(message)
})

test("the remote check is classified [a good status after a .bashrc banner]", () => {
  expect(classifyCheck(ran({ stdout: `Welcome to node1\n${json()}\n` }))).toEqual(STATUS)
})

/** A spec for node1 through login1, running the fake remote's opencorp. */
const specFor = (opencorp: string): Spec => ({ host: "node1", jump: ["login1"], opencorp })

/** What `connect` threw. */
async function failure(p: Promise<unknown>): Promise<ReachFailure> {
  try {
    await p
  } catch (error) {
    if (error instanceof ReachFailure) return error
    throw error
  }
  throw new Error("connect didn't fail")
}

/** The fake's calls that are `-O <op>`. */
const controlCalls = (fake: FakeSsh, op: string) => fake.calls().filter((argv) => argv.includes("-O") && argv.includes(op))

/** A home with a fake ssh, HQ's machine and a context for both, whose masters all end when the test does. */
async function setup(behavior: Parameters<typeof fakeHome>[0] = {}) {
  const { dir, fake } = fakeHome(behavior)
  const remote = await fakeRemote(dir)
  const ctx = await reachCtx(dir, fake)
  onTestFinished(() => exitAll(ctx))
  return { dir, fake, remote, ctx, spec: specFor(remote.opencorp) }
}

test("connect logs in, checks, forwards and sees the same health through the port", async () => {
  const { fake, remote, ctx, spec } = await setup()
  const port = await freePort()
  const conn = await connect(spec, port, ctx)
  expect(conn.port).toBe(port)
  expect(conn.socket).toBe(remote.socket)
  expect(conn.spec).toEqual(spec)
  const calls = fake.calls().map((argv) => argv.join(" "))
  const master = calls.findIndex((c) => c.includes(" -M -S ") && c.endsWith("-- node1 cat >/dev/null"))
  const check = calls.findIndex((c) => c.endsWith(`'${remote.opencorp}' 'hq' '--check' '--json'`))
  const forward = calls.findIndex((c) => c.includes(" -O forward ") && c.includes(`127.0.0.1:${port}:${remote.socket}`))
  expect(master).toBeGreaterThanOrEqual(0)
  expect(check).toBeGreaterThan(master)
  expect(forward).toBeGreaterThan(check)
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } })
  expect(await res.json()).toEqual(remote.health)
  await exitAll(ctx)
  expect(await conn.master.exited).toBe(0)
  expect(fake.masters()).toEqual([])
})

test("a refused login is couldn't connect, and nothing is left running", async () => {
  const { fake, ctx, spec } = await setup({ login: "refuse" })
  const got = await failure(connect(spec, await freePort(), ctx))
  expect(got.kind).toBe("unreachable")
  expect(got.message).toBe("ssh couldn't log in to node1 (exit 255)")
  expect(fake.masters()).toEqual([])
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
})

test("a port already taken here is port_taken before any forward", async () => {
  const { fake, ctx, spec } = await setup()
  const holder = net.createServer()
  await new Promise<void>((resolve) => holder.listen({ port: 0, host: "127.0.0.1" }, resolve))
  onTestFinished(() => void holder.close())
  const port = (holder.address() as net.AddressInfo).port
  expect(await portFree(port)).toBe(false)
  const got = await failure(connect(spec, port, ctx))
  expect([got.kind, got.message]).toEqual(["port_taken", `port ${port}`])
  expect(controlCalls(fake, "forward")).toEqual([])
  expect(fake.masters()).toEqual([])
})

test("a forward refused while the master lives is port_taken", async () => {
  const { fake, ctx, spec } = await setup({ forward: "refuse" })
  const got = await failure(connect(spec, await freePort(), ctx))
  expect(got.kind).toBe("port_taken")
  expect(controlCalls(fake, "check")).toHaveLength(1)
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
})

test("a forward that carries nothing is no_forward", async () => {
  const { ctx, spec } = await setup({ forward: "blackhole" })
  const got = await failure(connect(spec, await freePort(), ctx))
  expect(got.kind).toBe("no_forward")
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
})

test("health through the port that differs from the check's is no_forward", async () => {
  const { ctx, spec, remote } = await setup()
  remote.health = { ...remote.status.health, app: { build: "other", api: "1" } }
  const got = await failure(connect(spec, await freePort(), ctx))
  expect([got.kind, got.message]).toEqual(["no_forward", "HQ's health through the port differs from the check's"])
})

test("a failed connect ends only cm/node", async () => {
  const { fake, remote, ctx, spec } = await setup()
  // As reach.sh would: a plain session to login1 leaves its auto master, which the node's hop rides.
  const login = await runChild([ctx.paths.wrapper, "login1", "true"], { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: 5000 })
  expect(login.code).toBe(0)
  const loginSocket = path.join(ctx.paths.cm, fakeControlName("login1"))
  expect(isSocket(loginSocket)).toBe(true)
  remote.setCheck({ code: 1, stderr: "opencorp hq: this office has no HQ yet\n" })
  const got = await failure(connect(spec, await freePort(), ctx))
  expect(got.kind).toBe("not_ready")
  expect(fs.existsSync(ctx.paths.node)).toBe(false)
  expect((await control(ctx, loginSocket, "check")).code).toBe(0)
  await exitAll(ctx)
  expect(fake.masters()).toEqual([])
})

test("sign-in takes the code from opencorp hq --json over the master", async () => {
  const { fake, remote, ctx, spec } = await setup()
  await connect(spec, await freePort(), ctx)
  expect(await signIn(ctx, spec)).toBe(remote.code)
  expect(fake.calls().some((argv) => argv.at(-1)!.endsWith(`'${remote.opencorp}' 'hq' '--json'`))).toBe(true)
})

test("a code in the wrong format is broken and never written", async () => {
  const { remote, ctx, spec } = await setup()
  await connect(spec, await freePort(), ctx)
  remote.setSignIn({
    stdout: JSON.stringify({ path: "/pair#short", url: null, socket: remote.socket, port: 1, expires_at: "2026-11-11T10:00:00.000Z", open_file: null }),
  })
  const got = await failure(signIn(ctx, spec))
  expect([got.kind, got.message]).toEqual(["broken", "`opencorp hq --json` there printed no pairing code"])
  expect(fs.readdirSync(ctx.paths.dir).filter((name) => name.startsWith("pair-"))).toEqual([])
})

test("sign-in with no office there is no_office, and with the master gone couldn't connect", async () => {
  const { remote, ctx, spec } = await setup()
  await connect(spec, await freePort(), ctx)
  remote.setSignIn({ code: 3, stderr: "The office isn't running\n" })
  const none = await failure(signIn(ctx, spec))
  expect([none.kind, none.message]).toEqual(["no_office", "The office isn't running"])
  remote.setSignIn({ code: 1, stderr: "opencorp hq: HQ can't be reached\n" })
  expect((await failure(signIn(ctx, spec))).kind).toBe("not_ready")
  await exitAll(ctx)
  expect((await failure(signIn(ctx, spec))).kind).toBe("unreachable")
})
