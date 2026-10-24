/** Escape tests: what a sandboxed call must not reach, each one through `run.ts`. */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import type { SandboxPolicy } from "../../src/sandbox/policy.ts"
import { run } from "../../src/sandbox/run.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { gone, makePolicy, sandboxAvailable } from "./helpers.ts"

setDefaultTimeout(30_000)

const ON_MAC = process.platform === "darwin"
const ON_LINUX = process.platform.startsWith("linux")
const sandboxed = test.skipIf(!sandboxAvailable())
const SRC = fileURLToPath(new URL("../../src/sandbox/", import.meta.url))
const BUN = fs.realpathSync(process.execPath)
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

function sh(policy: SandboxPolicy, script: string) {
  return run(policy, ["/bin/sh", "-c", script])
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

/** Runs `code` with Bun in the sandbox (Python's `py`); Bun is exposed read-only. */
async function bun(policy: SandboxPolicy, code: string): Promise<string> {
  const result = await run(policy, [BUN, ...BUN_FLAGS, "-e", code])
  return result.stdout.toString() + result.stderr.toString()
}

/** A policy whose calls may run Bun. */
function bunPolicy(network = false): SandboxPolicy {
  return makePolicy().make({ network, readOnly: [BUN] })
}

/** A fake home with the secrets and office state the sandbox must not reach (no `HOME` change). */
function office(): string {
  const home = path.join(shortDir(), "home")
  const files: Record<string, string> = {
    ".config/yian/auth.json": '{"key": "sk-decoy-auth"}',
    ".ssh/id_ed25519": "decoy-ssh-key",
    ".aws/credentials": "decoy-aws",
    ".opencorp/office/store.sqlite": "decoy-store",
    ".opencorp/office/runs/r1/log.jsonl": "decoy-run-log",
    ".opencorp/office/secrets/cluster-a": "decoy-asset-secret",
    ".opencorp/company/people/minh/person.yaml": "decoy-repo",
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    fs.writeFileSync(path.join(home, rel), text)
  }
  return home
}

/** A server listening at `address` outside the workspace, closed when the test finishes. */
async function listen(address: string | { host: string; port: number }): Promise<net.Server> {
  const server = net.createServer((socket) => socket.destroy())
  onTestFinished(() => void server.close())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    if (typeof address === "string") server.listen(address, resolve)
    else server.listen(address.port, address.host, resolve)
  })
  return server
}

/** Bun code that connects to `target` (a unix socket path, or a TCP port on 127.0.0.1) and prints
 *  `CONNECTED`, or `REFUSED` on an error or after 5 s (Python's `settimeout(5)`). */
function connectCode(target: string | number): string {
  const args = typeof target === "string" ? JSON.stringify(target) : `${target}, "127.0.0.1"`
  return [
    `const s = require("node:net").connect(${args})`,
    `s.setTimeout(5000, () => { console.log("REFUSED timeout"); process.exit(0) })`,
    `s.on("connect", () => { console.log("CONNECTED"); process.exit(0) })`,
    `s.on("error", (e) => { console.log("REFUSED", e.message); process.exit(0) })`,
  ].join("\n")
}

const DECOYS = [
  ".config/yian/auth.json",
  ".ssh/id_ed25519",
  ".aws/credentials",
  ".opencorp/office/store.sqlite",
  ".opencorp/office/runs/r1/log.jsonl",
  ".opencorp/office/secrets/cluster-a",
  ".opencorp/company/people/minh/person.yaml",
]

sandboxed("cannot read owner or office files", async () => {
  const home = office()
  const policy = makePolicy().make()
  for (const rel of DECOYS) {
    // `cat` stands in for both the shell call and the read_file tool.
    const read = await shell(policy, `cat ${path.join(home, rel)}`)
    expect(read.output).not.toContain("decoy")
    expect(read.exit).not.toBe(0)
  }
  // The search tool's stand-in.
  expect((await shell(policy, `grep -r decoy ${home}`)).output).not.toContain("decoy")
})

sandboxed("cannot list the real home", async () => {
  const policy = bunPolicy()
  const home = fs.realpathSync(os.homedir())
  // The list_dir tool's stand-in; a trailing `/` marks a folder, as in Python's listing.
  const listing = await shell(policy, `ls -Ap ${home}`)
  if (ON_MAC) {
    expect(listing.exit).not.toBe(0)
  } else {
    // bwrap creates the home folders of mounted read-only paths (such as `.bun/`) as mount
    // points, so those entries, and only those, may show.
    const allowed = new Set(
      policy.readOnly.filter((p) => p.startsWith(home + "/")).map((p) => p.slice(home.length + 1).split("/")[0] + "/"),
    )
    const entries = listing.stdout.split("\n").filter((line) => line !== "")
    expect(listing.exit !== 0 || entries.every((entry) => allowed.has(entry)), listing.output).toBe(true)
  }
})

const UNIX_CASES = ["tmux-501/default", "office/office.sock"].flatMap((name) =>
  [false, true].map((network) => [name, network] as const),
)

