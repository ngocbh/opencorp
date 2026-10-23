/** Secret-named fields, which the company snapshot and `GET /api/company` leave out of the people they send. */
import { expect, test } from "bun:test"
import { Device, Person } from "@opencorp/protocol"
import { z } from "zod"
import { blankSecrets, isSecretKey, keyName, SECRET_KEYS } from "../../src/company/secret_keys.ts"

const HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
const SHA = "c".repeat(64)

test("secret keys cover every secret person and device field", () => {
  expect(SECRET_KEYS.has("devices") && SECRET_KEYS.has("password_hash")).toBe(true)
  expect(SECRET_KEYS.has("token_sha256")).toBe(true)
  expect(["devices", "password_hash"].every(isSecretKey)).toBe(true)
  expect(Object.keys(Person.shape).filter(isSecretKey)).toEqual(["devices", "password_hash"])
  expect(Object.keys(Device.shape).filter(isSecretKey)).toEqual(["token_sha256"])
})

test("secret key names", () => {
  const keys = ["devices", "password", "passwd", "Password-Hash", "TOKEN", "secret", "client secret", "api_key",
    "apikey", "access_token", "refresh_token", "private_key", "db_password", "github_token", "app_secret",
    "openai_api_key", "ssh_private_key", "token_sha256"]
  for (const key of keys) expect([key, isSecretKey(key)]).toEqual([key, true])
})

test("camel case and dotted secret key names", () => {
  const keys = ["accessToken", "clientSecret", "privateKey", "apiKey", "refreshToken", "APIKey", "XApiKey",
    "passwordHash", "tokenSha256", "dbPassword", "GitHubToken", "idToken", "OPENAI_API_KEY", "ApiKey", "AccessToken",
    "client-Secret", "api.key", "db.password", "spring.datasource.password", "HTTPSProxyPassword"]
  for (const key of keys) expect([key, isSecretKey(key)]).toEqual([key, true])
})

test("key name splits words and is linear", () => {
  expect(keyName("HTTPSProxyPassword")).toBe("https_proxy_password")
  expect(keyName("ABCDefGHi")).toBe("abc_def_g_hi")
  expect(keyName("aB1Cd")).toBe("a_b1_cd")
  expect(keyName("spring.datasource.password")).toBe("spring_datasource_password")
  const capitals = "A".repeat(1_000_000)
  const pairs = "Ab".repeat(500_000)
  // The fastest of 3 rounds, since the machine is shared.
  let fastest = Infinity
  for (let round = 0; round < 3; round++) {
    const start = performance.now()
    keyName(capitals)
    keyName(pairs)
    fastest = Math.min(fastest, performance.now() - start)
  }
  expect(fastest).toBeLessThan(100)
})

test("names that are not secret keys", () => {
  const keys: unknown[] = ["secrets", "max_tokens", "api_key_env", "name", "tokens", "password_hint", 3, null,
    "tokens_used", "secretary", "maxTokens", "totalTokens", "promptTokens", "tokenType", "TokenCount", "apiKeyEnv",
    "passwordHint", "Secretary", "keyboard", "monkey", "MAX_TOKENS"]
  for (const key of keys) expect([key, isSecretKey(key)]).toEqual([key, false])
})

test("blank secrets empties devices and the password hash", () => {
  const person = Person.parse({
    handle: "a",
    name: "A",
    kind: "human",
    title: "t",
    manager: null,
    devices: [{ name: "mac", token_sha256: SHA }],
    password_hash: HASH,
  })
  const blank = blankSecrets(Person, person)
  expect(blank.devices).toEqual([])
  expect(blank.password_hash).toBeNull()
})

test("blank secrets refuses a required secret field", () => {
  const Leaky = z.strictObject({ token: z.string() })
  expect(() => blankSecrets(Leaky, { token: "x" })).toThrow(Error)
})
