/** What a Codex thread runs under beside its employee's permission: the private folder under /tmp for its temp folder
 *  and the fence, the git root, the app-server's PATH and TMPDIR, the load that turns the owner's MCP servers off, and
 *  doctor's probe of a thread that starts but can't be used. */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import {
  harnessTemp,
  ownerConfig,
  employeeLoad,
  ProjectConfigLoads,
  checkLoaded,
  threadEnv,
  threadProbe,
} from "../../../src/features/codex/thread.ts"
import { fenceIn, freshFolder, removeFolder, sweepTemp } from "../../../src/runtime/sandbox/harness_temp.ts"
import { instructions } from "../../../src/runtime/sessions/speakers.ts"
import { type EmployeePermission, codexThread, harnessPath } from "../../../src/runtime/sandbox/harness_profile.ts"
import { UnsafeProfile } from "../../../src/runtime/sandbox/policy.ts"
import { APP_SERVER_ARGS, CodexProcess, nativeCodex, threadLoad } from "../../../src/tools/codex/codex.ts"
import { RpcError } from "../../../src/tools/codex/rpc.ts"
import { isGone, tempDir, waitFor } from "../../helpers.ts"
import { sandboxAvailable } from "../../runtime/sandbox/helpers.ts"

setDefaultTimeout(30_000)

const FAKE = fileURLToPath(new URL("../../../src/testing/fake_codex.ts", import.meta.url))
const BUN = [process.execPath, "--no-install", "--no-env-file", "--config=/dev/null"]

/** Every app-server a test started, checked gone after the file's last test. */
const started: { pid: number; time: number | null }[] = []
afterAll(async () => {
  for (const { pid, time } of started) await waitFor(() => isGone(pid, time), { timeout: 10_000, what: `${pid} gone` })
})

test("the harness temp folder is the user's own private folder under /tmp, made at each level", () => {
  const base = fs.realpathSync(tempDir())
  const root = harnessTemp(base)
  expect(root).toBe(path.join(base, `opencorp-${process.getuid!()}`, "codex"))
  for (const dir of [path.dirname(root), root]) {
    const stat = fs.lstatSync(dir)
    expect([stat.isDirectory(), stat.mode & 0o777]).toEqual([true, 0o700])
  }
  // Again, it is the same folder.
  expect(harnessTemp(base)).toBe(root)
})

