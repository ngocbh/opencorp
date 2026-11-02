/** The office's connections: one private file each, the default pointer, removed names, resolve and labels. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { lockFile } from "@ngocbh/yian/platform"
import { expect, spyOn, test } from "bun:test"
import { OFFICE } from "@opencorp/protocol"
import {
  azureBaseUrl,
  BadConnectionName,
  commercialAzure,
  ConnectionFile,
  ConnectionGone,
  Connections,
  ConnectionUnusable,
  configHash,
  keyId,
  providerLabel,
  RunMoved,
  type RunRecord,
  runRecord,
} from "../../src/chat/connections.ts"
import { type Price, Provider, ProviderError } from "../../src/chat/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir } from "../helpers.ts"

const SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"
const OTHER_KEY = "sk-ant-other-5f0e2b7c91d4"

/** `root/office` (0700), and, when `provider` is given, `connections/office.json` holding it. */
async function officeDir(root: string, provider?: unknown): Promise<string> {
  const office = path.join(root, "office")
  fs.mkdirSync(office, { mode: 0o700 })
  fs.chmodSync(office, 0o700)
  if (provider !== undefined) {
    const dir = path.join(office, "connections")
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    await writePrivate(path.join(dir, "office.json"), JSON.stringify(provider))
  }
  return office
}

function apiKey({
  model = "gpt-4o",
  key = SENTINEL,
  baseUrl = "https://second.example/v1/",
  prices,
}: { model?: string; key?: string; baseUrl?: string; prices?: Record<string, Price> } = {}): ConnectionFile {
  return ConnectionFile.parse({
    llm_config: { provider: "openai", base_url: baseUrl, api_key: key, model },
    ...(prices ? { prices } : {}),
  })
}

function subscription(model = "gpt-5.5"): ConnectionFile {
  return ConnectionFile.parse({ method: "subscription", llm_config: { provider: "openai", model } })
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o7777
}

/** Every path under `dir`, relative to it, sorted. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort()
}

/** A `log` option that keeps its lines. */
function logs(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line) => lines.push(line) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What `call` threw or rejected with; fails if it did neither. */
async function raised(call: () => unknown): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error("expected an error")
}

test("office json is the office connection and the default", async () => {
  const c = new Connections(
    await officeDir(tempDir(), { llm_config: { provider: "anthropic", model: "claude-x", api_key: SENTINEL } }),
  )
  expect(await c.names()).toEqual([OFFICE])
  expect(await c.default()).toBe(OFFICE)
  expect((await c.get(OFFICE)).llm_config?.api_key).toBe(SENTINEL)
  const info = await c.info(OFFICE)
  expect(info).toEqual({ name: OFFICE, provider: "anthropic", method: "api_key", model: "claude-x", default: true })
  expect(inspect(info)).not.toContain(SENTINEL)
  expect(JSON.stringify(info)).not.toContain(SENTINEL)
})

test("no office json is an office connection on composer defaults", async () => {
  const c = new Connections(await officeDir(tempDir()))
  expect(await c.names()).toEqual([OFFICE])
  const info = await c.info(OFFICE)
  expect(info).toEqual({ name: OFFICE, provider: "composer", method: "none", model: null, default: true })
  expect(await c.resolve(null, null)).toEqual(Provider.parse({}))
})

test("put writes 0600 in a 0700 dir and never shows the key", async () => {
  const office = await officeDir(tempDir())
  const { lines, log } = logs()
  const c = new Connections(office, { log })
  expect(fs.existsSync(path.join(office, "connections"))).toBe(false)
  const old = process.umask(0o022)
  try {
    await c.put("azure", apiKey({ baseUrl: azureBaseUrl("acme") }))
  } finally {
    process.umask(old)
  }
  expect(mode(path.join(office, "connections"))).toBe(0o700)
  expect(mode(path.join(office, "connections", "azure.json"))).toBe(0o600)
  expect(await c.names()).toEqual([OFFICE, "azure"])
  expect((await c.get("azure")).llm_config?.api_key).toBe(SENTINEL)
  const info = await c.info("azure")
  expect(info).toEqual({ name: "azure", provider: "azure", method: "api_key", model: "gpt-4o", default: false })
  for (const shown of [info, await c.get("azure"), await c.resolve("azure", null)]) {
    expect(inspect(shown)).not.toContain(SENTINEL)
    expect(JSON.stringify(shown)).not.toContain(SENTINEL)
  }
  expect(lines.join("\n")).not.toContain(SENTINEL)
})

test("a group readable connection is refused", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  await c.put("second", apiKey())
  const file = path.join(office, "connections", "second.json")
  fs.chmodSync(file, 0o640)
  const error = await raised(() => c.resolve("second", null))
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toContain(file)
  expect((error as Error).message).not.toContain(SENTINEL)
})

