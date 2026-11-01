/** Connection routes: listing, adding, removing and the default, and who may manage them (Python's
 *  `tests/daemon/test_routes_connections.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { type AuthRequest, HttpResponse, OpenAIAuth } from "@ngocbh/yian/llm_clients"
import { stringify } from "yaml"
import { Identity, identityPath, writeIdentity } from "../../src/auth/identity.ts"
import { newToken } from "../../src/auth/tokens.ts"
import { ConnectionFile, providerLabel } from "../../src/chat/connections.ts"
import type { LoginsOptions } from "../../src/chat/logins.ts"
import { DEADLINE_MS, type Lister, listModels, ownModels } from "../../src/chat/models.ts"
import { type Provider, ProviderError } from "../../src/chat/provider.ts"
import type { Office } from "../../src/daemon/office.ts"
import { type ModelCheck, MAX_KEY_CHARS, modelProblem } from "../../src/install/onboard.ts"
import { writePrivate } from "../../src/secrets.ts"
import { RegistryClosed } from "../../src/worker/spawn.ts"
import {
  APPROVED,
  CATALOG,
  keyCopies,
  MIXED_KEY,
  PENDING,
  REFRESH,
  refusingLlm,
  SIGNATURE,
  TOKENS,
  USERCODE,
  testScheduler,
} from "../chat/helpers.ts"
import { git } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import { recordEvents } from "../store/helpers.ts"
import { addHuman, bearer, giveDevice, makeOffice, type Reply, request, served } from "./helpers.ts"

setDefaultTimeout(30_000)

const SENTINEL = "sk-sentinel-0d4c7e19b2a6"
/** A key the fake provider refuses. */
const REFUSED = "sk-refused-5e8a1c03f7d2"
/** A key whose provider the fake listing can't reach. */
const UNREACHABLE = "sk-unreachable-93b7f2a05c1e"

const LISTS: Record<string, string[]> = {
  azure: ["gpt-5.4", "o3"],
  openai: ["chatgpt-4o-latest", "gpt-5.5", "o3"],
  anthropic: ["claude-opus-4-1", "claude-sonnet-4-5"],
  custom: ["llama-4"],
}

/** Stands in for listing a provider: those in `LISTS` list it, `REFUSED` is refused, and `UNREACHABLE` can't be
 *  listed; records each call. */
class Listings {
  calls: string[] = []

  readonly list: Lister = async (conn, name) => {
    this.calls.push(name)
    const llm = conn.llm_config ?? {}
    if (llm.api_key === REFUSED) return ownModels(conn, name, "HTTP 401", { refused: true })
    if (llm.api_key === UNREACHABLE) return ownModels(conn, name, "can't reach host")
    const label = providerLabel(llm)
    if (Object.hasOwn(LISTS, label)) {
      return { connection: name, models: LISTS[label]!.map((id) => ({ id, name: null })), listed: true, error: null }
    }
    return ownModels(conn, name)
  }
}

/** Stands in for the one-reply check: answers the next of `problems` (null: the model answered); records each. */
class Checks {
  calls: Provider[] = []
  problems: (string | null)[] = []

  readonly check: ModelCheck = async (provider) => {
    this.calls.push(provider)
    return this.problems.shift() ?? null
  }
}

/** An office with the office connection (anthropic, keyed `SENTINEL`), served with device tokens; `lister` stands
 *  in for the `Listings` fake, and `checkModel` for the `Checks` fake. */
async function setup({
  auth,
  lister,
  checkModel,
}: { auth?: LoginsOptions["auth"]; lister?: Lister; checkModel?: ModelCheck } = {}) {
  const lines: string[] = []
  const listings = new Listings()
  const checks = new Checks()
  const office = makeOffice({
    log: (m) => lines.push(m),
    models: { lister: lister ?? listings.list },
    logins: auth ? { auth } : {},
    checkModel: checkModel ?? checks.check,
  })
  // As buildOffice does, so makeOffice's cleanup cancels a sign-in still polling before the store closes.
  office.onStop.push(() => office.logins.closeAll())
  fs.mkdirSync(office.paths.office, { recursive: true, mode: 0o700 })
  office.connections.ensureDir()
  await writePrivate(
    path.join(office.connections.dir, "office.json"),
    JSON.stringify({ llm_config: { provider: "anthropic", api_key: SENTINEL } }),
  )
  const { sock } = await served(office, { tokens: true, log: (l) => lines.push(l) })
  return { office, sock, listings, checks, lines, company: office.paths.company }
}

/** Signs this device in as the owner, ngocbh; their bearer header. */
async function asOwner(office: Office): Promise<Record<string, string>> {
  const token = newToken()
  giveDevice(office.paths.company, "ngocbh", "mac", token)
  await writeIdentity(identityPath(office.paths.home), new Identity("ngocbh", "mac", token))
  return bearer(token)
}

/** Hires ava with a device; her bearer header. Call after `asOwner`. */
function asAva(office: Office): Record<string, string> {
  addHuman(office.paths.company, "ava")
  const token = newToken()
  giveDevice(office.paths.company, "ava", "pc", token)
  return bearer(token)
}

function officeAsset(grants: unknown[]) {
  return { id: "offices", kind: "office", tools: { connections: {} }, grants }
}