test("a harness temp folder that is a link, or that others may open, is refused", () => {
  const base = fs.realpathSync(tempDir())
  const elsewhere = path.join(base, "elsewhere")
  fs.mkdirSync(elsewhere, { mode: 0o700 })
  fs.symlinkSync(elsewhere, path.join(base, `opencorp-${process.getuid!()}`))
  expect(() => harnessTemp(base)).toThrow(UnsafeProfile)
  const open = fs.realpathSync(tempDir())
  fs.mkdirSync(path.join(open, `opencorp-${process.getuid!()}`, "codex"), { recursive: true })
  fs.chmodSync(path.join(open, `opencorp-${process.getuid!()}`), 0o755)
  expect(() => harnessTemp(open)).toThrow(/isn't private/)
})

test("the fence is an empty 0600 file, made once", () => {
  const root = harnessTemp(fs.realpathSync(tempDir()))
  const fence = fenceIn(root)
  expect(fence).toBe(path.join(root, "fence"))
  expect([fs.readFileSync(fence, "utf8"), fs.statSync(fence).mode & 0o777]).toEqual(["", 0o600])
  const inode = fs.statSync(fence).ino
  expect(fenceIn(root)).toBe(fence)
  expect(fs.statSync(fence).ino).toBe(inode)
})

test("a thread's temp folder is fresh, empty and private each time, and removed whatever was left in it", () => {
  const root = harnessTemp(fs.realpathSync(tempDir()))
  const dir = freshFolder(root, "S1")
  expect([dir, fs.readdirSync(dir), fs.statSync(dir).mode & 0o777]).toEqual([path.join(root, "S1"), [], 0o700])
  // What a command left: a file, a folder it locked, a link out.
  fs.writeFileSync(path.join(dir, "left.txt"), "x")
  fs.mkdirSync(path.join(dir, "locked/deep"), { recursive: true })
  fs.writeFileSync(path.join(dir, "locked/deep/f"), "x")
  fs.chmodSync(path.join(dir, "locked/deep"), 0o500)
  fs.chmodSync(path.join(dir, "locked"), 0o500)
  const outside = path.join(path.dirname(root), "outside.txt")
  fs.writeFileSync(outside, "keep")
  fs.symlinkSync(outside, path.join(dir, "link"))
  expect(fs.readdirSync(freshFolder(root, "S1"))).toEqual([])
  fs.mkdirSync(path.join(dir, "again"))
  fs.chmodSync(dir, 0o500)
  removeFolder(root, "S1")
  expect(fs.existsSync(dir)).toBe(false)
  expect(fs.readFileSync(outside, "utf8")).toBe("keep")
  // Nothing there is fine.
  removeFolder(root, "S1")
  expect(() => freshFolder(root, "../S1")).toThrow()
})

/** A temp layout for a thread: a home, an office home in it, a workspace, a fresh temp folder and the fence, and a
 *  Codex install; `permission` is an employee's over it. */
function layout() {
  const root = fs.realpathSync(tempDir())
  const home = path.join(root, "home")
  const ws = path.join(root, "ws")
  const install = path.join(root, "codex-install")
  for (const dir of [path.join(home, ".opencorp"), ws, path.join(install, "bin"), path.join(root, "tmp")]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const temp = harnessTemp(path.join(root, "tmp"))
  const permission = (fields: Partial<EmployeePermission> = {}): EmployeePermission => ({
    workspace: ws,
    gitRoot: null,
    writable: true,
    network: false,
    tmpdir: freshFolder(temp, "S1"),
    fence: fenceIn(temp),
    folders: [],
    home,
    officeHome: path.join(home, ".opencorp"),
    ...fields,
  })
  return { root, home, ws, install, temp, permission }
}

test("the app-server runs with the harness PATH and the thread's temp folder as TMPDIR, and the rest of its env", () => {
  const { permission } = layout()
  const p = permission()
  expect(threadEnv({ HOME: "/h", PATH: "/opt/bin:/usr/bin", TMPDIR: "/tmp", LANG: "C" }, p)).toEqual({
    HOME: "/h",
    LANG: "C",
    PATH: harnessPath(p),
    TMPDIR: p.tmpdir,
  })
})

/** A started fake app-server on `script`, logging under `dir`; closed when the test ends. */
async function fakeServer(dir: string, script: object): Promise<{ proc: CodexProcess; log: string }> {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "s.json")
  const log = path.join(dir, "rpc.jsonl")
  fs.writeFileSync(file, JSON.stringify(script))
  const proc = new CodexProcess({
    command: [...BUN, FAKE, "--script", file, "--log", log],
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    log: path.join(dir, "codex.log"),
    onNotification() {},
    onRequest() {},
    onExit() {},
    environ: {},
    logLine() {},
  })
  await proc.start()
  started.push({ pid: proc.pid, time: null })
  return { proc, log }
}

/** The params of each request the fake was sent with `method`. */
function calls(log: string, method: string): unknown[] {
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.dir === "in" && e.msg.method === method)
    .map((e) => e.msg.params)
}