test.each(["Office", "..", "../x", "a/b", "_default", "_removed", "chatgpt.auth", "", "office", "default", "login"])(
  "bad or reserved names raise before any path [%s]",
  async (bad) => {
    const root = tempDir()
    const c = new Connections(await officeDir(root, { llm_config: { provider: "anthropic", api_key: SENTINEL } }))
    const before = tree(root)
    const calls: (() => unknown)[] = [() => c.put(bad, apiKey()), () => c.remove(bad), () => c.authFile(bad)]
    if (bad !== OFFICE) {
      calls.push(
        () => c.get(bad),
        () => c.info(bad),
        () => c.resolve(bad, null),
        () => c.setDefault(bad),
      )
    }
    for (const call of calls) expect(await raised(call)).toBeInstanceOf(RangeError)
    if (bad === OFFICE) {
      // office can be read and resolved, never written or removed
      expect((await c.get(bad)).llm_config?.provider).toBe("anthropic")
      expect(await c.resolve(bad, null)).toEqual(await c.resolve(null, null))
    }
    expect(tree(root)).toEqual(before)
  },
)

test("default follows the pointer and falls back when its file is gone", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  await c.put("second", apiKey())
  await c.setDefault("second")
  expect(await c.default()).toBe("second")
  expect(mode(path.join(office, "connections", "_default.json"))).toBe(0o600)
  expect((await c.info("second")).default).toBe(true)
  expect((await c.info(OFFICE)).default).toBe(false)
  expect(await new Connections(office).default()).toBe("second")
  fs.unlinkSync(path.join(office, "connections", "second.json"))
  expect(await c.default()).toBe(OFFICE)
  expect(await raised(() => c.setDefault("nope"))).toBeInstanceOf(ConnectionGone)
  await c.setDefault(OFFICE)
  expect(await c.default()).toBe(OFFICE)
})

test("a chat on a removed connection moves to the default on its own model", async () => {
  const c = new Connections(await officeDir(tempDir()))
  for (const name of ["second", "third"]) await c.put(name, apiKey())
  expect(await c.choice(null, null)).toEqual([OFFICE, null, false])
  expect(await c.choice("second", "gpt-4o-mini")).toEqual(["second", "gpt-4o-mini", false])
  await c.setDefault("third")
  await c.remove("second")
  expect(await c.choice("second", "gpt-4o-mini")).toEqual(["third", null, true])
})

test("remove unlinks the connection and its sign in", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  await c.put("chatgpt", subscription())
  await writePrivate(c.authFile("chatgpt"), "{}")
  const lock = path.join(c.dir, "chatgpt.auth.json.lock")
  await writePrivate(lock, "") // yian's lock on the sign-in
  const removedAtUnlink: unknown[] = []
  const unlink = fs.unlinkSync
  const spy = spyOn(fs, "unlinkSync").mockImplementation((p: fs.PathLike) => {
    // writePrivate clears its own temporary file first
    if (!path.basename(String(p)).startsWith(".")) {
      removedAtUnlink.push(JSON.parse(fs.readFileSync(path.join(c.dir, "_removed.json"), "utf8")))
    }
    unlink(p)
  })
  try {
    await c.remove("chatgpt")
  } finally {
    spy.mockRestore()
  }
  expect(removedAtUnlink.length).toBeGreaterThan(0)
  for (const r of removedAtUnlink) expect(r).toEqual({ names: ["chatgpt"] })
  expect(fs.existsSync(path.join(c.dir, "chatgpt.json"))).toBe(false)
  expect(fs.existsSync(c.authFile("chatgpt"))).toBe(false)
  // yian keeps it, so a waiter and a newcomer never lock different files
  expect(fs.existsSync(lock)).toBe(true)
  expect(await c.names()).toEqual([OFFICE])
  const error = await raised(() => c.get("chatgpt"))
  expect(error).toBeInstanceOf(ConnectionGone)
  expect((error as Error).message).toMatch(/removed/)
  expect(await raised(() => c.remove("chatgpt"))).toBeInstanceOf(ConnectionGone)
})

test("remove waits for composer to let go of the sign in", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("chatgpt", subscription())
  const auth = c.authFile("chatgpt")
  await writePrivate(auth, "{}")
  const lock = `${auth}.lock`
  const held = lockFile(lock, { private: true }) // yian refreshing the sign-in
  let settled = false
  const removing = c.remove("chatgpt").finally(() => {
    settled = true
  })
  try {
    await sleep(400)
    expect(settled).toBe(false)
    expect(fs.existsSync(auth)).toBe(true)
  } finally {
    held.release()
  }
  await removing
  expect(fs.existsSync(auth)).toBe(false)
  expect(fs.existsSync(lock)).toBe(true)
})

