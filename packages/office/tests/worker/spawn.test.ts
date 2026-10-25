/** Run worker processes: the environment they start with, and the office's reader of their frames. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import type net from "node:net"
import path from "node:path"
import { inspect } from "node:util"
import { inspectRun } from "@ngocbh/yian/run"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { INHERITED_ENV as LAUNCH_ENV } from "../../src/install/launch.ts"
import { args, killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { selfCommand } from "../../src/platform.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { type Channel, ChannelClosed, type Frame, FrameTooLarge, socketChannel } from "../../src/worker/channel.ts"
import { encode } from "../../src/worker/codec.ts"
import type { Job } from "../../src/worker/job.ts"
import { EXIT_FAILED, EXIT_ORPHANED, jobTools } from "../../src/worker/main.ts"
import type { OfficeTool, WorkerHandlers } from "../../src/worker/rpc.ts"
import {
  INHERITED_ENV,
  RegistryClosed,
  type SpawnLog,
  spawnProcess,
  Worker,
  WorkerExists,
  workerEnv,
} from "../../src/worker/spawn.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { cwdOf, envEntries, envNames, isGone, ps, startGroup, tempDir, waitFor } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { base, channelPair, makeJob, makeRegistry, officeEnd, Recorder, runWorker, writeFiles } from "./helpers.ts"

setDefaultTimeout(60_000)

const CHANNEL_URL = new URL("../../src/worker/channel.ts", import.meta.url).href
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
// A frame whose body is `[]`: JSON, but not an object.
const BAD_FRAME = "Buffer.from([0, 0, 0, 2, 0x5b, 0x5d])"
const BAD_FRAME_LINE = "worker s1 sent a bad frame (TypeError); closing its channel"

/** A log that records each line with its level. */
function recordingLog(): { lines: [string, string][]; log: SpawnLog } {
  const lines: [string, string][] = []
  return { lines, log: (level, line) => void lines.push([level, line]) }
}

/** A `Worker` over `child` and the office's `channel`, with `handlers` and a no-op `onExit`. */
function workerOver(
  child: ChildProcess,
  channel: Channel,
  handlers: WorkerHandlers<Worker>,
  job: Job = makeJob(base()),
  { log }: { log?: SpawnLog } = {},
): Worker {
  return new Worker(job, child, channel, handlers, () => {}, { log })
}

/** A child that has already exited with code 0, for tests without a process (`killGroup` refuses pid 0). */
function exitedChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { pid: 0, exitCode: 0, signalCode: null }) as unknown as ChildProcess
}

/** Runs `body` as a Bun script in a fresh directory, after imports of `fs`, `ChannelClosed` and `fdChannel`, leading
 *  its own process group with the office end of a socket at its fd 3. When the test finishes the group is killed if
 *  its leader is still the process that started (pid and start time). */
function script(body: string): { child: ChildProcess; channel: Channel } {
  const dir = tempDir()
  const file = path.join(dir, "worker.ts")
  fs.writeFileSync(
    file,
    `import fs from "node:fs"\nimport { ChannelClosed, fdChannel } from "${CHANNEL_URL}"\n${body}\n`,
  )
  const child = spawn(process.execPath, [...BUN_FLAGS, file], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdio: ["ignore", "inherit", "inherit", "pipe"],
    detached: true,
  })
  if (child.pid === undefined) {
    // The spawn error is also emitted as an event; a listener keeps it from becoming an uncaught exception.
    child.on("error", () => {})
    child.stdio[3]?.destroy()
    throw new Error("script: spawn failed")
  }
  const pid = child.pid
  const started = startTime(pid)
  const channel = socketChannel(child.stdio[3] as net.Socket)
  onTestFinished(() => {
    channel.close()
    if (started !== null && sameProcess(pid, started)) killGroup(pid)
  })
  return { child, channel }
}

/** A script leader that starts a child holding its fd 3 (in the leader's group, or its own if `detached`), writes the
 *  child's pid to `file`, and exits 0 half a second later. */
function holdingLeader(file: string, { detached }: { detached: boolean }): { child: ChildProcess; channel: Channel } {
  return script(`
    import { spawn } from "node:child_process"
    const holder = spawn(process.execPath, [...${JSON.stringify(BUN_FLAGS)}, "-e", "setTimeout(() => {}, 60000)"], {
      detached: ${detached},
      stdio: ["ignore", "ignore", "ignore", 3],
    })
    fs.writeFileSync(${JSON.stringify(file)}, String(holder.pid))
    setTimeout(() => process.exit(0), 500)
  `)
}

