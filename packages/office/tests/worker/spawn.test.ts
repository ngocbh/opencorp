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
import { type Channel, ChannelClosed, socketChannel } from "../../src/worker/channel.ts"
import { encode } from "../../src/worker/codec.ts"
import type { Job } from "../../src/worker/job.ts"
import { EXIT_FAILED, EXIT_ORPHANED } from "../../src/worker/main.ts"
import type { OfficeTool, WorkerHandlers } from "../../src/worker/rpc.ts"
import {
  INHERITED_ENV,
  type SpawnLog,
  spawnProcess,
  Worker,
  WorkerExists,
  workerEnv,
} from "../../src/worker/spawn.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { cwdOf, envEntries, envNames, isGone, ps, startGroup, tempDir, waitFor } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"
import { base, channelPair, makeJob, makeRegistry, Recorder, runWorker } from "./helpers.ts"

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

test("a steer left frame without its fields is a bad frame", async () => {
  const { office, worker: far } = await channelPair()
  const rec = new Recorder()
  const { lines, log } = recordingLog()
  const worker = workerOver(exitedChild(), office, rec, makeJob(base()), { log })
  await worker.start()
  expect((await far.recv()).type).toBe("start")
  await far.send({ type: "steer_left", inbox: 3 })
  await expect(far.recv()).rejects.toBeInstanceOf(ChannelClosed)
  expect(await worker.wait(10_000)).toBe(0)
  expect(rec.left).toEqual([])
  expect(lines).toEqual([["WARNING", BAD_FRAME_LINE]])
})

test("a worker that keeps running after its channel closes is killed after the grace", async () => {
  // Never reads or closes fd 3: on Linux the worker also holds fd 4, so closing fd 3 wouldn't end the channel.
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

test("a worker starts only once", async () => {
  const { office, worker: far } = await channelPair()
  const worker = workerOver(exitedChild(), office, new Recorder())
  await worker.start()
  await expect(worker.start()).rejects.toThrow("the worker was already started")
  expect((await far.recv()).type).toBe("start")
  // A frame the office can't read makes it close the channel: the stream ends with no second start frame.
  await far.send({ type: "steer_left", inbox: 3 })
  await expect(far.recv()).rejects.toBeInstanceOf(ChannelClosed)
  expect(await worker.wait(10_000)).toBe(0)
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