test("the load turns off exactly the MCP servers the owner's Codex config defines, under the thread's profile", async () => {
  const { root, ws, install, permission } = layout()
  const servers = { docs: { command: "docs-mcp" }, "a.b": { url: "https://e.com/mcp" } }
  const { proc, log } = await fakeServer(path.join(root, "fake"), { mcp_servers: servers })
  try {
    const p = permission()
    const params = await employeeLoad(proc.rpc!, p, "opencorp-S1", install)
    // As Codex sees the folder: its layers, a project's own among them.
    expect(calls(log, "config/read")).toEqual([{ cwd: ws, includeLayers: true }])
    expect(params.cwd).toBe(ws)
    expect([params.approvalPolicy, params.permissions, "sandbox" in params]).toEqual(["never", "opencorp-S1", false])
    const config = params.config as Record<string, any>
    expect(config.mcp_servers).toEqual({ docs: { enabled: false }, "a.b": { enabled: false } })
    expect(config.default_permissions).toBe("opencorp-S1")
    expect(config.permissions["opencorp-S1"].filesystem[p.fence]).toBe("deny")
    expect(await ownerConfig(proc.rpc!, ws)).toEqual({ mcpServers: ["docs", "a.b"] })
  } finally {
    await proc.close(1000)
  }
})

test("a project config codex would load, as the owner trusts the project, refuses the load; one it won't load doesn't", async () => {
  const { root, ws, install, permission } = layout()
  const dotCodex = path.join(ws, ".codex")
  const reason = "To load project-local config, add the folder as a trusted project"
  const { proc } = await fakeServer(path.join(root, "fake"), {
    project_layers: { [ws]: [{ dotCodexFolder: dotCodex }], [root]: [{ dotCodexFolder: dotCodex, disabledReason: reason }] },
  })
  try {
    const refused = await employeeLoad(proc.rpc!, permission(), "opencorp-S1", install).catch((error) => error)
    expect(refused).toBeInstanceOf(ProjectConfigLoads)
    expect(refused.folders).toEqual([dotCodex])
    expect(refused.message).toContain(path.join(dotCodex, "config.toml"))
    expect(refused.message).toContain("Untrust the project in your Codex config.toml")
    // Codex lists the project's config with why it won't load it: nothing of it runs.
    expect(await ownerConfig(proc.rpc!, root)).toEqual({ mcpServers: [] })
  } finally {
    await proc.close(1000)
  }
})

test("a load codex answers with another approval policy or profile is refused", () => {
  const profile = (id: string) => ({ id, extends: null })
  expect(() => checkLoaded({ approvalPolicy: "never", activePermissionProfile: profile("opencorp-S1") }, "opencorp-S1"))
    .not.toThrow()
  for (const answer of [
    { approvalPolicy: "on-request", activePermissionProfile: profile("opencorp-S1") },
    { approvalPolicy: "never", activePermissionProfile: profile(":workspace") },
    { approvalPolicy: "never", activePermissionProfile: null },
    { approvalPolicy: "never" },
    null,
  ]) {
    expect(() => checkLoaded(answer, "opencorp-S1"), JSON.stringify(answer)).toThrow(UnsafeProfile)
  }
})

test("the sweep removes the stale folders it names and dead probes', the user's only, and nothing else", () => {
  const root = harnessTemp(fs.realpathSync(tempDir()))
  fenceIn(root)
  for (const name of ["S1", "S2", "other-office", `doctor-${process.pid}`, "doctor-999999999"]) freshFolder(root, name)
  fs.writeFileSync(path.join(root, "S1/left"), "x")
  const target = fs.realpathSync(tempDir())
  fs.symlinkSync(target, path.join(root, "S3"))
  const lines: string[] = []
  sweepTemp(root, (name) => ["S1", "S2", "S3", "fence"].includes(name), (line) => lines.push(line))
  expect(fs.readdirSync(root).sort()).toEqual(["S3", `doctor-${process.pid}`, "fence", "other-office"].sort())
  expect(fs.existsSync(target)).toBe(true)
  expect(lines).toEqual([])
})

test("a config the app-server can't read fails the load: an MCP server left on would run as the owner", async () => {
  const { root, install, permission } = layout()
  const { proc } = await fakeServer(path.join(root, "fake"), {
    config_read_error: { code: -32603, message: "bad config.toml" },
  })
  try {
    await expect(employeeLoad(proc.rpc!, permission(), "opencorp-S1", install)).rejects.toBeInstanceOf(RpcError)
  } finally {
    await proc.close(1000)
  }
})