/** The pid and start time of the holder `holdingLeader` wrote to `file`, read while its leader still runs; the
 *  holder is killed at test end if it is still that process. */
async function holderOf(file: string): Promise<{ pid: number; started: number | null }> {
  const pid = Number(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), { what: "the pid" }))
  const started = startTime(pid)
  onTestFinished(() => {
    // The holder can exit between the check and the kill.
    try {
      if (started !== null && sameProcess(pid, started)) process.kill(pid, "SIGKILL")
    } catch {}
  })
  return { pid, started }
}

/** How many fds this process has open. */
function fdCount(): number {
  return fs.readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length
}

// The probe writes the identity (`dev:ino`) of each fd 3-63 it holds, then "end", to the file named by its first
// argument, then stays alive for its second argument's milliseconds (as channel.test.ts's grandchild test).
const PROBE = `
  import fs from "node:fs"
  const [file, stay] = process.argv.slice(-2)
  const held = []
  for (let fd = 3; fd < 64; fd++) {
    try {
      const { dev, ino } = fs.fstatSync(fd, { bigint: true })
      held.push(dev + ":" + ino)
    } catch {}
  }
  fs.writeFileSync(file, [...held, "end"].join(" "))
  setTimeout(() => {}, Number(stay))
`

// A company CODE node that runs the probe twice from inside the worker: a positive control handed the worker's
// channel (fd 3) on purpose, then a grandchild that inherits nothing and stays alive. Returns the grandchild's pid
// and the channel's identity.
const PROBE_FLOW =
  "id: probe\nname: probe\ninput:\n  dir: !str\nnodes:\n  probe:\n    kind: code\n" +
  '    input: {dir: "${input.dir}"}\n    output: Any\n    code: ./probe.ts:run\noutput: ${probe.output}\n'
const PROBE_CODE = `import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const FLAGS = ${JSON.stringify(BUN_FLAGS)}
const PROBE = ${JSON.stringify(PROBE)}

export async function run(inputs: { dir: string }) {
  const { dev, ino } = fs.fstatSync(3, { bigint: true })
  const probe = (file: string, stay: string, stdio: any) =>
    spawn(process.execPath, [...FLAGS, "-e", PROBE, path.join(inputs.dir, file), stay], { stdio })
  const control = probe("fds-control", "0", ["ignore", "ignore", "ignore", 3])
  await new Promise((resolve) => control.once("exit", resolve).once("error", resolve))
  const grandchild = probe("fds", "60000", "ignore")
  // The thread must not wait on it.
  grandchild.unref()
  // Returns once the grandchild has listed its fds, so the group kill after the worker's exit can't come first.
  const fds = path.join(inputs.dir, "fds")
  for (let i = 0; i < 750 && !(fs.existsSync(fds) && fs.readFileSync(fds, "utf8").endsWith("end")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { pid: grandchild.pid, channel: dev + ":" + ino }
}
`

/** Handlers granting group `g`, whose tool `big` returns 5,000 characters. */
function bigTool(): Recorder {
  const big: OfficeTool = {
    description: "Big.",
    parameters: { type: "object", properties: {} },
    call: () => "x".repeat(5000),
  }
  return new Recorder({ tools: { g: { big } } })
}

test("a worker keeps where tls finds ca certificates when the office has it", () => {
  const env = workerEnv({
    PATH: "/bin",
    SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/pki/tls/certs",
  })
  expect(env.SSL_CERT_FILE).toBe("/etc/pki/tls/certs/ca-bundle.crt")
  expect(env.SSL_CERT_DIR).toBe("/etc/pki/tls/certs")
  const without = workerEnv({ PATH: "/bin", SSL_CERT_FILE: undefined })
  expect("SSL_CERT_FILE" in without).toBe(false)
  expect("SSL_CERT_DIR" in without).toBe(false)
})

test("worker env narrows the environment it is given", () => {
  const environ = { PATH: "/bin", LC_ALL: "C", SSL_CERT_FILE: "/ca.pem", OPENAI_API_KEY: "sk-secret" }
  expect(workerEnv(environ)).toEqual({ PATH: "/bin", LC_ALL: "C", SSL_CERT_FILE: "/ca.pem" })
})

