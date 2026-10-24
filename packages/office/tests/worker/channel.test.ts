/** The worker channel: length-prefixed JSON frames over a socket and the worker's fd 3, in order, size-capped,
 *  closed cleanly. */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { inspect } from "node:util"
import { expect, onTestFinished, test } from "bun:test"
import { ChannelClosed, FrameTooLarge, socketChannel, type Channel, type Frame } from "../../src/worker/channel.ts"
import { shortDir, tempDir, waitFor } from "../helpers.ts"

const TIMEOUT = 20_000
const CHILD_TIMEOUT = 60_000
const CHANNEL_URL = new URL("../../src/worker/channel.ts", import.meta.url).href
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

type Pair = { left: Channel; right: Channel; leftSocket: net.Socket; rightSocket: net.Socket }

/** Two connected sockets (both half-open capable) through a unix-socket server, with a channel on each;
 *  both channels and the server close when the test finishes. */
async function pair(options?: { maxFrame?: number }): Promise<Pair> {
  const where = path.join(shortDir(), "s")
  const server = net.createServer({ allowHalfOpen: true })
  await new Promise<void>((resolve) => server.listen(where, resolve))
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve))
  const leftSocket = net.createConnection({ path: where, allowHalfOpen: true })
  await new Promise<void>((resolve, reject) => leftSocket.once("connect", resolve).once("error", reject))
  const rightSocket = await accepted
  const left = socketChannel(leftSocket, options)
  const right = socketChannel(rightSocket, options)
  onTestFinished(() => {
    left.close()
    right.close()
    server.close()
  })
  return { left, right, leftSocket, rightSocket }
}

/** Writes `bytes` on `socket` and waits for its write callback. */
function rawWrite(socket: net.Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => socket.write(bytes, (error) => (error ? reject(error) : resolve())))
}

/** A 4-byte big-endian length, then `body`. */
function framed(body: Buffer, size = body.length): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(size)
  return Buffer.concat([header, body])
}

/** `promise`, or a rejection with `still blocked` once `ms` pass, so a hang fails clearly rather than at the test's
 *  timeout. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("still blocked")), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Destroys `socket` with an error holding `code` and a secret in its message, as a broken transport reports. */
function breakWith(socket: net.Socket, code: string): void {
  socket.destroy(Object.assign(new Error("sk-secret"), { code }))
}

test("frames round trip in order", async () => {
  const { left, right } = await pair()
  const frames = [{ type: "start", n: 1 }, { text: "héllo ✓", nested: { a: [1, 2.5, null, true] } }, {}]
  for (const frame of frames) await left.send(frame)
  const got = []
  for (const _ of frames) got.push(await right.recv())
  expect(got).toEqual(frames)
}, TIMEOUT)

test("an oversized frame is refused on both ends", async () => {
  const { left, right, leftSocket } = await pair({ maxFrame: 64 })
  await expect(left.send({ text: "x".repeat(100) })).rejects.toBeInstanceOf(FrameTooLarge)
  await rawWrite(leftSocket, framed(Buffer.from("{}"), 65))
  const error = await right.recv().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(FrameTooLarge)
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).name).toBe("FrameTooLarge")
  expect((error as Error).message).toBe("a 65-byte frame is over the 64-byte limit")
  // The body was never read, so the stream can't be resynced.
  await expect(right.recv()).rejects.toBeInstanceOf(ChannelClosed)
}, TIMEOUT)

test("a frame must be an object", async () => {
  const { left, right, leftSocket } = await pair()
  await rawWrite(leftSocket, framed(Buffer.from("[]")))
  const error = await right.recv().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(TypeError)
  expect((error as Error).message).toMatch(/JSON object, got array$/)
  await rawWrite(leftSocket, framed(Buffer.from("null")))
  await expect(right.recv()).rejects.toThrow("a frame must be a JSON object, got null")
  await left.send({ ok: 1 })
  expect(await right.recv()).toEqual({ ok: 1 })
}, TIMEOUT)

test("close send ends one direction only", async () => {
  const { left, right } = await pair()
  await left.send({ n: 1 })
  left.closeSend()
  await expect(left.send({ n: 2 })).rejects.toBeInstanceOf(ChannelClosed)
  expect(await right.recv()).toEqual({ n: 1 })
  await expect(right.recv()).rejects.toBeInstanceOf(ChannelClosed)
  await right.send({ n: 3 })
  expect(await left.recv()).toEqual({ n: 3 })
}, TIMEOUT)