sandboxed.each(UNIX_CASES)("cannot connect to unix sockets [%s, network %p]", async (name, network) => {
  const socket = path.join(shortDir(), name)
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  await listen(socket)
  const out = await bun(bunPolicy(network), connectCode(socket))
  expect(out).toContain("REFUSED")
  expect(out).not.toContain("CONNECTED")
})

sandboxed("cannot write outside the workspace", async () => {
  const { ws, make } = makePolicy()
  const policy = make()
  const home = office()
  for (const target of [
    path.join(path.dirname(ws), "outside.txt"),
    path.join(shortDir(), "outside.txt"),
    path.join(home, ".ssh/authorized_keys"),
  ]) {
    // The write_file tool's stand-in, then the shell call.
    expect((await shell(policy, `printf x > ${target}`)).exit).not.toBe(0)
    expect((await shell(policy, `echo x > ${target}`)).exit).not.toBe(0)
    expect(fs.existsSync(target)).toBe(false)
  }
  expect((await shell(policy, "printf x > ../escape.txt")).exit).not.toBe(0)
  expect(fs.existsSync(path.join(path.dirname(ws), "escape.txt"))).toBe(false)
})

sandboxed("git hooks and config are read only", async () => {
  const { ws, make } = makePolicy()
  fs.mkdirSync(path.join(ws, ".git/hooks"), { recursive: true })
  fs.writeFileSync(path.join(ws, ".git/config"), "[core]\n")
  const policy = make()
  expect((await shell(policy, "printf evil > .git/hooks/pre-commit")).exit).not.toBe(0)
  // The edit_file tool's stand-in: the whole file rewritten.
  expect((await shell(policy, "printf '[core]\\nhooksPath=x\\n' > .git/config")).exit).not.toBe(0)
  // Renaming .git away (to plant a new hooks dir and rename it back) is denied too.
  expect((await shell(policy, "mv .git .git2")).exit).not.toBe(0)
  expect(fs.existsSync(path.join(ws, ".git/hooks/pre-commit"))).toBe(false)
  expect(fs.readFileSync(path.join(ws, ".git/config"), "utf8")).toBe("[core]\n")
  // The rest of .git stays writable, so git itself works.
  expect((await shell(policy, "printf 'ref: refs/heads/main\\n' > .git/HEAD")).exit).toBe(0)
  expect(fs.readFileSync(path.join(ws, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
})

sandboxed("links do not escape", async () => {
  const policy = makePolicy().make()
  const secret = path.join(office(), ".ssh/id_ed25519")
  expect((await shell(policy, `ln -s ${path.dirname(secret)} sl; cat sl/id_ed25519`)).output).not.toContain("decoy")
  expect((await shell(policy, `ln ${secret} hard; cat hard`)).output).not.toContain("decoy")
})

sandboxed.each([false, true])("network only when allowed [network %p]", async (network) => {
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

sandboxed("background process is dead after the call", async () => {
  const result = await sh(makePolicy().make(), "sleep 4343 >/dev/null 2>&1 & echo started")
  expect(result.stdout.toString()).toBe("started\n")
  expect(result.exit).toBe(0)
  expect(await gone("4343")).toBe(true)
})

sandboxed("no environment secrets", () => {
  const { ws, tmp } = makePolicy()
  // The secret is set in a child's env, since a test never changes its own.
  const script = path.join(tempDir(), "child.ts")
  fs.writeFileSync(
    script,
    [
      `import { SandboxPolicy } from "${pathToFileURL(path.join(SRC, "policy.ts")).href}"`,
      `import { run } from "${pathToFileURL(path.join(SRC, "run.ts")).href}"`,
      `const policy = new SandboxPolicy({ workspace: ${JSON.stringify(ws)}, writable: true, network: false, tmpdir: ${JSON.stringify(tmp)} })`,
      `process.stdout.write((await run(policy, ["env"])).stdout)`,
      "",
    ].join("\n"),
  )
  const child = spawnSync(process.execPath, [...BUN_FLAGS, script], {
    env: { ...process.env, OPENCORP_API_KEY: "sk-office-secret" },
    encoding: "utf8",
    timeout: 30_000,
  })
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
  const proc = spawn(process.execPath, [...BUN_FLAGS, "-e", "setTimeout(() => {}, 60000)"], {
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

test.skipIf(!ON_MAC || !sandboxAvailable())("macos launch services and launchd are unreachable", async () => {
  const policy = makePolicy().make()
  const marker = path.join(shortDir(), "escaped")
  const submit = await shell(policy, `launchctl submit -l dev.opencorp.sandbox-test -- /usr/bin/touch ${marker}`)
  await Bun.sleep(1_000)
  spawnSync("launchctl", ["remove", "dev.opencorp.sandbox-test"])
  expect(fs.existsSync(marker), submit.output).toBe(false)
  expect((await shell(policy, "/usr/bin/open -g -a Finder")).exit).not.toBe(0)
  expect((await shell(policy, "echo x | /usr/bin/pbcopy")).exit).not.toBe(0)
})
