// A client machine for `opencorp hq` from another machine, in tests: a home with an approved reach.sh that reaches a
// real test office through the fake ssh (node1 through login1), and the CLI run through the checkout wrapper. The fake
// is compiled and lives outside the home, in a folder the visit's env names, so the agent's sandbox can run it.
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cmIdOf } from "@opencorp/office/features/reach/paths"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "@opencorp/office/testing/fake_ssh"
import type { TestOffice } from "@opencorp/office/testing/office"

export const CHECKOUT = fs.realpathSync(fileURLToPath(new URL("../../..", import.meta.url)))
export const WRAPPER = path.join(CHECKOUT, "packages/cli/bin/opencorp")
/** The fake ssh's source. */
const FAKE_SOURCE = path.join(CHECKOUT, "packages/office/src/testing/fake_ssh.ts")
/** The variable naming the fake's folder, which the agent's sandbox binds (the office's `TEST_SSH_DIR`). */
export const TEST_SSH_DIR = "OPENCORP_TEST_SSH_DIR"

/** Compiles the fake ssh (`bun build --compile`) into `dir`, a private folder of the client's own, so the agent's
 *  sandbox runs it with neither Bun nor the checkout; returns the program. Never at a path another user could make
 *  first, and gone with the client. */
export function compileFake(dir: string): string {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) {
    throw new Error(`the fake ssh's folder ${dir} isn't this user's own private folder`)
  }
  const program = path.join(dir, "fake_ssh.build")
  // Its own folder as its home and cwd: no bunfig or .env of the checkout's, and nothing written to the real home.
  execFileSync(process.execPath, ["build", "--compile", FAKE_SOURCE, "--outfile", program], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  })
  return program
}

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

/** The client: `root` is its HOME and `root/c` its OPENCORP_HOME, with destination `dest` (`hq/login1`, named after
 *  its login host as a first learn names it) saved with reach.sh for `office` (approved unless `approved` is false,
 *  with access.json on a free port; none with `office` null, only a 0700 hq folder), its control sockets in `cm`, and
 *  the fake ssh in `fakeDir`, a 0700 `/tmp/oc-f-XXXX` outside the home, first on PATH and named by
 *  `OPENCORP_TEST_SSH_DIR`: compiled there with `compiled`, for the agent's sandbox to run. */
export interface Client {
  readonly root: string
  readonly fakeDir: string
  readonly home: string
  readonly hq: string
  readonly dest: string
  /** Its control-socket folder; null with `office` null. */
  readonly cm: string | null
  readonly port: number
  readonly fake: FakeSsh
  /** The environment the CLI runs with: nothing else of this process's. */
  readonly env: Record<string, string>
}

export async function client(
  office: TestOffice | null,
  {
    behavior = {},
    approved = true,
    compiled = false,
  }: { behavior?: FakeSshBehavior; approved?: boolean; compiled?: boolean } = {},
): Promise<Client> {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const fakeDir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-f-"))
  fs.chmodSync(fakeDir, 0o700)
  const program = compiled ? compileFake(fakeDir) : undefined
  const fake = installFakeSsh(fakeDir, behavior, program === undefined ? {} : { program })
  // Linked into bin/: the build's own name goes.
  if (program !== undefined) fs.rmSync(program, { force: true })
  const home = path.join(root, "c")
  const hq = path.join(home, "hq")
  fs.mkdirSync(hq, { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  const port = await freePort()
  const dest = path.join(hq, "login1")
  const saved = office === null ? null : await destination(hq, "login1", office, { approved, port })
  return { root, fakeDir, home, hq, dest, cm: saved?.cm ?? null, port, fake, env: clientEnv(root, fake, fakeDir) }
}

/** Saves destination `name` in the client's `hq` folder, reaching `office`: reach.sh, approved unless `approved` is
 *  false, with access.json on `port` and `over` in it; resolves to its folder and its control-socket folder, as a
 *  visit finds it. */
export async function destination(
  hq: string,
  name: string,
  office: TestOffice,
  { approved = true, port, over = {} }: { approved?: boolean; port: number; over?: Record<string, unknown> },
): Promise<{ dir: string; cm: string }> {
  const dir = path.join(hq, name)
  fs.mkdirSync(dir, { mode: 0o700 })
  const id = cmIdOf(dir)
  const body = reachScript(office)
  fs.writeFileSync(path.join(dir, "reach.sh"), body, { mode: 0o600 })
  if (approved) {
    fs.writeFileSync(path.join(dir, "reach.approved.sh"), body, { mode: 0o600 })
    const access = {
      port,
      sha256: createHash("sha256").update(body).digest("hex"),
      learned_at: new Date().toISOString(),
      last_used_at: null,
      signed_in_at: null,
      cm: id,
      ...over,
    }
    fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify(access), { mode: 0o600 })
  }
  return { dir, cm: path.join(hq, `cm-${id}`) }
}

/** The environment the client's CLI runs with: nothing else of this process's. */
function clientEnv(root: string, fake: FakeSsh, fakeDir: string): Record<string, string> {
  const home = path.join(root, "c")
  return {
    PATH: `${fake.bin}:/usr/bin:/bin`,
    HOME: root,
    OPENCORP_HOME: home,
    OPENCORP_BUN: process.execPath,
    [TEST_SSH_DIR]: fakeDir,
  }
}

/** Kills what's left of `c`, each process whose command line names one of its folders, and removes them. Never the
 *  fake's own record of its masters: inside the agent's sandbox it records pids of the sandbox's pid namespace. */
export function removeClient(c: Client): void {
  for (const pid of [...pidsNaming(c.root), ...pidsNaming(c.fakeDir)]) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  fs.rmSync(c.root, { recursive: true, force: true })
  fs.rmSync(c.fakeDir, { recursive: true, force: true })
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
