// A client machine for `opencorp hq` from another machine, in tests: a home with an approved reach.sh that reaches a
// real test office through the fake ssh (node1 through login1), and the CLI run through the checkout wrapper.
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "@opencorp/office/testing/fake_ssh"
import type { TestOffice } from "@opencorp/office/testing/office"

export const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)))
export const WRAPPER = path.join(CHECKOUT, "packages/cli/bin/opencorp")

/** A built web app in `dir` (an index page and its build.json), so the office's health names a build. */
export function builtApp(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>HQ</title>\n")
  fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ build: "b1", api: "x" }))
  return dir
}

/** A port free on 127.0.0.1 a moment ago. */
export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** reach.sh for `office`: log in to login1 (leaving its master, which the node's hop rides), then print the spec. */
export function reachScript(office: TestOffice): string {
  const spec = {
    host: "node1",
    jump: ["login1"],
    opencorp: WRAPPER,
    env: { OPENCORP_HOME: office.home, OPENCORP_BUN: process.execPath },
  }
  return `set -eu\nssh login1 true\nprintf '%s\\n' '${JSON.stringify(spec)}'\n`
}

/** The client: `root/c` is its OPENCORP_HOME, with reach.sh (approved unless `approved` is false, with access.json
 *  on a free port) and the fake ssh in `root/fake` first on PATH. */
export interface Client {
  readonly root: string
  readonly home: string
  readonly hq: string
  readonly cm: string
  readonly port: number
  readonly fake: FakeSsh
  /** The environment the CLI runs with: nothing else of this process's. */
  readonly env: Record<string, string>
}

export async function client(
  office: TestOffice,
  { behavior = {}, approved = true }: { behavior?: FakeSshBehavior; approved?: boolean } = {},
): Promise<Client> {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const fake = installFakeSsh(path.join(root, "fake"), behavior)
  const home = path.join(root, "c")
  const hq = path.join(home, "hq")
  fs.mkdirSync(hq, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  const body = reachScript(office)
  fs.writeFileSync(path.join(hq, "reach.sh"), body, { mode: 0o600 })
  const port = await freePort()
  if (approved) {
    fs.writeFileSync(path.join(hq, "reach.approved.sh"), body, { mode: 0o600 })
    const access = {
      port,
      sha256: createHash("sha256").update(body).digest("hex"),
      learned_at: new Date().toISOString(),
      last_used_at: null,
      signed_in_at: null,
    }
    fs.writeFileSync(path.join(hq, "access.json"), JSON.stringify(access), { mode: 0o600 })
  }
  const env = { PATH: `${fake.bin}:/usr/bin:/bin`, HOME: root, OPENCORP_HOME: home, OPENCORP_BUN: process.execPath }
  return { root, home, hq, cm: path.join(hq, "cm"), port, fake, env }
}

/** Kills what's left of `c` (its fake masters, then any process naming its folder) and removes it. */
export function removeClient(c: Client): void {
  for (const pid of [...c.fake.masters(), ...pidsNaming(c.root)]) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  fs.rmSync(c.root, { recursive: true, force: true })
}

/** The pids of this user's processes, other than this one and `ps`, whose command line holds `text`. */
export function pidsNaming(text: string): number[] {
  const ps = ["/bin/ps", "/usr/bin/ps"].find((file) => fs.existsSync(file))!
  return execFileSync(ps, ["-A", "-o", "pid=,args="], { env: { LC_ALL: "C" }, encoding: "utf8", timeout: 5000 })
    .split("\n")
    .filter((line) => line.includes(text) && !line.includes(" -o pid=,args="))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid !== process.pid)
}

/** A running `opencorp hq`: its output so far, a wait for a line, and its exit. */
export interface Running {
  readonly child: ChildProcess
  stdout(): string
  stderr(): string
  /** Resolves once stdout or stderr holds `text`; rejects after `ms` or when it exits first. */
  waitFor(text: string | RegExp, ms?: number): Promise<void>
  readonly exited: Promise<number | null>
}

/** Runs `opencorp hq <args>` through the wrapper with exactly `env`, stdin a pipe held open; killed after 90 s. */
export function runHq(env: Record<string, string>, args: string[], cwd: string): Running {
  const child = spawn(WRAPPER, ["hq", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c))
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c))
  child.stdin!.on("error", () => {})
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code)
    }),
  )
  let done = false
  void exited.then(() => (done = true))
  const has = (text: string | RegExp) => {
    const both = out + err
    return typeof text === "string" ? both.includes(text) : text.test(both)
  }
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    async waitFor(text, ms = 30_000) {
      const deadline = performance.now() + ms
      while (!has(text)) {
        if (done) throw new Error(`opencorp hq exited before printing ${text}:\n${out}${err}`)
        if (performance.now() > deadline) throw new Error(`no ${text} within ${ms} ms:\n${out}${err}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}