test("the worker env names are the launch allowlist", () => {
  expect(INHERITED_ENV).toBe(LAUNCH_ENV)
  expect([...INHERITED_ENV]).toEqual([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
})

test("a worker that exits takes its process group with it", async () => {
  const { office, worker: far } = await channelPair()
  const leader = startGroup("/bin/sleep 60 & echo $!")
  // Built before the line is read, so the leader's exit can't come first.
  const worker = workerOver(leader.child, office, new Recorder())
  const grand = Number(await leader.line())
  const grandStarted = startTime(grand)
  leader.track(grand, grandStarted)
  await worker.start()
  far.close()
  expect(await worker.wait(10_000)).toBe(0)
  await waitFor(() => isGone(grand, grandStarted), { what: "the grandchild to go" })
  const kill = spyOn(process, "kill")
  onTestFinished(() => kill.mockRestore())
  worker.kill()
  expect(kill).not.toHaveBeenCalled()
})

test("a reply that cannot be sent becomes a failed reply", async () => {
  const { office, worker: far } = await channelPair({ maxFrame: 2000 })
  const handlers = bigTool()
  const job = makeJob(base(), "flows/echo.yaml", { inputs: {} }, handlers)
  expect(Buffer.byteLength(encode({ type: "start", job }))).toBeLessThan(2000)
  const worker = workerOver(exitedChild(), office, handlers, job)
  await worker.start()
  expect((await far.recv()).type).toBe("start")
  await far.send({ type: "tool_call", id: 7, group: "g", name: "big" })
  const reply = await far.recv()
  expect([reply.type, reply.id, reply.error, reply.message]).toEqual([
    "tool_result",
    7,
    "failed",
    "the reply could not be sent (FrameTooLarge)",
  ])
})

test("a request without an id is answered without raising", async () => {
  const { office, worker: far } = await channelPair({ maxFrame: 2000 })
  const handlers = bigTool()
  const job = makeJob(base(), "flows/echo.yaml", { inputs: {} }, handlers)
  const worker = workerOver(exitedChild(), office, handlers, job)
  await worker.start()
  expect((await far.recv()).type).toBe("start")
  await far.send({ type: "tool_call", group: "g", name: "missing" })
  const reply = await far.recv()
  expect([reply.type, reply.id, reply.error, reply.message]).toEqual([
    "tool_result",
    null,
    "failed",
    "no tool 'missing' in group 'g'",
  ])
})

test("the office closes the channel of a worker that sends a bad frame", async () => {
  // Sends a frame that isn't a JSON object, then exits once the office closes the channel.
  const { child, channel } = script(`
    fs.writeSync(3, ${BAD_FRAME})
    const channel = fdChannel(3)
    for (;;) {
      try {
        await channel.recv()
      } catch (error) {
        process.exit(error instanceof ChannelClosed ? 0 : 1)
      }
    }
  `)
  const rec = new Recorder()
  const { lines, log } = recordingLog()
  const worker = workerOver(child, channel, rec, makeJob(base()), { log })
  await worker.start()
  expect(await worker.wait(10_000)).toBe(0)
  expect(rec.returncode).toBe(0)
  expect(rec.outcome).toBeNull()
  expect(lines).toEqual([["WARNING", BAD_FRAME_LINE]])
})

test("a deliver reply frame without its fields is a bad frame", async () => {
  const { office, worker: far } = await channelPair()
  const rec = new Recorder()
  const { lines, log } = recordingLog()
  const worker = workerOver(exitedChild(), office, rec, makeJob(base()), { log })
  await worker.start()
  expect((await far.recv()).type).toBe("start")
  await far.send({ type: "deliver_reply", id: 3 })
  await expect(far.recv()).rejects.toBeInstanceOf(ChannelClosed)
  expect(await worker.wait(10_000)).toBe(0)
  expect(rec.replies).toEqual([])
  expect(lines).toEqual([["WARNING", BAD_FRAME_LINE]])
})

test("a worker that keeps running after its channel closes is killed after the grace", async () => {
  // Neither reads nor ends the channel, so only the grace kill can end it.
  const { child, channel } = script(`
    fs.writeSync(3, ${BAD_FRAME})
    setTimeout(() => {}, 60_000)
  `)
  const { lines, log } = recordingLog()
  const worker = workerOver(child, channel, new Recorder(), makeJob(base()), { log })
  // The start frame sits unread in the socket buffer.
  await worker.start()
  const began = performance.now()
  expect(await worker.wait(15_000)).toBe(-9)
  expect(performance.now() - began).toBeGreaterThanOrEqual(4500)
  expect(lines).toEqual([["WARNING", BAD_FRAME_LINE]])
})

test("a workers group is killed as soon as its leader exits", async () => {
  const file = path.join(tempDir(), "holder")
  const { child, channel } = holdingLeader(file, { detached: false })
  const worker = workerOver(child, channel, new Recorder())
  await worker.start()
  const began = performance.now()
  const holder = await holderOf(file)
  expect(holder.started).not.toBeNull()
  // The holder keeps the channel open, so only the group kill at the leader's exit lets the worker finish.
  expect(await worker.wait(15_000)).toBe(0)
  expect(performance.now() - began).toBeLessThan(4000)
  expect(isGone(holder.pid, holder.started)).toBe(true)
})

test("a workers group is killed at its leaders exit while a detached child holds the channel", async () => {
  const kill = process.kill.bind(process)
  const groupKills: number[] = []
  let pgid = 0
  const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -pgid) groupKills.push(performance.now())
    return kill(pid, signal)
  })
  onTestFinished(() => spy.mockRestore())
  const file = path.join(tempDir(), "holder")
  const { child, channel } = holdingLeader(file, { detached: true })
  pgid = child.pid!
  const worker = workerOver(child, channel, new Recorder())
  let exitedAt = 0
  child.once("exit", () => (exitedAt = performance.now()))
  await worker.start()
  const holder = await holderOf(file)
  expect(holder.started).not.toBeNull()
  await waitFor(() => groupKills.length > 0, { timeout: 5000, what: "the group kill" })
  expect(exitedAt).toBeGreaterThan(0)
  expect(Math.abs(groupKills[0]! - exitedAt)).toBeLessThan(1000)
  // The holder, in its own group, still holds the channel: the kill didn't wait for the channel to end.
  expect(isGone(holder.pid, holder.started)).toBe(false)
  expect(groupKills).toHaveLength(1)
})