/** The probe's options over `layout`'s home, running `script` in the fake. */
function probeOptions(dir: string, home: string, script: object) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "s.json")
  fs.writeFileSync(file, JSON.stringify(script))
  const wrapper = path.join(dir, "bin/codex")
  fs.mkdirSync(path.dirname(wrapper))
  fs.mkdirSync(path.join(dir, "tmp"))
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${BUN.join(" ")} ${FAKE} --script ${file} --log ${path.join(dir, "rpc.jsonl")} "$@"\n`,
  )
  fs.mkdirSync(path.join(dir, "install"))
  // Only the user may change the Codex the probe runs, whatever the umask.
  for (const p of [wrapper, path.dirname(wrapper), path.join(dir, "install")]) fs.chmodSync(p, 0o755)
  return {
    codex: { run: wrapper, install: path.join(dir, "install") },
    env: { PATH: "/usr/bin:/bin", HOME: home },
    environ: {},
    home,
    officeHome: path.join(home, ".opencorp"),
    base: path.join(dir, "tmp"),
    timeoutMs: 10_000,
  }
}

test("doctor's probe passes when a thread under an employee's permission loads and reloads its config", async () => {
  const { root, home } = layout()
  const options = probeOptions(path.join(root, "probe"), home, { mcp_servers: { docs: {} } })
  expect(await threadProbe(options)).toEqual({ failed: null, projectConfigs: [] })
  const log = path.join(root, "probe/rpc.jsonl")
  const [start] = calls(log, "thread/start") as Record<string, any>[]
  expect([start!.approvalPolicy, start!.ephemeral, start!.permissions]).toEqual(["never", true, "opencorp-doctor"])
  expect(start!.config.mcp_servers).toEqual({ docs: { enabled: false } })
  expect(start!.config.permissions["opencorp-doctor"].filesystem[start!.cwd]).toBe("read")
  expect(calls(log, "mcpServerStatus/list")).toEqual([{ threadId: "thr_fake", detail: "toolsAndAuthOnly" }])
  expect(calls(log, "turn/start")).toEqual([])
  // Its folders are gone; the fence stays.
  expect(fs.readdirSync(harnessTemp(options.base)).sort()).toEqual(["doctor-codex.log", "fence"])
})

test("doctor's probe says why a thread that starts can't be used", async () => {
  const { root, home } = layout()
  const message = "failed to reload config: config defines `[permissions]` profiles but does not set `default_permissions`"
  const options = probeOptions(path.join(root, "probe"), home, { mcp_status_error: { code: -32603, message } })
  expect(await threadProbe(options)).toEqual({
    failed: { why: `mcpServerStatus/list failed: ${message}`, log: path.join(harnessTemp(options.base), "doctor-codex.log") },
    projectConfigs: [],
  })
  expect(calls(path.join(root, "probe/rpc.jsonl"), "thread/start")).toHaveLength(1)
  const refused = probeOptions(path.join(root, "refused"), home, { load_exit: 3 })
  expect((await threadProbe(refused)).failed?.why).toStartWith("thread/start failed: ")
  const misread = probeOptions(path.join(root, "misread"), home, { load_answer: { approvalPolicy: "on-request" } })
  expect((await threadProbe(misread)).failed?.why).toContain('Codex loaded the thread with approval policy "on-request"')
})

test("doctor's probe refuses a codex others could change before it runs it", async () => {
  const { root, home } = layout()
  const marker = path.join(root, "ran")
  for (const [name, change] of [
    // Codex's install holds the probe's temp folder, which the employee can write.
    ["holding", (o: ReturnType<typeof probeOptions>) => void (o.codex.install = path.join(root, "holding"))],
    // The wrapper the office spawns is open to the group.
    ["open", (o: ReturnType<typeof probeOptions>) => fs.chmodSync(o.codex.run, 0o775)],
  ] as const) {
    const options = probeOptions(path.join(root, name), home, {})
    fs.writeFileSync(options.codex.run, `#!/bin/sh\ntouch ${marker}\n`)
    change(options)
    const { failed } = await threadProbe(options)
    expect(failed?.why, name).toStartWith("an employee's permission can't be built here: ")
    expect(fs.existsSync(marker), name).toBe(false)
  }
})