function commitAsset(company: string, asset: { id: string }): void {
  fs.writeFileSync(path.join(company, "assets", `${asset.id}.yaml`), stringify(asset))
  git(company, "add", "-A")
  git(company, "commit", "-qm", `asset ${asset.id}`)
}

function azureFile(): ConnectionFile {
  return ConnectionFile.parse({
    llm_config: {
      provider: "openai",
      base_url: "https://acme.openai.azure.com/openai/v1/",
      api_key: SENTINEL,
      model: "gpt-5.4",
    },
  })
}

function saved(office: Office, name: string): { llm_config: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(office.connections.dir, `${name}.json`), "utf8"))
}

/** Nothing but the office connection and its folder's lock was written. */
function onlyOffice(office: Office): void {
  expect(fs.readdirSync(office.connections.dir).sort()).toEqual([".lock", "office.json"])
}

type Json = Record<string, unknown>
const json = (r: Reply) => r.json() as Json
const errorOf = (r: Reply) => json(r).error

function send(sock: string, method: string, target: string, headers: Record<string, string>, body?: unknown) {
  if (body === undefined) return request(sock, method, target, { headers })
  return request(sock, method, target, {
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const get = (sock: string, target: string, headers: Record<string, string>) => send(sock, "GET", target, headers)
const post = (sock: string, target: string, headers: Record<string, string>, body: unknown) =>
  send(sock, "POST", target, headers, body)
const put = (sock: string, target: string, headers: Record<string, string>, body: unknown) =>
  send(sock, "PUT", target, headers, body)
const del = (sock: string, target: string, headers: Record<string, string>) => send(sock, "DELETE", target, headers)

test("everyone signed in sees connections without keys", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const ava = asAva(office)
  await office.connections.put("azure", azureFile())
  const r = await get(sock, "/connections", ava)
  expect(r.status).toBe(200)
  expect(r.text).not.toContain(SENTINEL)
  expect(r.json()).toEqual({
    connections: [
      { name: "office", provider: "anthropic", method: "api_key", model: null, default: true },
      { name: "azure", provider: "azure", method: "api_key", model: "gpt-5.4", default: false },
    ],
    default: "office",
    can_manage: false,
  })
  expect(json(await get(sock, "/connections", owner)).can_manage).toBe(true)
})

test("the owner adds a connection", async () => {
  const { office, sock, checks, lines } = await setup()
  const owner = await asOwner(office)
  const events = recordEvents(office.store)
  let r = await post(sock, "/connections", owner, { provider: "openai", api_key: SENTINEL })
  expect([r.status, r.json()]).toEqual([
    200,
    { name: "openai", provider: "openai", method: "api_key", model: "gpt-5.5", default: false },
  ])
  const file = path.join(office.connections.dir, "openai.json")
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(saved(office, "openai").llm_config).toEqual({ provider: "openai", api_key: SENTINEL, model: "gpt-5.5" })
  r = await post(sock, "/connections", owner, { provider: "openai", api_key: SENTINEL, model: "o3" })
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "openai-2", "o3"])
  expect(checks.calls).toEqual([]) // a listed model needs no one-reply check
  const listed = await get(sock, "/connections", owner)
  expect(r.text + listed.text + lines.join("\n")).not.toContain(SENTINEL)
  expect(events.filter((e) => JSON.stringify(e).includes(SENTINEL))).toEqual([])
})

test("a listed provider without a default takes its first model", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, { provider: "azure", api_key: SENTINEL, endpoint: "acme" })
  expect(json(r).model).toBe("gpt-5.4")
})

test("a model the listing doesnt offer gets a one reply check", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  checks.problems.push(...Array(2).fill("Error code: 404 - model not found"))
  for (const body of [
    { provider: "openai", api_key: SENTINEL, model: "gpt5-prod" },
    { provider: "azure", api_key: SENTINEL, endpoint: "acme", model: "gpt5-prod" },
  ]) {
    const r = await post(sock, "/connections", owner, body)
    expect([r.status, r.json()]).toEqual([
      422,
      { error: "model_refused", message: "The model didn't answer: Error code: 404 - model not found" },
    ])
  }
  onlyOffice(office)
  expect(checks.calls.map((c) => c.llm_config!.model)).toEqual(["gpt5-prod", "gpt5-prod"])
  const r = await post(sock, "/connections", owner, { provider: "openai", api_key: SENTINEL, model: "gpt5-prod" })
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "openai", "gpt5-prod"])
  expect(checks.calls.at(-1)!.llm_config).toEqual({ provider: "openai", api_key: SENTINEL, model: "gpt5-prod" })
})

/** Those of `needles` that `text` holds, case-insensitively. */
const leaks = (text: string, ...needles: string[]) =>
  needles.filter((n) => text.toLowerCase().includes(n.toLowerCase()))

/** The `model_refused` message for `body` when the one-reply check answers `problem`. */
async function refusedWith(body: Record<string, unknown>, problem: string): Promise<string> {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  checks.problems.push(problem)
  const r = await post(sock, "/connections", owner, body)
  expect([r.status, errorOf(r)]).toEqual([422, "model_refused"])
  expect(checks.calls).toHaveLength(1)
  return (r.json() as { message: string }).message
}