test("peer close and a cut frame raise channel closed", async () => {
  const { left, right, leftSocket } = await pair()
  await rawWrite(leftSocket, framed(Buffer.from('{"a"'), 10))
  left.close()
  await expect(right.recv()).rejects.toBeInstanceOf(ChannelClosed)
  await expect(right.recv()).rejects.toBeInstanceOf(ChannelClosed)
}, TIMEOUT)

test("close wakes a blocked reader", async () => {
  const { right } = await pair()
  const reading = right.recv()
  // Far more than a socket buffer holds while the peer doesn't read, so this send is still pending.
  const sending = right.send({ pad: "p".repeat(8 << 20) })
  // Handlers go on before close() rejects them: bun:test's expect().rejects runs the event loop until its promise
  // settles, so it can't be set up ahead of close().
  const settled = Promise.all(
    [reading, sending].map((promise) => within<unknown>(promise, 5_000).catch((error: unknown) => error)),
  )
  right.close()
  for (const error of await settled) expect(error).toBeInstanceOf(ChannelClosed)
  await expect(right.recv()).rejects.toBeInstanceOf(ChannelClosed)
  right.close()
}, TIMEOUT)

test("send after the peer is gone raises channel closed", async () => {
  const { left, rightSocket } = await pair()
  // As when the worker process dies.
  const closed = new Promise((resolve) => rightSocket.once("close", resolve))
  rightSocket.destroy()
  await closed
  await expect(left.send({ x: "y" })).rejects.toBeInstanceOf(ChannelClosed)
}, TIMEOUT)

test("concurrent sends do not interleave", async () => {
  const { left, right } = await pair()
  const producers = [0, 1, 2, 3].map((t) =>
    Promise.all(Array.from({ length: 50 }, (_, i) => left.send({ t, i, pad: "p".repeat(5000) }))),
  )
  const got: Record<string, unknown>[] = []
  for (let k = 0; k < 200; k++) got.push(await right.recv())
  await Promise.all(producers)
  const order = Array.from({ length: 50 }, (_, i) => i)
  for (const t of [0, 1, 2, 3]) expect(got.filter((frame) => frame.t === t).map((frame) => frame.i)).toEqual(order)
}, TIMEOUT)

test("a frame that is not json is refused with a fixed message", async () => {
  const { left, right, leftSocket } = await pair()
  for (const body of [Buffer.from('{"k": sk-secret'), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])]) {
    await rawWrite(leftSocket, framed(body))
    const error = await right.recv().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SyntaxError)
    expect((error as Error).message).toBe("a frame isn't valid JSON")
    expect("cause" in (error as Error)).toBe(false)
  }
  await left.send({ ok: 2 })
  expect(await right.recv()).toEqual({ ok: 2 })
}, TIMEOUT)

test("a channel shows no frame bytes when inspected", async () => {
  const { right, leftSocket, rightSocket } = await pair()
  const body = Buffer.from('{"llm_config":{"api_key":"sk-secret"}}')
  const head = framed(body).subarray(0, -2)
  const reading = right.recv()
  await rawWrite(leftSocket, head)
  // Every byte so far is off the socket and in the channel's own buffer.
  await waitFor(() => rightSocket.bytesRead >= head.length && rightSocket.readableLength === 0, {
    timeout: 10_000,
    what: "the cut frame buffered",
  })
  for (const shown of [inspect(right), inspect(right, { depth: Infinity, showHidden: true })]) {
    expect(shown).toBe("Channel {}")
  }
  await rawWrite(leftSocket, framed(body).subarray(-2))
  expect(await reading).toEqual({ llm_config: { api_key: "sk-secret" } })
}, TIMEOUT)

test("frames buffered before a reset still arrive", async () => {
  const { right, leftSocket, rightSocket } = await pair()
  const first = framed(Buffer.from('{"n":1}'))
  const second = framed(Buffer.from('{"n":2}'))
  await rawWrite(leftSocket, first)
  await rawWrite(leftSocket, second)
  const both = first.length + second.length
  await waitFor(() => rightSocket.readableLength >= both, { timeout: 10_000, what: "both frames buffered" })
  const closed = new Promise((resolve) => rightSocket.once("close", resolve))
  breakWith(rightSocket, "ECONNRESET")
  await closed
  expect(await right.recv()).toEqual({ n: 1 })
  expect(await right.recv()).toEqual({ n: 2 })
  const error = await right.recv().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ChannelClosed)
  expect((error as Error).message).toBe("channel closed")
  expect((error as Error).message).not.toContain("sk-")
}, TIMEOUT)

