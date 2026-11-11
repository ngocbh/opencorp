/** Helpers shared by the reach tests. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import type { HqStatus } from "@opencorp/protocol"
import { PassThrough } from "node:stream"
import { onTestFinished } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { type ReachContext, writeSshFiles } from "../../src/reach/ssh.ts"
import type { VisitDeps } from "../../src/reach/visit.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../src/testing/fake_ssh.ts"
import { NO_LISTING, Script } from "../install/helpers.ts"

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

/** HQ's health as the fake remote answers it. */
export const HEALTH = Object.freeze({ ok: true as const, office: { api: "1" }, app: { build: "b1", api: "1" } })

/** What the fake remote's `opencorp` prints and exits with for one command. */
export interface Answer {
  stdout?: string
  stderr?: string
  code?: number
  /** Seconds to wait before answering. */
  delay?: number
}

/** HQ's machine, here: hq.sock at `<dir>/office/hq.sock` answering `/api/health` with `HEALTH` (and 404 else), and
 *  `<dir>/bin/opencorp`, a sh script that answers `hq --check --json` and `hq --json` from files `setCheck` and
 *  `setSignIn` rewrite; at first a good status and a code. Stopped when the test finishes. */
export interface FakeRemote {
  readonly opencorp: string
  readonly socket: string
  /** What `/api/health` answers; change it to make the check and the port differ. */
  health: unknown
  /** The pairing code `hq --json` prints at first. */
  readonly code: string
  /** The status `hq --check --json` prints at first. */
  readonly status: HqStatus
  setCheck(answer: Answer): void
  setSignIn(answer: Answer): void
  stop(): Promise<void>
}

export async function fakeRemote(dir: string): Promise<FakeRemote> {
  const office = path.join(dir, "office")
  const bin = path.join(dir, "bin")
  const answers = path.join(dir, "answers")
  for (const d of [office, bin, answers]) fs.mkdirSync(d, { recursive: true })
  const socket = path.join(office, "hq.sock")
  const opencorp = path.join(bin, "opencorp")
  const write = (name: string, { stdout = "", stderr = "", code = 0, delay = 0 }: Answer) => {
    fs.writeFileSync(path.join(answers, `${name}.delay`), String(delay))
    fs.writeFileSync(path.join(answers, `${name}.stdout`), stdout)
    fs.writeFileSync(path.join(answers, `${name}.stderr`), stderr)
    fs.writeFileSync(path.join(answers, `${name}.code`), String(code))
  }
  fs.writeFileSync(
    opencorp,
    [
      "#!/bin/sh",
      `d='${answers}'`,
      'case "$*" in',
      '  "hq --check --json") n=check ;;',
      '  "hq --json") n=signin ;;',
      '  *) echo "fake opencorp: no $*" >&2; exit 2 ;;',
      "esac",
      'sleep "$(cat "$d/$n.delay")"',
      'cat "$d/$n.stdout"',
      'cat "$d/$n.stderr" >&2',
      'exit "$(cat "$d/$n.code")"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  const code = randomBytes(16).toString("base64url")
  const status: HqStatus = {
    socket,
    tcp: { enabled: false, port: 49380, listening: false, error: null, next_retry_at: null },
    url: null,
    health: HEALTH,
    socket_error: null,
    warnings: [],
  }
  write("check", { stdout: `Welcome to node1\n${JSON.stringify(status)}\n` })
  write("signin", {
    stdout:
      JSON.stringify({
        path: `/pair#${code}`,
        url: null,
        socket,
        port: 49380,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        open_file: null,
      }) + "\n",
  })
  const remote: FakeRemote = {
    opencorp,
    socket,
    health: HEALTH,
    code,
    status,
    setCheck: (answer) => write("check", answer),
    setSignIn: (answer) => write("signin", answer),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(remote.health))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  onTestFinished(() => remote.stop())
  return remote
}

/** What a visit's `exit` throws in a test. */
export class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

/** A visit's deps for a test: home `dir`, the fake ssh first on PATH (the system's ssh with `fake` null), `answers`
 *  for its approvals, recorded output and opens, a SIGINT the test sends with `sigint()`, an `exit` that throws
 *  `Exited`, short limits, and a model picker that lists nothing and a model check that passes. */
export function visitDeps(
  dir: string,
  fake: FakeSsh | null,
  { answers = [], interactive = true, ...more }: { answers?: string[]; interactive?: boolean } & Partial<VisitDeps> = {},
) {
  const printed: string[] = []
  const errors: string[] = []
  const echoed: string[] = []
  const opened: string[] = []
  const prompter = new Script(answers, { interactive })
  const stdin = new PassThrough()
  let handler: (() => void) | undefined
  const deps: VisitDeps = {
    home: dir,
    env: { PATH: fake ? `${fake.bin}:/usr/bin:/bin` : "/usr/bin:/bin", HOME: dir, SSH_AUTH_SOCK: path.join(dir, "agent") },
    prompter,
    stdin,
    print: (line) => void printed.push(line),
    error: (line) => void errors.push(line),
    echo: (text) => void echoed.push(text),
    open: (target) => void opened.push(target),
    now: () => new Date(),
    onSigint: (fn) => {
      handler = fn
      return () => {
        if (handler === fn) handler = undefined
      }
    },
    exit: (code) => {
      throw new Exited(code)
    },
    limits: SHORT_LIMITS,
    sshIncludes: [],
    listers: NO_LISTING,
    checkModel: async () => null,
    ...more,
  }
  return { deps, prompter, stdin, printed, errors, echoed, opened, sigint: () => handler?.() }
}
