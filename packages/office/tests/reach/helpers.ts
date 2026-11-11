/** Helpers shared by the reach tests. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { type ReachContext, writeSshFiles } from "../../src/reach/ssh.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../src/testing/fake_ssh.ts"

/** Limits short enough that a test which hits one still finishes. */
export const SHORT_LIMITS = Object.freeze({ promptMs: 5000, stepMs: 5000 })

/** A short home folder with a fake ssh in `<dir>/fake`. When the test finishes, every fake master is killed, then
 *  the folder removed (in that order, so no master outlives its state). */
export function fakeHome(behavior?: FakeSshBehavior): { dir: string; fake: FakeSsh } {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const fake = installFakeSsh(path.join(dir, "fake"), behavior)
  onTestFinished(() => {
    for (const pid of fake.masters()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, fake }
}

/** A context whose home is `dir` and whose ssh is `fake`, with the hq folders made and the ssh files written (no
 *  includes); children get only a system PATH and `dir` as HOME. */
export async function reachCtx(dir: string, fake: FakeSsh, more: Partial<ReachContext> = {}): Promise<ReachContext> {
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  await writeSshFiles(paths, fake.ssh, [])
  return {
    paths,
    ssh: fake.ssh,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    batch: false,
    echo: () => {},
    limits: SHORT_LIMITS,
    ...more,
  }
}

/** Leaves a socket file at `file` that no server holds: moved aside while its server closes, then put back. */
export async function staleSocket(file: string) {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(file, resolve))
  fs.renameSync(file, `${file}.x`)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.renameSync(`${file}.x`, file)
}

/** A port free on 127.0.0.1 a moment ago. */
export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A server on the unix socket `file` that echoes and holds each connection; closed when the test finishes. */
export async function holdingServer(file: string): Promise<{ server: net.Server; connections: Set<net.Socket> }> {
  const connections = new Set<net.Socket>()
  const server = net.createServer((c) => {
    connections.add(c)
    c.on("error", () => {})
    c.once("close", () => connections.delete(c))
    c.pipe(c)
  })
  await new Promise<void>((resolve) => server.listen(file, resolve))
  onTestFinished(() => {
    for (const c of connections) c.destroy()
    server.close()
  })
  return { server, connections }
}

/** An open connection to 127.0.0.1:`port`, and a promise of its close; destroyed when the test finishes. */
export async function holdConnection(port: number): Promise<{ socket: net.Socket; closed: Promise<void> }> {
  const socket = net.connect({ port, host: "127.0.0.1" })
  socket.on("error", () => {})
  onTestFinished(() => socket.destroy())
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject))
  return { socket, closed }
}