test("a broken transport closes the channel with a fixed message", async () => {
  const cases: [string, string][] = [
    ["EPIPE", "the channel broke (EPIPE)"],
    ["ECONNRESET", "channel closed"],
    ["x y", "channel closed"],
  ]
  for (const [code, message] of cases) {
    const { right, rightSocket } = await pair()
    breakWith(rightSocket, code)
    const received = await right.recv().catch((error: unknown) => error)
    const sent = await right.send({}).catch((error: unknown) => error)
    for (const error of [received, sent]) {
      expect(error).toBeInstanceOf(ChannelClosed)
      expect((error as Error).message).toBe(message)
      expect((error as Error).message).not.toContain("sk-")
    }
  }
}, TIMEOUT)

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error }

/** Kills the process group `pid` leads, if it still exists. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    // macOS answers EPERM for a group left with only an unreaped zombie.
    const code = (error as { code?: unknown }).code
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

/** Runs `body` as a worker script in a fresh directory, after an import of `ChannelClosed` and `fdChannel`, with
 *  the office end of its fd 3 as `office`. The child leads its own process group, killed when the test finishes. */
function worker(body: string): { office: Channel; exited: Promise<Exit>; dir: string } {
  const dir = tempDir()
  const script = path.join(dir, "worker.ts")
  fs.writeFileSync(script, `import { ChannelClosed, fdChannel } from "${CHANNEL_URL}"\n${body}\n`)
  const child = spawn(process.execPath, [...BUN_FLAGS, script], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdio: ["ignore", "inherit", "inherit", "pipe"],
    detached: true,
  })
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    // A spawn failure emits `error` and no `exit`; settling here fails the test instead of the runner.
    child.once("error", (error) => resolve({ code: null, signal: null, error }))
  })
  const office = socketChannel(child.stdio[3] as net.Socket)
  onTestFinished(() => {
    office.close()
    killGroup(child.pid)
  })
  return { office, exited, dir }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

test(
  "the worker end carries 20 MiB frames over fd 3 under backpressure",
  async () => {
    const { office, exited } = worker(`
      import { createHash } from "node:crypto"
      const channel = fdChannel(3)
      const got = await channel.recv()
      const text = got.text
      const echo = { length: text.length, sha256: createHash("sha256").update(text).digest("hex"), big: got.big }
      await Promise.all([
        channel.send({ text: "w".repeat(20 * 2 ** 20) }),
        channel.send(echo),
        channel.send({ n: 1 }),
        channel.send({ n: 2 }),
        channel.send({ n: 3 }),
      ])
      process.exit(0)
    `)
    const text = "o".repeat(20 * 2 ** 20)
    const big = 2n ** 80n + 7n
    await office.send({ text, big })
    // A best-effort delay so the child's writes meet a full socket, not a synchronisation point: its 20 MiB frame is
    // bigger than the socket buffer anyway.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // Compared by length and hash, so a failure doesn't print 20 MiB.
    const first = (await office.recv()).text as string
    const sent = "w".repeat(20 * 2 ** 20)
    expect({ length: first.length, sha256: sha256(first) }).toEqual({ length: sent.length, sha256: sha256(sent) })
    expect(await office.recv()).toEqual({ length: text.length, sha256: sha256(text), big })
    for (const n of [1, 2, 3]) expect(await office.recv()).toEqual({ n })
    expect(await exited).toEqual({ code: 0, signal: null })
  },
  CHILD_TIMEOUT,
)

test(
  "frames sent just before the worker exits still arrive",
  async () => {
    const { office, exited } = worker(`
      const channel = fdChannel(3)
      await channel.send({ n: 1 })
      await channel.send({ n: 2 })
      process.exit(0)
    `)
    expect(await exited).toEqual({ code: 0, signal: null })
    expect(await office.recv()).toEqual({ n: 1 })
    expect(await office.recv()).toEqual({ n: 2 })
    expect(await office.recv().catch((error: unknown) => error)).toBeInstanceOf(ChannelClosed)
  },
  CHILD_TIMEOUT,
)

