/** E2E helpers (Python's `tests/e2e/conftest.py` and `tests/e2e/fixtures/office.py`): a real office on a temp home,
 *  made by `opencorp init` through the checkout's wrapper with the fake LLM as its provider, driven over its socket
 *  as the TUI drives it, and a browser stand-in for HQ. Nothing touches the owner's home, a real Codex or a real
 *  service manager. */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { authorization, officeFetch } from "@opencorp/client"
import { readIdentity } from "@opencorp/client/node"
import { onTestFinished } from "bun:test"
import { OfficePaths } from "../../src/daemon/office.ts"
import { args } from "../../src/install/proc.ts"
import { FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { cwdOf, ps, psStat, waitFor } from "../helpers.ts"

export const REPO = path.resolve(import.meta.dirname, "../../../..")
/** The `opencorp` wrapper in this checkout; it runs the Bun from `OPENCORP_BUN` or `PATH`. */
export const OPENCORP = path.join(REPO, "packages/cli/bin/opencorp")
export const FAKE_CODEX = path.join(REPO, "packages/office/src/testing/fake_codex.ts")
const SERVICE_TOOLS = ["launchctl", "systemctl", "loginctl", "tmux"]
const SSH_VARS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
/** Python's `wait_for` default. */
const WAIT = 40_000
/** The pairing URL `opencorp hq` prints for HQ's TCP listener: its port and code. */
export const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/pair#([A-Za-z0-9_-]+)/

/** `s` single-quoted for sh. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Writes an executable sh script at `file`. */
function script(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 })
}

/** Makes a project folder at `p` with a README, and returns its realpath. */
export function folder(p: string): string {
  fs.mkdirSync(p)
  fs.writeFileSync(path.join(p, "README.md"), "# Demo\n\nStatus: TODO\n")
  return fs.realpathSync(p)
}

/** A model request's messages as JSON text. */
export function asked(request: Record<string, unknown>): string {
  return JSON.stringify(request.messages)
}

/** Whether `pid` is running; a zombie counts as gone. */
export function alive(pid: number): boolean {
  const stat = psStat(pid)
  return stat !== "" && !stat.startsWith("Z")
}

/** A finished command's exit code (null when killed) and output. */
export type Ran = { code: number | null; stdout: string; stderr: string }

/** Runs `argv` with `input` on stdin; resolves with its exit code and output, killing it after `timeout` ms. Async,
 *  since the fake LLM it may call answers from this process. */
export function run(
  argv: string[],
  {
    cwd,
    env,
    input = "",
    timeout = 120_000,
  }: { cwd: string; env: Record<string, string>; input?: string; timeout?: number },
): Promise<Ran> {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  // A command that exits before reading stdin, or fails to spawn, reports through `close` or `error` instead.
  child.stdin.on("error", () => {})
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** `ps -wwaxo <fields>`: one line per process. */
function listed(fields: string): string[] {
  const out = execFileSync(ps(), ["-wwaxo", fields], { env: { LC_ALL: "C.UTF-8" }, encoding: "utf8", timeout: 5000 })
  return out.split("\n")
}

/** The pids of every process, other than this one, whose command line contains `root`. */
function naming(root: string): number[] {
  return listed("pid=,command=")
    .filter((line) => line.includes(root))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid !== process.pid)
}

/** The pids of every process this user can see whose cwd is under `dir`: Linux `/proc/<pid>/cwd`; macOS one lsof
 *  call for all of them, as one per process would be slow. */
function within(dir: string): number[] {
  const prefix = dir + path.sep
  const found: number[] = []
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue
      try {
        if (fs.readlinkSync(`/proc/${name}/cwd`).startsWith(prefix)) found.push(Number(name))
      } catch {}
    }
    return found
  }
  // lsof exits non-zero when it can't read some process, so its output is read whatever its status.
  const out = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn"], {
    env: { LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    timeout: 10_000,
  }).stdout
  let pid = 0
  for (const line of (out ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && line.slice(1).startsWith(prefix)) found.push(pid)
  }
  return found
}

