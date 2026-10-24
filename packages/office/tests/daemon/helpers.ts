/** Daemon test helpers (Python's `tests/daemon/conftest.py`). */
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import net from "node:net"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { type Limits, type RequestInfo, type Route, createServer, requestListener } from "../../src/daemon/http.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import { shortDir } from "../helpers.ts"

/** How `serve` builds each request's context, where its log lines go, and its server's limits. */
export type ServeOptions<C> = {
  context: (info: RequestInfo) => C | Promise<C>
  log?: (line: string) => void
  limits?: Limits
}

/** Serves `routes` on a unix socket until the current test finishes; `settled` counts answered requests. */
export async function serve<C>(
  routes: readonly Route<C>[],
  { context, log = () => {}, limits }: ServeOptions<C>,
): Promise<{ sock: string; server: http.Server; settled: () => number }> {
  let settled = 0
  const listener = requestListener(routes, { context, log })
  const server = createServer((req, res) => listener(req, res).finally(() => settled++), limits)
  const sock = path.join(shortDir(), "o.sock")
  onTestFinished(async () => {
    // On Bun's node:http, closeAllConnections also stops the listener, so close's callback gets
    // ERR_SERVER_NOT_RUNNING; on Node close is still needed. The other order force-closes nothing on Bun.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(sock, { force: true })
  })
  await listenUnix(server, sock)
  return { sock, server, settled: () => settled }
}

export type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json(): unknown }

/** One request over `node:http`, on a fresh connection. Under `bun test` this client is fetch-based, so
 *  assertions about `connection: close` or reuse go through `raw` or `Conn`. */
export function request(
  sock: string,
  method: string,
  target: string,
  {
    headers = {},
    body,
    chunks,
  }: { headers?: Record<string, string>; body?: Buffer | string; chunks?: AsyncIterable<Buffer> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let responded = false
    const req = http.request({ socketPath: sock, method, path: target, headers, agent: false }, (res) => {
      responded = true
      const parts: Buffer[] = []
      res.on("data", (part: Buffer) => parts.push(part))
      res.on("error", reject)
      res.on("end", () => {
        const text = Buffer.concat(parts).toString()
        resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    // A write error (EPIPE, ECONNRESET) after the server answered is the server not reading the rest.
    const failed = (error: unknown) => {
      if (!responded) reject(error)
    }
    req.on("error", failed)
    if (chunks)
      (async () => {
        for await (const chunk of chunks) req.write(chunk)
        req.end()
      })().catch(failed)
    else req.end(body)
  })
}

/** Writes `text` on a new connection and reads until the first line, the end of the head, or EOF. `closed`
 *  is true only when the peer ended the connection (a reset counts). */
export function raw(
  sock: string,
  text: string,
  { until = "close", timeout = 9000 }: { until?: "line" | "head" | "close"; timeout?: number } = {},
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock)
    let got = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("raw read timed out"))
    }, timeout)
    const finish = (closed: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ text: got, closed })
    }
    socket.on("connect", () => socket.write(text))
    socket.on("data", (data: Buffer) => {
      got += data.toString()
      if ((until === "line" && got.includes("\r\n")) || (until === "head" && got.includes("\r\n\r\n"))) finish(false)
    })
    socket.on("end", () => finish(true))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") return finish(true)
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}

/** The status, head and body of one raw response. */
export function parse(text: string): { status: number; head: string; body: string } {
  const at = text.indexOf("\r\n\r\n")
  const head = at < 0 ? text : text.slice(0, at)
  return { status: Number(head.split(" ")[1]), head, body: at < 0 ? "" : text.slice(at + 4) }
}

/** A raw `method target` request on its own connection, asking the server to close it after. */
export async function exchange(sock: string, method: string, target: string) {
  const { text } = await raw(sock, `${method} ${target} HTTP/1.1\r\nhost: office\r\nconnection: close\r\n\r\n`)
  return parse(text)
}

/** One held connection, for keep-alive checks. */
export class Conn {
  private buf = Buffer.alloc(0)
  private ended = false
  private wake: (() => void) | undefined

  private constructor(readonly socket: net.Socket) {
    const end = () => {
      this.ended = true
      this.wake?.()
    }
    socket.on("data", (data: Buffer) => {
      this.buf = Buffer.concat([this.buf, data])
      this.wake?.()
    })
    socket.on("end", end)
    socket.on("close", end)
    socket.on("error", end)
  }

  static async open(sock: string): Promise<Conn> {
    const socket = net.connect(sock)
    onTestFinished(() => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve())
      socket.once("error", reject)
    })
    return new Conn(socket)
  }

  send(text: string): void {
    this.socket.write(text)
  }

  /** Waits until `ready()` holds or `deadline` passes; false if it didn't hold. */
  private async until(ready: () => boolean, deadline: number): Promise<boolean> {
    while (!ready()) {
      const left = deadline - performance.now()
      if (this.ended || left <= 0) return ready()
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.wake = undefined
          resolve()
        }
        const timer = setTimeout(done, left)
        this.wake = done
      })
    }
    return true
  }

  /** The next whole response, as soon as it is all read. */
  async response({ timeout = 9000 } = {}): Promise<{ status: number; head: string; body: string }> {
    const deadline = performance.now() + timeout
    if (!(await this.until(() => this.buf.includes("\r\n\r\n"), deadline))) throw new Error("no response head")
    const at = this.buf.indexOf("\r\n\r\n")
    const head = this.buf.subarray(0, at).toString()
    const end = at + 4 + Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0)
    if (!(await this.until(() => this.buf.length >= end, deadline))) throw new Error("short response body")
    const body = this.buf.subarray(at + 4, end).toString()
    this.buf = this.buf.subarray(end)
    return { status: Number(head.split(" ")[1]), head, body }
  }

  /** Whether the peer ends or resets the connection (or already has) within `timeout`. */
  closed({ timeout = 9000 } = {}): Promise<boolean> {
    return this.until(() => this.ended, performance.now() + timeout)
  }
}