test("remove gives up on a sign in locked too long", async () => {
  const c = new Connections(await officeDir(tempDir()), { signInLockTimeoutMs: 200 })
  await c.put("chatgpt", subscription())
  await writePrivate(c.authFile("chatgpt"), "{}")
  const held = lockFile(path.join(c.dir, "chatgpt.auth.json.lock"), { private: true })
  try {
    const error = await raised(() => c.remove("chatgpt"))
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toMatch(/timed out/i)
  } finally {
    held.release()
  }
  expect(fs.existsSync(c.authFile("chatgpt"))).toBe(true)
  // still removed: its name was retired first
  expect(await c.names()).toEqual([OFFICE])
  await c.remove("chatgpt")
  expect(tree(c.dir)).toEqual([".lock", "_removed.json", "chatgpt.auth.json.lock"])
})

test("remove refuses a symlinked lock", async () => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  await c.put("chatgpt", subscription())
  await writePrivate(c.authFile("chatgpt"), "{}")
  const target = path.join(root, "elsewhere")
  fs.writeFileSync(target, "")
  fs.symlinkSync(target, path.join(c.dir, "chatgpt.auth.json.lock"))
  const error = await raised(() => c.remove("chatgpt"))
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/regular private path/)
  expect(fs.existsSync(target)).toBe(true)
})

test("remove cleans a sign in whose connection was never written", async () => {
  const c = new Connections(await officeDir(tempDir()))
  c.ensureDir()
  await writePrivate(c.authFile("chatgpt"), "{}")
  await c.remove("chatgpt")
  expect(tree(c.dir)).toEqual([".lock", "_removed.json", "chatgpt.auth.json.lock"])
  expect(await raised(() => c.remove("chatgpt"))).toBeInstanceOf(ConnectionGone)
  expect(await raised(() => c.remove("../x"))).toBeInstanceOf(RangeError)
})

test("a bad name raises bad connection name", async () => {
  const c = new Connections(await officeDir(tempDir(), { llm_config: { provider: "anthropic", api_key: SENTINEL } }))
  for (const call of [
    () => c.get("Bad"),
    () => c.remove("../x"),
    () => c.setDefault("login"),
    () => c.put("office", apiKey()),
  ]) {
    expect(await raised(call)).toBeInstanceOf(BadConnectionName)
  }
})

test("get reads a connection removed mid read as gone", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  const file = path.join(c.dir, "second.json")
  const open = fs.openSync
  // A remove landing between the removed-list check and the read.
  const spy = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: never[]) => {
    if (p === file) fs.unlinkSync(file)
    return (open as (...args: unknown[]) => number)(p, ...rest)
  }) as typeof fs.openSync)
  try {
    const error = await raised(() => c.get("second"))
    expect(error).toBeInstanceOf(ConnectionGone)
    expect((error as Error).message).toMatch(/no connection 'second'/)
  } finally {
    spy.mockRestore()
  }
})

test("ensure dir fixes a loose directory", async () => {
  const office = await officeDir(tempDir())
  fs.mkdirSync(path.join(office, "connections"), { mode: 0o755 })
  fs.chmodSync(path.join(office, "connections"), 0o755)
  new Connections(office).ensureDir()
  expect(mode(path.join(office, "connections"))).toBe(0o700)
})

test("a symlinked connections folder is refused and its target keeps its mode", async () => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  const target = path.join(root, "target")
  fs.mkdirSync(target)
  fs.chmodSync(target, 0o755)
  fs.symlinkSync(target, c.dir)
  expect(() => c.ensureDir()).toThrow(ProviderError)
  expect(mode(target)).toBe(0o755)
  // Guards the write paths: readPrivate's folder check refuses the link before they reach ensureDir.
  for (const call of [() => c.put("azure", apiKey({ baseUrl: azureBaseUrl("acme") })), () => c.setDefault("office")]) {
    const error = (await raised(call)) as Error
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toContain(c.dir)
    expect(error.message).not.toContain(SENTINEL)
    expect(mode(target)).toBe(0o755)
    expect(fs.readdirSync(target)).toEqual([])
  }
  const error = (await raised(() => c.ensureDir())) as Error
  expect(error.message).toContain(c.dir)
  expect(error.message).not.toContain(SENTINEL)
})

test("a connections path that is a file or a dangling symlink is refused", async () => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  fs.writeFileSync(c.dir, "")
  fs.chmodSync(c.dir, 0o644)
  expect(() => c.ensureDir()).toThrow(ProviderError)
  expect(mode(c.dir)).toBe(0o644)
  fs.unlinkSync(c.dir)
  const missing = path.join(root, "missing")
  fs.symlinkSync(missing, c.dir)
  expect(() => c.ensureDir()).toThrow(ProviderError)
  expect(fs.existsSync(missing)).toBe(false)
})

