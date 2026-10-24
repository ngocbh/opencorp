/** Length-prefixed JSON frames over a socket, for traffic between the office and a worker. */
import type net from "node:net"
import type { Readable } from "node:stream"
import { decode, encode } from "./codec.ts"

/** The largest frame body, in bytes, either end sends or accepts. */
export const MAX_FRAME = 64 << 20

const HEADER = 4
// Fixed messages: a frame can hold secrets, so an error never quotes one.
const NOT_JSON = "a frame isn't valid JSON"
const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** The other end closed the channel, or the transport broke. */
export class ChannelClosed extends Error {
  constructor(message = "the channel closed") {
    super(message)
    this.name = "ChannelClosed"
  }
}

/** A frame is bigger than the channel's frame limit. */
export class FrameTooLarge extends RangeError {
  constructor(size: number, max: number) {
    super(`a ${size}-byte frame is over the ${max}-byte limit`)
    this.name = "FrameTooLarge"
  }
}

/** One frame: a JSON object. */
export type Frame = Record<string, unknown>

/** The byte stream under a channel. `write` delivers whole buffers in call order and resolves once the bytes are
 *  taken; `readable`'s `end`, `error` and `close` events tell the channel the stream is over. */
export type Transport = {
  readable: Readable
  write(data: Buffer): Promise<void>
  endWrite(): void
  destroy(): void
}

/** JSON-object frames, each sent as a 4-byte big-endian length and UTF-8 JSON. */
export class Channel {
  private readonly transport: Transport
  private readonly maxFrame: number
  // Pending sends' rejecters, so close() or a broken transport settles them without waiting on the transport.
  private readonly pending = new Set<(error: ChannelClosed) => void>()
  private reading: Promise<unknown> = Promise.resolve()
  private wake = () => {}
  private closed = false
  private sendClosed = false
  private readClosed = false
  // Set once the transport's stream ended or broke; reads still drain what it buffered before.
  private over: ChannelClosed | undefined
  // Set once the transport broke or closed, after which nothing can be sent.
  private broken: ChannelClosed | undefined
  private chunks: Buffer[] = []
  private buffered = 0
  private size: number | undefined

  constructor(transport: Transport, { maxFrame = MAX_FRAME }: { maxFrame?: number } = {}) {
    this.transport = transport
    this.maxFrame = maxFrame
    // Attached at once: an `error` event with no listener would crash the process.
    transport.readable.on("readable", () => this.wake())
    transport.readable.on("end", () => {
      this.over ??= new ChannelClosed()
      this.wake()
    })
    transport.readable.on("error", (error) => this.stop(closedBy(error)))
    transport.readable.on("close", () => this.stop(new ChannelClosed()))
  }

  /** Sends one frame. Rejects with `FrameTooLarge`, or with `ChannelClosed` after `closeSend()` or `close()`, or
   *  once the transport broke. The bytes are handed to the transport before the first `await`, so frames go out in
   *  call order; it resolves once the transport has taken them. */
  async send(frame: Frame): Promise<void> {
    const text = encode(frame)
    const size = Buffer.byteLength(text)
    if (size > this.maxFrame) throw new FrameTooLarge(size, this.maxFrame)
    if (this.sendClosed || this.closed) throw new ChannelClosed("this end stopped sending")
    if (this.broken) throw this.broken
    const data = Buffer.allocUnsafe(HEADER + size)
    data.writeUInt32BE(size, 0)
    data.write(text, HEADER)
    return new Promise<void>((resolve, reject) => {
      this.pending.add(reject)
      this.transport
        .write(data)
        .then(resolve, (error: unknown) => reject(closedBy(error)))
        .finally(() => this.pending.delete(reject))
    })
  }

  /** The next frame. Rejects with `ChannelClosed` at end of stream, on a cut frame, a broken transport or after
   *  `close()`, and on every later call; with `FrameTooLarge` for a declared size over the limit (later calls get
   *  `ChannelClosed`); with a `SyntaxError` for a body that isn't UTF-8 JSON and a `TypeError` for one that isn't a
   *  JSON object or holds a forged tag, after which the next frame still reads. Calls are served one at a time. */
  recv(): Promise<Frame> {
    const next = this.reading.then(() => this.read())
    this.reading = next.catch(() => {})
    return next
  }

