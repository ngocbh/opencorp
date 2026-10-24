/** The office's sockets and HTTP pipeline: a 0700 office dir, 0600 unix sockets, HQ's TCP socket on loopback. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import {
  OfficeStartError,
  listenTcp,
  listenUnix,
  makeOfficeDir,
  removeStaleSocket,
} from "../../src/daemon/sockets.ts"
import { shortDir, tempDir } from "../helpers.ts"

setDefaultTimeout(30_000)

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

/** A server closed when the current test finishes. */
function server(): net.Server {
  const s = net.createServer((conn) => conn.end())
  onTestFinished(() => new Promise<void>((resolve) => (s.listening ? s.close(() => resolve()) : resolve())))
  return s
}

/** Closes `s` and waits for it. */
function close(s: net.Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())))
}

/** A unix socket at `socketPath` whose server is closed: the file stays, as after a crash. */
async function staleSocket(socketPath: string): Promise<void> {
  const s = server()
  await listenUnix(s, socketPath)
  await close(s)
}

describe("sockets", () => {
  test("socket is 0600 even with a loose umask", async () => {
    const dir = shortDir()
    const sock = path.join(dir, "s.sock")
    const old = process.umask(0o022)
    try {
      await listenUnix(server(), sock)
    } finally {
      process.umask(old)
    }
    expect(mode(sock)).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(["s.sock"]) // the temp folder is gone
  })

  test("the socket mode leaves the process umask as it found it", async () => {
    const sock = path.join(shortDir(), "s.sock")
    const prev = process.umask(0o027)
    let after: number
    try {
      await listenUnix(server(), sock)
    } finally {
      // Restores the umask and reads the one listenUnix left, in one call.
      after = process.umask(prev)
    }
    expect(after).toBe(0o027)
    expect(mode(sock)).toBe(0o600)
  })

  test("too long socket path is a clear error", async () => {
    const sock = path.join(tempDir(), "x".repeat(120), "office.sock")
    const err = await listenUnix(server(), sock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfficeStartError)
    expect((err as Error).message).toMatch(/socket path too long/)
  })

  test("office dir is created 0700", () => {
    const office = path.join(shortDir(), "home", "office")
    makeOfficeDir(office)
    expect(mode(office)).toBe(0o700)
  })

  test("a loose office dir is tightened to 0700", () => {
    const office = path.join(shortDir(), "office")
    fs.mkdirSync(office)
    fs.chmodSync(office, 0o755)
    makeOfficeDir(office)
    expect(mode(office)).toBe(0o700)
  })

  test.each(["dir", "missing"])("a symlinked office dir is refused [%s]", (target) => {
    const dir = shortDir()
    const elsewhere = path.join(dir, "elsewhere")
    if (target === "dir") fs.mkdirSync(elsewhere)
    const office = path.join(dir, "office")
    fs.symlinkSync(elsewhere, office)
    let err: unknown
    try {
      makeOfficeDir(office)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OfficeStartError)
    expect((err as Error).message).toContain(office)
    expect(!fs.existsSync(elsewhere) || fs.readdirSync(elsewhere).length === 0).toBe(true)
  })

  test("an office dir owned by someone else is refused", () => {
    const dir = shortDir()
    const office = path.join(dir, "office")
    fs.mkdirSync(office)
    expect(() => makeOfficeDir(office, fs.statSync(dir).uid + 1)).toThrow(OfficeStartError)
    expect(() => makeOfficeDir(office, fs.statSync(dir).uid + 1)).toThrow(/owned by uid/)
  })

  test("a stale socket is removed", async () => {
    const sock = path.join(shortDir(), "s.sock")
    await staleSocket(sock) // closing leaves the file, as a crash does
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    removeStaleSocket(sock)
    expect(fs.existsSync(sock)).toBe(false)
    removeStaleSocket(sock) // nothing there is fine
  })

  test.each(["dir", "file", "symlink"])("something else at the socket path is refused [%s]", async (kind) => {
    const dir = shortDir()
    const sock = path.join(dir, "s.sock")
    if (kind === "dir") fs.mkdirSync(sock)
    else if (kind === "file") fs.writeFileSync(sock, "mine")
    else {
      await staleSocket(path.join(dir, "real.sock"))
      fs.symlinkSync(path.join(dir, "real.sock"), sock)
    }
    expect(() => removeStaleSocket(sock)).toThrow(OfficeStartError)
    expect(() => removeStaleSocket(sock)).toThrow(/not a socket/)
    expect(() => fs.lstatSync(sock)).not.toThrow()
  })

  test("the tcp socket listens on loopback and never shares the port", async () => {
    const first = server()
    const port = await listenTcp(first, 0)
    expect((first.address() as net.AddressInfo).address).toBe("127.0.0.1")
    const err = await listenTcp(server(), port).catch((e: unknown) => e)
    expect((err as NodeJS.ErrnoException).code).toBe("EADDRINUSE")
  })

  test("the tcp socket binds a port left in time wait", async () => {
    // The server side closes its one connection first, so that connection sits in TIME_WAIT on the
    // server's port, as after a restart with a browser stream open.
    const listener = server()
    const port = await listenTcp(listener, 0)
    const client = net.connect(port, "127.0.0.1")
    // The client reads to EOF, then ends: a FIN, not a RST that clears TIME_WAIT.
    await new Promise<void>((resolve, reject) => {
      client.on("error", reject)
      client.on("data", () => {})
      client.on("end", () => {
        client.end()
        resolve()
      })
    })
    await new Promise<void>((resolve) => client.on("close", () => resolve()))
    await close(listener)
    expect(await listenTcp(server(), port)).toBe(port)
  })
})