test("doctor's probe names each trusted project whose own config codex would load", async () => {
  const { root, home } = layout()
  const trusted = path.join(root, "trusted")
  const plain = path.join(root, "plain")
  for (const dir of [trusted, plain]) fs.mkdirSync(path.join(dir, ".codex"), { recursive: true })
  const options = probeOptions(path.join(root, "probe"), home, {
    projects: {
      [trusted]: { trust_level: "trusted" },
      [plain]: { trust_level: "untrusted" },
      [path.join(root, "gone")]: { trust_level: "trusted" },
    },
    project_layers: { [trusted]: [{ dotCodexFolder: path.join(trusted, ".codex") }], [plain]: [{ dotCodexFolder: path.join(plain, ".codex") }] },
  })
  expect(await threadProbe(options)).toEqual({ failed: null, projectConfigs: [path.join(trusted, ".codex")] })
})

/** The real Codex the opt-in tests run, named by `OPENCORP_TEST_CODEX` (a wrapper, npm's launcher or the native
 *  binary). Unset, they skip; under `OPENCORP_TEST_SANDBOX` they run, and fail without it. Codex's sandbox needs what
 *  the office's does, so they also skip where that can't start. They run no model turn. */
const CODEX = process.env.OPENCORP_TEST_CODEX
const NO_CODEX = CODEX === undefined ? !process.env.OPENCORP_TEST_SANDBOX : !sandboxAvailable()

/** A temp home for the real Codex: `CODEX_HOME` with a config whose provider needs no sign-in (it is never reached:
 *  no turn runs) and an MCP server that leaves a marker if it ever starts. */
function realHome() {
  if (CODEX === undefined) throw new Error("OPENCORP_TEST_SANDBOX is set: set OPENCORP_TEST_CODEX to a Codex 0.167.0+")
  const { root, home } = layout()
  const codexHome = path.join(root, "codex-home")
  fs.mkdirSync(codexHome)
  const marker = path.join(root, "mcp-ran")
  const config =
    'model_provider = "local"\n\n[model_providers.local]\nname = "local"\nbase_url = "http://127.0.0.1:9/v1"\n' +
    `\n[mcp_servers.probe]\ncommand = "sh"\nargs = ["-c", "touch ${marker}; exec sleep 3"]\n`
  fs.writeFileSync(path.join(codexHome, "config.toml"), config)
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true })
  return {
    root,
    codexHome,
    marker,
    config,
    options: {
      codex: nativeCodex(CODEX),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      environ: { CODEX_HOME: codexHome },
      home,
      officeHome: path.join(home, ".opencorp"),
      base: path.join(root, "tmp"),
      timeoutMs: 60_000,
    },
  }
}

test.skipIf(NO_CODEX)(
  "a real codex takes the thread the office sends, keeps the owner's MCP server off and writes no config",
  async () => {
    const { codexHome, marker, config, options } = realHome()
    expect(await threadProbe(options)).toEqual({ failed: null, projectConfigs: [] })
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(config)
  },
  120_000,
)

/** An employee's read-only permission in `ws` for the real Codex of `home`, and that Codex started under it. */
async function realServer(home: ReturnType<typeof realHome>, ws: string, gitRoot: string | null = null) {
  const { root, options } = home
  const temp = harnessTemp(options.base)
  const p: EmployeePermission = {
    workspace: ws,
    gitRoot,
    writable: false,
    network: false,
    tmpdir: freshFolder(temp, "real"),
    fence: fenceIn(temp),
    folders: [],
    home: options.home,
    officeHome: options.officeHome,
    harnessHomes: [options.environ.CODEX_HOME],
  }
  const proc = new CodexProcess({
    command: [options.codex.run, "app-server", "--listen", "stdio://"],
    cwd: ws,
    env: threadEnv(options.env, p),
    log: path.join(root, "codex.log"),
    onNotification() {},
    onRequest: (id) => void proc.rpc?.replyError(id, -32601, "no").catch(() => {}),
    onExit() {},
    environ: options.environ,
    logLine() {},
  })
  return { p, proc }
}