test("a model that doesnt answer never quotes the azure resource it was named", async () => {
  const body = { provider: "azure", endpoint: "sk-AzureRes-KEY123", api_key: SENTINEL, model: "gpt-5.4-x" }
  const problem = "openai request failed (connection): getaddrinfo ENOTFOUND sk-azureres-key123.openai.azure.com"
  const message = await refusedWith(body, problem)
  expect(message).toBe(
    "The model didn't answer: openai request failed (connection): getaddrinfo ENOTFOUND the endpoint",
  )
  expect(leaks(message, "sk-AzureRes-KEY123")).toEqual([])
})

test("a model that doesnt answer never quotes the endpoint url, even at a sentence's end", async () => {
  const endpoint = " https://Sk-Pasted-SECRET9.example.invalid/v1 "
  const body = { provider: "openai", endpoint, api_key: SENTINEL, model: "m1" }
  const problem =
    "request to https://sk-pasted-secret9.example.invalid/v1/chat/completions failed, " +
    "ENOTFOUND sk-pasted-secret9.example.invalid."
  const message = await refusedWith(body, problem)
  expect(message).toBe(
    "The model didn't answer: request to the endpoint/chat/completions failed, ENOTFOUND the endpoint.",
  )
  expect(leaks(message, "Sk-Pasted-SECRET9")).toEqual([])
})

test("a model that doesnt answer never quotes the path of an endpoint that ends in a slash", async () => {
  const body = { provider: "openai", endpoint: "https://gw.example/team-sk-123/v1/", api_key: SENTINEL, model: "m1" }
  const problem = "request to https://gw.example/team-sk-123/v1/chat/completions failed"
  const message = await refusedWith(body, problem)
  expect(message).toBe("The model didn't answer: request to the endpoint/chat/completions failed")
  expect(leaks(message, "team-sk-123")).toEqual([])
})

test("a model that doesnt answer never quotes the endpoint in its normalized form", async () => {
  const body = { provider: "openai", endpoint: "https://gw.example.com:443/team-sk-123/v1/", api_key: SENTINEL, model: "m1" }
  const problem = "request to https://gw.example.com/team-sk-123/v1/chat/completions failed"
  const message = await refusedWith(body, problem)
  expect(message).toBe("The model didn't answer: request to the endpoint/chat/completions failed")
  expect(leaks(message, "team-sk-123")).toEqual([])
})

test("a model id with no letter or digit is left as is", async () => {
  const body = { provider: "openai", api_key: SENTINEL, model: "-" }
  const message = await refusedWith(body, "model - not found; try gpt-5-mini")
  expect(message).toBe("The model didn't answer: model - not found; try gpt-5-mini")
})

test("an azure resource is replaced even where another host continues it", async () => {
  const body = { provider: "azure", endpoint: "sk-AzureRes-KEY123", api_key: SENTINEL, model: "gpt-5.4-x" }
  const message = await refusedWith(body, "getaddrinfo ENOTFOUND sk-azureres-key123.cognitiveservices.azure.com")
  expect(message).toBe("The model didn't answer: getaddrinfo ENOTFOUND the endpoint.cognitiveservices.azure.com")
  expect(leaks(message, "sk-AzureRes-KEY123")).toEqual([])
})

test("a model that doesnt answer never quotes the model it was named", async () => {
  const body = { provider: "openai", api_key: SENTINEL, model: "sk-Model-SECRET1" }
  const message = await refusedWith(body, "Error code: 404 - The model `sk-Model-SECRET1` does not exist")
  expect(message).toBe("The model didn't answer: Error code: 404 - The model `the model` does not exist")
})

test("a model id that ends in punctuation is replaced before whatever follows it", async () => {
  const body = { provider: "openai", api_key: SENTINEL, model: "sk-Org-SECRET2/" }
  const message = await refusedWith(body, "model sk-org-secret2/latest not found")
  expect(message).toBe("The model didn't answer: model the modellatest not found")
})

test("a short model id is replaced only where it stands alone", async () => {
  const body = { provider: "google", api_key: SENTINEL, model: "o3" }
  const message = await refusedWith(body, "model o3 not found; try o3-mini")
  expect(message).toBe("The model didn't answer: model the model not found; try o3-mini")
})

test("a single-label host is replaced wherever it stands alone", async () => {
  // On purpose: the host is the endpoint the request named, so the word it equals goes too.
  const body = { provider: "openai", endpoint: "https://openai:8000/v1", api_key: SENTINEL, model: "m1" }
  const message = await refusedWith(body, "openai request failed (connection): getaddrinfo ENOTFOUND openai")
  expect(message).toBe(
    "The model didn't answer: the endpoint request failed (connection): getaddrinfo ENOTFOUND the endpoint",
  )
})

test("an endpoint with credentials is refused before the check, unquoted", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const endpoint = "https://user:pw-SECRET@sk-host-KEY4.example.invalid/v1"
  const r = await post(sock, "/connections", owner, { provider: "openai", endpoint, api_key: SENTINEL, model: "m1" })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
  expect(leaks(r.text, "sk-host-KEY4", "pw-SECRET")).toEqual([])
  expect(checks.calls).toEqual([])
})

