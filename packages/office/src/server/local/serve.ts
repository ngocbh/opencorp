/** Serving the no-office host to the TUI: the office's own request pipeline on a private unix socket, `s` in a fresh
 *  0700 folder under the temp folder, and a random token per start, which every request must carry. The token is held
 *  in memory and handed to the TUI in this process: it is in no file, argument, environment or log, and it is compared
 *  in constant time. The folder goes when the host stops, and when the process exits; one a crashed host left is swept
 *  at the next start. */
import { createHash, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"
import { bearerToken, newToken } from "../../runtime/auth/tokens.ts"
import { listenUnix, probeSocket, removeOwnSocket } from "../../util/sockets.ts"
import { createServer, errorType, HANDLER_WAIT_MS, HttpError, logLine, requestListener, trackRequests } from "../http.ts"
import { type LocalHost, OWNER } from "./host.ts"
import { type LocalContext, localRoutes } from "./routes.ts"

export { LocalHost, type LocalHostOptions, OWNER } from "./host.ts"

/** A host's folder: the prefix and `mkdtemp`'s six characters. */
const FOLDER = /^opencorp-local-[A-Za-z0-9]{6}$/
const PREFIX = "opencorp-local-"
/** The socket's name in its folder, short so the path fits however long the home is. */
const SOCKET = "s"
/** How old, in ms, a host's folder with no socket must be before a sweep takes it for a crashed host's: a host that
 *  is starting has made its folder and not yet bound its socket. */
const UNBOUND_MS = 60_000

/** A served host: its socket, the token its requests carry, and how to stop serving it. */
export interface LocalServer {
  readonly socket: string
  /** The token, for the TUI in this process: `Authorization: Bearer <token>`. It isn't enumerable, and inspecting
   *  or serializing the server shows only its socket. */
  readonly token: string
  /** Stops serving, ending open streams, and removes the socket and its folder. Never rejects. */
  close(): Promise<void>
}

/** What serving takes beside the host. */
export interface ServeOptions {
  /** Where the socket's folder goes: `/tmp` where it exists, else the system's temp folder. */
  readonly tmpdir?: string
  /** Gets the pipeline's log lines, which never hold a request's headers or body. */
  readonly log?: (line: string) => void
  /** The event stream's idle ping, in ms. */
  readonly pingMs?: number
}

/** The sha-256 of `token`: what is compared, so the comparison takes the same time whatever the token's length. */
function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}

/** The temp folder a socket's folder goes in by default: `/tmp`, short, where it is a folder. */
function defaultTmp(): string {
  try {
    if (fs.statSync("/tmp").isDirectory()) return "/tmp"
  } catch {}
  return os.tmpdir()
}

/** Removes each host folder in `base` a crashed host left: one of this user's, holding a socket nobody listens on, or
 *  none long after it was made. A live host's, someone else's, and anything else of that name is left. Never throws. */
async function sweep(base: string): Promise<void> {
  let names: string[]
  try {
    names = fs.readdirSync(base)
  } catch {
    return
  }
  const uid = process.geteuid?.()
  for (const name of names) {
    if (!FOLDER.test(name)) continue
    const dir = path.join(base, name)
    try {
      const st = fs.lstatSync(dir)
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue
      const socket = path.join(dir, SOCKET)
      let found: fs.Stats | null = null
      try {
        found = fs.lstatSync(socket)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue
      }
      if (found === null ? Date.now() - st.mtimeMs < UNBOUND_MS : !found.isSocket()) continue
      if (found !== null && (await probeSocket(socket)) !== "stale") continue
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Gone meanwhile, or not ours to read: left as it is.
    }
  }
}

/** Makes a fresh folder for a host's socket in `base`: 0700, this user's, a folder and no link. */
function socketFolder(base: string): string {
  const dir = fs.mkdtempSync(path.join(base, PREFIX))
  fs.chmodSync(dir, 0o700)
  const st = fs.lstatSync(dir)
  const uid = process.geteuid?.()
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`the host's socket folder ${dir} isn't private`)
  }
  return dir
}

/** Serves `host`'s routes on a private socket with a new token; see the module's doc. A request whose bearer token
 *  isn't the host's is refused 401 before routing. Throws when it can't listen, leaving no folder behind. */
export async function serveLocal(host: LocalHost, options: ServeOptions = {}): Promise<LocalServer> {
  const base = options.tmpdir ?? defaultTmp()
  await sweep(base)
  const dir = socketFolder(base)
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true })
  // The process's end takes the folder too; a kill that skips this leaves it for the next start's sweep.
  process.on("exit", removeDir)
  const token = newToken()
  const expected = digest(token)
  const log = (line: string) => {
    try {
      options.log?.(line)
    } catch {}
  }
  const requests = trackRequests(
    requestListener<LocalContext>(localRoutes({ pingMs: options.pingMs }), {
      context: (info) => {
        const given = bearerToken(info.headers.authorization ?? "")
        if (given === null || !timingSafeEqual(digest(given), expected)) {
          throw new HttpError(401, "unauthenticated", "this request doesn't carry the host's token")
        }
        return { host, person: OWNER, signal: info.signal, query: info.query }
      },
      log,
    }),
  )
  const server = createServer(requests.listener)
  const socket = path.join(dir, SOCKET)
  let id: Awaited<ReturnType<typeof listenUnix>>
  try {
    id = await listenUnix(server, socket)
  } catch (error) {
    process.off("exit", removeDir)
    removeDir()
    throw error
  }
  server.on("error", (error) => log(logLine("ERROR", "opencorp.local", `socket error: ${errorType(error)}`)))
  let closing: Promise<void> | null = null
  const close = async () => {
    // Open streams end with their connections; on this runtime close() alone would leave them open.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await requests.settled(HANDLER_WAIT_MS)
    try {
      removeOwnSocket(socket, id)
    } catch {}
    removeDir()
    process.off("exit", removeDir)
  }
  const served = {
    socket,
    close: () =>
      (closing ??= close().catch((error: unknown) => {
        log(logLine("ERROR", "opencorp.local", `the host's socket didn't close cleanly: ${errorType(error)}`))
      })),
    // What inspecting or logging it shows: never the token.
    [inspect.custom]: () => ({ socket }),
    toJSON: () => ({ socket }),
  }
  // Not enumerable, so no copy, spread or listing of the server carries the token.
  return Object.defineProperty(served, "token", { value: token, enumerable: false }) as typeof served & LocalServer
}
