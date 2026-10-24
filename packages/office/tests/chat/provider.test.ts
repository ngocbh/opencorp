/** The provider file: defaults, checked fields, refused env names and values, and errors that never echo it. */
import fs from "node:fs"
import path from "node:path"
import { inspect } from "node:util"
import { expect, test } from "bun:test"
import type { z } from "zod"
import { checked, loadProvider, Provider, ProviderError, providerSchema } from "../../src/chat/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir } from "../helpers.ts"

const SENTINEL = "sk-sentinel-4b1d9e"

/** Writes `data` (text, or JSON for anything else) to `file` with `mode`, and returns `file`. */
function write(file: string, data: unknown, mode = 0o600): string {
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data))
  fs.chmodSync(file, mode)
  return file
}

/** The error `loadProvider` rejects with for `file`; fails unless it is a `ProviderError` with no cause. */
async function refusal(file: string): Promise<ProviderError> {
  const error = await loadProvider(file, Provider.parse).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ProviderError)
  expect((error as Error).cause).toBeUndefined()
  return error as ProviderError
}

/** Fails if `error`'s message or its inspected form holds any of `texts`. */
function expectNoneOf(error: Error, ...texts: string[]): void {
  for (const text of texts) {
    expect(error.message).not.toContain(text)
    expect(inspect(error)).not.toContain(text)
  }
}

test("no file means composer defaults", async () => {
  const provider = await loadProvider(path.join(tempDir(), "provider.json"), Provider.parse)
  expect(provider).toEqual(Provider.parse({}))
})

class Extra extends Provider {
  readonly method: string

  protected constructor(fields: z.output<typeof providerSchema>, method: string) {
    super(fields)
    this.method = method
  }

  static override parse(data: unknown = {}): Extra {
    const { method = "api_key", ...rest } = data as { method?: string }
    return new Extra(checked(providerSchema, rest), method)
  }
}

test("load provider validates as the given model", async () => {
  const tmp = tempDir()
  const file = path.join(tmp, "c.json")
  await writePrivate(file, '{"method": "subscription"}')
  expect((await loadProvider(file, Extra.parse)).method).toBe("subscription")
  const missing = await loadProvider(path.join(tmp, "missing.json"), Extra.parse)
  expect(missing).toEqual(Extra.parse({}))
  expect(missing).toBeInstanceOf(Extra)
  const error = await loadProvider(path.join(tmp, "missing.json"), Extra.parse, { missingOk: false }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
})

test("reads config env and prices", async () => {
  const file = write(path.join(tempDir(), "provider.json"), {
    llm_config: { provider: "anthropic", model: "claude-x", api_key: SENTINEL },
    env: { ANTHROPIC_BASE_URL: "https://llm.example" },
    prices: { "claude-x": { input: 3, output: 15 } },
  })
  const provider = await loadProvider(file, Provider.parse)
  expect(provider.llm_config).toEqual({ provider: "anthropic", model: "claude-x", api_key: SENTINEL })
  expect(provider.env).toEqual({ ANTHROPIC_BASE_URL: "https://llm.example" })
  expect(provider.prices).toEqual({ "claude-x": { input: 3, output: 15 } })
  expect(inspect(provider)).not.toContain(SENTINEL)
  expect(JSON.stringify(provider)).not.toContain(SENTINEL)
})

test.each([
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "CLIENT_SECRET",
  "DB_PASSWORD",
  "PASSWORD_FILE",
  "openai_api_key",
  "OPENAI_APIKEY",
  "DB_PASS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_CREDENTIALS",
])("a credential in env is refused [%s]", async (name) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { [name]: SENTINEL } }))
  expect(error.message).toMatch(/llm_config\.api_key/)
  expectNoneOf(error, SENTINEL)
})

test.each([
  `https://user:${SENTINEL}@proxy.example:3128`,
  `http://${SENTINEL}@llm.example`,
  `socks5://u:${SENTINEL}@h`,
  `  https://u:${SENTINEL}@h`,
  `\thttp://${SENTINEL}@h`,
])("a url with credentials in env is refused [%s]", async (url) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env: { HTTPS_PROXY: url } }))
  expect(error.message).toMatch(/HTTPS_PROXY/)
  expectNoneOf(error, SENTINEL)
})

test.each(["https://proxy.example:3128", "http://llm.example/v1?user=a@b", "/etc/ssl/ca.pem", "a@b.example"])(
  "settings that arent credentials are kept [%s]",
  async (value) => {
    const file = write(path.join(tempDir(), "provider.json"), { env: { HTTPS_PROXY: value } })
    expect((await loadProvider(file, Provider.parse)).env).toEqual({ HTTPS_PROXY: value })
  },
)

test.each(
  [{ [`${SENTINEL}_KEY`]: "v" }, { [SENTINEL]: 5 }, { [SENTINEL]: "https://u:p@h" }].map(
    (env) => [JSON.stringify(env), env] as const,
  ),
)("an env name that isnt a variable name is never echoed [%s]", async (_label, env) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { env }))
  expectNoneOf(error, SENTINEL)
})

test.each(
  [{ [SENTINEL]: "v" }, { api_key: SENTINEL }, { prices: { m: { input: 1, output: 1, [SENTINEL]: 1 } } }].map(
    (data) => [JSON.stringify(data), data] as const,
  ),
)("an extra field is never named [%s]", async (_label, data) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), data))
  expect(error.message).toMatch(/an extra field/)
  expectNoneOf(error, SENTINEL, "api_key")
})

test.each(
  [{ [SENTINEL]: { input: "x", output: 1 } }, { [SENTINEL]: { input: -1, output: 1 } }, { [SENTINEL]: 5 }].map(
    (prices) => [JSON.stringify(prices), prices] as const,
  ),
)("a model name in prices is never echoed [%s]", async (_label, prices) => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), { prices }))
  expect(error.message).toMatch(/prices/)
  expectNoneOf(error, SENTINEL)
})

test("a file others can read is refused", async () => {
  const error = await refusal(write(path.join(tempDir(), "provider.json"), {}, 0o644))
  expect(error.message).toMatch(/mode 0600/)
})

test("a symlink is refused", async () => {
  const tmp = tempDir()
  const target = write(path.join(tmp, "real.json"), {})
  fs.symlinkSync(target, path.join(tmp, "provider.json"))
  const error = await refusal(path.join(tmp, "provider.json"))
  expect(error.message).toMatch(/can't open/)
})

test.each(['{"env": {"KEY": 12345678}, "llm_config": "sk-secret-value"}', "sk-secret-value"])(
  "errors never echo the file [%s]",
  async (text) => {
    const error = await refusal(write(path.join(tempDir(), "provider.json"), text))
    expectNoneOf(error, "sk-secret-value", "12345678")
  },
)

test.each([
  "BUN_OPTIONS",
  "BUN_INSTALL",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_PATH",
])("a runtime or loader variable in env is refused [%s]", async (name) => {
  const tmp = tempDir()
  const error = await refusal(write(path.join(tmp, "provider.json"), { env: { [name]: "x" } }))
  expect(error.message).toContain(name)
  // BUNDLE_PATH sits just outside the BUN_ prefix.
  const kept = { NODE_ENV: "production", BUNDLE_PATH: "/b", NODE_EXTRA_CA_CERTS: "/etc/ssl/ca.pem" }
  const file = write(path.join(tmp, "kept.json"), { env: kept })
  expect((await loadProvider(file, Provider.parse)).env).toEqual(kept)
})
