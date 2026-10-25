/** Daemon test helpers (Python's `tests/daemon/conftest.py`). */
import fs from "node:fs"
import http, { type IncomingHttpHeaders } from "node:http"
import net from "node:net"
import path from "node:path"
import { type MarkdownStore, MarkdownVersionMismatch } from "@ngocbh/yian"
import type { JsonObject } from "@ngocbh/yian/run"
import { onTestFinished } from "bun:test"
import { parse as parseYaml, stringify } from "yaml"
import { tokenSha256 } from "../../src/auth/tokens.ts"
import type { LoginsOptions } from "../../src/chat/logins.ts"
import { type ModelCacheOptions, ownModels } from "../../src/chat/models.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { DeviceTokens } from "../../src/daemon/auth.ts"
import { Bus } from "../../src/daemon/bus.ts"
import { type Limits, type RequestInfo, type Route, createServer, requestListener } from "../../src/daemon/http.ts"
import { Office, OfficePaths, type RequestContext } from "../../src/daemon/office.ts"
import { allRoutes } from "../../src/daemon/routes/index.ts"
import { listenUnix } from "../../src/daemon/sockets.ts"
import { blobId } from "../../src/profile/store.ts"
import type { ModelCheck } from "../../src/install/onboard.ts"
import { Store } from "../../src/store/store.ts"
import { git, makeCompany } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"

/** The base company's CEO. */
export const CEO = "ngocbh"
/** A well-formed id that names nothing. */
export const ULID = "01JA1H0000000000000000000A"

/**
 * An office over a fresh home: the base company at `paths.company`, a store, company git and a bus; not started
 * (Python's `office` fixture). `log` gets the office's raw log messages. The listing and the sign-in are offline
 * stand-ins unless `models`/`logins` give others: the defaults reach OpenAI. The model check rejects unless
 * `checkModel` gives one, as tests have no worker. `files` are `makeCompany` overrides on the base company.
 *
 * When the test finishes it is stopped and its store closed, before its temp dir is removed. A test that already
 * called `stop()` gets a second one then, after its assertions; that is harmless, though `stop` is not idempotent
 * (its stop callbacks run again), as in Python.
 */
export function makeOffice({
  log,
  models,
  logins,
  files,
  checkModel = () => Promise.reject(new Error("no worker in tests: pass checkModel")),
}: {
  log?: (message: string) => void
  models?: ModelCacheOptions
  logins?: Omit<LoginsOptions, "models">
  files?: Record<string, unknown>
  checkModel?: ModelCheck
} = {}): Office {
  let office: Office | undefined
  let store: Store | undefined
  // Registered before tempDir's removal: onTestFinished runs callbacks in registration order.
  onTestFinished(async () => {
    try {
      await office?.stop()
    } finally {
      store?.close()
    }
  })
  const home = tempDir()
  makeCompany(files ?? {}, home)
  const paths = new OfficePaths(home)
  store = new Store(paths.store)
  office = new Office({
    paths,
    store,
    git: new CompanyGit(paths.company, paths.worktrees),
    bus: new Bus(),
    log,
    models: { lister: (conn, name) => Promise.resolve(ownModels(conn, name)), ...models },
    logins: {
      auth: () => {
        throw new Error("no network in tests: pass logins.auth")
      },
      ...logins,
    },
    checkModel,
  })
  return office
}

/** A MarkdownStore over one file, versioned by git blob id; only the current version is readable. */
export class BlobFileStore implements MarkdownStore {
  /** Each write's provenance, in order. */
  readonly provenance: (JsonObject | null)[] = []

  constructor(readonly path: string) {}

  #current(): [string, string] {
    const data = fs.existsSync(this.path) ? fs.readFileSync(this.path) : Buffer.alloc(0)
    return [data.toString(), blobId(data)]
  }

  read(version?: string | null): [string, string] {
    const [text, current] = this.#current()
    if (version !== undefined && version !== null && version !== current) throw new RangeError(version)
    return [text, current]
  }

  write(text: string, { baseVersion, provenance = null }: { baseVersion: string; provenance?: JsonObject | null }) {
    const [, current] = this.#current()
    if (baseVersion !== current) throw new MarkdownVersionMismatch(baseVersion, current)
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    const data = Buffer.from(text)
    fs.writeFileSync(this.path, data)
    this.provenance.push(provenance)
    return blobId(data)
  }
}

/** Sets `office.profileStore` to one `BlobFileStore` per person over `<company>/people/<handle>/profile.md`, made
 *  on first use; returns them by handle (Python's `profile_stores` fixture). */
export function blobStores(office: Office): Map<string, BlobFileStore> {
  const stores = new Map<string, BlobFileStore>()
  office.profileStore = (handle) => {
    let store = stores.get(handle)
    if (store === undefined) {
      store = new BlobFileStore(path.join(office.paths.company, "people", handle, "profile.md"))
      stores.set(handle, store)
    }
    return store
  }
  return stores
}

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

/**
 * Starts `office` and serves the office's routes, then `extra`, on a unix socket (Python's `served`). With `tokens`,
 * each request's context comes from `DeviceTokens` (the token check, enforcement once a human lists a device);
 * without, every request acts as the CEO from no device. `pingMs` sets the event stream's idle ping; `log` gets the
 * pipeline's log lines.
 *
 * When the test finishes, `makeOffice`'s cleanup runs first: it stops the office, which ends open event streams;
 * then `serve`'s closes the server.
 */