test.skipIf(process.geteuid?.() === 0)("a connections folder this user cannot read is a provider error", async () => {
  const c = new Connections(await officeDir(tempDir()))
  fs.mkdirSync(c.dir)
  fs.chmodSync(c.dir, 0o300)
  try {
    const error = (await raised(() => c.ensureDir())) as Error
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toContain(c.dir)
    expect(error.message).not.toContain("EACCES")
    expect(mode(c.dir)).toBe(0o300)
  } finally {
    fs.chmodSync(c.dir, 0o700)
  }
})

test.each(["_removed.json", "_default.json"])("a symlinked or loose list is refused [%s]", async (name) => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  await c.put("second", apiKey())
  const body = name === "_removed.json" ? '{"names": ["second"]}' : '{"name": "second"}'
  const read = () => (name === "_removed.json" ? c.names() : c.default())
  const real = path.join(root, "real.json")
  await writePrivate(real, body)
  fs.symlinkSync(real, path.join(c.dir, name))
  let error = await raised(read)
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/is a symlink, not a regular file/)
  fs.unlinkSync(path.join(c.dir, name))
  await writePrivate(path.join(c.dir, name), body)
  fs.chmodSync(path.join(c.dir, name), 0o640)
  error = await raised(read)
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/private/)
})

test("a garbled default is refused not ignored", async () => {
  const c = new Connections(await officeDir(tempDir()))
  c.ensureDir()
  for (const garbled of ["{", '{"name": 1}', "[]", "null"]) {
    await writePrivate(path.join(c.dir, "_default.json"), garbled)
    const error = await raised(() => c.default())
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toMatch(/_default\.json/)
  }
})

test("a connection cannot set the auth file", async () => {
  const root = tempDir()
  const error = await raised(() =>
    ConnectionFile.parse({
      method: "subscription",
      llm_config: { provider: "openai" },
      env: { YIAN_AUTH_FILE: path.join(root, "other.auth.json") },
    }),
  )
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/YIAN_AUTH_FILE/)
  const joined = await raised(() =>
    ConnectionFile.parse({
      method: "subscription",
      llm_config: { provider: "openai" },
      env: { "YIAN_AUTH_FILE=/tmp/a": "x" },
    }),
  )
  expect(joined).toBeInstanceOf(ProviderError)
})

test("office may still set the auth file", async () => {
  // Only an added connection is refused the auth file; office.json may set it.
  const root = tempDir()
  const auth = path.join(root, "composer-auth.json")
  const c = new Connections(
    await officeDir(root, { llm_config: { provider: "openai", model: "m" }, env: { YIAN_AUTH_FILE: auth } }),
  )
  const provider = await c.resolve(OFFICE, null)
  expect(provider.env).toEqual({ YIAN_AUTH_FILE: auth })
  expect(await c.forRun(runRecord(OFFICE, null, provider), "r2")).toEqual(provider)
  const [infos, defaultName] = await c.infos()
  expect(infos.map((i) => i.name)).toEqual([OFFICE])
  expect(defaultName).toBe(OFFICE)
})

test("infos lists every readable connection and logs only a broken ones name", async () => {
  const office = await officeDir(tempDir(), { llm_config: { provider: "anthropic", api_key: SENTINEL } })
  const { lines, log } = logs()
  const c = new Connections(office, { log })
  await c.put("second", apiKey())
  await c.put("broken", apiKey())
  await writePrivate(
    path.join(c.dir, "broken.json"),
    JSON.stringify({ llm_config: { api_key: SENTINEL }, bogus: SENTINEL }),
  )
  await writePrivate(path.join(c.dir, "loose.json"), JSON.stringify({ llm_config: apiKey().llm_config }))
  fs.chmodSync(path.join(c.dir, "loose.json"), 0o644)
  await c.setDefault("second")
  const [infos, defaultName] = await c.infos()
  expect(defaultName).toBe("second")
  expect(infos.map((i) => [i.name, i.default])).toEqual([
    [OFFICE, false],
    ["second", true],
  ])
  const logged = lines.join("\n")
  expect(logged).toContain("broken")
  expect(logged).toContain("loose")
  expect(logged).not.toContain(SENTINEL)
  expect(inspect(infos)).not.toContain(SENTINEL)
})

test("remove finishes a remove cut short", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("chatgpt", subscription())
  // retired, but its file was left
  await writePrivate(path.join(c.dir, "_removed.json"), '{"names": ["chatgpt"]}')
  expect(await c.names()).toEqual([OFFICE])
  await c.remove("chatgpt")
  expect(tree(c.dir)).toEqual([".lock", "_removed.json"])
  expect(JSON.parse(fs.readFileSync(path.join(c.dir, "_removed.json"), "utf8"))).toEqual({ names: ["chatgpt"] })
  expect(await raised(() => c.remove("chatgpt"))).toBeInstanceOf(ConnectionGone)
})