test(
  "the worker end still sends after the office closes its sending side",
  async () => {
    const { office, exited } = worker(`
      const channel = fdChannel(3)
      const first = await channel.recv()
      const ended = await channel.recv().then(() => undefined, (error) => error)
      if (first.n !== 1 || !(ended instanceof ChannelClosed)) {
        console.error("worker saw", typeof first.n === "number" ? first.n : typeof first.n, String(ended?.name))
        process.exit(1)
      }
      await channel.send({ late: true })
      process.exit(0)
    `)
    await office.send({ n: 1 })
    office.closeSend()
    expect(await office.recv()).toEqual({ late: true })
    expect(await office.recv().catch((error: unknown) => error)).toBeInstanceOf(ChannelClosed)
    expect(await exited).toEqual({ code: 0, signal: null })
  },
  CHILD_TIMEOUT,
)

test(
  "a worker close stops its queued sends",
  async () => {
    const { office, exited, dir } = worker(`
      import fs from "node:fs"
      const channel = fdChannel(3)
      const pad = "q".repeat(4 * 2 ** 20)
      // The office isn't reading yet, so the first frame blocks part way and the others wait their turn.
      const sends = [1, 2, 3].map((n) => channel.send({ n, pad }).then(() => undefined, (error) => error))
      await new Promise((resolve) => setTimeout(resolve, 200))
      channel.close()
      const ok = (await Promise.all(sends)).every((error) => error instanceof ChannelClosed)
      fs.writeFileSync("closed", ok ? "ok" : "bad")
      // Time for the office to drain the frame being written, and for any queued frame to follow if one wrongly did.
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      process.exit(ok ? 0 : 1)
    `)
    await waitFor(() => fs.existsSync(path.join(dir, "closed")), { timeout: 30_000, what: "the worker's close" })
    const got: Frame[] = []
    let error: unknown
    while (error === undefined) {
      await office.recv().then(
        (frame) => got.push(frame),
        (reason: unknown) => {
          error = reason
        },
      )
    }
    expect(error).toBeInstanceOf(ChannelClosed)
    // Only the frame already being written at close() may arrive, and only whole; checked by length, so a failure
    // doesn't print 4 MiB.
    expect(got.length).toBeLessThanOrEqual(1)
    for (const frame of got) expect([frame.n, (frame.pad as string).length]).toEqual([1, 4 * 2 ** 20])
    expect(await exited).toEqual({ code: 0, signal: null })
  },
  CHILD_TIMEOUT,
)

test(
  "a worker send after the office closed the channel raises channel closed",
  async () => {
    const { office, exited } = worker(`
      const channel = fdChannel(3)
      await channel.send({ ready: true })
      const received = await channel.recv().then(() => undefined, (error) => error)
      if (!(received instanceof ChannelClosed)) {
        console.error("worker saw recv give", String(received?.name))
        process.exit(1)
      }
      const sent = await channel.send({ after: true }).then(() => undefined, (error) => error)
      if (!(sent instanceof ChannelClosed)) {
        console.error("worker saw send give", String(sent?.name))
        process.exit(1)
      }
      process.exit(7)
    `)
    expect(await office.recv()).toEqual({ ready: true })
    office.close()
    expect(await exited).toEqual({ code: 7, signal: null })
  },
  CHILD_TIMEOUT,
)

test(
  "a grandchild of the worker does not hold the channel open",
  async () => {
    // The grandchild lists which of fds 3-9 it holds, in the worker's directory, then sleeps.
    const probe =
      'for f in 3 4 5 6 7 8 9; do if { true >&$f; } 2>/dev/null; then printf "fd$f "; fi; done > fds; ' +
      "echo end >> fds; exec sleep 60"
    const { office, exited, dir } = worker(`
      import { spawn } from "node:child_process"
      const channel = fdChannel(3)
      const grandchild = spawn("/bin/sh", ["-c", ${JSON.stringify(probe)}], { stdio: "ignore" })
      await channel.send({ pid: grandchild.pid })
      process.exit(0)
    `)
    const { pid } = (await office.recv()) as { pid: number }
    expect(await within(office.recv().catch((error: unknown) => error), 15_000)).toBeInstanceOf(ChannelClosed)
    expect(await exited).toEqual({ code: 0, signal: null })
    // Still in the worker's process group, which the cleanup kills.
    expect(() => process.kill(pid, 0)).not.toThrow()
    const fds = path.join(dir, "fds")
    const listed = await waitFor(
      () => {
        const text = fs.existsSync(fds) ? fs.readFileSync(fds, "utf8") : ""
        return text.includes("end") && text
      },
      { timeout: 15_000, what: "the grandchild's fd list" },
    )
    expect(listed).not.toContain("fd3")
  },
  CHILD_TIMEOUT,
)