test("a default model that doesnt answer has nothing scrubbed", async () => {
  const before = LISTS.openai!
  LISTS.openai = ["o3"]
  onTestFinished(() => {
    LISTS.openai = before
  })
  const message = await refusedWith({ provider: "openai", api_key: SENTINEL }, "getaddrinfo ENOTFOUND api.openai.com")
  expect(message).toBe("The model 'gpt-5.5' didn't answer: getaddrinfo ENOTFOUND api.openai.com; name another model")
})

test("azure needs an endpoint and gets its v1 url", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  let r = await post(sock, "/connections", owner, { provider: "azure", api_key: SENTINEL })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
  onlyOffice(office)
  r = await post(sock, "/connections", owner, { provider: "azure", api_key: SENTINEL, endpoint: "acme", model: "o3" })
  expect([r.status, json(r).name, json(r).provider, json(r).model]).toEqual([200, "azure", "azure", "o3"])
  expect(saved(office, "azure").llm_config).toEqual({
    provider: "openai",
    base_url: "https://acme.openai.azure.com/openai/v1/",
    api_key: SENTINEL,
    model: "o3",
  })
  expect(checks.calls).toEqual([]) // listing was the check
})

test("other takes a base url and needs a model", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "openai", api_key: SENTINEL, endpoint: "https://gw.example/v1" }
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
  r = await post(sock, "/connections", owner, { ...body, model: "llama-4" })
  expect([r.status, json(r).name, json(r).provider]).toEqual([200, "custom", "custom"])
  expect(saved(office, "custom").llm_config).toEqual({
    provider: "openai",
    base_url: "https://gw.example/v1",
    api_key: SENTINEL,
    model: "llama-4",
  })
  expect(checks.calls).toEqual([]) // listing was the check
})

test("an endpoint is only for azure or openai", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, {
    provider: "anthropic",
    api_key: SENTINEL,
    endpoint: "https://gw.example/v1",
  })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
})

test("a refused key on a providers own host or azure is not saved", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  for (const body of [
    { provider: "openai", api_key: REFUSED },
    { provider: "azure", api_key: REFUSED, endpoint: "acme" },
  ]) {
    const r = await post(sock, "/connections", owner, body)
    expect([r.status, r.json()]).toEqual([422, { error: "key_refused", message: "The key didn't work (HTTP 401)" }])
  }
  onlyOffice(office)
  expect(checks.calls).toEqual([])
})

test("a custom endpoint that refuses its list gets a one reply check", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "openai", api_key: REFUSED, endpoint: "https://gw.example/v1", model: "llama-4" }
  checks.problems.push("Error code: 401 - invalid key")
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, r.json()]).toEqual([
    422,
    { error: "model_refused", message: "The model didn't answer: Error code: 401 - invalid key" },
  ])
  onlyOffice(office)
  r = await post(sock, "/connections", owner, body)
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "custom", "llama-4"])
  const llm = { provider: "openai", base_url: "https://gw.example/v1", api_key: REFUSED, model: "llama-4" }
  expect(checks.calls.map((c) => c.llm_config)).toEqual([llm, llm])
})

test("a default model that doesnt answer is named", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const before = LISTS.openai!
  LISTS.openai = ["o3"]
  onTestFinished(() => {
    LISTS.openai = before
  })
  checks.problems.push(...Array(2).fill("Error code: 404 - model not found"))
  for (const [body, model] of [
    [{ provider: "openai", api_key: SENTINEL }, "gpt-5.5"],
    [{ provider: "anthropic", api_key: UNREACHABLE }, "claude-sonnet-4-5"],
  ] as const) {
    const r = await post(sock, "/connections", owner, body)
    expect([r.status, r.json()]).toEqual([
      422,
      {
        error: "model_refused",
        message: `The model '${model}' didn't answer: Error code: 404 - model not found; name another model`,
      },
    ])
  }
  expect(checks.calls).toHaveLength(2)
  onlyOffice(office)
  // Yian has no default model, so the check and the saved connection name it.
  expect(checks.calls.map((c) => c.llm_config!.model)).toEqual(["gpt-5.5", "claude-sonnet-4-5"])
})

test("an unlisted provider named no model is saved on its default", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, { provider: "anthropic", api_key: UNREACHABLE })
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "anthropic", "claude-sonnet-4-5"])
  expect(checks.calls.map((c) => c.llm_config!.model)).toEqual(["claude-sonnet-4-5"])
  expect(saved(office, "anthropic").llm_config.model).toBe("claude-sonnet-4-5")
})

test("azure that cant list needs a model to check", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "azure", api_key: UNREACHABLE, endpoint: "acme" }
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, r.json()]).toEqual([
    422,
    {
      error: "models_unlisted",
      message:
        "Couldn't list the deployments (can't reach host); name a model to check it with one reply",
    },
  ])
  expect(r.text.toLowerCase()).not.toContain("acme.openai.azure.com")
  expect(checks.calls).toEqual([])
  onlyOffice(office)
  r = await post(sock, "/connections", owner, { ...body, model: "gpt-5.4" })
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "azure", "gpt-5.4"])
  expect(checks.calls.map((c) => c.llm_config!.model)).toEqual(["gpt-5.4"])
})

