/** A real office on a temp home, for the client packages' tests and the TUI's `bun run dev`: `opencorp init` through
 *  the checkout wrapper starts it in the background, its model a `FakeLLM` in this process. Callers register
 *  `stop()` in `onTestFinished` or `afterAll`. It never touches `~/.opencorp`: `--home` and `OPENCORP_HOME` always
 *  name the temp home. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OfficePaths } from "../daemon/office.ts"
import { CHECKOUT } from "../hq/version.ts"
import { args } from "../install/proc.ts"
import { FakeLLM, LLM_CONFIG } from "./fake_llm.ts"

const OPENCORP = path.join(CHECKOUT, "packages/cli/bin/opencorp")
// The caller's own session (a Codex override, an SSH login) would change what init sets up; Bun's and Node's
// options would change how the office runs.
const DROPPED = new Set(["NODE_OPTIONS", "OPENCORP_CODEX_BIN", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])

/** A command's exit code (null when a signal ended it) and output. */
export interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

/** The `ps` binary: /bin/ps on macOS, /usr/bin/ps on some Linux images. */
function psBinary(): string {
  const found = ["/bin/ps", "/usr/bin/ps"].find((file) => fs.existsSync(file))
  if (found === undefined) throw new Error("a test office needs ps at /bin/ps or /usr/bin/ps")
  return found
}

/** Sends `sig` to `pid`; a process that went meanwhile (ESRCH) is ignored. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}

/** Polls every 50 ms until `done()` or `timeout` ms pass; true when it was done. */
async function until(done: () => boolean, timeout: number): Promise<boolean> {
  const deadline = performance.now() + timeout
  for (;;) {
    if (done()) return true
    if (performance.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The pids of every process, other than this one, whose command line contains `root`. */
function under(root: string, ps: string): number[] {
  return execFileSync(ps, ["-wwaxo", "pid=,command="], { env: { LC_ALL: "C.UTF-8" }, encoding: "utf8", timeout: 5000 })
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid !== process.pid)
}

/** Runs `argv` in `cwd` with `env` and `input` on stdin (none when undefined); resolves with its exit code and
 *  output, killing it after `timeout` ms. Async, since the fake LLM it may call answers from this process. */
function run(
  argv: string[],
  { cwd, env, input, timeout }: { cwd: string; env: Record<string, string>; input?: string; timeout: number },
): Promise<Ran> {
  const stdin = input === undefined ? "ignore" : "pipe"
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: [stdin, "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout!.setEncoding("utf8")
  child.stderr!.setEncoding("utf8")
  child.stdout!.on("data", (chunk) => (stdout += chunk))
  child.stderr!.on("data", (chunk) => (stderr += chunk))
  if (child.stdin) {
    // A command that exits before reading stdin, or fails to spawn, reports through `close` or `error` instead.
    child.stdin.on("error", () => {})
    child.stdin.end(input)
  }
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

/** A started office on the temp home `root/h`, and how to reach and stop it. */
export class TestOffice {
  /** The temp folder (real path, under /tmp) holding the home; gone after `stop()`. */
  readonly root: string
  readonly home: string
  /** The office's unix socket. */
  readonly socket: string
  /** HQ's unix socket. */
  readonly hqSocket: string
  /** The office's model; init's model check is done and forgotten. */
  readonly llm: FakeLLM
  /** The environment the office and `opencorp()` run with. */
  readonly env: Record<string, string>
  /** The device token from `identity.json` for an office started with `device`; else undefined. */
  token: string | undefined
  readonly #ps: string
  readonly #pidfile: string
  #stopped: Promise<void> | undefined

  constructor(root: string, llm: FakeLLM, ps: string) {
    this.root = root
    this.home = path.join(root, "h")
    const paths = new OfficePaths(this.home)
    this.socket = paths.socket
    this.hqSocket = path.join(paths.office, "hq.sock")
    this.#pidfile = paths.pidfile
    this.llm = llm
    this.#ps = ps
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("GIT_") || key.startsWith("BUN_") || DROPPED.has(key)) continue
      env[key] = value
    }
    this.env = {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      OPENCORP_HOME: this.home,
      OPENCORP_BUN: process.execPath,
    }
  }

  /** Runs `opencorp <argv>` through the checkout wrapper with `env`, in `cwd` (default the home); killed after 90 s. */
  opencorp(argv: string[], { cwd = this.home }: { cwd?: string } = {}): Promise<Ran> {
    return run([OPENCORP, ...argv], { cwd, env: this.env, timeout: 90_000 })
  }

  /** Stops the office (SIGTERM, SIGKILL after 15 s), kills every process naming `root`, closes the fake LLM and
   *  removes `root`. A second call returns the first call's promise. */
  stop(): Promise<void> {
    this.#stopped ??= this.#stop()
    return this.#stopped
  }

  async #stop(): Promise<void> {
    let pid = Number.NaN
    try {
      pid = Number.parseInt(fs.readFileSync(this.#pidfile, "utf8"), 10)
    } catch {}
    // The pid may have been reused by another process: signal it only while its command line names this home.
    const ours = () => args(pid, this.#ps)?.includes(this.home) ?? false
    if (ours()) {
      signal(pid, "SIGTERM")
      if (!(await until(() => !ours(), 15_000)) && ours()) signal(pid, "SIGKILL")
    }
    for (const other of under(this.root, this.#ps)) signal(other, "SIGKILL")
    await until(() => under(this.root, this.#ps).length === 0, 5000)
    await this.llm.close()
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

/** Starts a real office on a fresh temp home through `opencorp init`, with `hq` as its `office/hq.json` and, unless
 *  `device`, no device listed for the CEO (Ngoc, @ngocbh, of Acme). Stops it and rethrows when init fails. */
export async function startOffice({
  hq = { tcp: false },
  device = false,
}: { hq?: unknown; device?: boolean } = {}): Promise<TestOffice> {
  const ps = psBinary()
  // Short, for the socket paths: macOS caps a unix socket's path at 104 bytes.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  let llm: FakeLLM
  try {
    llm = await FakeLLM.start()
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
  const office = new TestOffice(root, llm, ps)
  try {
    fs.mkdirSync(path.join(office.home, "office"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(office.home, "office", "hq.json"), JSON.stringify(hq))
    llm.script({ content: "OK", match: "Reply with the single word OK." })
    const argv = [
      OPENCORP,
      "init",
      "--home",
      office.home,
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
    ]
    const input = JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() })
    const init = await run(argv, { cwd: office.home, env: office.env, input, timeout: 120_000 })
    if (init.code !== 0 || !init.stdout.includes("with you as CEO and Minh (@minh)"))
      throw new Error(`opencorp init exited ${init.code}:\n${init.stdout}${init.stderr}`)
    llm.forget()
    if (device) office.token = JSON.parse(fs.readFileSync(path.join(office.home, "identity.json"), "utf8")).token
    return office
  } catch (error) {
    await office.stop()
    throw error
  }
}
