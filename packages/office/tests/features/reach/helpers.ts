/** Helpers shared by the reach tests. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import type { HqStatus } from "@opencorp/protocol"
import { PassThrough } from "node:stream"
import { onTestFinished } from "bun:test"
import { OAuthCredentials } from "@ngocbh/yian/llm_clients"
import type { Provider } from "../../../src/models/provider.ts"
import { ConnectionShell } from "../../../src/features/reach/connection.ts"
import { Learning } from "../../../src/features/reach/learning.ts"
import { type SaveAccessHost, saveAccess } from "../../../src/features/reach/tools/save_access.ts"
import { dontAskRefusal } from "../../../src/runtime/permissions/policy.ts"
import type { CardAnswer, QuestionCard } from "../../../src/runtime/sessions/builtin.ts"
import { claimCm, makeDirs, ReachPaths } from "../../../src/features/reach/paths.ts"
import type { Spec } from "../../../src/features/reach/spec.ts"
import { exitAll, type ReachContext, writeSshFiles } from "../../../src/features/reach/ssh.ts"
import { DEFAULT_PORT, sha256, writeAccess } from "../../../src/features/reach/state.ts"
import type { VisitDeps } from "../../../src/features/reach/run.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { freePort } from "../../../src/testing/ports.ts"
import { writePrivate } from "../../../src/util/private_files.ts"
import { ACCOUNT, fakeSubscription, NO_LISTING, Script } from "../setup/helpers.ts"

export { freePort }

/** Limits short enough that a test which hits one still finishes. */
export const SHORT_LIMITS = Object.freeze({ promptMs: 5000, stepMs: 5000, quietMs: 5000 })

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

/** A context whose home is `dir` and whose ssh is `fake`, for destination `name` ("misha" unless given), with its
 *  folders made, a control-socket folder claimed and recorded in its `cm.id`, as a visit finds it, and the ssh files
 *  written with `includes` (none unless given); children get only a system PATH and `dir` as HOME. */
export async function reachCtx(
  dir: string,
  fake: FakeSsh,
  { includes = [], name = "misha", ...more }: Partial<ReachContext> & { includes?: readonly string[]; name?: string } = {},
): Promise<ReachContext> {
  const found = new ReachPaths(dir, name)
  makeDirs(found)
  const paths = found.withCm(claimCm(found.root, new Set()))
  await writePrivate(paths.cmRecord, `${paths.cmId}\n`)
  makeDirs(paths)
  await writeSshFiles(paths, fake.ssh, includes)
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
    sshHome: dir,
    listers: NO_LISTING,
    checkModel: async () => null,
    ...more,
  }
  return { deps, prompter, stdin, printed, errors, echoed, opened, sigint: () => handler?.() }
}

/** A learning run over a fake ssh: its context, in folder `name` of hq ("misha" unless given; a temporary folder's
 *  name for a first learn), its state with the session's folder in hq/sessions and `wanted` as the destination's
 *  name (null unless given), and the cards its `save_access` held, each answered by the next of `answers` at once
 *  ("dontAsk": refused, as a host in that mode refuses it). OpenCorp's connection shell is made on first use; the
 *  test's end ends the masters and closes it. */