test("a worker starts only once", async () => {
  const { office, worker: far } = await channelPair()
  const worker = workerOver(exitedChild(), office, new Recorder())
  await worker.start()
  await expect(worker.start()).rejects.toThrow("the worker was already started")
  expect((await far.recv()).type).toBe("start")
  // A frame the office can't read makes it close the channel: the stream ends with no second start frame.
  await far.send({ type: "deliver_reply", id: 3 })
  await expect(far.recv()).rejects.toBeInstanceOf(ChannelClosed)
  expect(await worker.wait(10_000)).toBe(0)
})

test("a worker sends a delivery as a deliver frame", async () => {
  const { office, worker: far } = await channelPair()
  const rec = new Recorder()
  const worker = workerOver(exitedChild(), office, rec)
  await worker.start()
  expect((await far.recv()).type).toBe("start")
  expect(await worker.deliver({ id: "d1", op: "close", inbox: "steers" })).toBe(true)
  expect(await far.recv()).toEqual({ type: "deliver", id: "d1", op: "close", inbox: "steers" })
  await far.send({ type: "deliver_reply", id: "d1", seq: 4 })
  await waitFor(() => rec.replies.length === 1, { timeout: 5000, what: "the reply" })
  expect(rec.replies).toEqual([{ type: "deliver_reply", id: "d1", seq: 4 }])
  office.close()
  expect(await worker.deliver({ id: "d2", op: "close", inbox: "steers" })).toBe(false)
})

test("a worker shows no job when inspected or serialized", async () => {
  const { office } = await channelPair()
  const job = makeJob(base(), undefined, { llm_config: { ...LLM_CONFIG, api_key: "sk-sentinel-0123456789" } })
  const worker = workerOver(exitedChild(), office, new Recorder(), job)
  expect(inspect(worker)).not.toContain("sk-sentinel-0123456789")
  expect(JSON.stringify(worker)).not.toContain("sk-sentinel-0123456789")
})

test("a chat job streams events and a result", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "hello there" })
  const rec = await runWorker(registry, makeJob(where), new Recorder(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome).toEqual({
    type: "result",
    status: "succeeded",
    run_id: "r1",
    output: "hello there",
    failure: null,
    waits: [],
  })
  const names = rec.names()
  expect(names[0]).toBe("RunStarted")
  expect(names.at(-1)).toBe("RunSucceeded")
  const reply = rec.frames.filter(
    (frame) => (frame.data as { node_id?: unknown } | undefined)?.node_id === "reply" || frame.node_id === "reply",
  )
  const kinds = reply.map((frame) => String(frame.name ?? "stream"))
  expect(kinds[0]).toBe("NodeStarted")
  expect(kinds.at(-1)).toBe("NodeSucceeded")
  expect(kinds).toContain("stream")
  const chunks = rec.frames.filter((frame) => frame.type === "stream").map((frame) => frame.chunk)
  expect(chunks.join("")).toBe("hello there")
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  expect(fs.statSync(path.join(sessionDir, "worker.log")).mode & 0o777).toBe(0o600)
})

