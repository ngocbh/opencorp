/** The office dir and the sockets the office listens on: 0600 unix sockets in the office dir, and HQ's TCP
 *  socket on 127.0.0.1. */
import fs from "node:fs"
import type net from "node:net"
import path from "node:path"

/** The size of `sockaddr_un.sun_path`, including its terminating NUL: 104 on darwin, else 108. */
export const SUN_PATH_MAX = process.platform === "darwin" ? 104 : 108

/** The daemon can't start; the message says why. */
export class OfficeStartError extends Error {
  override name = "OfficeStartError"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Throws `OfficeStartError` if `socketPath` is too long for a unix socket. */
export function checkSocketPath(socketPath: string): void {
  const size = Buffer.byteLength(socketPath)
  if (size >= SUN_PATH_MAX)
    throw new OfficeStartError(`socket path too long (${size} bytes, limit ${SUN_PATH_MAX - 1}): ${socketPath}`)
}

/** Creates `dir` if needed and makes it 0700; throws `OfficeStartError` if it isn't ours to use.
 *
 *  The office dir holds the socket, pidfile, store, and secrets, so a symlink (which could point anywhere) or a
 *  directory owned by another user is refused. `uid` is the owner it must have: by default the effective uid,
 *  which equals the real one for a daemon that isn't setuid. */
export function makeOfficeDir(dir: string, uid: number = process.geteuid!()): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new OfficeStartError(`can't create the office directory ${dir}: ${messageOf(error)}`)
  }
  const st = fs.lstatSync(dir)
  if (st.isSymbolicLink()) throw new OfficeStartError(`the office directory ${dir} is a symlink`)
  if (!st.isDirectory()) throw new OfficeStartError(`the office directory ${dir} is not a directory`)
  if (st.uid !== uid)
    throw new OfficeStartError(`the office directory ${dir} is owned by uid ${st.uid}, not ${uid}`)
  fs.chmodSync(dir, 0o700)
}

/** Unlinks the socket a crashed daemon left at `socketPath`; throws `OfficeStartError` if something else is
 *  there (a directory, a file, or a symlink, even one to a socket). */
export function removeStaleSocket(socketPath: string): void {
  let st: fs.Stats
  try {
    st = fs.lstatSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!st.isSocket()) throw new OfficeStartError(`${socketPath} exists and is not a socket`)
  try {
    fs.unlinkSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/** Runs `start` and waits for `server` to listen, or rejects with its error; both listeners are removed once
 *  settled. */
function listening(server: net.Server, start: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      server.off("listening", onListening)
      server.off("error", onError)
    }
    const onListening = () => {
      done()
      resolve()
    }
    const onError = (error: Error) => {
      done()
      reject(error)
    }
    server.on("listening", onListening)
    server.on("error", onError)
    try {
      start()
    } catch (error) {
      done()
      reject(error)
    }
  })
}

/** Makes `server` listen on a unix socket at `socketPath` with mode 0600; throws `OfficeStartError` if it can't.
 *
 *  The socket is bound in a private 0700 temp folder next to `socketPath`, so nobody can connect before its mode
 *  is set, then hard-linked into place, which fails if anything is at `socketPath`. The caller runs
 *  `removeStaleSocket` first, and removes `socketPath` after `server.close()`: close doesn't unlink a linked
 *  socket. A crash before the cleanup leaves a `.sXXXXXX` folder beside `socketPath`. After a successful call
 *  `server.address()` still names the removed temp path, so callers use `socketPath`, not `server.address()`. */
export async function listenUnix(server: net.Server, socketPath: string): Promise<void> {
  checkSocketPath(socketPath)
  let tmp: string
  try {
    tmp = fs.mkdtempSync(path.join(path.dirname(socketPath), ".s"))
  } catch (error) {
    throw new OfficeStartError(`can't listen on ${socketPath}: ${messageOf(error)}`)
  }
  try {
    const temp = path.join(tmp, "s")
    const tempSize = Buffer.byteLength(temp)
    if (tempSize >= SUN_PATH_MAX)
      throw new OfficeStartError(
        `socket path too long (${Buffer.byteLength(socketPath)} bytes, its temp path ${tempSize}, ` +
          `limit ${SUN_PATH_MAX - 1}): ${socketPath}`,
      )
    try {
      await listening(server, () => {
        // The umask is process-wide, but the bind happens inside listen() itself, so it is restored before
        // anything else runs; the 0700 temp folder is the real guard.
        const old = process.umask(0o177)
        try {
          server.listen(temp)
        } finally {
          process.umask(old)
        }
      })
      fs.chmodSync(temp, 0o600)
      // A link, unlike a rename, never replaces what appeared at socketPath after the stale check.
      fs.linkSync(temp, socketPath)
    } catch (error) {
      if (server.listening) server.close()
      throw new OfficeStartError(`can't listen on ${socketPath}: ${messageOf(error)}`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Makes `server` listen on 127.0.0.1:`port` (0: any free port) and resolves to the bound port; errors such as
 *  `EADDRINUSE` propagate as they are.
 *
 *  The runtime sets `SO_REUSEADDR` on TCP listeners, so a restart binds past TIME_WAIT, and, without
 *  `reusePort`, never `SO_REUSEPORT`, which would let another socket share the port. */
export async function listenTcp(server: net.Server, port: number): Promise<number> {
  await listening(server, () => server.listen({ host: "127.0.0.1", port }))
  return (server.address() as net.AddressInfo).port
}