export async function served(
  office: Office,
  {
    pingMs,
    log,
    tokens = false,
    extra = [],
  }: {
    pingMs?: number
    log?: (line: string) => void
    /** Check device tokens as the office does, rather than act as the CEO. */
    tokens?: boolean
    /** Stand-in routes served after the office's own. */
    extra?: readonly Route<RequestContext>[]
  } = {},
): Promise<{ sock: string; server: http.Server }> {
  await office.start()
  const context = tokens
    ? new DeviceTokens(office).context
    : (info: RequestInfo): RequestContext => ({
        office,
        person: CEO,
        device: null,
        signal: info.signal,
        query: info.query,
      })
  const { sock, server } = await serve([...allRoutes({ pingMs }), ...extra], { context, log })
  return { sock, server }
}

/** An `Authorization` header carrying `token`. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** Commits a new human `handle` reporting to the CEO, in the company repo at `company`. */
export function addHuman(company: string, handle: string): void {
  const file = path.join(company, "people", handle, "person.yaml")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const name = handle.charAt(0).toUpperCase() + handle.slice(1)
  fs.writeFileSync(file, stringify({ handle, name, kind: "human", title: "R", manager: CEO }))
  git(company, "add", "-A")
  git(company, "commit", "-qm", `hire ${handle}`)
}

/** Commits a device `name` with `token`'s hash for `handle`, as a hand edit of the repo at `company` would. */
export function giveDevice(company: string, handle: string, name: string, token: string): void {
  const file = path.join(company, "people", handle, "person.yaml")
  const data = parseYaml(fs.readFileSync(file, "utf8")) as { devices?: unknown[] }
  data.devices = [...(data.devices ?? []), { name, token_sha256: tokenSha256(token) }]
  fs.writeFileSync(file, stringify(data))
  git(company, "commit", "-qam", `device for ${handle}`)
}

export type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json(): unknown }

/** One request over `node:http`, on a fresh connection. Under `bun test` this client is fetch-based, so
 *  assertions about `connection: close` or reuse go through `raw` or `Conn`. `setHost` false sends the `host`
 *  header exactly as given (Bun otherwise replaces an empty Host with `localhost`). */
export function request(
  sock: string,
  method: string,
  target: string,
  {
    headers = {},
    body,
    chunks,
    setHost,
  }: {
    headers?: Record<string, string>
    body?: Buffer | string
    chunks?: AsyncIterable<Buffer>
    setHost?: boolean
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let responded = false
    const options = { socketPath: sock, method, path: target, headers, agent: false, setHost }
    const req = http.request(options, (res) => {
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

/** `[event, id, data]` per SSE frame, and `["comment", null, text]` per comment line. */
export type Frame = [string, string | null, unknown]

/** The frames of `res`, as Python's `frames` reads them: `data` JSON-parsed, an empty `data:` as null. */
export async function* frames(res: http.IncomingMessage): AsyncGenerator<Frame> {
  res.setEncoding("utf8")
  let event: string | null = null
  let id: string | null = null
  let data: unknown = null
  // Chunks can split or merge lines, so the unfinished last line waits for the next chunk.
  let tail = ""
  for await (const chunk of res as AsyncIterable<string>) {
    const lines = (tail + chunk).split("\n")
    tail = lines.pop()!
    for (const line of lines) {
      if (line.startsWith(":")) yield ["comment", null, line.slice(1).trim()]
      else if (line.startsWith("event: ")) event = line.slice(7)
      else if (line.startsWith("id: ")) id = line.slice(4)
      else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6))
      else if (line === "data:") data = null
      else if (line === "" && event !== null) {
        yield [event, id, data]
        event = null
        id = null
        data = null
      }
    }
  }
}

/** `promise`, or a rejection after 5 s. */
export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out after 5 s")), 5000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The next `n` frames of `it`, within 5 s. */
export async function take(it: AsyncIterator<Frame>, n: number): Promise<Frame[]> {
  return within(
    (async () => {
      const got: Frame[] = []
      for (let i = 0; i < n; i++) {
        const step = await it.next()
        if (step.done) throw new Error(`the stream ended after ${got.length} frames`)
        got.push(step.value)
      }
      return got
    })(),
  )
}

/** Whether `it` ends (within 5 s) instead of yielding another frame. */
export async function ends(it: AsyncIterator<Frame>): Promise<boolean> {
  return (await within(it.next())).done === true
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

  /** The next whole response, as soon as it is all read. With `head`, the response to a HEAD request: its
   *  `content-length` names a body that isn't sent. */
  async response({
    timeout = 9000,
    head: isHead = false,
  } = {}): Promise<{ status: number; head: string; body: string }> {
    const deadline = performance.now() + timeout
    if (!(await this.until(() => this.buf.includes("\r\n\r\n"), deadline))) throw new Error("no response head")
    const at = this.buf.indexOf("\r\n\r\n")
    const head = this.buf.subarray(0, at).toString()
    const end = at + 4 + (isHead ? 0 : Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? 0))
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
