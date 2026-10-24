/** The office's connections: one private file each, the default pointer, removed names, resolve and labels. */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, spyOn, test } from "bun:test"
import { OFFICE } from "@opencorp/protocol"
import {
  azureBaseUrl,
  BadConnectionName,
  ConnectionFile,
  ConnectionGone,
  Connections,
  providerLabel,
} from "../../src/chat/connections.ts"
import { type Price, Provider, ProviderError } from "../../src/chat/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir } from "../helpers.ts"

const SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"

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
    const calls: (() => unknown)[] = [() => c.put(bad, apiKey()), () => c.authFile(bad)]
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
      // office can be read and resolved, never written
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

test("a bad name raises bad connection name", async () => {
  const c = new Connections(await officeDir(tempDir(), { llm_config: { provider: "anthropic", api_key: SENTINEL } }))
  for (const call of [() => c.get("Bad"), () => c.setDefault("login"), () => c.put("office", apiKey())]) {
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
  expect((error as Error).message).toMatch(/can't open/)
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
  const [infos, dflt] = await c.infos()
  expect(dflt).toBe("second")
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
