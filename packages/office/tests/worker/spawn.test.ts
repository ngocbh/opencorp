/** Run worker processes: the environment they start with, and the office's reader of their frames. */
import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import type net from "node:net"
import path from "node:path"
import { inspect } from "node:util"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { INHERITED_ENV as LAUNCH_ENV } from "../../src/install/launch.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { type Channel, ChannelClosed, socketChannel } from "../../src/worker/channel.ts"
import { encode } from "../../src/worker/codec.ts"
import type { Job } from "../../src/worker/job.ts"
import type { OfficeTool, WorkerHandlers } from "../../src/worker/rpc.ts"
import { INHERITED_ENV, type SpawnLog, Worker, workerEnv } from "../../src/worker/spawn.ts"
import { isGone, startGroup, tempDir, waitFor } from "../helpers.ts"
import { base, channelPair, makeJob, Recorder } from "./helpers.ts"

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