test("the worker log gets the workers output and keeps it across spawns", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  let child: ChildProcess | undefined
  const registry = makeRegistry(store, {
    spawn: (...given) => {
      const out = spawnProcess(...given)
      child = out.child
      return out
    },
  })
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "never", hold: true })
  const worker = await registry.spawn(makeJob(where), sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  // A frame whose body is `[]`: the worker can't read it, so it treats the office as gone.
  ;(child!.stdio[3] as net.Socket).write(Buffer.from([0, 0, 0, 2, 0x5b, 0x5d]))
  expect(await worker.wait(10_000)).toBe(3)
  fake.release()
  const line = "opencorp __worker: bad office frame (TypeError)\n"
  const log = path.join(sessionDir, "worker.log")
  expect(fs.readFileSync(log, "utf8")).toContain(line)
  fake.script({ content: "again" })
  const rec = await runWorker(registry, makeJob(where, undefined, { run_id: "r2" }), new Recorder(), sessionDir, {
    env: fake.env(),
  })
  expect(rec.outcome?.status).toBe("succeeded")
  expect(fs.readFileSync(log, "utf8").startsWith(line)).toBe(true)
})

test("a running worker is recorded and isolated", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store, {
    environ: { ...process.env, OFFICE_SECRET: "office-env-secret", LC_CTYPE: "UTF-8", BUN_OPTIONS: "--preload /nope" },
  })
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "slow", hold: true })
  const rec = new Recorder()
  const worker = await registry.spawn(makeJob(where), sessionDir, rec, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  const pid = worker.pid
  const [record, ...more] = store.listWorkers()
  expect(more).toEqual([])
  expect([record!.key, record!.pid, record!.pgid]).toEqual(["s1", pid, pid])
  expect(Math.abs(record!.startTime - startTime(pid)!)).toBeLessThan(0.01)
  const pgid = execFileSync(ps(), ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim()
  expect(pgid).toBe(String(pid))
  expect(fs.realpathSync(cwdOf(pid))).toBe(fs.realpathSync(sessionDir))
  expect(args(pid, ps())).toBe([...selfCommand(), "__worker"].join(" "))
  const env = new Map(envEntries(pid))
  expect(env.get("LC_CTYPE")).toBe("UTF-8")
  expect(env.get("PATH")).toBe(process.env.PATH!)
  // The provider env rides in the spawn env.
  expect(env.has("VLLM_BASE_URL")).toBe(true)
  expect(env.has("OFFICE_SECRET")).toBe(false)
  expect([...env.keys()].filter((name) => name.startsWith("BUN_"))).toEqual([])
  fake.release()
  expect(await worker.wait(30_000)).toBe(0)
  expect(rec.outcome?.output).toBe("slow")
})

test("a worker env drops runtime and loader variables from the provider env", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const dropped = {
    BUN_OPTIONS: "--preload /nope",
    BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1",
    NODE_OPTIONS: "--require /nope",
    DYLD_INSERT_LIBRARIES: "/nope",
    LD_PRELOAD: "/nope",
  }
  fake.script({ content: "kept", hold: true })
  const rec = new Recorder()
  const worker = await registry.spawn(makeJob(where), sessionDir, rec, { env: { ...fake.env(), ...dropped } })
  await fake.waitForRequests(1, 30_000)
  const names = envNames(worker.pid)
  expect(Object.keys(dropped).filter((name) => names.includes(name))).toEqual([])
  fake.release()
  expect(await worker.wait(30_000)).toBe(0)
  expect(rec.outcome?.status).toBe("succeeded")
})

test("one live worker per session", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const env = fake.env()
  fake.script({ content: "one", hold: true }, { content: "two" }, { content: "three" })
  const first = await registry.spawn(makeJob(where), sessionDir, new Recorder(), { env })
  // So the first worker takes the held reply.
  await fake.waitForRequests(1, 30_000)
  await expect(
    registry.spawn(makeJob(where, undefined, { run_id: "r2" }), sessionDir, new Recorder(), { env }),
  ).rejects.toBeInstanceOf(WorkerExists)
  const other = await registry.spawn(
    makeJob(where, undefined, { session_id: "s2", run_id: "r3" }),
    path.join(where.root, "sessions", "s2"),
    new Recorder(),
    { env },
  )
  expect(await other.wait(30_000)).toBe(0)
  fake.release()
  expect(await first.wait(30_000)).toBe(0)
  const rec = await runWorker(registry, makeJob(where, undefined, { run_id: "r4" }), new Recorder(), sessionDir, {
    env,
  })
  expect(rec.returncode).toBe(0)
})

