/** Length-prefixed JSON frames over a socket, for traffic between the office and a worker. */
import fs from "node:fs"
import type net from "node:net"
import type { Readable } from "node:stream"
import { decode, encode, NOT_JSON } from "./codec.ts"

/** The largest frame body, in bytes, either end sends or accepts. */
export const MAX_FRAME = 64 << 20

const HEADER = 4
const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** The other end closed the channel, or the transport broke. */
export class ChannelClosed extends Error {
  constructor(message = "channel closed") {
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
type Transport = {
  readable: Readable
  write(data: Buffer): Promise<void>
  endWrite(): void
  destroy(): void
}

/** JSON-object frames, each sent as a 4-byte big-endian length and UTF-8 JSON. */
export class Channel {
  // `#` fields, so inspecting or logging a channel never shows the transport or buffered bytes, which can be part of
  // the start frame and its provider key.
  readonly #transport: Transport
  readonly #maxFrame: number
  // Pending sends' rejecters, so close() or a broken transport settles them without waiting on the transport.
  readonly #pending = new Set<(error: ChannelClosed) => void>()
  #reading: Promise<unknown> = Promise.resolve()
  #wake = () => {}
  #closed = false
  #sendClosed = false
  #readClosed = false
  // Set once the transport's stream ended or broke; reads still drain what it buffered before.
  #ended: ChannelClosed | undefined
  // Set once the transport broke, closed or failed a write, after which nothing can be sent.
  #broken: ChannelClosed | undefined
  #chunks: Buffer[] = []
  #buffered = 0
  #size: number | undefined

  constructor(transport: Transport, { maxFrame = MAX_FRAME }: { maxFrame?: number } = {}) {
    this.#transport = transport
    this.#maxFrame = maxFrame
    // Attached at once: an `error` event with no listener would crash the process.
    transport.readable.on("readable", () => this.#wake())
    transport.readable.on("end", () => {
      this.#ended ??= new ChannelClosed()
      this.#wake()
    })
    transport.readable.on("error", (error) => this.stop(closedBy(error)))
    transport.readable.on("close", () => this.stop(new ChannelClosed()))
  }

  /** The largest frame body, in bytes, this channel sends or accepts. */
  get maxFrame(): number {
    return this.#maxFrame
  }

  /** Sends one frame. Rejects with `FrameTooLarge`, or with `ChannelClosed` after `closeSend()` or `close()`, or
   *  once the transport broke. The bytes are handed to the transport before the first `await`, so frames go out in
   *  call order; it resolves once the transport has taken them. */
  async send(frame: Frame): Promise<void> {
    const text = encode(frame)
    const size = Buffer.byteLength(text)
    if (size > this.#maxFrame) throw new FrameTooLarge(size, this.#maxFrame)
    if (this.#sendClosed || this.#closed) throw new ChannelClosed("this end stopped sending")
    if (this.#broken) throw this.#broken
    const data = Buffer.allocUnsafe(HEADER + size)
    data.writeUInt32BE(size, 0)
    data.write(text, HEADER)
    return new Promise<void>((resolve, reject) => {
      this.#pending.add(reject)
      this.#transport
        .write(data)
        .then(resolve, (error: unknown) => {
          // Not every transport reports a failed write on its readable (a write to a file descriptor doesn't), and
          // reads still drain what arrived, so only sending stops.
          const closed = closedBy(error)
          this.#broken ??= closed
          reject(closed)
        })
        .finally(() => this.#pending.delete(reject))
    })
  }

  /** The next frame. Rejects with `ChannelClosed` at end of stream, on a cut frame, a broken transport or after
   *  `close()`, and on every later call; with `FrameTooLarge` for a declared size over the limit (later calls get
   *  `ChannelClosed`); with a `SyntaxError` for a body that isn't UTF-8 JSON and a `TypeError` for one that isn't a
   *  JSON object (an array, `null`, or a number, string, boolean or tagged bigint) or holds a forged tag, after
   *  which the next frame still reads. Calls are served one at a time. */
  recv(): Promise<Frame> {
    const next = this.#reading.then(() => this.read())
    this.#reading = next.catch(() => {})
    return next
  }

  /** Stops sending, so the peer reads end of stream; later sends reject with `ChannelClosed`, and `recv()` keeps
   *  working. A send called before it still goes out. */
  closeSend(): void {
    this.#sendClosed = true
    this.#transport.endWrite()
  }

  /** Closes both directions, dropping buffered bytes: pending and later `recv()` and `send()` calls reject with
   *  `ChannelClosed`. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#chunks = []
    this.#buffered = 0
    this.settle(new ChannelClosed())
    this.#transport.destroy()
  }

  private stop(error: ChannelClosed): void {
    this.#ended ??= error
    this.#broken ??= error
    this.settle(error)
  }

  private settle(error: ChannelClosed): void {
    for (const reject of this.#pending) reject(error)
    this.#pending.clear()
    this.#wake()
  }

  private async read(): Promise<Frame> {
    for (;;) {
      if (this.#closed || this.#readClosed) throw new ChannelClosed()
      // Bytes the transport already took are read even after its stream ended, broke or was destroyed: a worker
      // that writes its last frames and exits while nobody reads makes the socket report a reset and close at
      // once, yet every byte is still buffered.
      const frame = this.take()
      if (frame) return frame
      if (this.#ended) {
        this.#readClosed = true
        throw this.#ended
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }

  // A whole buffered frame, pulling bytes from the transport only while none is whole, so a fast peer meets
  // backpressure instead of filling memory.
  private take(): Frame | undefined {
    for (;;) {
      const frame = this.parse()
      if (frame) return frame
      const chunk: Buffer | null = this.#transport.readable.read()
      if (chunk === null) return undefined
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
  }

  private parse(): Frame | undefined {
    if (this.#size === undefined) {
      if (this.#buffered < HEADER) return undefined
      const size = this.split(HEADER).readUInt32BE(0)
      if (size > this.#maxFrame) {
        // The body stays unread, so the stream can't be resynced.
        this.#readClosed = true
        throw new FrameTooLarge(size, this.#maxFrame)
      }
      this.#size = size
    }
    if (this.#buffered < this.#size) return undefined
    const body = this.split(this.#size)
    this.#size = undefined
    return toFrame(body)
  }

  // The first `n` buffered bytes, joining only the chunks that hold them, once per header or body.
  private split(n: number): Buffer {
    let count = 0
    let have = 0
    while (have < n) have += this.#chunks[count++]!.length
    const joined = count === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks.slice(0, count), have)
    const rest = joined.subarray(n)
    this.#chunks.splice(0, count)
    if (rest.length > 0) this.#chunks.unshift(rest)
    this.#buffered -= n
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

/** The worker's channel over the socket the office passed as `fd`. `closeSend()` only stops this end sending; nothing
 *  here closes the fd. After `close()` or a failed write no queued frame is written, though a frame already being
 *  written may still arrive. */
export function fdChannel(fd = 3, options?: { maxFrame?: number }): Channel {
  // The fd is left to process exit: the worker ends with `process.exit`, since a read blocked on the fd keeps the event
  // loop alive. Closing it sooner could let a read or write still queued in the thread pool hit an unrelated file
  // that reused its number.
  // A file stream, not a socket: Bun's runtime can't wrap fd 3 in a `net.Socket`. `autoClose: false` keeps the fd for
  // writes after end of stream, and also turns off `autoDestroy`, so end of stream emits no `close`, which the
  // channel would take for a broken transport. The stream's `fs.close` is a no-op, since `destroy()` closes the fd
  // even with `autoClose: false`.
  const readable = fs.createReadStream("", { fd, autoClose: false, fs: { ...fs, close: noClose } })
  // One write at a time: parallel writes would interleave in the thread pool.
  let queue: Promise<void> = Promise.resolve()
  // Set by destroy() or a failed write: a queued frame the channel already rejected must not go out, and after a
  // partial write the next frame would be out of alignment.
  let stopped = false
  return new Channel(
    {
      readable,
      write: (data) => {
        const done = queue.then(() => (stopped ? Promise.reject(new ChannelClosed()) : writeAll(fd, data)))
        queue = done.catch(() => {
          stopped = true
        })
        return done
      },
      // A file descriptor can't be half-closed, and end of stream leaves it open so this end can still send.
      endWrite: () => {},
      destroy: () => {
        stopped = true
        readable.destroy()
      },
    },
    options,
  )
}

function noClose(_fd: number, callback: (error: null) => void): void {
  callback(null)
}

// Async, since the fd is blocking and a sync write would freeze the event loop while the office is slow; looped,
// since a blocking fd may take part of a buffer.
async function writeAll(fd: number, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length; ) {
    offset += await new Promise<number>((resolve, reject) =>
      fs.write(fd, data, offset, data.length - offset, null, (error, written) =>
        error ? reject(error) : resolve(written),
      ),
    )
  }
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