/** Stops the office on `<root>/h` (SIGTERM, then SIGKILL after 15 s), then SIGKILLs every process whose command
 *  names `root` or whose cwd is under it; fails if one is still listed after 5 s. */
async function stopAll(root: string): Promise<void> {
  const home = path.join(root, "h")
  const paths = new OfficePaths(home)
  if (fs.existsSync(paths.pidfile)) {
    const pid = Number.parseInt(fs.readFileSync(paths.pidfile, "utf8"), 10)
    // The pid may have been reused by another process: signal it only while its command line names this home.
    const ours = () => args(pid, ps())?.includes(home) ?? false
    // The office may exit between the check and the signal (ESRCH).
    if (ours()) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
      try {
        await waitFor(() => !ours(), { timeout: 15_000, what: "the office to stop" })
      } catch {
        try {
          if (ours()) process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }
  // A safety net: workers exit by themselves when their office goes.
  const left = () => [...new Set([...naming(root), ...within(root)])]
  for (const pid of left()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  await waitFor(() => left().length === 0, { timeout: 5000, what: "every process of the test to go" })
}

/** Starts an office on a fresh temp home, onboarded unless `onboard` is false, and stops it, its workers and the
 *  fake LLM when the current test finishes. `hq` is written as `office/hq.json` (HQ's TCP listener stays off by
 *  default: it is on by default on macOS, where the owner's own office holds its port). `PATH` starts with refusing
 *  stand-ins for the service tools, so no test registers a real service, and the fake Codex as `codex`, run with
 *  `codexScript` when given. Call inside a test. */
export async function openOffice({
  hq = { tcp: false },
  device = false,
  onboard = true,
  codexScript,
}: {
  hq?: Record<string, unknown>
  device?: boolean
  onboard?: boolean
  codexScript?: unknown
} = {}): Promise<RunningOffice> {
  // Short, for the unix sockets under it (macOS caps their paths at 104 bytes).
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const calls = path.join(root, "calls.log")
  let llm: FakeLLM | undefined
  // One hook, registered first, so it runs even if the setup below fails; a hook, not a finally, as a test that
  // times out skips its finally but still runs and awaits this.
  onTestFinished(async () => {
    try {
      await stopAll(root)
    } finally {
      try {
        if (fs.existsSync(calls)) throw new Error(`a test ran a real service tool:\n${fs.readFileSync(calls, "utf8")}`)
      } finally {
        try {
          await llm?.close()
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }
    }
  })
  const home = path.join(root, "h")
  const paths = new OfficePaths(home)
  fs.mkdirSync(paths.office, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(paths.office, "hq.json"), JSON.stringify(hq))

  const tools = path.join(root, "tools", "bin")
  fs.mkdirSync(tools, { recursive: true })
  for (const name of SERVICE_TOOLS) script(path.join(tools, name), `echo "${name} $*" >> ${q(calls)}\nexit 1\n`)
  const codexDir = path.join(root, "codex")
  fs.mkdirSync(codexDir)
  let scripted = ""
  if (codexScript !== undefined) {
    const file = path.join(codexDir, "script.json")
    fs.writeFileSync(file, JSON.stringify(codexScript))
    scripted = ` --script ${q(file)} --log ${q(path.join(codexDir, "rpc.jsonl"))}`
  }
  // Bun in a fixed cwd and env, reading no .env or bunfig.toml there.
  script(
    path.join(tools, "codex"),
    `cd ${q(codexDir)} || exit 1\n` +
      `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=${q(codexDir)} ${q(process.execPath)} --no-install ` +
      `--no-env-file --config=/dev/null ${q(FAKE_CODEX)}${scripted} "$@"\n`,
  )

  llm = await FakeLLM.start()
  const env = gitEnv(process.env)
  // The CLI runs as from a local terminal with no Codex override, whatever this process was started with.
  for (const name of ["OPENCORP_CODEX_BIN", ...SSH_VARS]) delete env[name]
  Object.assign(env, {
    PATH: [tools, process.env.PATH].filter(Boolean).join(":"),
    OPENCORP_HOME: home,
    OPENCORP_BUN: process.execPath,
  })
  const office = new RunningOffice(root, llm, env)
  if (onboard) await office.onboard({ device })
  return office
}

/** An office daemon on `<root>/h` whose provider is `llm`, driven over its unix socket. */
export class RunningOffice {
  readonly root: string
  readonly home: string
  readonly llm: FakeLLM
  readonly paths: OfficePaths
  /** The env every CLI run gets. */
  readonly env: Record<string, string>
  /** This device's token, sent with every request once `onboard({ device: true })` registered the device. */
  token?: string

  constructor(root: string, llm: FakeLLM, env: Record<string, string>) {
    this.root = root
    this.home = path.join(root, "h")
    this.llm = llm
    this.paths = new OfficePaths(this.home)
    this.env = env
  }

  /** Makes Acme with Ngoc as CEO and Minh as its first teammate, and the office as a background process, by running
   *  `opencorp init` through the wrapper. With `device`, init registers this device, and its token goes with every
   *  request. */
  async onboard({ device = false }: { device?: boolean } = {}): Promise<void> {
    const provider = { llm_config: LLM_CONFIG, env: this.llm.env() }
    this.llm.script({ content: "OK", match: "Reply with the single word OK." }) // init's model check
    const done = await run(
      [
        OPENCORP,
        "init",
        "--home",
        this.home,
        "--provider-stdin",
        "--company",
        "Acme",
        "--name",
        "Ngoc",
        "--handle",
        "ngocbh",
        "--service",
        "background",
        ...(device ? [] : ["--no-device"]),
      ],
      { cwd: this.home, env: this.env, input: JSON.stringify(provider) },
    )
    if (done.code !== 0 || !done.stdout.includes("with you as CEO and Minh (@minh)"))
      throw new Error(`opencorp init exited ${done.code}:\n${done.stdout}${done.stderr}`)
    this.llm.forget() // tests count the office's model calls from the first
    if (device) {
      // The client's identityPath() reads OPENCORP_HOME from this process's env, which a test never changes.
      const file = path.join(this.home, "identity.json")
      const identity = readIdentity(file)
      if (identity === undefined) throw new Error(`init left no identity at ${file}`)
      this.token = identity.token
    }
  }

  /** Sends `method path` to the office, with `body` as JSON and this device's token unless `anonymous`. */
  request(method: string, target: string, { body, anonymous = false }: { body?: unknown; anonymous?: boolean } = {}) {
    const headers: Record<string, string> = anonymous ? {} : authorization(this.token)
    if (body !== undefined) headers["content-type"] = "application/json"
    return officeFetch({ socket: this.paths.socket }, target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A stuck office fails the test instead of hanging it.
      signal: AbortSignal.timeout(30_000),
    })
  }

  /** The JSON body of `method path`; throws `<METHOD> <path>: <status> <body>` on an error status. */
  async #json(method: string, target: string, body?: unknown): Promise<any> {
    const reply = await this.request(method, target, { body })
    const text = await reply.text()
    if (!reply.ok) throw new Error(`${method} ${target}: ${reply.status} ${text}`)
    return JSON.parse(text)
  }

  /** GET `target` with `params` as its query. */
  get(target: string, params?: Record<string, string>): Promise<any> {
    return this.#json("GET", params ? `${target}?${new URLSearchParams(params)}` : target)
  }

  /** POST `body` to `target`. */
  post(target: string, body?: unknown): Promise<any> {
    return this.#json("POST", target, body)
  }

  /** PUT `body` to `target`. */
  put(target: string, body: unknown): Promise<any> {
    return this.#json("PUT", target, body)
  }

  /** HQ's status as `opencorp hq` and `opencorp doctor` read it: `GET /hq` on the office socket. */
  hqStatus(): Promise<any> {
    return this.get("/hq")
  }

  /** `handle`, once the office lists a person with it; throws otherwise. */
  async person(handle: string): Promise<string> {
    const people: { handle: string }[] = await this.get("/people")
    const found = people.find((p) => p.handle === handle)
    if (found === undefined) throw new Error(`the office lists no @${handle}`)
    return found.handle
  }

  /** The handles the picker offers first in `cwd`: who has had a session there. */
  async folderPeople(cwd: string): Promise<string[]> {
    const people: { handle: string }[] = await this.get(`/folders/${encodeURIComponent(cwd)}/people`)
    return people.map((p) => p.handle)
  }

  /** Session `sid` as the office reports it. */
  session(sid: string): Promise<any> {
    return this.get(`/sessions/${sid}`)
  }

  /** Session `sid`'s status, such as `starting`, `idle` or `busy`. */
  async status(sid: string): Promise<string> {
    return (await this.session(sid)).status
  }

  /** The `kind` parts of session `sid`'s `role` messages, oldest first. */
  async #parts(sid: string, role: string, kind: string): Promise<any[]> {
    const messages: { role: string; parts: { type: string }[] }[] = await this.get(`/sessions/${sid}/messages`)
    return messages.filter((m) => m.role === role).flatMap((m) => m.parts.filter((p) => p.type === kind))
  }

  /** The text of Minh's replies in session `sid`, oldest first. */
  async texts(sid: string): Promise<string[]> {
    return (await this.#parts(sid, "assistant", "text")).map((p) => p.text)
  }

  /** The text of the owner's messages in session `sid`, oldest first. */
  async users(sid: string): Promise<string[]> {
    return (await this.#parts(sid, "user", "text")).map((p) => p.text)
  }

  /** Each tool part in session `sid` as `[tool, state]`. */
  async tools(sid: string): Promise<[string, string][]> {
    return (await this.#parts(sid, "assistant", "tool")).map((p) => [p.tool, p.state])
  }

  /** Starts a session as the TUI's new chat does and returns its id; with `wait`, waits until it is idle. The TUI
   *  sends the first message at once, while the session is still starting. */
  async startChat(person: string, cwd: string, { wait = true }: { wait?: boolean } = {}): Promise<string> {
    const sid: string = (await this.post("/sessions", { person, cwd })).id
    const idle = async () => (await this.status(sid)) === "idle"
    if (wait) await waitFor(idle, { timeout: WAIT, what: `session ${sid} to start` })
    return sid
  }

  /** Sends `text` as the TUI does every message: a turn when idle, a steer when busy. */
  prompt(sid: string, text: string): Promise<any> {
    return this.post(`/sessions/${sid}/prompt`, { text })
  }

  /** Waits until the office has seen Minh's reply start in session `sid`: the newest message is his. */
  async replying(sid: string): Promise<void> {
    // A prompt steers only once the office has handled the reply's start frame, which can arrive just after the
    // model request does.
    await waitFor(async () => (await this.get(`/sessions/${sid}/messages`)).at(-1)?.role === "assistant", {
      timeout: WAIT,
      what: `session ${sid}'s reply to start`,
    })
  }

  /** Esc in the TUI. */
  interrupt(sid: string): Promise<any> {
    return this.post(`/sessions/${sid}/interrupt`)
  }

  /** Waits until session `sid` is idle with exactly `texts` as Minh's replies. */
  async settled(sid: string, texts: string[]): Promise<void> {
    const want = JSON.stringify(texts)
    await waitFor(
      async () => (await this.status(sid)) === "idle" && JSON.stringify(await this.texts(sid)) === want,
      { timeout: WAIT, what: `replies ${want}` },
    )
  }

  /** Waits until session `sid`'s status is `ended`. */
  async ended(sid: string): Promise<void> {
    await waitFor(async () => (await this.status(sid)) === "ended", { timeout: WAIT, what: `session ${sid} to end` })
  }

  /** Runs `opencorp <args>` in `cwd` against this office and waits for it; with `check`, throws on a non-zero exit.
   *  With `ssh`, the CLI runs as from an SSH login. */
  async opencorp(
    argv: string[],
    { cwd, check = true, ssh = false }: { cwd: string; check?: boolean; ssh?: boolean },
  ): Promise<Ran> {
    const env = ssh ? { ...this.env, SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" } : this.env
    const done = await run([OPENCORP, ...argv], { cwd, env, timeout: 90_000 })
    if (check && done.code !== 0) throw new Error(`opencorp ${argv.join(" ")}: ${done.stdout}${done.stderr}`)
    return done
  }

  /** The company repo's commit subjects, newest first. */
  gitLog(): string[] {
    return git(this.paths.company, "log", "--format=%s").split("\n").filter(Boolean)
  }

  /** The pid in the office's pidfile. */
  pid(): number {
    return Number.parseInt(fs.readFileSync(this.paths.pidfile, "utf8"), 10)
  }

  /** The pid of session `sid`'s live worker: the office's child running in `office/sessions/<sid>/`. Skips zombies
   *  and the child whose pid is `otherThan`, so a just-killed worker is never returned. */
  worker(sid: string, { otherThan }: { otherThan?: number } = {}): Promise<number> {
    const dir = this.paths.sessionDir(sid)
    return waitFor(
      () => {
        const office = this.pid()
        for (const line of listed("pid=,ppid=,stat=")) {
          const [first = "", ppid, stat = ""] = line.trim().split(/\s+/)
          const pid = Number(first)
          if (Number(ppid) !== office || !pid || pid === otherThan || stat.startsWith("Z")) continue
          try {
            if (cwdOf(pid) === dir) return pid
          } catch {
            // The child exited meanwhile.
          }
        }
        return undefined
      },
      { timeout: WAIT, what: `session ${sid}'s worker` },
    )
  }

  /** SIGKILLs the office, as a crash would; returns its pid. */
  async killOffice(): Promise<number> {
    const pid = this.pid()
    process.kill(pid, "SIGKILL")
    await waitFor(() => !alive(pid), { timeout: WAIT, what: "the office to die" })
    return pid
  }

  /** Stops the office and any worker or other process of this test left behind. */
  stop(): Promise<void> {
    return stopAll(this.root)
  }
}

/** HQ's status once its TCP listener is up. */
export function waitListening(office: RunningOffice): Promise<any> {
  return waitFor(
    async () => {
      const status = await office.hqStatus()
      return status.tcp.listening && status
    },
    { timeout: 10_000, what: "HQ's TCP listener" },
  )
}

/** A reply to a `Browser` request, its body read in full: `body` as received, `text` that body decoded as UTF-8. */
export type BrowserReply = {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  text: string
  json(): any
}

/** A browser stand-in for HQ at `origin` (Python's `web()` and `over_hq_sock()`): same-origin requests with cookies
 *  kept, over TCP to `origin`, or over `socket` (hq.sock through an SSH forward whose local end is `origin`). */
export class Browser {
  readonly origin: string
  readonly #socket?: string
  readonly #jar = new Map<string, string>()

  constructor(origin: string, { socket }: { socket?: string } = {}) {
    this.origin = origin
    this.#socket = socket
  }

  /** The names of the cookies kept. */
  cookies(): string[] {
    return [...this.#jar.keys()]
  }

  /** GET `target` with `params` as its query; `headers` override the browser's own. */
  get(
    target: string,
    { params, headers = {} }: { params?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<BrowserReply> {
    return this.#send("GET", params ? `${target}?${new URLSearchParams(params)}` : target, headers)
  }

  /** POST `json` to `target`. */
  post(target: string, json: unknown): Promise<BrowserReply> {
    return this.#send("POST", target, { "content-type": "application/json" }, JSON.stringify(json))
  }

  /** The first line of the stream at `target`; the stream is then cut. */
  firstLine(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(this.#options("GET", target, {}), (res) => {
        this.#keep(res)
        res.setEncoding("utf8")
        // Cutting the stream below makes it error with nobody reading it.
        res.on("error", () => {})
        let seen = ""
        res.on("data", (chunk: string) => {
          seen += chunk
          const end = seen.indexOf("\n")
          if (end < 0) return
          resolve(seen.slice(0, end).replace(/\r$/, ""))
          req.destroy()
        })
        res.on("end", () => resolve(seen))
      })
      req.on("timeout", () => req.destroy(new Error(`GET ${target} timed out`)))
      req.on("error", reject)
      req.end()
    })
  }

  /** Opens the stream at `target`: `connected` resolves with its first line, `ended` once the stream ends or its
   *  connection closes. The stream is cut when the current test finishes. */
  stream(target: string): { connected: Promise<string>; ended: Promise<void> } {
    let ended!: () => void
    const done = new Promise<void>((resolve) => (ended = resolve))
    const connected = new Promise<string>((resolve, reject) => {
      // No timeout: the stream stays open until the office ends it.
      const req = http.request({ ...this.#options("GET", target, {}), timeout: undefined }, (res) => {
        res.setEncoding("utf8")
        res.on("error", () => {})
        let seen = ""
        res.on("data", (chunk: string) => {
          seen += chunk
          const end = seen.indexOf("\n")
          if (end >= 0) resolve(seen.slice(0, end))
        })
        res.on("end", ended)
        res.on("close", ended)
      })
      onTestFinished(() => req.destroy())
      req.on("error", (error) => {
        ended()
        reject(error)
      })
      req.end()
    })
    return { connected, ended: done }
  }

  /** The `node:http` options for `method target`: the browser's Host, Origin and cookies, then `headers`. */
  #options(method: string, target: string, headers: Record<string, string>): http.RequestOptions {
    const url = new URL(this.origin)
    const cookie = [...this.#jar].map(([name, value]) => `${name}=${value}`).join("; ")
    return {
      ...(this.#socket === undefined ? { host: url.hostname, port: url.port } : { socketPath: this.#socket }),
      method,
      path: target,
      agent: false,
      timeout: 10_000,
      headers: { host: url.host, origin: this.origin, ...(cookie ? { cookie } : {}), ...headers },
    }
  }

  /** Keeps the cookies `res` sets, and drops the ones it expires. */
  #keep(res: http.IncomingMessage): void {
    for (const line of res.headers["set-cookie"] ?? []) {
      const [pair = "", ...attributes] = line.split(";")
      const name = pair.slice(0, pair.indexOf("=")).trim()
      if (attributes.some((a) => /^\s*max-age\s*=\s*(0|-)/i.test(a))) this.#jar.delete(name)
      else this.#jar.set(name, pair.slice(pair.indexOf("=") + 1).trim())
    }
  }

  /** Sends `method target` with `payload` and resolves with the whole reply, keeping its cookies. */
  #send(method: string, target: string, headers: Record<string, string>, payload?: string): Promise<BrowserReply> {
    return new Promise((resolve, reject) => {
      const req = http.request(this.#options(method, target, headers), (res) => {
        this.#keep(res)
        const parts: Buffer[] = []
        res.on("data", (part: Buffer) => parts.push(part))
        res.on("error", reject)
        res.on("end", () => {
          const body = Buffer.concat(parts)
          const text = body.toString()
          resolve({ status: res.statusCode!, headers: res.headers, body, text, json: () => JSON.parse(text) })
        })
      })
      req.on("timeout", () => req.destroy(new Error(`${method} ${target} timed out`)))
      req.on("error", reject)
      req.end(payload)
    })
  }
}