test("add raises its own error when the sign in cannot be removed", async () => {
  const { lines, log } = logs()
  const c = new Connections(await officeDir(tempDir()), { log, signInLockTimeoutMs: 200 })
  c.ensureDir()
  const held = lockFile(path.join(c.dir, "chatgpt.auth.json.lock"), { private: true })
  try {
    const refuse = (auth: string) => {
      fs.writeFileSync(auth, SENTINEL)
      throw new ProviderError("sign-in cancelled")
    }
    const error = await raised(() => c.add("chatgpt", subscription(), { signIn: refuse }))
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toMatch(/cancelled/)
  } finally {
    held.release()
  }
  const logged = lines.join("\n")
  expect(logged).toContain("connection chatgpt")
  expect(logged).not.toContain(SENTINEL)
})

test("office cannot be removed", async () => {
  const office = await officeDir(tempDir(), { llm_config: { provider: "anthropic", api_key: SENTINEL } })
  const c = new Connections(office)
  const error = await raised(() => c.remove(OFFICE))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/opencorp onboard/)
  expect(fs.existsSync(path.join(office, "connections", "office.json"))).toBe(true)
})

test("add takes the first name no file holds", async () => {
  const c = new Connections(await officeDir(tempDir()))
  expect(await c.add("azure", apiKey())).toBe("azure")
  await c.put("azure-2", apiKey())
  expect(await c.add("azure", apiKey())).toBe("azure-3")
  expect((await c.names()).slice(0, 4)).toEqual([OFFICE, "azure", "azure-2", "azure-3"])
  c.ensureDir()
  await writePrivate(c.authFile("chatgpt"), "{}") // a sign-in whose connection was never written
  expect(await c.add("chatgpt", subscription())).toBe("chatgpt-2")
  // a reserved name is skipped like a taken one
  expect(await c.add("login", apiKey())).toBe("login-2")
  for (const bad of ["Bad", "x".repeat(33)]) {
    expect(await raised(() => c.add(bad, apiKey()))).toBeInstanceOf(RangeError)
  }
  expect(await c.add("x".repeat(31), apiKey())).toBe("x".repeat(31))
  // x*31-2 is too long a name
  expect(await raised(() => c.add("x".repeat(31), apiKey()))).toBeInstanceOf(RangeError)
})

test("add saves the sign in before the connection", async () => {
  const c = new Connections(await officeDir(tempDir()))
  const seen: [string, string[]][] = []
  const signIn = async (auth: string) => {
    seen.push([auth, fs.readdirSync(c.dir).sort()])
    await writePrivate(auth, "{}")
  }
  const name = await c.add("chatgpt", subscription(), { signIn })
  expect(name).toBe("chatgpt")
  expect(seen).toEqual([[c.authFile("chatgpt"), []]])
  expect(mode(c.dir)).toBe(0o700)
  expect((await c.resolve("chatgpt", null)).env.YIAN_AUTH_FILE).toBe(c.authFile("chatgpt"))
})

test("add removes the sign in when the connection cannot be written", async () => {
  const c = new Connections(await officeDir(tempDir()))
  const full = Object.assign(new Error("No space left on device"), { code: "ENOSPC" })
  const spy = spyOn(fs, "renameSync").mockImplementation(() => {
    throw full
  })
  try {
    // Python's path.write_bytes; writePrivate would fail on the spy
    const signIn = (auth: string) => fs.writeFileSync(auth, "{}")
    const error = await raised(() => c.add("chatgpt", subscription(), { signIn }))
    expect(error).toBe(full)
  } finally {
    spy.mockRestore()
  }
  expect(tree(c.dir)).toEqual([".lock", "chatgpt.auth.json.lock"])
  const refuse = (auth: string) => {
    fs.writeFileSync(auth, "{}")
    throw new ProviderError("sign-in cancelled")
  }
  const error = await raised(() => c.add("chatgpt", subscription(), { signIn: refuse }))
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/cancelled/)
  expect(tree(c.dir)).toEqual([".lock", "chatgpt.auth.json.lock"])
})