test("a job that raises sends an error frame", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const rec = await runWorker(registry, makeJob(where, "flows/missing.yaml"), new Recorder(), sessionDir, {
    env: fake.env(),
  })
  expect(rec.returncode).toBe(1)
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message).startsWith("Error: ENOENT")).toBe(true)
  for (const line of String(rec.outcome?.traceback).split("\n")) expect(line).toMatch(/^\s+at /)
  expect(fake.requests()).toEqual([])
})

test("a failed run is a result", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ error: 500 })
  const rec = await runWorker(registry, makeJob(where), new Recorder(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome?.status).toBe("failed")
  expect((rec.outcome?.failure as { node_id?: unknown } | null)?.node_id).toBe("reply")
})

test("a failing handler does not stop the reader", async () => {
  class Broken extends Recorder {
    override event(): void {
      throw new Error("handler bug")
    }
  }
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const { lines, log } = recordingLog()
  const registry = makeRegistry(store, { log })
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "fine" })
  const rec = await runWorker(registry, makeJob(where), new Broken(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome?.output).toBe("fine")
  expect(lines).toContainEqual(["ERROR", "worker s1 handler event failed (Error)"])
  expect(lines.filter(([, line]) => line.includes("handler bug"))).toEqual([])
})

test("an async handler that rejects does not stop the reader", async () => {
  class Broken extends Recorder {
    override async event(): Promise<void> {
      throw new Error("handler bug")
    }
  }
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const { lines, log } = recordingLog()
  const registry = makeRegistry(store, { log })
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "fine" })
  const rec = await runWorker(registry, makeJob(where), new Broken(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome?.output).toBe("fine")
  expect(lines).toContainEqual(["ERROR", "worker s1 handler event failed (Error)"])
  expect(lines.filter(([, line]) => line.includes("handler bug"))).toEqual([])
})

test("a worker exits when the office closes its channel", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "never", hold: true })
  const worker = await registry.spawn(makeJob(where), sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  worker.closeChannel()
  expect(await worker.wait(10_000)).toBe(EXIT_ORPHANED)
})

test("close stops the run first", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "never", hold: true })
  const job = makeJob(where)
  const rec = new Recorder()
  await registry.spawn(job, sessionDir, rec, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await registry.close("s1", 10_000)).toBe(EXIT_FAILED)
  expect(rec.outcome?.type).toBe("error")
  expect(String(rec.outcome?.message)).toContain("the office stopped the run")
  expect(inspectRun(job.log).status).toBe("stopped")
})

test("close kills a worker that does not exit", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "never", hold: true })
  const worker = await registry.spawn(makeJob(where), sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  // It can't see the stop or the channel close.
  process.kill(worker.pid, "SIGSTOP")
  expect(await registry.close("s1", 1000)).toBe(-9)
})

test("close does not wait on a worker that stopped reading", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "never", hold: true })
  const worker = await registry.spawn(makeJob(where), sessionDir, new Recorder(), { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  process.kill(worker.pid, "SIGSTOP")
  // A frame the stopped worker never reads, queued ahead of the stop.
  void worker.channel.send({ type: "pad", pad: "x".repeat(16 << 20) }).catch(() => {})
  const began = performance.now()
  expect(await registry.close("s1", 1000)).toBe(-9)
  expect(performance.now() - began).toBeLessThan(3500)
})

test("a waiting run ends its worker normally", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  const job = makeJob(where, "flows/nap.yaml", { inputs: {} })
  const rec = await runWorker(registry, job, new Recorder(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome?.status).toBe("waiting")
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
})

test("a failing exit step still finishes the worker", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const { lines, log } = recordingLog()
  const registry = makeRegistry(store, { log })
  const sessionDir = path.join(where.root, "sessions", "s1")
  const removeWorker = spyOn(store, "removeWorker").mockImplementation(() => {
    throw new Error("database is locked")
  })
  onTestFinished(() => removeWorker.mockRestore())
  fake.script({ content: "fine" })
  const rec = await runWorker(registry, makeJob(where), new Recorder(), sessionDir, { env: fake.env() })
  expect(rec.returncode).toBe(0)
  expect(rec.outcome?.output).toBe("fine")
  expect(registry.get("s1")).toBeUndefined()
  expect(lines).toContainEqual(["ERROR", "could not remove the record of worker s1 (Error)"])
  expect(lines.filter(([, line]) => line.includes("database is locked"))).toEqual([])
})