test.skipIf(NO_CODEX)(
  "a real codex thread with no default profile starts, but its config can't be reloaded, as the probe sees",
  async () => {
    const real = realHome()
    const { options } = real
    const { p, proc } = await realServer(real, path.join(real.root, "ws"))
    try {
      await proc.start()
      const params = await employeeLoad(proc.rpc!, p, "opencorp-real", options.codex.install)
      delete (params.config as Record<string, unknown>).default_permissions
      const thread = (await proc.rpc!.request("thread/start", { ...params, ephemeral: true })) as { thread: { id: string } }
      const listed = proc.rpc!.request("mcpServerStatus/list", { threadId: thread.thread.id, detail: "toolsAndAuthOnly" })
      await expect(listed).rejects.toThrow(/does not set `default_permissions`/)
    } finally {
      await proc.close(2000)
    }
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "a real codex takes an employee instrument's thread: the employee's permission, and Codex told of its two speakers",
  async () => {
    const real = realHome()
    const { codexHome, config, options } = real
    const { p, proc } = await realServer(real, path.join(real.root, "ws"))
    try {
      await proc.start()
      const params = await employeeLoad(proc.rpc!, p, "opencorp-real", options.codex.install)
      const developerInstructions = instructions((a) => (a === "minh" ? "@minh" : "Ngoc (owner)"), "minh", "ngocbh")
      const loaded = await proc.rpc!.request("thread/start", { ...params, developerInstructions, ephemeral: true })
      checkLoaded(loaded, "opencorp-real")
      // The thread's config reloads as each turn's does: no model turn runs.
      const threadId = (loaded as { thread: { id: string } }).thread.id
      await proc.rpc!.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" })
    } finally {
      await proc.close(2000)
    }
    expect(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(config)
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "a real codex takes a thread/resume in a new app-server as the office sends it, and has nothing to resume before a turn",
  async () => {
    const real = realHome()
    const { options } = real
    const loaded = async () => {
      const { p, proc } = await realServer(real, path.join(real.root, "ws"))
      await proc.start()
      return { proc, params: await employeeLoad(proc.rpc!, p, "opencorp-real", options.codex.install) }
    }
    const first = await loaded()
    let threadId: string
    try {
      const started = await first.proc.rpc!.request("thread/start", first.params)
      checkLoaded(started, "opencorp-real")
      threadId = (started as { thread: { id: string } }).thread.id
    } finally {
      await first.proc.close(2000)
    }
    // The office restarted: a new app-server, which has never loaded the thread. Codex keeps a thread on disk from its
    // first turn, which this test runs none of, so the resume is taken and refused as having no rollout: an instrument
    // session the restart caught before its first turn fails, saying so.
    const second = await loaded()
    try {
      const params = { threadId, excludeTurns: true, ...second.params }
      await expect(second.proc.rpc!.request("thread/resume", params)).rejects.toMatchObject({
        rpcMessage: expect.stringMatching(/^no rollout found for thread id /),
      })
    } finally {
      await second.proc.close(2000)
    }
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "in a folder the owner's real codex trusts, the project's own config would load, so the load is refused before any of it runs",
  async () => {
    const real = realHome()
    const { root, codexHome, options } = real
    const ws = path.join(root, "trusted")
    const marker = path.join(root, "project-mcp-ran")
    fs.mkdirSync(path.join(ws, ".codex"), { recursive: true })
    const init = spawnSync("git", ["init", "-q", ws], { env: { PATH: "/usr/bin:/bin", HOME: options.home } })
    expect(init.status).toBe(0)
    const project = `[mcp_servers.project_probe]\ncommand = "sh"\nargs = ["-c", "touch ${marker}; exec sleep 3"]\n`
    fs.writeFileSync(path.join(ws, ".codex/config.toml"), project)
    // As Codex itself writes it the first time the owner runs Codex there.
    fs.appendFileSync(path.join(codexHome, "config.toml"), `\n[projects."${ws}"]\ntrust_level = "trusted"\n`)
    const { p, proc } = await realServer(real, ws, ws)
    try {
      await proc.start()
      const refused = await employeeLoad(proc.rpc!, p, "opencorp-real", options.codex.install).catch((error) => error)
      expect(refused).toBeInstanceOf(ProjectConfigLoads)
      expect(refused.folders).toEqual([path.join(ws, ".codex")])
      await sleep(1000)
      expect(fs.existsSync(marker)).toBe(false)
      // What the check stops: the thread's own override pins the folder untrusted, yet Codex loads the project's config
      // and starts its MCP server, outside the sandbox, once the thread's servers are asked for (or a turn starts).
      const params = threadLoad(ws, codexThread(p, "opencorp-real", { install: options.codex.install }))
      const thread = (await proc.rpc!.request("thread/start", { ...params, ephemeral: true })) as { thread: { id: string } }
      await proc.rpc!.request("mcpServerStatus/list", { threadId: thread.thread.id, detail: "toolsAndAuthOnly" })
      await waitFor(() => fs.existsSync(marker), { timeout: 15_000, what: "the project's MCP server, as the control" })
    } finally {
      await proc.close(2000)
    }
    // Doctor names the project.
    expect(await threadProbe(options)).toEqual({ failed: null, projectConfigs: [path.join(ws, ".codex")] })
  },
  120_000,
)

test.skipIf(NO_CODEX)(
  "a trusted home whose .codex is Codex's own home is no project config, to doctor or to a session there; another home's is",
  async () => {
    const { root, options } = realHome()
    const { home } = options
    const own = path.join(home, ".codex")
    fs.mkdirSync(own)
    // The owner trusts their whole home, and works in a repository at its top.
    const config = `model_provider = "local"\n\n[model_providers.local]\nname = "local"\nbase_url = "http://127.0.0.1:9/v1"\n\n[projects."${home}"]\ntrust_level = "trusted"\n`
    fs.writeFileSync(path.join(own, "config.toml"), config)
    const init = spawnSync("git", ["init", "-q", home], { env: { PATH: "/usr/bin:/bin", HOME: home } })
    expect(init.status).toBe(0)
    const link = path.join(root, "codex-link")
    fs.symlinkSync(own, link)
    // Codex's home by default (~/.codex), named, and named through a link: Codex skips its own home as a project.
    for (const environ of [{}, { CODEX_HOME: own }, { CODEX_HOME: link }]) {
      expect(await threadProbe({ ...options, environ })).toEqual({ failed: null, projectConfigs: [] })
      const ws = path.join(home, "proj")
      fs.mkdirSync(ws, { recursive: true })
      const proc = new CodexProcess({
        command: [options.codex.run, ...APP_SERVER_ARGS],
        cwd: ws,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        log: path.join(root, "codex.log"),
        onNotification() {},
        onRequest: (id) => void proc.rpc?.replyError(id, -32601, "no").catch(() => {}),
        onExit() {},
        environ,
        logLine() {},
      })
      try {
        await proc.start()
        expect(await ownerConfig(proc.rpc!, ws)).toEqual({ mcpServers: [] })
      } finally {
        await proc.close(2000)
      }
    }
    // With CODEX_HOME elsewhere (a scratch one, say), the home's .codex is a trusted project's own config.
    const elsewhere = path.join(root, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, "config.toml"), config)
    expect(await threadProbe({ ...options, environ: { CODEX_HOME: elsewhere } })).toEqual({
      failed: null,
      projectConfigs: [own],
    })
  },
  120_000,
)