export async function learning(
  answers: (CardAnswer | "dontAsk")[],
  {
    behavior,
    secrets = [],
    port = 49381,
    wanted = null,
    ...more
  }: { behavior?: FakeSshBehavior; secrets?: string[]; port?: number; wanted?: string | null; name?: string } & Partial<ReachContext> = {},
) {
  const { dir, fake } = fakeHome(behavior)
  const ctx = await reachCtx(dir, fake, more)
  const folder = path.join(ctx.paths.sessions, "01JDLEARNSESSION0000000000")
  const state = new Learning(ctx, secrets, port, folder, () => new Date(), wanted)
  const cards: QuestionCard[] = []
  const listed: string[] = []
  const host: SaveAccessHost = {
    state,
    binding: {
      ask: (card, _callId, act) => {
        cards.push(card)
        const answer = answers.shift()
        if (answer === undefined) throw new Error("no answer left for the card")
        return answer === "dontAsk" ? dontAskRefusal(card.reason) : act(answer, new AbortController().signal)
      },
    },
    connection: () =>
      (state.shell ??= new ConnectionShell({
        ctx,
        folder,
        sessionId: "01JDSESSION000000000000000",
        instruments: {
          add: (instrument) => void listed.push(instrument.id),
          updated: () => {},
          output: () => {},
          remove: () => {},
        },
      })),
  }
  onTestFinished(async () => {
    await exitAll(ctx)
    await state.shell?.close()
  })
  /** save_access on `files`, as the model calls it. */
  const save = (files: { script: string; notes: string; risks: readonly string[] }) =>
    Promise.resolve(saveAccess({ ...files, risks: [...files.risks] }, "r/learn/1/0", host)) as Promise<string>
  return { dir, fake, ctx, state, cards, listed, host, save, folder }
}

/** What `promise` rejects with; fails the test when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

/** The model's API key a learning run is given. */
export const KEY = "sk-ant-test-0123456789abcdef"
/** notes.md as the agent would write it. */
export const NOTES = "Log in to login1, then find the job's node with squeue.\n"

/** A learning run whose owner answers `answers`, HQ's machine reached as node1 through login1, and a free port; in
 *  folder `name` with `wanted` as the destination's name, as `learning` takes them. */
export async function chain(
  answers: (CardAnswer | "dontAsk")[],
  behavior: FakeSshBehavior = {},
  where: { name?: string; wanted?: string | null } = {},
) {
  const port = await freePort()
  const run = await learning(answers, { behavior, port, ...where })
  const remote = await fakeRemote(run.dir)
  const spec: Spec = { host: "node1", jump: ["login1"], opencorp: remote.opencorp }
  return { ...run, remote, spec, port }
}

/** learnProvider's options with the fake subscription; `checked` gets each provider the model check is given. */
export function subscribed() {
  const checked: Provider[] = []
  const options = {
    listers: NO_LISTING,
    auth: fakeSubscription().auth,
    checkModel: async (p: Provider) => {
      checked.push(p)
      return null
    },
  }
  return { checked, options }
}

/** The model a ChatGPT subscription's provider.json names. */
export const SUBSCRIBED_LLM = { provider: "openai", model: "gpt-5.5-codex" }

/** Subscription tokens for `name`, expiring `inSeconds` from now. */
export function tokens(name: string, inSeconds: number): OAuthCredentials {
  return new OAuthCredentials({
    accessToken: `${name}-access-0123456789`,
    refreshToken: `${name}-refresh-0123456789`,
    expiresAt: Date.now() / 1000 + inSeconds,
    accountId: ACCOUNT,
  })
}

/** The line a failed visit adds for `host`, whose ssh config sets `options`. */
export const named = (options: string, host: string) =>
  `opencorp hq: your ssh config sets ${options} for ${host}, which a visit can't work with; see https://opencorp.readthedocs.io/hq/#troubleshooting`

/** An include for the owner's ssh config, where the fake reads its `userConfig`; nothing is at the path. */
export const ownerConfig = (dir: string) => path.join(dir, "owner_ssh_config")

/** A connection spec reach.sh may print. */
export const SPEC = { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }

/** Writes `body` as the approved reach.sh: the script and its sha256 in access.json. */
export async function approved(paths: ReachPaths, body: string): Promise<void> {
  await writePrivate(paths.script, body)
  await writePrivate(paths.approved, body)
  await writeAccess(paths, {
    port: DEFAULT_PORT,
    sha256: sha256(body),
    learned_at: "2026-11-11T10:00:00.000Z",
    last_used_at: null,
    signed_in_at: null,
    cm: paths.cmId!,
  })
}
