/** Connection routes: listing, adding, removing and the default, and who may manage them (Python's
 *  `tests/daemon/test_routes_connections.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { stringify } from "yaml"
import { Identity, identityPath, writeIdentity } from "../../src/auth/identity.ts"
import { newToken } from "../../src/auth/tokens.ts"
import { ConnectionFile, providerLabel } from "../../src/chat/connections.ts"
import type { LoginsOptions } from "../../src/chat/logins.ts"
import { type Lister, ownModels } from "../../src/chat/models.ts"
import { ProviderError } from "../../src/chat/provider.ts"
import type { Office } from "../../src/daemon/office.ts"
import { writePrivate } from "../../src/secrets.ts"
import { git } from "../company/helpers.ts"
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
    if (llm.api_key === UNREACHABLE) return ownModels(conn, name, "can't reach acme.openai.azure.com")
    const label = providerLabel(llm)
    if (Object.hasOwn(LISTS, label)) {
      return { connection: name, models: LISTS[label]!.map((id) => ({ id, name: null })), listed: true, error: null }
    }
    return ownModels(conn, name)
  }
}

/** An office with the office connection (anthropic, keyed `SENTINEL`), served with device tokens. */
async function setup({ auth }: { auth?: LoginsOptions["auth"] } = {}) {
  const lines: string[] = []
  const listings = new Listings()
  const office = makeOffice({
    log: (m) => lines.push(m),
    models: { lister: listings.list },
    logins: auth ? { auth } : {},
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
  return { office, sock, listings, lines, company: office.paths.company }
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
  const { office, sock, lines } = await setup()
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
  // A listed model needs no one-reply check: one would have answered 501.
  expect([r.status, json(r).name, json(r).model]).toEqual([200, "openai-2", "o3"])
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

test("azure needs an endpoint and gets its v1 url", async () => {
  const { office, sock, listings } = await setup()
  const owner = await asOwner(office)
  let r = await post(sock, "/connections", owner, { provider: "azure", api_key: SENTINEL })
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
  onlyOffice(office)
  // An Azure resource that can't be listed needs a model to check with one reply.
  r = await post(sock, "/connections", owner, { provider: "azure", api_key: UNREACHABLE, endpoint: "acme" })
  expect([r.status, r.json()]).toEqual([
    422,
    {
      error: "models_unlisted",
      message:
        "Couldn't list the deployments (can't reach acme.openai.azure.com); name a model to check it with one reply",
    },
  ])
  onlyOffice(office)
  expect(listings.calls).toEqual(["azure"])
  r = await post(sock, "/connections", owner, { provider: "azure", api_key: SENTINEL, endpoint: "acme", model: "o3" })
  // Listing was the check: one would have answered 501.
  expect([r.status, json(r).name, json(r).provider, json(r).model]).toEqual([200, "azure", "azure", "o3"])
  expect(saved(office, "azure").llm_config).toEqual({
    provider: "openai",
    base_url: "https://acme.openai.azure.com/openai/v1/",
    api_key: SENTINEL,
    model: "o3",
  })
})

test("other takes a base url and needs a model", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const body = { provider: "openai", api_key: SENTINEL, endpoint: "https://gw.example/v1" }
  let r = await post(sock, "/connections", owner, body)
  expect([r.status, errorOf(r)]).toEqual([422, "invalid_connection"])
  r = await post(sock, "/connections", owner, { ...body, model: "llama-4" })
  // Listing was the check: one would have answered 501.
  expect([r.status, json(r).name, json(r).provider]).toEqual([200, "custom", "custom"])
  expect(saved(office, "custom").llm_config).toEqual({
    provider: "openai",
    base_url: "https://gw.example/v1",
    api_key: SENTINEL,
    model: "llama-4",
  })
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
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  for (const body of [
    { provider: "openai", api_key: REFUSED },
    { provider: "azure", api_key: REFUSED, endpoint: "acme" },
  ]) {
    const r = await post(sock, "/connections", owner, body)
    // A 422, not the 501 a one-reply check would answer.
    expect([r.status, r.json()]).toEqual([422, { error: "key_refused", message: "The key didn't work (HTTP 401)" }])
  }
  onlyOffice(office)
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
    // The length spelled out, as httpx sent it: without it, Bun's runtime answers a DELETE with a body 400 itself.
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

test("a remove that cant get the sign in lock is 409", async () => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  await office.connections.put("azure", azureFile())
  spyOn(office.connections, "remove").mockRejectedValue(
    new ProviderError("the sign-in of connection 'azure' is busy; try again"),
  )
  const r = await del(sock, "/connections/azure", owner)
  expect([r.status, errorOf(r)]).toEqual([409, "connection_unusable"])
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
      error: "can't reach acme.openai.azure.com",
    },
  ])
  expect(r.text).not.toContain(UNREACHABLE)
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
    headers: { ...owner, "content-type": "application/json" },
    body: `{"api_key": "${SENTINEL}"`,
  })
  expect([r.status, r.text.includes(SENTINEL)]).toEqual([422, false])
  onlyOffice(office)
})

// Each path to the one-reply check, which runs as a worker job once the worker lands.
const NEEDS_CHECK: [string, Json][] = [
  ["unlisted model", { provider: "openai", api_key: SENTINEL, model: "gpt5-prod" }],
  ["default model", { provider: "anthropic", api_key: UNREACHABLE }],
  ["refused custom", { provider: "openai", api_key: REFUSED, endpoint: "https://gw.example/v1", model: "llama-4" }],
  ["azure with a model", { provider: "azure", api_key: UNREACHABLE, endpoint: "acme", model: "gpt-5.4" }],
  ["unlisted provider", { provider: "google", api_key: SENTINEL, model: "gemini-x" }],
]

test.each(NEEDS_CHECK)("an add that needs a one reply check answers 501 and saves nothing [%s]", async (_, body) => {
  const { office, sock } = await setup()
  const owner = await asOwner(office)
  const r = await post(sock, "/connections", owner, body)
  expect([r.status, errorOf(r)]).toEqual([501, "not_implemented"])
  expect(r.text).not.toContain(body.api_key as string)
  onlyOffice(office)
})