// Each in-process collision on connections/.lock costs one of yian waitForLock's 100 ms polls (measured ~12 s at
// load 7); Python's 30 rounds and unqueued default() reads are kept.
test(
  "concurrent adds take distinct names and defaults stay whole",
  async () => {
    const c = new Connections(await officeDir(tempDir()))
    await c.put("second", apiKey())
    const flip = async (name: string) => {
      for (let i = 0; i < 30; i++) {
        await c.setDefault(name)
        expect([OFFICE, "second"]).toContain(await c.default())
      }
    }
    const [names] = await Promise.all([
      Promise.all([1, 2, 3, 4].map(() => c.add("azure", apiKey()))),
      ...[OFFICE, "second", OFFICE, "second"].map(flip),
    ])
    expect(names.sort()).toEqual(["azure", "azure-2", "azure-3", "azure-4"])
    const defaultName = JSON.parse(fs.readFileSync(path.join(c.dir, "_default.json"), "utf8")).name
    expect([OFFICE, "second"]).toContain(defaultName)
    expect(fs.readdirSync(c.dir).filter((e) => e.startsWith("."))).toEqual([".lock"])
  },
  60_000,
)

test("a removed name is never reused", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  const anthropic = () => ConnectionFile.parse({ llm_config: { provider: "anthropic", api_key: SENTINEL } })
  await c.put("anthropic", anthropic())
  await c.remove("anthropic")
  expect(await new Connections(office).add("anthropic", apiKey())).toBe("anthropic-2")
  const error = await raised(() => c.put("anthropic", anthropic()))
  expect(error).toBeInstanceOf(RangeError)
  expect((error as Error).message).toMatch(/removed/)
  expect(await c.names()).toEqual([OFFICE, "anthropic-2"])
})

test("a removed name is gone even if its file was left", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  await c.put("second", apiKey())
  // a remove cut short
  await writePrivate(path.join(office, "connections", "_removed.json"), '{"names": ["second"]}')
  expect(await c.names()).toEqual([OFFICE])
  expect(await raised(() => c.resolve("second", null))).toBeInstanceOf(ConnectionGone)
})

test("a garbled removed list is refused not ignored", async () => {
  const office = await officeDir(tempDir())
  const c = new Connections(office)
  c.ensureDir()
  for (const garbled of ["{", '{"names": "anthropic"}', '{"names": [1]}', "null"]) {
    await writePrivate(path.join(office, "connections", "_removed.json"), garbled)
    const error = await raised(() => c.add("anthropic", apiKey()))
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).toMatch(/_removed\.json/)
  }
})

test("resolve puts the model in llm config", async () => {
  const c = new Connections(
    await officeDir(tempDir(), {
      llm_config: { provider: "vllm", model: "a" },
      env: { VLLM_BASE_URL: "http://x" },
    }),
  )
  expect((await c.resolve("office", "b")).llm_config).toEqual({ provider: "vllm", model: "b" })
  expect((await c.resolve("office", "b")).env).toEqual({ VLLM_BASE_URL: "http://x" })
  expect((await c.resolve("office", null)).llm_config?.model).toBe("a")
  await c.put("second", apiKey())
  await c.setDefault("second")
  // null is office, not the default
  expect(await c.resolve(null, null)).toEqual(await c.resolve("office", null))
})

test("resolve refuses an llm config yian wont take without its values or path", async () => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  c.ensureDir()
  const file = path.join(c.dir, "second.json")
  await writePrivate(file, JSON.stringify({ llm_config: { provider: "nope-provider", model: "m" } }))
  let error = await raised(() => c.resolve("second", null))
  expect(error).toBeInstanceOf(ProviderError)
  let message = (error as Error).message
  expect(message).toStartWith("connection 'second': yian won't take this provider")
  expect(message).not.toContain("nope-provider")
  expect(message).not.toContain(root)
  // A key with no provider would go to whichever provider yian picks.
  await writePrivate(file, JSON.stringify({ llm_config: { api_key: SENTINEL, model: "m" } }))
  error = await raised(() => c.resolve("second", null))
  expect(error).toBeInstanceOf(ProviderError)
  message = (error as Error).message
  expect(message).toStartWith("connection 'second': llm_config.api_key needs llm_config.provider")
  expect(message).not.toContain(SENTINEL)
  // A run resumed on it moves, as on any connection that can't be used.
  const record = { connection: "second", model: null, configSha256: "x" }
  expect(await raised(() => c.forRun(record, "run-1"))).toBeInstanceOf(RunMoved)
})

test("a subscription resolves to its own auth file and no key", async () => {
  const root = tempDir()
  const c = new Connections(await officeDir(root))
  await c.put("chatgpt", subscription())
  await writePrivate(c.authFile("chatgpt"), "{}")
  const p = await c.resolve("chatgpt", "gpt-5.4")
  expect(p.llm_config).toEqual({ provider: "openai", model: "gpt-5.4" })
  expect(p.env).toEqual({ YIAN_AUTH_FILE: path.join(root, "office", "connections", "chatgpt.auth.json") })
  expect((await c.resolve("chatgpt", null)).llm_config).toEqual({ provider: "openai", model: "gpt-5.5" })
  expect(await c.info("chatgpt")).toEqual({
    name: "chatgpt",
    provider: "chatgpt",
    method: "subscription",
    model: "gpt-5.5",
    default: false,
  })
  // a key would take the run off the subscription
  expect(() =>
    ConnectionFile.parse({
      method: "subscription",
      llm_config: { provider: "openai", model: "m", api_key: SENTINEL },
    }),
  ).toThrow(ProviderError)
  expect(() =>
    ConnectionFile.parse({ method: "subscription", llm_config: { provider: "anthropic", model: "m" } }),
  ).toThrow(ProviderError)
})