test("a provider that cant be listed gets a one reply check", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "anthropic", api_key: UNREACHABLE, model: "claude-x" }
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "anthropic", "claude-x"])
  expect(checks.calls[0]!.llm_config).toEqual({ provider: "anthropic", api_key: UNREACHABLE, model: "claude-x" })
  checks.problems.push("Error code: 404 - model not found")
  r = await post(sock, "/connections", owner, body)
  expect([r.status, r.json()]).toEqual([
    422,
    { error: "model_refused", message: "The model didn't answer: Error code: 404 - model not found" },
  ])
  expect(fs.readdirSync(office.connections.dir).sort()).toEqual([".lock", "anthropic.json", "office.json"])
})

test("a provider the listing leaves unlisted gets a one reply check", async () => {
  const { office, sock, checks } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "google", api_key: SENTINEL, model: "gemini-x" }
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "google", "gemini-x"])
  expect(checks.calls.map((c) => c.llm_config)).toEqual([{ provider: "google", api_key: SENTINEL, model: "gemini-x" }])
  checks.problems.push("Error code: 404 - model not found")
  r = await post(sock, "/connections", owner, body)
  expect([r.status, r.json()]).toEqual([
    422,
    { error: "model_refused", message: "The model didn't answer: Error code: 404 - model not found" },
  ])
  expect(fs.readdirSync(office.connections.dir).sort()).toEqual([".lock", "google.json", "office.json"])
})

test("anthropic is checked against what its host lists", async () => {
  const seen: [url: string, key: string | undefined][] = []
  const host: AuthRequest = async (_method, url, { headers }) => {
    const key = headers["x-api-key"]
    seen.push([url, key])
    if (key === REFUSED) return new HttpResponse(401, null)
    // Dated ids only: the aliases that answer as well aren't listed.
    const dated = ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"]
    return new HttpResponse(200, { data: dated.map((id) => ({ id })), has_more: false })
  }
  const listings = new Listings()
  // The route lists with exactly DEADLINE_MS and a warm-up with what remains of it, so only the route reaches the
  // fake host: in Python the route called the patched real listing while the cache kept the fake one.
  const lister: Lister = (conn, name, opts) =>
    opts.deadlineMs === DEADLINE_MS
      ? listModels(conn, name, { ...opts, request: host })
      : listings.list(conn, name, opts)
  const { office, sock, checks, lines } = await setup({ lister })
  const owner = await asOwner(office)
  let r = await post(sock, "/connections", owner, { provider: "anthropic", api_key: REFUSED })
  expect([r.status, r.json()]).toEqual([422, { error: "key_refused", message: "The key didn't work (HTTP 401)" }])
  checks.problems.push("Error code: 404 - model not found")
  r = await post(sock, "/connections", owner, { provider: "anthropic", api_key: SENTINEL, model: "claude-x" })
  expect([r.status, r.json()]).toEqual([
    422,
    { error: "model_refused", message: "The model didn't answer: Error code: 404 - model not found" },
  ])
  onlyOffice(office)
  r = await post(sock, "/connections", owner, { provider: "anthropic", api_key: SENTINEL })
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "anthropic", "claude-sonnet-4-5"])
  expect(checks.calls.map((c) => c.llm_config)).toEqual([
    { provider: "anthropic", api_key: SENTINEL, model: "claude-x" },
    { provider: "anthropic", api_key: SENTINEL, model: "claude-sonnet-4-5" },
  ])
  r = await post(sock, "/connections", owner, {
    provider: "anthropic",
    api_key: SENTINEL,
    model: "claude-opus-4-1-20250805",
  })
  expect([r.status, json(r).model]).toEqual([200, "claude-opus-4-1-20250805"])
  expect(checks.calls).toHaveLength(2)
  const url = "https://api.anthropic.com/v1/models?limit=1000"
  expect(seen).toEqual([
    [url, REFUSED],
    [url, SENTINEL],
    [url, SENTINEL],
    [url, SENTINEL],
  ])
  expect(r.text + lines.join("\n")).not.toContain(SENTINEL)
})

test("others are refused before the body is read", async () => {
  const { office, sock } = await setup()
  await asOwner(office)
  const ava = asAva(office)
  for (const [method, target] of [
    ["POST", "/connections"],
    ["DELETE", "/connections/office"],
    ["DELETE", "/connections/nope"],
    ["PUT", "/connections/default"],
    ["POST", "/connections/login"],
  ] as const) {
    // node:http's client sends a DELETE body without a content-length, so the server would read it as a
    // second request; the length is spelled out, as httpx sent it.
    const r = await request(sock, method, target, { headers: { ...ava, "content-length": "8" }, body: "not json" })
    expect([r.status, errorOf(r)]).toEqual([403, "forbidden"])
  }
  onlyOffice(office)
})

test("a grant lets ava manage", async () => {
  const { office, sock, company } = await setup()
  await asOwner(office)
  const ava = asAva(office)
  commitAsset(company, officeAsset([{ who: "ava", can: ["connections"] }]))
  expect(json(await get(sock, "/connections", ava)).can_manage).toBe(true)
  const r = await post(sock, "/connections", ava, { provider: "openai", api_key: SENTINEL })
  expect(r.status).toBe(200)
})