test("a record that cannot be written leaves no worker behind", async () => {
  const where = base()
  const store = openStore()
  let child: ChildProcess | undefined
  let channel: Channel | undefined
  const registry = makeRegistry(store, {
    spawn: (...given) => {
      const out = spawnProcess(...given)
      child = out.child
      channel = out.channel
      return out
    },
  })
  const sessionDir = path.join(where.root, "sessions", "s1")
  const failure = new Error("database is locked")
  const recordWorker = spyOn(store, "recordWorker").mockImplementation(() => {
    throw failure
  })
  onTestFinished(() => recordWorker.mockRestore())
  await expect(registry.spawn(makeJob(where), sessionDir, new Recorder())).rejects.toBe(failure)
  await waitFor(() => child!.exitCode !== null || child!.signalCode !== null)
  // Killed, not exited on its own after its channel closed.
  expect(child!.signalCode).toBe("SIGKILL")
  // Closed by the office, not broken by the child's death.
  await expect(channel!.send({ type: "pad" })).rejects.toThrow("this end stopped sending")
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
})

test("a model ask user call reaches the office", async () => {
  const where = base()
  const fake = await fakeLlm()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script(
    {
      content: "",
      tool_calls: [{ name: "ask_user", arguments: { question: "Which city?", options: ["Paris", "Rome"] } }],
    },
    { content: "Booked Paris." },
  )
  const job = makeJob(where, "flows/ask.yaml")
  const rec = await runWorker(registry, job, new Recorder({ answers: ["Paris"] }), sessionDir, { env: fake.env() })
  expect(rec.asked).toHaveLength(1)
  const [asked] = rec.asked
  expect([asked!.question, asked!.node_id, asked!.options]).toEqual(["Which city?", null, ["Paris", "Rome"]])
  expect(rec.outcome?.output).toBe("Booked Paris.")
  expect(JSON.stringify(fake.requests().at(-1)?.messages)).toContain("Paris")
})

test("an ask node asks through the same stub", async () => {
  const where = base()
  const fake = await fakeLlm()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  fake.script({ content: "hello" })
  const job = makeJob(where, "flows/chat.yaml", { inputs: {} })
  const rec = await runWorker(registry, job, new Recorder({ answers: ["hi there"] }), sessionDir, { env: fake.env() })
  expect(rec.asked).toHaveLength(1)
  const [asked] = rec.asked
  expect([asked!.question, asked!.node_id]).toEqual(["you> ", "ask"])
  expect(rec.outcome?.output).toBe("hello")
  expect(JSON.stringify(fake.requests().at(-1)?.messages)).toContain("hi there")
})

test.each(["chat", "advance"] as const)("every job kind gets the ask user stub [%s]", async (kind) => {
  const groups = { toolbox: [{ name: "shout", description: "", parameters: { type: "object", properties: {} } }] }
  const rpc = await officeEnd(new Recorder())
  const tools = jobTools(makeJob(base(), "flows/echo.yaml", { kind, groups }), rpc)
  expect(Object.keys(tools)).toEqual(["toolbox", "ask"])
  // The groups are spread in under their names, which the return type doesn't list.
  const { toolbox } = tools as typeof tools & { toolbox?: { name: string }[] }
  expect(toolbox?.map((tool) => tool.name)).toEqual(["shout"])
  expect(typeof tools.ask).toBe("function")
})

test("a start frame that cannot be sent leaves nothing behind", async () => {
  const where = base()
  const fake = await fakeLlm()
  const store = openStore()
  const started: ChildProcess[] = []
  const registry = makeRegistry(store, {
    maxFrame: 2000,
    spawn: (dir, env, options) => {
      const out = spawnProcess(dir, env, options)
      started.push(out.child)
      return out
    },
  })
  const sessionDir = path.join(where.root, "sessions", "s1")
  const before = fdCount()
  const job = makeJob(where, undefined, { inputs: { message: "x".repeat(5000) } })
  await expect(registry.spawn(job, sessionDir, new Recorder())).rejects.toBeInstanceOf(FrameTooLarge)
  expect(started).toHaveLength(1)
  const child = started[0]!
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  await waitFor(() => fdCount() === before, { timeout: 5000, what: "the fds closed" })
  fake.script({ content: "second try" })
  const rec = await runWorker(makeRegistry(store), makeJob(where), new Recorder(), sessionDir, { env: fake.env() })
  expect(rec.outcome?.output).toBe("second try")
})

test("close during a failing start returns promptly", async () => {
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store, { maxFrame: 2000 })
  const sessionDir = path.join(where.root, "sessions", "s1")
  const job = makeJob(where, undefined, { inputs: { message: "x".repeat(5000) } })
  const spawning = registry.spawn(job, sessionDir, new Recorder())
  spawning.catch(() => {})
  expect(registry.get("s1")).toBeDefined()
  const began = performance.now()
  await registry.close("s1", 2000)
  expect(performance.now() - began).toBeLessThan(1500)
  await expect(spawning).rejects.toBeInstanceOf(FrameTooLarge)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
})