test("a subscription without its sign in fails clearly", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("chatgpt", subscription())
  const error = await raised(() => c.resolve("chatgpt", null))
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).message).toMatch(/connection 'chatgpt' has no sign-in/)
})

test("resolving a removed connection raises connection gone", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  await c.remove("second")
  let error = await raised(() => c.resolve("second", null))
  expect(error).toBeInstanceOf(ConnectionGone)
  expect((error as Error).message).toMatch(/second/)
  error = await raised(() => c.resolve("nope", null))
  expect(error).toBeInstanceOf(ConnectionGone)
  expect((error as Error).message).toMatch(/nope/)
})

test("prices are per connection", async () => {
  const c = new Connections(
    await officeDir(tempDir(), {
      llm_config: { provider: "anthropic", api_key: SENTINEL },
      prices: { "claude-x": { input: 3, output: 15 } },
    }),
  )
  await c.put("second", apiKey({ prices: { "gpt-4o": { input: 1, output: 2 } } }))
  expect((await c.resolve("second", null)).prices).toEqual({ "gpt-4o": { input: 1, output: 2 } })
  expect((await c.resolve(OFFICE, null)).prices).toEqual({ "claude-x": { input: 3, output: 15 } })
})

test("labels", () => {
  expect(providerLabel({ provider: "openai", base_url: azureBaseUrl("acme") })).toBe("azure")
  expect(providerLabel({ provider: "openai", base_url: "https://acme.cognitiveservices.azure.com/openai/v1/" })).toBe(
    "azure",
  )
  expect(providerLabel({ provider: "openai", base_url: "https://gw.example/v1/" })).toBe("custom")
  // Azure Government and Azure China.
  for (const host of ["openai.azure.us", "cognitiveservices.azure.us", "openai.azure.cn", "cognitiveservices.azure.cn"])
    expect(providerLabel({ provider: "openai", base_url: `https://acme.${host}/openai/v1/` })).toBe("azure")
  for (const base_url of ["https://evilazure.us/v1", "https://azure.us.evil.com/v1", "https://acme.azure.co/v1"])
    expect(providerLabel({ provider: "openai", base_url })).toBe("custom")
  expect(commercialAzure({ provider: "openai", base_url: azureBaseUrl("acme") })).toBe(true)
  expect(commercialAzure({ provider: "openai", base_url: "https://acme.openai.azure.us/openai/v1/" })).toBe(false)
  expect(commercialAzure({ provider: "openai", base_url: "https://gw.example/v1" })).toBe(false)
  expect(commercialAzure({ provider: "openai" })).toBe(false)
  expect(providerLabel({ provider: "openai" })).toBe("openai")
  expect(providerLabel({ provider: "anthropic", api_key: SENTINEL })).toBe("anthropic")
  expect(providerLabel({ model: "m" })).toBe("composer")
  expect(providerLabel(null)).toBe("composer")
})

test("azure base url", () => {
  expect(azureBaseUrl("acme")).toBe("https://acme.openai.azure.com/openai/v1/")
  expect(azureBaseUrl(" https://acme.example.com/openai/v1/ ")).toBe("https://acme.example.com/openai/v1/")
})

test("a connection file has the python layout and a python file reads", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put(
    "second",
    ConnectionFile.parse({
      llm_config: { provider: "openai", model: "m", api_key: SENTINEL },
      env: { HTTPS_PROXY: "https://proxy.example:3128" },
      prices: { m: { input: 1.5, output: 2.5 } },
    }),
  )
  // As the frozen Python office's model_dump_json(indent=2) writes it.
  expect(fs.readFileSync(path.join(c.dir, "second.json"), "utf8")).toBe(
    '{\n  "llm_config": {\n    "provider": "openai",\n    "model": "m",\n    "api_key": "sk-ant-sentinel-a7d93c10e5b2"\n  },\n  "env": {\n    "HTTPS_PROXY": "https://proxy.example:3128"\n  },\n  "prices": {\n    "m": {\n      "input": 1.5,\n      "output": 2.5\n    }\n  },\n  "method": "api_key"\n}',
  )
  await writePrivate(
    path.join(c.dir, "chatgpt.json"),
    '{\n  "llm_config": {\n    "provider": "openai",\n    "model": "gpt-5.5"\n  },\n  "env": {},\n  "prices": {\n    "m": {\n      "input": 3.0,\n      "output": 15.0\n    }\n  },\n  "method": "subscription"\n}',
  )
  const read = await c.get("chatgpt")
  expect(read.method).toBe("subscription")
  expect(read.prices).toEqual({ m: { input: 3, output: 15 } })
})