test("an uncommitted grant doesnt count", async () => {
  const { office, sock, company } = await setup()
  await asOwner(office)
  const ava = asAva(office)
  fs.writeFileSync(
    path.join(company, "assets", "offices.yaml"),
    stringify(officeAsset([{ who: "ava", can: ["admin"] }])),
  )
  const r = await post(sock, "/connections", ava, { provider: "openai", api_key: SENTINEL })
  expect(r.status).toBe(403)
  expect(json(await get(sock, "/connections", ava)).can_manage).toBe(false)
})

test("office cannot be removed", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const r = await del(sock, "/connections/office", owner)
  expect([r.status, errorOf(r)]).toEqual([422, "set_up_by_onboard"])
})

test("a removed name comes back as a new name", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "azure", api_key: SENTINEL, endpoint: "acme" }
  expect(json(await post(sock, "/connections", owner, body)).name).toBe("azure")
  let r = await del(sock, "/connections/azure", owner)
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  expect(json(await post(sock, "/connections", owner, body)).name).toBe("azure-2")
  r = await get(sock, "/connections", owner)
  expect((json(r).connections as { name: string }[]).map((c) => c.name)).toEqual(["office", "azure-2"])
  expect((await del(sock, "/connections/azure", owner)).status).toBe(404)
})

test("a removed connection releases the parked workers that use it", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const changed: string[] = []
  office.harness = { connectionsChanged: async () => void changed.push("changed") } as unknown as Office["harness"]
  await office.connections.put("second", azureFile())
  expect((await del(sock, "/connections/second", owner)).status).toBe(200)
  expect(changed).toEqual(["changed"])
})

/** The 409 a connection that can't be used answers: the provider error's text goes to the office log. */
const UNUSABLE = { error: "connection_unusable", message: "the connection can't be used now; see the office log" }

test("a remove that cant get the sign in lock is 409", async () => {
  const { office, sock, lines } = await setup()
  const owner = await asOwner(office)
  await office.connections.put("azure", azureFile())
  spyOn(office.connections, "remove").mockRejectedValue(
    new ProviderError("the sign-in of connection 'azure' is busy; try again"),
  )
  const r = await del(sock, "/connections/azure", owner)
  expect([r.status, r.json()]).toEqual([409, UNUSABLE])
  expect(lines.some((l) => l.includes("the sign-in of connection 'azure' is busy"))).toBe(true)
})

test("a 409 never names the connections file", async () => {
  const { office, sock, lines } = await setup()
  const owner = await asOwner(office)
  const file = path.join(office.connections.dir, "office.json")
  // A provider error's text can name a file under office/connections.
  spyOn(office.connections, "infos").mockRejectedValue(new ProviderError(`${file} can't be read`))
  let r = await get(sock, "/connections", owner)
  expect([r.status, r.json()]).toEqual([409, UNUSABLE])
  spyOn(office.connections, "add").mockRejectedValue(new ProviderError(`${office.connections.dir} belongs to another user`))
  r = await post(sock, "/connections", owner, { provider: "openai", api_key: SENTINEL })
  expect([r.status, r.json()]).toEqual([409, UNUSABLE])
  expect(lines.some((l) => l.includes(`${file} can't be read`))).toBe(true)
  expect(lines.some((l) => l.includes(`${office.connections.dir} belongs to another user`))).toBe(true)
  expect(lines.filter((l) => l.includes(SENTINEL))).toEqual([])
})

test("an unexpected value error is a 500 not a 404", async () => {
  const { office, sock, lines } = await setup()
  const owner = await asOwner(office)
  spyOn(office.connections, "remove").mockRejectedValue(new RangeError(SENTINEL))
  const r = await del(sock, "/connections/azure", owner)
  expect([r.status, r.json()]).toEqual([500, { error: "internal_error", message: "internal error" }])
  // A 500 logs the error's type only.
  expect(lines.some((l) => l.endsWith("internal error on DELETE /connections/:name: RangeError"))).toBe(true)
  expect(lines.filter((l) => l.includes(SENTINEL))).toEqual([])
})

test("a default whose file cant be read is still the default", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  await office.connections.put("azure", azureFile())
  await office.connections.setDefault("azure")
  await writePrivate(path.join(office.connections.dir, "azure.json"), "{not json")
  const r = await get(sock, "/connections", owner)
  expect(r.status).toBe(200)
  const found = (json(r).connections as { name: string; default: boolean }[]).map((c) => [c.name, c.default])
  expect([json(r).default, found]).toEqual(["azure", [["office", false]]])
})

test("unknown names are 404", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  for (const [method, target, body] of [
    ["DELETE", "/connections/nope", undefined],
    ["DELETE", "/connections/Bad_Name", undefined],
    ["GET", "/connections/nope/models", undefined],
    ["GET", "/connections/login/models", undefined],
    ["PUT", "/connections/default", { connection: "nope" }],
  ] as const) {
    const r = await send(sock, method, target, owner, body)
    expect([target, r.status, errorOf(r)]).toEqual([target, 404, "not_found"])
  }
})