  /** Stops sending, so the peer reads end of stream; later sends reject with `ChannelClosed`, and `recv()` keeps
   *  working. A send called before it still goes out. */
  closeSend(): void {
    this.sendClosed = true
    this.transport.endWrite()
  }

  /** Closes both directions, dropping buffered bytes: pending and later `recv()` and `send()` calls reject with
   *  `ChannelClosed`. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.chunks = []
    this.buffered = 0
    this.settle(new ChannelClosed())
    this.transport.destroy()
  }

  private stop(error: ChannelClosed): void {
    this.over ??= error
    this.broken ??= error
    this.settle(error)
  }

  private settle(error: ChannelClosed): void {
    for (const reject of this.pending) reject(error)
    this.pending.clear()
    this.wake()
  }

  private async read(): Promise<Frame> {
    for (;;) {
      if (this.closed || this.readClosed) throw new ChannelClosed()
      // Bytes the transport already took are read even after its stream ended, broke or was destroyed: a worker
      // that writes its last frames and exits while nobody reads makes the socket report a reset and close at
      // once, yet every byte is still buffered.
      const frame = this.take()
      if (frame) return frame
      if (this.over) {
        this.readClosed = true
        throw this.over
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  // A whole buffered frame, pulling bytes from the transport only while none is whole, so a fast peer meets
  // backpressure instead of filling memory.
  private take(): Frame | undefined {
    for (;;) {
      const frame = this.parse()
      if (frame) return frame
      const chunk: Buffer | null = this.transport.readable.read()
      if (chunk === null) return undefined
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
  }

  private parse(): Frame | undefined {
    if (this.size === undefined) {
      if (this.buffered < HEADER) return undefined
      const size = this.split(HEADER).readUInt32BE(0)
      if (size > this.maxFrame) {
        // The body stays unread, so the stream can't be resynced.
        this.readClosed = true
        throw new FrameTooLarge(size, this.maxFrame)
      }
      this.size = size
    }
    if (this.buffered < this.size) return undefined
    const body = this.split(this.size)
    this.size = undefined
    return toFrame(body)
  }

  // The first `n` buffered bytes, joining only the chunks that hold them, once per header or body.
  private split(n: number): Buffer {
    let count = 0
    let have = 0
    while (have < n) have += this.chunks[count++]!.length
    const joined = count === 1 ? this.chunks[0]! : Buffer.concat(this.chunks.slice(0, count), have)
    const rest = joined.subarray(n)
    this.chunks.splice(0, count, ...(rest.length > 0 ? [rest] : []))
    this.buffered -= n
    return joined.subarray(0, n)
  }
}

/** A channel over a connected socket. Its `error` and `close` listeners are attached at once; a reset is a normal
 *  end of stream. It leaves `allowHalfOpen` as it is: the office end never sends after the worker's end of stream. */
export function socketChannel(socket: net.Socket, options?: { maxFrame?: number }): Channel {
  return new Channel(
    {
      readable: socket,
      write: (data) =>
        new Promise((resolve, reject) => {
          socket.write(data, (error) => (error ? reject(error) : resolve()))
        }),
      endWrite: () => socket.end(),
      destroy: () => socket.destroy(),
    },
    options,
  )
}

function toFrame(body: Buffer): Frame {
  // Two steps, so the codec's TypeError for a forged tag passes through unchanged.
  let text: string
  try {
    text = UTF8.decode(body)
  } catch {
    throw new SyntaxError(NOT_JSON)
  }
  const value = decode(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    throw new TypeError(`a frame must be a JSON object, got ${kind}`)
  }
  return value as Frame
}

// The ChannelClosed for a transport error: its text is at most the error's code, never anything it quotes.
function closedBy(error: unknown): ChannelClosed {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== "string" || code === "ECONNRESET" || !/^[A-Z][A-Z0-9_]*$/.test(code)) return new ChannelClosed()
  return new ChannelClosed(`the channel broke (${code})`)
}