test("a closed registry refuses new workers", async () => {
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  await registry.closeAll()
  await expect(registry.spawn(makeJob(where), sessionDir, new Recorder())).rejects.toBeInstanceOf(RegistryClosed)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
  expect(fs.existsSync(path.join(sessionDir, "worker.log"))).toBe(false)
})

test("the worker log is never followed through a link", async () => {
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const target = path.join(where.root, "elsewhere.txt")
  fs.writeFileSync(target, "untouched\n")
  fs.symlinkSync(target, path.join(sessionDir, "worker.log"))
  await expect(registry.spawn(makeJob(where), sessionDir, new Recorder())).rejects.toMatchObject({ code: "ELOOP" })
  expect(fs.readFileSync(target, "utf8")).toBe("untouched\n")
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
})

test("a fifo planted as the worker log is refused at once", async () => {
  const where = base()
  const store = openStore()
  const registry = makeRegistry(store)
  const sessionDir = path.join(where.root, "sessions", "s1")
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  execFileSync("/usr/bin/mkfifo", [path.join(sessionDir, "worker.log")], { timeout: 5000 })
  const began = performance.now()
  await expect(registry.spawn(makeJob(where), sessionDir, new Recorder())).rejects.toMatchObject({ code: "ENXIO" })
  expect(performance.now() - began).toBeLessThan(2000)
  expect(registry.get("s1")).toBeUndefined()
  expect(store.listWorkers()).toEqual([])
})

test("a key goes to the base url beside it and stays out of the run log", async () => {
  const where = base()
  const fake = await fakeLlm()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  const key = "sk-test-base-url-0123456789"
  fake.script({ content: "hello" })
  const job = makeJob(where, undefined, {
    llm_config: { provider: "vllm", model: "stub", base_url: `${fake.baseUrl}/v1`, api_key: key },
  })
  const rec = await runWorker(registry, job, new Recorder(), sessionDir, { env: {} })
  expect(rec.outcome?.output).toBe("hello")
  expect(fake.authorizations()).toEqual([`Bearer ${key}`])
  const log = fs.readFileSync(job.log, "utf8")
  expect(log).not.toContain(key)
  expect(log).toContain(`${fake.baseUrl}/v1`)
})

test("a grandchild of a spawned worker does not hold the channel open", async () => {
  const where = base()
  writeFiles(where.pin, { "flows/probe.yaml": PROBE_FLOW, "flows/probe.ts": PROBE_CODE })
  const fake = await fakeLlm()
  const registry = makeRegistry(openStore())
  const sessionDir = path.join(where.root, "sessions", "s1")
  // Notes the grandchild with its start time as soon as its pid arrives, so the test can kill it whatever happens.
  const grand: { pid: number; started: number | null }[] = []
  class Probed extends Recorder {
    override result(worker: unknown, frame: Frame): void {
      super.result(worker, frame)
      // An int crosses the channel as a bigint.
      const pid = (frame.output as { pid?: unknown } | null)?.pid
      if (typeof pid === "bigint") grand.push({ pid: Number(pid), started: startTime(Number(pid)) })
    }
  }
  onTestFinished(() => {
    for (const { pid, started } of grand) {
      // The probe can exit between the check and the kill.
      try {
        if (started !== null && sameProcess(pid, started)) process.kill(pid, "SIGKILL")
      } catch {}
    }
  })
  const job = makeJob(where, "flows/probe.yaml", { inputs: { dir: sessionDir } })
  const rec = await runWorker(registry, job, new Probed(), sessionDir, { env: fake.env() })
  // The office saw the end of the stream while the grandchild lived; the group was killed only after.
  expect(rec.returncode).toBe(0)
  const { pid, channel } = rec.outcome?.output as { pid: bigint; channel: string }
  expect(grand.map((entry) => entry.pid)).toEqual([Number(pid)])
  expect(fs.readFileSync(path.join(sessionDir, "fds-control"), "utf8").split(" ")).toContain(channel)
  const listed = fs.readFileSync(path.join(sessionDir, "fds"), "utf8")
  expect(listed.endsWith("end")).toBe(true)
  expect(listed.split(" ")).not.toContain(channel)
  expect(grand[0]!.started).not.toBeNull()
  await waitFor(() => isGone(Number(pid), grand[0]!.started), { timeout: 10_000, what: "the grandchild to go" })
})