test("set default", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  await office.connections.put("azure", azureFile())
  let r = await put(sock, "/connections/default", owner, { connection: "azure" })
  expect(r.status).toBe(200)
  const defaults = (json(r).connections as { default: boolean }[]).map((c) => c.default)
  expect([json(r).default, defaults]).toEqual(["azure", [false, true]])
  expect(await office.connections.default()).toBe("azure")
  r = await put(sock, "/connections/default", owner, { connection: "Bad" })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
})

test("models route lists and unknown connection is 404", async () => {
  const { office, sock, listings } = await setup()
  await asOwner(office)
  const ava = asAva(office)
  await office.connections.put("azure", azureFile())
  let r = await get(sock, "/connections/azure/models", ava)
  expect([r.status, r.json()]).toEqual([
    200,
    {
      connection: "azure",
      models: [
        { id: "gpt-5.4", name: null },
        { id: "o3", name: null },
      ],
      listed: true,
      error: null,
    },
  ])
  await get(sock, "/connections/azure/models", ava)
  expect(listings.calls).toEqual(["azure"])
  await get(sock, "/connections/azure/models?refresh=1", ava)
  expect(listings.calls).toEqual(["azure", "azure"])
  r = await get(sock, "/connections/office/models", ava)
  expect(r.json()).toEqual({
    connection: "office",
    models: [
      { id: "claude-opus-4-1", name: null },
      { id: "claude-sonnet-4-5", name: null },
    ],
    listed: true,
    error: null,
  })
  // An unlisted listing goes through the reply schema without its hidden refused flag or the key.
  await office.connections.put(
    "acme",
    ConnectionFile.parse({
      llm_config: {
        provider: "openai",
        base_url: "https://acme.openai.azure.com/openai/v1/",
        api_key: UNREACHABLE,
        model: "gpt-5.4",
      },
    }),
  )
  r = await get(sock, "/connections/acme/models", ava)
  expect([r.status, r.json()]).toEqual([
    200,
    {
      connection: "acme",
      models: [{ id: "gpt-5.4", name: null }],
      listed: false,
      error: "can't reach host",
    },
  ])
  expect(r.text).not.toContain(UNREACHABLE)
  expect(r.text.toLowerCase()).not.toContain("acme.openai.azure.com")
  r = await get(sock, "/connections/nope/models", ava)
  expect([r.status, errorOf(r)]).toEqual([404, "not_found"])
})

test("a malformed add never echoes the key", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  for (const body of [
    { provider: "openai", api_key: SENTINEL, [SENTINEL]: SENTINEL },
    { provider: SENTINEL, api_key: SENTINEL },
    { provider: "openai", api_key: SENTINEL, endpoint: SENTINEL },
    { provider: "openai", api_key: SENTINEL, model: 5 },
    { provider: ["openai"], api_key: SENTINEL },
  ]) {
    const r = await post(sock, "/connections", owner, body)
    expect([r.status, r.text.includes(SENTINEL)]).toEqual([422, false])
  }
  const r = await request(sock, "POST", "/connections", {
    headers: owner,
    body: `{"api_key": "${SENTINEL}"`,
  })
  expect([r.status, r.text.includes(SENTINEL)]).toEqual([422, false])
  onlyOffice(office)
})

test.each([
  ["too long", "k".repeat(MAX_KEY_CHARS + 1), "llm_config.api_key is too long (at most 16384 characters)"],
  ["a space", " ", "llm_config.api_key must be printable ASCII with no leading or trailing spaces"],
  ["a trailing newline", "k\n", "llm_config.api_key must be printable ASCII with no leading or trailing spaces"],
  ["a leading tab", "\tsk-abc", "llm_config.api_key must be printable ASCII with no leading or trailing spaces"],
  ["non-ascii", "sk-é-0123456789", "llm_config.api_key must be printable ASCII with no leading or trailing spaces"],
] as const)("a key that cant be sent as a header is refused before any request [%s]", async (_case, key, message) => {
  const { office, sock, listings, checks, lines } = await setup()
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, { provider: "openai", api_key: key, model: "gpt-5.5" })
  expect([r.status, r.json()]).toEqual([422, { error: "invalid_connection", message }])
  if (key.length > 8) {
    expect(r.text).not.toContain(key)
    expect(lines.filter((line) => line.includes(key))).toEqual([])
  }
  expect([listings.calls, checks.calls]).toEqual([[], []])
  onlyOffice(office)
})

test("a refusal quoting the key in another case or base64 never echoes a copy", async () => {
  const url = await refusingLlm(`bad key: ${keyCopies(MIXED_KEY).join(" and ")}`)
  // The real check, in-process, at the fake host.
  const { office, sock, lines } = await setup({
    checkModel: (provider) => modelProblem(provider, { env: { ANTHROPIC_BASE_URL: url } }),
  })
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, { provider: "anthropic", api_key: MIXED_KEY, model: "claude-x" })
  expect([r.status, errorOf(r)]).toEqual([422, "model_refused"])
  expect(json(r).message).toContain("bad key: [redacted] and [redacted] and [redacted]")
  for (const copy of [MIXED_KEY, ...keyCopies(MIXED_KEY)]) {
    expect(r.text).not.toContain(copy)
    expect(lines.filter((line) => line.includes(copy))).toEqual([])
  }
  onlyOffice(office)
})