// run records

test("a run record holds hashes and no key", async () => {
  const { lines, log } = logs()
  const c = new Connections(await officeDir(tempDir()), { log })
  await c.put("second", apiKey())
  const provider = await c.resolve("second", "gpt-4o-mini")
  const record = runRecord("second", "gpt-4o-mini", provider)
  expect(record).toEqual({ connection: "second", model: "gpt-4o-mini", configSha256: configHash(provider) })
  expect(record.configSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(record)).not.toContain(SENTINEL)
  expect(keyId(provider)).toBe(createHash("sha256").update(SENTINEL).digest("hex"))
  expect(keyId(Provider.parse({}))).toBeNull()
  expect(lines.join("\n")).not.toContain(SENTINEL)
})

/** The run values of a run r1 started on connection `second` with its own model. */
async function recordOf(c: Connections) {
  return runRecord("second", null, await c.resolve("second", null))
}

/** The error `forRun(record, "r1")` rejects with, checked to be a `RunMoved` whose message matches `pattern`. */
async function moved(c: Connections, record: RunRecord, pattern: RegExp) {
  const error = await raised(() => c.forRun(record, "r1"))
  expect(error).toBeInstanceOf(RunMoved)
  expect((error as Error).message).toMatch(pattern)
  return error as RunMoved
}

test("for run exact needs the whole config", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  const record = await recordOf(c)
  expect(await c.forRun(record, "r1")).toEqual(await c.resolve("second", null))
  await c.put("second", apiKey({ model: "gpt-4o-mini" }))
  await moved(c, record, /connection 'second' changed since run r1/)
})

test("for run fails on a changed key or endpoint", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  const record = await recordOf(c)
  for (const changed of [apiKey({ key: OTHER_KEY }), apiKey({ baseUrl: "https://elsewhere.example/v1/" })]) {
    await c.put("second", changed)
    const error = await moved(c, record, /connection 'second' changed since run r1/)
    expect(error.message).not.toContain(SENTINEL)
    expect(error.message).not.toContain(OTHER_KEY)
  }
})

test("for run fails on a removed connection", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  const record = await recordOf(c)
  await c.remove("second")
  await moved(c, record, /connection 'second' was removed/)
})

test("for run tells a connection that cant be used now from one that moved", async () => {
  const c = new Connections(await officeDir(tempDir()))
  await c.put("second", apiKey())
  const record = await recordOf(c)
  fs.chmodSync(path.join(c.dir, "second.json"), 0o644)
  const error = await moved(c, record, /private/)
  expect(error).toBeInstanceOf(ConnectionUnusable)
  expect((error as ConnectionUnusable).connection).toBe("second")
  expect(error.cause).toBeUndefined()
  fs.chmodSync(path.join(c.dir, "second.json"), 0o600)
  await c.put("second", apiKey({ key: OTHER_KEY }))
  expect(await moved(c, record, /changed/)).not.toBeInstanceOf(ConnectionUnusable)
  await c.remove("second")
  expect(await moved(c, record, /removed/)).not.toBeInstanceOf(ConnectionUnusable)
})

test("for run raises only run moved", async () => {
  const c = new Connections(await officeDir(tempDir()))
  for (const bad of ["../x", "default", ""]) {
    await moved(c, { connection: bad, model: null, configSha256: "c" }, /run r1's record names no connection/)
  }
  await c.put("chatgpt", subscription())
  await moved(c, { connection: "chatgpt", model: null, configSha256: "c" }, /no sign-in/)
  await c.put("broken", apiKey())
  fs.chmodSync(path.join(c.dir, "broken.json"), 0o644)
  const error = await moved(c, { connection: "broken", model: null, configSha256: "c" }, /private/)
  expect(error.cause).toBeUndefined()
  expect(error.message).not.toContain(SENTINEL)
})

test("an env change trips the config hash", () => {
  const before = Provider.parse({ llm_config: { provider: "openai", api_key: SENTINEL, model: "m" } })
  const after = Provider.parse({ llm_config: before.llm_config, env: { OPENAI_BASE_URL: "https://proxy.example/v1" } })
  expect(configHash(before)).not.toBe(configHash(after))
  const reordered = Provider.parse({ llm_config: { model: "m", api_key: SENTINEL, provider: "openai" } })
  expect(configHash(reordered)).toBe(configHash(before))
})
