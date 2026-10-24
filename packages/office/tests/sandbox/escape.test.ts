/** Escape tests: what a sandboxed call must not reach, each one through `run.ts`. */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { helperCommand } from "../../src/platform.ts"
import { helperFiles, type SandboxPolicy } from "../../src/sandbox/policy.ts"
import { run } from "../../src/sandbox/run.ts"
import { shortDir } from "../helpers.ts"
import { envInChild, gone, helperTool, makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

const ON_MAC = process.platform === "darwin"
const ON_LINUX = process.platform === "linux"
const BUN = fs.realpathSync(process.execPath)
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

function sh(policy: SandboxPolicy, script: string) {
  return run(policy, ["/bin/sh", "-c", script], { timeout: 20 })
}

/** Runs `script` in the sandbox and returns its output and its exit status as the shell itself
 *  reports it (Python's `[exit N]` trailer), so a call that never ran can't pass as a refusal. */
async function shell(policy: SandboxPolicy, script: string) {
  const result = await sh(policy, `${script}\necho "[exit $?]"`)
  const stdout = result.stdout.toString()
  const output = stdout + result.stderr.toString()
  const trailer = stdout.match(/\[exit (\d+)\]\n$/)
  if (!trailer) throw new Error(`the call did not run: ${output}`)
  return { stdout: stdout.slice(0, trailer.index), output, exit: Number(trailer[1]) }
}

/** Runs `code` with Bun in the sandbox (Python's `py`); `policy` must expose Bun (see `bunPolicy`). */
async function bun(policy: SandboxPolicy, code: string): Promise<string> {
  const result = await run(policy, [BUN, ...BUN_FLAGS, "-e", code], { timeout: 20 })
  return result.stdout.toString() + result.stderr.toString()
}

/** A policy whose calls may run Bun. */
function bunPolicy(network = false): SandboxPolicy {
  return makePolicy().make({ network, readOnly: [BUN] })
}

/** The secrets and office state the sandbox must not reach, by path under the fake home. */
const DECOY_FILES: Record<string, string> = {
  ".config/yian/auth.json": '{"key": "sk-decoy-auth"}',
  ".ssh/id_ed25519": "decoy-ssh-key",
  ".aws/credentials": "decoy-aws",
  ".opencorp/office/store.sqlite": "decoy-store",
  ".opencorp/office/runs/r1/log.jsonl": "decoy-run-log",
  ".opencorp/office/secrets/cluster-a": "decoy-asset-secret",
  ".opencorp/company/people/minh/person.yaml": "decoy-repo",
}
const DECOYS = Object.keys(DECOY_FILES)

/** A fake home holding `DECOY_FILES` (no `HOME` change). */
function office(): string {
  const home = path.join(shortDir(), "home")
  for (const [rel, text] of Object.entries(DECOY_FILES)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    fs.writeFileSync(path.join(home, rel), text)
  }
  return home
}

/** A server listening at `address` outside the workspace, closed when the test finishes. It holds every
 *  connection open until then: a reset would make the client print `REFUSED` though it connected. */
async function listen(address: string | { host: string; port: number }): Promise<net.Server> {
  const held: net.Socket[] = []
  const server = net.createServer((socket) => {
    // A held socket can still error (a reset when the client exits); unhandled, that would throw.
    socket.on("error", () => {})
    held.push(socket)
  })
  onTestFinished(() => {
    for (const socket of held) socket.destroy()
    server.close()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    if (typeof address === "string") server.listen(address, resolve)
    else server.listen(address.port, address.host, resolve)
  })
  return server
}

/** Bun code that connects to `target` (a unix socket path, or a TCP port on 127.0.0.1) and prints
 *  `CONNECTED`, or `REFUSED` on an error or after 5 s whatever the socket's state (Python's `settimeout(5)`). */
function connectCode(target: string | number): string {
  const args = typeof target === "string" ? JSON.stringify(target) : `${target}, "127.0.0.1"`
  return [
    `const s = require("node:net").connect(${args})`,
    `setTimeout(() => { console.log("REFUSED timeout"); process.exit(0) }, 5000)`,
    `s.on("connect", () => { console.log("CONNECTED"); process.exit(0) })`,
    `s.on("error", (e) => { console.log("REFUSED", e.message); process.exit(0) })`,
  ].join("\n")
}

test.skipIf(!sandboxAvailable()).each(DECOYS)("cannot read owner or office files [%s]", async (rel) => {
  const home = office()
  const target = path.join(home, rel)
  const policy = makePolicy().make()
  const read = await shell(policy, `cat ${target}`)
  expect(read.output).not.toContain("decoy")
  expect(read.exit, `${target}: ${read.output}`).not.toBe(0)
  // The read_file and search tools, as the helper runs them under its profile.
  const file = await helperTool(policy, { op: "read_file", path: target })
  expect(JSON.stringify(file)).not.toContain("decoy")
  expect(file.ok, `${target}: ${JSON.stringify(file)}`).toBe(false)
  const found = await helperTool(policy, { op: "search", pattern: "decoy", path: home })
  expect(JSON.stringify(found)).not.toContain("decoy")
})

test.skipIf(!sandboxAvailable())("cannot list the real home", async () => {
  const policy = makePolicy().make()
  const home = fs.realpathSync(os.homedir())
  // The list_dir tool, as the helper runs it under its profile.
  const listing = await helperTool(policy, { op: "list", path: home })
  if (ON_MAC) {
    expect(listing.ok, `${home}: ${JSON.stringify(listing)}`).toBe(false)
  } else {
    // bwrap creates the home folders of mounted paths (the read-only ones, and the helper's own
    // files such as Bun under `.bun/`) as mount points, so those entries, and only those, may show.
    const mounted = [...policy.readOnly, ...helperFiles(helperCommand().helper)]
    const allowed = new Set(
      mounted.filter((p) => p.startsWith(home + "/")).map((p) => p.slice(home.length + 1).split("/")[0] + "/"),
    )
    const ok =
      !listing.ok ||
      listing.output === "(empty)" ||
      listing.output.split("\n").every((entry) => allowed.has(entry))
    expect(ok, JSON.stringify(listing)).toBe(true)
  }
})

const UNIX_CASES = ["tmux-501/default", "office/office.sock"].flatMap((name) =>
  [false, true].map((network) => [name, network] as const),
)

test.skipIf(!sandboxAvailable()).each(UNIX_CASES)("cannot connect to unix sockets [%s, network %p]", async (name, network) => {
  const socket = path.join(shortDir(), name)
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  await listen(socket)
  const out = await bun(bunPolicy(network), connectCode(socket))
  expect(out).toContain("REFUSED")
  expect(out).not.toContain("CONNECTED")
})

test.skipIf(!sandboxAvailable())("cannot write outside the workspace", async () => {
  const { ws, make } = makePolicy()
  const policy = make()
  const home = office()
  for (const target of [
    path.join(path.dirname(ws), "outside.txt"),
    path.join(shortDir(), "outside.txt"),
    path.join(home, ".ssh/authorized_keys"),
  ]) {
    const write = await helperTool(policy, { op: "write_file", path: target, content: "x" })
    expect(write.ok, `${target}: ${JSON.stringify(write)}`).toBe(false)
    const echo = await shell(policy, `echo x > ${target}`)
    expect(echo.exit, `${target}: ${echo.output}`).not.toBe(0)
    expect(fs.existsSync(target), target).toBe(false)
  }
  const escape = path.join(path.dirname(ws), "escape.txt")
  const relative = await helperTool(policy, { op: "write_file", path: "../escape.txt", content: "x" })
  expect(relative.ok, `${escape}: ${JSON.stringify(relative)}`).toBe(false)
  expect(fs.existsSync(escape), escape).toBe(false)
})

test.skipIf(!sandboxAvailable())("git hooks and config are read only", async () => {
  const { ws, make } = makePolicy()
  fs.mkdirSync(path.join(ws, ".git/hooks"), { recursive: true })
  fs.writeFileSync(path.join(ws, ".git/config"), "[core]\n")
  const policy = make()
  const hook = await helperTool(policy, { op: "write_file", path: ".git/hooks/pre-commit", content: "evil" })
  expect(hook.ok, `.git/hooks/pre-commit: ${JSON.stringify(hook)}`).toBe(false)
  const config = await helperTool(policy, { op: "edit_file", path: ".git/config", old: "[core]", new: "[core]\nhooksPath=x" })
  expect(config.ok, `.git/config: ${JSON.stringify(config)}`).toBe(false)
  // Renaming .git away (to plant a new hooks dir and rename it back) is denied too.
  const rename = await shell(policy, "mv .git .git2")
  expect(rename.exit, `.git: ${rename.output}`).not.toBe(0)
  expect(fs.existsSync(path.join(ws, ".git/hooks/pre-commit"))).toBe(false)
  expect(fs.readFileSync(path.join(ws, ".git/config"), "utf8")).toBe("[core]\n")
  // The rest of .git stays writable, so git itself works.
  const head = await helperTool(policy, { op: "write_file", path: ".git/HEAD", content: "ref: refs/heads/main\n" })
  expect(head, `.git/HEAD: ${JSON.stringify(head)}`).toEqual({ ok: true, output: "wrote 21 bytes to .git/HEAD" })
  expect(fs.readFileSync(path.join(ws, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
})

test.skipIf(!sandboxAvailable())("links do not escape", async () => {
  const policy = makePolicy().make()
  const secret = path.join(office(), ".ssh/id_ed25519")
  expect((await shell(policy, `ln -s ${path.dirname(secret)} sl; cat sl/id_ed25519`)).output).not.toContain("decoy")
  // The helper itself doesn't follow the planted link out either.
  const file = await helperTool(policy, { op: "read_file", path: "sl/id_ed25519" })
  expect(JSON.stringify(file)).not.toContain("decoy")
  expect(file.ok, JSON.stringify(file)).toBe(false)
  expect((await shell(policy, `ln ${secret} hard; cat hard`)).output).not.toContain("decoy")
})

test.skipIf(!sandboxAvailable()).each([false, true])("network only when allowed [network %p]", async (network) => {
  const server = await listen({ host: "127.0.0.1", port: 0 })
  const port = (server.address() as net.AddressInfo).port
  const out = await bun(bunPolicy(network), connectCode(port))
  if (network) {
    expect(out).toContain("CONNECTED")
  } else {
    expect(out).toContain("REFUSED")
    expect(out).not.toContain("CONNECTED")
  }
})

test.skipIf(!sandboxAvailable())("background process is dead after the call", async () => {
  // Kills a leftover even when an earlier assertion fails.
  onTestFinished(() => gone("4343"))
  const result = await sh(makePolicy().make(), "sleep 4343 >/dev/null 2>&1 & echo started")
  expect(result.stdout.toString()).toBe("started\n")
  expect(result.exit).toBe(0)
  expect(await gone("4343")).toBe(true)
})

test.skipIf(!sandboxAvailable())("no environment secrets", () => {
  const { ws, tmp } = makePolicy()
  // The secret is set in a child's env, since a test never changes its own.
  const child = envInChild(ws, tmp, { OPENCORP_API_KEY: "sk-office-secret" })
  expect(child.stderr).toBe("")
  expect(child.status).toBe(0)
  expect(child.stdout).toContain(`HOME=${tmp}\n`)
  expect(child.stdout).not.toContain("sk-office-secret")
  expect(child.stdout).not.toContain("OPENCORP_API_KEY")
})

/** An unsandboxed process with a secret in its environment, like the office; killed when the test
 *  finishes. It runs Bun, not a platform binary such as `/bin/sleep`: macOS hides a platform
 *  binary's environment from every reader, so the macOS test could not see the marker at all. */
function secretProcess() {
  const marker = "sk-proc-" + Math.random().toString(16).slice(2, 10)
  const proc = spawn(BUN, [...BUN_FLAGS, "-e", "setTimeout(() => {}, 60000)"], {
    env: { PATH: "/usr/bin:/bin", OFFICE_SECRET: marker },
    stdio: "ignore",
  })
  onTestFinished(() => void proc.kill("SIGKILL"))
  return { pid: proc.pid!, marker }
}

test.skipIf(!ON_LINUX || !sandboxAvailable())("linux proc environ of the office is hidden", async () => {
  const { marker } = secretProcess()
  const out = await shell(makePolicy().make(), "cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; ls /proc")
  expect(out.output).not.toContain(marker)
})

// Python's xfail `test_macos_other_process_environ_is_hidden`, pinned as the documented leak: Seatbelt
// doesn't gate KERN_PROCARGS2, so a same-uid process's environment is readable. This fails if Seatbelt
// starts gating it. (`ps -E` can't stand in: Seatbelt refuses to exec the setuid `/bin/ps`.)
test.skipIf(!ON_MAC || !sandboxAvailable())("macos other process environ is readable", async () => {
  const { pid, marker } = secretProcess()
  const code = [
    `const { dlopen } = require("bun:ffi")`,
    `const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {`,
    `  sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },`,
    `})`,
    `const mib = new Int32Array([1, 49, ${pid}]) // CTL_KERN, KERN_PROCARGS2`,
    `const buf = new Uint8Array(1 << 20)`,
    `const size = new BigUint64Array([BigInt(buf.length)])`,
    `if (symbols.sysctl(mib, 3, buf, size, null, 0) === 0) {`,
    `  process.stdout.write(Buffer.from(buf.subarray(0, Number(size[0]))).toString("latin1"))`,
    `} else console.log("SYSCTL FAILED")`,
  ].join("\n")
  expect(await bun(bunPolicy(), code)).toContain(marker)
})

const LAUNCHD_LABEL = "dev.opencorp.sandbox-test"

test.skipIf(!ON_MAC || !sandboxAvailable())("macos launch services and launchd are unreachable", async () => {
  const policy = makePolicy().make()
  const marker = path.join(shortDir(), "escaped")
  // Removed however the test ends, so a job that did get submitted never outlives it.
  onTestFinished(() => void spawnSync("launchctl", ["remove", LAUNCHD_LABEL]))
  const submit = await shell(policy, `launchctl submit -l ${LAUNCHD_LABEL} -- /usr/bin/touch ${marker}`)
  await Bun.sleep(1_000)
  expect(fs.existsSync(marker), submit.output).toBe(false)
  const open = await shell(policy, "/usr/bin/open -g -a Finder")
  expect(open.exit, `open: ${open.output}`).not.toBe(0)
  const pbcopy = await shell(policy, "echo x | /usr/bin/pbcopy")
  expect(pbcopy.exit, `pbcopy: ${pbcopy.output}`).not.toBe(0)
})