test("a check once the office is stopping is 503", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  spyOn(office, "checkModel").mockRejectedValue(new RegistryClosed())
  const r = await post(sock, "/connections", owner, { provider: "openai", api_key: SENTINEL, model: "gpt5-prod" })
  expect([r.status, errorOf(r)]).toEqual([503, "stopping"])
  expect(r.text).not.toContain(SENTINEL)
  onlyOffice(office)
})

// Subscription sign-ins.

/** OpenAI's sign-in and model catalog: the device code is approved once `approved` is set. */
class FakeOpenAI {
  approved = false

  readonly request: AuthRequest = async (_method, url) => {
    if (url.endsWith("/usercode")) return USERCODE
    if (url.endsWith("/deviceauth/token")) return this.approved ? APPROVED : PENDING
    return url.endsWith("/oauth/token") ? TOKENS : CATALOG
  }
}

/** A fake OpenAI, and the `auth` option that signs in to it on a test scheduler. */
function openai(): { fake: FakeOpenAI; auth: NonNullable<LoginsOptions["auth"]> } {
  const fake = new FakeOpenAI()
  return {
    fake,
    auth: ({ signal }) => new OpenAIAuth({ request: fake.request, scheduler: testScheduler(), signal }),
  }
}

/** The reply to `GET /connections/login/:id` once the sign-in reaches `state` (at most 10 s). */
function poll(sock: string, id: string, headers: Record<string, string>, state: string): Promise<Reply> {
  return waitFor(
    async () => {
      const r = await get(sock, `/connections/login/${id}`, headers)
      return json(r).state === state ? r : null
    },
    { timeout: 10_000, what: `sign-in ${id} to become ${state}` },
  )
}

function noTokens(...texts: string[]): void {
  for (const text of texts) {
    expect(text).not.toContain(SIGNATURE)
    expect(text).not.toContain(REFRESH)
  }
}

test("the owner signs in to a subscription", async () => {
  const { fake, auth } = openai()
  const { office, sock, listings } = await setup({ auth })
  const owner = await asOwner(office)
  const r = await post(sock, "/connections/login", owner, { provider: "openai" })
  const login = json(r)
  expect([r.status, login.state, login.url, login.user_code, login.connection]).toEqual([
    200,
    "waiting",
    "https://auth.openai.com/codex/device",
    "ABCD-EFGH",
    null,
  ])
  const shown = await get(sock, `/connections/login/${login.id}`, owner)
  expect(shown.json()).toEqual(login)
  fake.approved = true
  const done = await poll(sock, login.id as string, owner, "signed_in")
  expect(json(done).connection).toBe("chatgpt")
  // Only the warm-up after a sign-in lists the office connection here: Logins got the office's model cache.
  await waitFor(() => listings.calls.includes("office"), { what: "the warm-up to list office" })
  const listed = await get(sock, "/connections", owner)
  expect(json(listed).connections).toContainEqual({
    name: "chatgpt",
    provider: "chatgpt",
    method: "subscription",
    model: "gpt-5.5",
    default: false,
  })
  const models = await get(sock, "/connections/chatgpt/models", owner)
  noTokens(
    r.text,
    shown.text,
    done.text,
    listed.text,
    models.text,
    fs.readFileSync(path.join(office.connections.dir, "chatgpt.json"), "utf8"),
  )
})

test("a sign in is only for openai", async () => {
  const { auth } = openai()
  const { office, sock } = await setup({ auth })
  const owner = await asOwner(office)
  const r = await post(sock, "/connections/login", owner, { provider: "anthropic" })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_body"])
  onlyOffice(office)
})

test("only the starter sees or cancels a sign in", async () => {
  const { fake, auth } = openai()
  const { office, sock, company } = await setup({ auth })
  const owner = await asOwner(office)
  const ava = asAva(office)
  commitAsset(company, officeAsset([{ who: "ava", can: ["connections"] }])) // managing isn't enough
  const login = json(await post(sock, "/connections/login", owner, { provider: "openai" }))
  const unknown = "01J0000000000000000000000Z"
  for (const [method, id, headers] of [
    ["GET", login.id as string, ava],
    ["DELETE", login.id as string, ava],
    ["GET", unknown, owner],
    ["DELETE", unknown, owner],
  ] as const) {
    const r = await send(sock, method, `/connections/login/${id}`, headers)
    expect([method, id, r.status, errorOf(r)]).toEqual([method, id, 404, "not_found"])
  }
  let r = await del(sock, `/connections/login/${login.id}`, owner)
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  r = await get(sock, `/connections/login/${login.id}`, owner)
  expect(json(r).state).toBe("cancelled")
  fake.approved = true
  expect(await office.connections.names()).toEqual(["office"])
})

test("no sign in starts once the office is stopping", async () => {
  const { auth } = openai()
  const { office, sock } = await setup({ auth })
  const owner = await asOwner(office)
  await office.logins.closeAll()
  const r = await post(sock, "/connections/login", owner, { provider: "openai" })
  expect([r.status, errorOf(r)]).toEqual([503, "stopping"])
})
