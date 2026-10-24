/** The worker channel: length-prefixed JSON frames over a socket, in order, size-capped, closed cleanly. */
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { ChannelClosed, FrameTooLarge, socketChannel, type Channel } from "../../src/worker/channel.ts"
import { shortDir } from "../helpers.ts"

const TIMEOUT = 20_000

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

/** `promise`, or a rejection with `still blocked` once `ms` pass. */
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
