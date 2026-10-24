/** Listing the models a connection offers (Python's `tests/chat/test_models.py`). */
import { once } from "node:events"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  type AuthRequest,
  type AuthRequestOptions,
  AuthStore,
  HttpResponse,
  OAuthCredentials,
} from "@ngocbh/yian/llm_clients"
import { ModelList } from "@opencorp/protocol"
import { ConnectionFile, ConnectionGone, Connections } from "../../src/chat/connections.ts"
import {
  azureDeployments,
  FRESH_MS,
  ListTimeout,
  listModels,
  ModelCache,
  ModelListError,
  type ModelListing,
  ownModels,
  providerModels,
  TIMED_OUT,
} from "../../src/chat/models.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir, waitFor } from "../helpers.ts"

const SENTINEL = "sk-sentinel-3c9e10b7a2f4"
const ANTHROPIC_KEY = "sk-ant-sentinel-a7d93c10e5b2"
const AZURE = "https://acme.openai.azure.com/openai/v1/"

const azure = (model = "gpt-5.4") =>
  ConnectionFile.parse({ llm_config: { provider: "openai", base_url: AZURE, api_key: SENTINEL, model } })

const openai = (model = "gpt-5") =>
  ConnectionFile.parse({ llm_config: { provider: "openai", api_key: SENTINEL, model } })

function deploymentsReply(): HttpResponse {
  const data = [
    { id: "gpt-5.4", model: "gpt-5.4", status: "succeeded" },
    { id: "embed", model: "text-embedding-3-small", status: "succeeded" },
    { id: "new", model: "gpt-5.6", status: "creating" },
    { id: "o3", model: "o3", status: "succeeded" },
  ]
  return new HttpResponse(200, { data, object: "list" })
}

/** An HTTP sender (`send`) that answers every call with `response`, or throws it, recording each call. */
class FakeRequest {
  readonly calls: [method: string, url: string, options: AuthRequestOptions][] = []

  constructor(readonly response: HttpResponse | Error) {}

  readonly send: AuthRequest = async (method, url, options) => {
    this.calls.push([method, url, options])
    if (this.response instanceof HttpResponse) return this.response
    throw this.response
  }
}

/** A sender that counts its calls and fails each one. */
function never(): { send: AuthRequest; calls: () => number } {
  let calls = 0
  const send: AuthRequest = async () => {
    calls += 1
    throw new Error("no request expected")
  }
  return { send, calls: () => calls }
}

/** A `node:http` server on 127.0.0.1 answering with `handler`, and its port. */
async function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function stop(server: http.Server | undefined): void {
  server?.closeAllConnections()
  server?.close()
}

/** What `call` rejected with (it must reject). */
async function rejection(call: Promise<unknown>): Promise<ModelListError> {
  const error = await call.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ModelListError)
  return error as ModelListError
}

test("azure lists ready chat deployments", async () => {
  const fake = new FakeRequest(deploymentsReply())
  expect(await azureDeployments(AZURE, SENTINEL, { timeoutMs: 5000, request: fake.send })).toEqual(["gpt-5.4", "o3"])
  expect(fake.calls).toHaveLength(1)
  const [[method, url, options]] = fake.calls as [[string, string, AuthRequestOptions]]
  expect([method, url]).toEqual(["GET", "https://acme.openai.azure.com/openai/deployments?api-version=2022-12-01"])
  expect(options.headers["api-key"]).toBe(SENTINEL)
  const got = await listModels(azure(), "azure", { request: new FakeRequest(deploymentsReply()).send })
  expect(got as ModelListing).toEqual({
    connection: "azure",
    models: [
      { id: "gpt-5.4", name: null },
      { id: "o3", name: null },
    ],
    listed: true,
    error: null,
  })
})

test.each([
  ["401", new HttpResponse(401, { error: { message: SENTINEL } }), "HTTP 401", 401],
  ["not json", new HttpResponse(200, null), "the reply isn't a deployment list", null],
  ["data not a list", new HttpResponse(200, { data: "x" }), "the reply isn't a deployment list", null],
  ["unreachable", new TypeError("fetch failed"), "can't reach acme.openai.azure.com", null],
  ["timeout", new DOMException("slow", "TimeoutError"), TIMED_OUT, null],
] as const)("azure deployments says why it cant list them [%s]", async (_, response, problem, status) => {
  const fake = new FakeRequest(response)
  const error = await rejection(azureDeployments(AZURE, SENTINEL, { timeoutMs: 5000, request: fake.send }))
  expect([error.message, error.status]).toEqual([problem, status])
})

test("openai with a key lists text models", async () => {
  const ids = [
    "gpt-5",
    "dall-e-3",
    "gpt-4o-realtime-preview",
    "o3",
    "text-embedding-3-small",
    "gpt-4o-mini-tts",
    "o4-mini",
  ]
  const fake = new FakeRequest(new HttpResponse(200, { data: ids.map((id) => ({ id })) }))
  const got = await listModels(openai(), "openai", { deadlineMs: 6000, request: fake.send })
  expect(got.models.map((m) => m.id)).toEqual(["gpt-5", "o3", "o4-mini"])
  expect([got.listed, got.error]).toEqual([true, null])
  expect(fake.calls).toHaveLength(1)
  const [[method, url, options]] = fake.calls as [[string, string, AuthRequestOptions]]
  expect([method, url]).toEqual(["GET", "https://api.openai.com/v1/models"])
  expect(options.headers["Authorization"]).toBe(`Bearer ${SENTINEL}`)
  expect(options.timeoutMs).toBeLessThanOrEqual(6000)
})

test.each([
  [
    "anthropic",
    { provider: "anthropic", api_key: ANTHROPIC_KEY },
    "https://api.anthropic.com/v1/models?limit=1000",
    ["x-api-key", ANTHROPIC_KEY],
  ],
  [
    "openrouter",
    { provider: "openrouter", api_key: SENTINEL },
    "https://openrouter.ai/api/v1/models",
    ["Authorization", `Bearer ${SENTINEL}`],
  ],
  [
    "gateway",
    { provider: "openai", base_url: "https://gw.example/v1", api_key: SENTINEL },
    "https://gw.example/v1/models",
    ["Authorization", `Bearer ${SENTINEL}`],
  ],
] as const)("other providers list every model their host offers [%s]", async (_, llm, url, [header, value]) => {
  const ids = ["claude-x", "gpt-x", "llama-4"]
  const fake = new FakeRequest(new HttpResponse(200, { data: ids.map((id) => ({ id })), has_more: false }))
  const conn = ConnectionFile.parse({ llm_config: { ...llm, model: "claude-x" } })
  const got = await listModels(conn, "other", { deadlineMs: 6000, request: fake.send })
  expect([got.listed, got.error, got.models.map((m) => m.id)]).toEqual([true, null, ids])
  expect(fake.calls).toHaveLength(1)
  const [[method, sent, options]] = fake.calls as [[string, string, AuthRequestOptions]]
  expect([method, sent]).toEqual(["GET", url])
  expect(options.headers[header]).toBe(value)
  expect(options.timeoutMs).toBeLessThanOrEqual(6000)
})

test.each([
  [
    "vllm",
    { provider: "vllm", model: "stub" },
    { VLLM_BASE_URL: "http://127.0.0.1:9/v1" },
    "http://127.0.0.1:9/v1/models",
  ],
  [
    "ollama",
    { provider: "ollama", model: "stub" },
    { OLLAMA_BASE_URL: "http://127.0.0.1:9" },
    "http://127.0.0.1:9/api/tags",
  ],
] as const)("a provider without a key lists the host its runs go to [%s]", async (_, llm, env, url) => {
  const fake = new FakeRequest(new HttpResponse(200, { data: [{ id: "stub" }], models: [{ name: "stub" }] }))
  const got = await listModels(ConnectionFile.parse({ llm_config: llm, env }), "local", { request: fake.send })
  expect([got.listed, got.models.map((m) => m.id)]).toEqual([true, ["stub"]])
  expect(fake.calls).toHaveLength(1)
  const [[, sent, options]] = fake.calls as [[string, string, AuthRequestOptions]]
  expect(sent).toBe(url)
  expect("Authorization" in options.headers).toBe(false)
})

test.each([
  [
    "openai",
    { provider: "openai", base_url: "https://gw.example/v1", api_key: SENTINEL },
    { OPENAI_BASE_URL: "https://elsewhere.example/v1" },
  ],
  [
    "vllm",
    { provider: "vllm", base_url: "https://gw.example/v1", api_key: SENTINEL },
    { VLLM_BASE_URL: "http://127.0.0.1:9/v1" },
  ],
] as const)("the connections base url wins over the environment [%s]", async (_, llm, env) => {
  const fake = new FakeRequest(new HttpResponse(200, { data: [{ id: "llama-4" }] }))
  const conn = ConnectionFile.parse({ llm_config: { ...llm, model: "llama-4" }, env })
  const got = await listModels(conn, "custom", { request: fake.send })
  expect([got.listed, got.models.map((m) => m.id)]).toEqual([true, ["llama-4"]])
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]![1]).toBe("https://gw.example/v1/models")
})

test.each(["401", "403"])("a refused key says the status never the key [%s]", async (code) => {
  const status = Number(code)
  const lines: string[] = []
  const log = (line: string) => void lines.push(line)
  const fake = new FakeRequest(new HttpResponse(status, { error: { message: `bad key ${SENTINEL} ${ANTHROPIC_KEY}` } }))
  const anthropic = ConnectionFile.parse({ llm_config: { provider: "anthropic", api_key: ANTHROPIC_KEY } })
  for (const conn of [openai(), anthropic]) {
    const got = await listModels(conn, "openai", { request: fake.send, log })
    expect([got.error, got.refused]).toEqual([`HTTP ${status}`, true])
    const dumped = JSON.stringify(got)
    expect(dumped).not.toContain(SENTINEL)
    expect(dumped).not.toContain(ANTHROPIC_KEY)
    expect(dumped).not.toContain("refused")
    expect(() => ModelList.parse(got)).not.toThrow()
  }
  const got = await listModels(azure(), "azure", { request: new FakeRequest(new HttpResponse(status, null)).send, log })
  expect([got.error, got.refused]).toEqual([`HTTP ${status}`, true])
  const logged = lines.join("\n")
  expect(logged).not.toContain(SENTINEL)
  expect(logged).not.toContain(ANTHROPIC_KEY)
})

test("a failure that isnt a refusal isnt refused", async () => {
  const got = await listModels(openai(), "openai", { request: new FakeRequest(new HttpResponse(500, {})).send })
  expect([got.error, got.refused, got.listed]).toEqual(["HTTP 500", false, false])
  expect(got.models).toEqual([{ id: "gpt-5", name: null }])
})

test.each([
  ["cant reach host", "can't reach host"],
  ["invalid response", "invalid response"],
  ["timed out", TIMED_OUT],
] as const)(
  "a request that fails says why in composers words [%s]",
  async (_, problem) => {
    if (problem === TIMED_OUT) {
      // Only yian's own timeout can answer: no deadline race, and a host that accepts and never answers.
      let server: http.Server | undefined
      try {
        const started = await serve(() => {})
        server = started.server
        const call = providerModels("vllm", null, `http://127.0.0.1:${started.port}/v1`, { timeoutMs: 300 })
        const error = await rejection(call)
        expect([error.message, error.status]).toEqual([TIMED_OUT, null])
      } finally {
        stop(server)
      }
      return
    }
    const response =
      problem === "invalid response" ? new HttpResponse(200, { data: "x" }) : new Error(`refused ${SENTINEL}`)
    const got = await listModels(openai(), "openai", { request: new FakeRequest(response).send })
    expect([got.error, got.refused, got.listed]).toEqual([problem, false, false])
    expect(JSON.stringify(got)).not.toContain(SENTINEL)
  },
)

test.each([
  ["subscription", { method: "subscription", llm_config: { provider: "openai", model: "claude-x" } }],
  // No key: runs have none either.
  ["anthropic without a key", { llm_config: { provider: "anthropic", model: "claude-x" } }],
  // Yian has no listing for azure.
  ["azure", { llm_config: { provider: "azure", api_key: SENTINEL, model: "claude-x" } }],
  [
    "openai elsewhere",
    {
      llm_config: { provider: "openai", api_key: SENTINEL, model: "claude-x" },
      env: { OPENAI_BASE_URL: "https://gw.example/v1" },
    },
  ],
  [
    "anthropic elsewhere",
    {
      llm_config: { provider: "anthropic", api_key: ANTHROPIC_KEY, model: "claude-x" },
      env: { ANTHROPIC_BASE_URL: "https://gw.example" },
    },
  ],
] as const)("a provider that cant list gives its own model [%s]", async (_, data) => {
  const request = never()
  const got = await listModels(ConnectionFile.parse(data), "other", { request: request.send })
  const want = { connection: "other", models: [{ id: "claude-x", name: null }], listed: false, error: null }
  expect(got as ModelListing).toEqual(want)
  const bare = ConnectionFile.parse({ method: "subscription", llm_config: { provider: "openai" } })
  const unnamed = await listModels(bare, "other", { request: request.send })
  expect([unnamed.models, unnamed.listed]).toEqual([[], false])
  expect(request.calls()).toBe(0)
})

// Subscriptions.

const ACCESS = "fake-access-1e7b40c9"
const REFRESH = "fake-refresh-9d3f62a1"
const NEW_ACCESS = "fake-access-new-5c08e2b7"

// Bigint priorities, as yian's decoder gives them.
const CATALOG = new HttpResponse(200, {
  models: [
    { slug: "gpt-5.5-codex", visibility: "list", priority: 2n },
    { slug: "gpt-5.5", visibility: "list", priority: 1n },
    { slug: "hidden", visibility: "hide", priority: 0n },
  ],
})

const subscription = (model = "gpt-5.5") =>
  ConnectionFile.parse({ method: "subscription", llm_config: { provider: "openai", model } })

/** A sign-in saved in `dir` (made 0700), with fake tokens expiring in `expiresInS` seconds; returns its file. */
async function signedIn(dir: string, expiresInS = 3600): Promise<string> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const auth = path.join(dir, "chatgpt.auth.json")
  const creds = new OAuthCredentials({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: Date.now() / 1000 + expiresInS,
    accountId: "account-test",
  })
  await new AuthStore(auth).save("openai", creds, "gpt-5.5")
  return auth
}

/** An HTTP sender (`send`) answering each call with the next of `responses`, recording each call. */
class Replies {
  readonly calls: [method: string, url: string, options: AuthRequestOptions][] = []

  constructor(readonly responses: HttpResponse[]) {}

  readonly send: AuthRequest = async (method, url, options) => {
    this.calls.push([method, url, options])
    return this.responses.shift()!
  }
}

test("subscription models are listed through its auth file", async () => {
  const auth = await signedIn(path.join(tempDir(), "connections"))
  const fake = new FakeRequest(CATALOG)
  const got = await listModels(subscription(), "chatgpt", { deadlineMs: 6000, request: fake.send, authFile: auth })
  expect([got.listed, got.error, got.models.map((m) => m.id)]).toEqual([true, null, ["gpt-5.5", "gpt-5.5-codex"]])
  expect(fake.calls).toHaveLength(1)
  const [[method, url, options]] = fake.calls as [[string, string, AuthRequestOptions]]
  expect([method, url.split("?")[0]]).toEqual(["GET", "https://chatgpt.com/backend-api/codex/models"])
  expect(options.headers["Authorization"]).toBe(`Bearer ${ACCESS}`)
  expect(options.timeoutMs).toBeLessThanOrEqual(6000)
})

test("an expiring sign in is refreshed and each request gets the time left", async () => {
  // Inside yian's refresh margin.
  const auth = await signedIn(path.join(tempDir(), "connections"), 10)
  const replies = new Replies([new HttpResponse(200, { access_token: NEW_ACCESS, expires_in: 3600n }), CATALOG])
  const send: AuthRequest = async (method, url, options) => {
    const reply = await replies.send(method, url, options)
    if (url.endsWith("/oauth/token")) await new Promise((resolve) => setTimeout(resolve, 300))
    return reply
  }
  const got = await listModels(subscription(), "chatgpt", { deadlineMs: 6000, request: send, authFile: auth })
  expect([got.listed, got.error]).toEqual([true, null])
  expect(replies.calls).toHaveLength(2)
  const [[, refreshUrl, refresh], [, , listing]] = replies.calls as [
    [string, string, AuthRequestOptions],
    [string, string, AuthRequestOptions],
  ]
  expect(refreshUrl).toBe("https://auth.openai.com/oauth/token")
  expect(refresh.form?.["refresh_token"]).toBe(REFRESH)
  expect(listing.headers["Authorization"]).toBe(`Bearer ${NEW_ACCESS}`)
  expect(refresh.timeoutMs).toBeLessThanOrEqual(6000)
  // The listing gets only what the refresh left.
  expect(refresh.timeoutMs - listing.timeoutMs).toBeGreaterThanOrEqual(300)
  expect(refresh.timeoutMs - listing.timeoutMs).toBeLessThan(6000)
  // Yian saved the refreshed sign-in where runs read it.
  expect(fs.readFileSync(auth, "utf8")).toContain(NEW_ACCESS)
})

test.each([
  ["401", 401, true],
  ["500", 500, false],
] as const)("a subscription that cant be listed says the status never a token [%s]", async (_, status, refused) => {
  const auth = await signedIn(path.join(tempDir(), "connections"))
  const lines: string[] = []
  const log = (line: string) => void lines.push(line)
  const fake = new FakeRequest(new HttpResponse(status, { error: `bad token ${ACCESS} ${REFRESH}` }))
  const got = await listModels(subscription(), "chatgpt", { request: fake.send, authFile: auth, log })
  expect([got.listed, got.refused, got.models]).toEqual([false, refused, [{ id: "gpt-5.5", name: null }]])
  expect(got.error?.endsWith(`(HTTP ${status})`)).toBe(true)
  for (const text of [JSON.stringify(got), lines.join("\n")]) {
    expect(text).not.toContain(ACCESS)
    expect(text).not.toContain(REFRESH)
  }
})

test("a subscription without its sign in offers its own model", async () => {
  const request = never()
  const dir = path.join(tempDir(), "connections")
  fs.mkdirSync(dir, { mode: 0o700 })
  const got = await listModels(subscription(), "chatgpt", {
    request: request.send,
    authFile: path.join(dir, "gone.auth.json"),
  })
  expect([got.listed, got.error, got.models]).toEqual([false, "no sign-in", [{ id: "gpt-5.5", name: null }]])
  expect(request.calls()).toBe(0)
})

test("the cache lists a subscription through its own auth file", async () => {
  const office = path.join(tempDir(), "office")
  fs.mkdirSync(office, { mode: 0o700 })
  const conns = new Connections(office)
  const creds = new OAuthCredentials({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: Date.now() / 1000 + 3600,
    accountId: "account-test",
  })
  await conns.add("chatgpt", subscription(), {
    signIn: async (auth) => {
      await new AuthStore(auth).save("openai", creds, "gpt-5.5")
    },
  })
  await conns.put("openai", openai())
  const seen: Record<string, string | null> = {}
  const cache = new ModelCache(conns, {
    lister: (conn, name, { deadlineMs, authFile }) => {
      seen[name] = authFile
      return listModels(conn, name, { deadlineMs, request: new FakeRequest(CATALOG).send, authFile })
    },
  })
  expect((await cache.get("chatgpt")).models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.5-codex"])
  await cache.get("openai")
  expect(seen).toEqual({ chatgpt: conns.authFile("chatgpt"), openai: null })
})

test("listing returns by the deadline", async () => {
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const cap = setTimeout(release, 30_000)
  const send: AuthRequest = async () => {
    await released
    return deploymentsReply()
  }
  const start = performance.now()
  let got: Awaited<ReturnType<typeof listModels>>
  try {
    got = await listModels(azure(), "azure", { deadlineMs: 500, request: send })
  } finally {
    release()
    clearTimeout(cap)
  }
  expect(performance.now() - start).toBeLessThan(2000)
  expect([got.error, got.listed, got.models]).toEqual([TIMED_OUT, false, [{ id: "gpt-5.4", name: null }]])
})

test("a redirect from azure is not followed", async () => {
  let target: http.Server | undefined
  let redirect: http.Server | undefined
  let reached = 0
  try {
    const second = await serve((_, res) => {
      reached += 1
      res.end("{}")
    })
    target = second.server
    const first = await serve((_, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${second.port}/openai/deployments` })
      res.end()
    })
    redirect = first.server
    const call = azureDeployments(`http://127.0.0.1:${first.port}/openai/v1/`, SENTINEL, { timeoutMs: 5000 })
    const error = await rejection(call)
    expect([error.message, error.status]).toEqual(["HTTP 302", 302])
    expect(reached).toBe(0)
  } finally {
    stop(redirect)
    stop(target)
  }
})

test.each([
  ["not a deployment list", "the reply isn't a deployment list"],
  ["timed out", TIMED_OUT],
  ["cant reach", "can't reach 127.0.0.1"],
] as const)(
  "azure deployments through the default sender says why [%s]",
  async (_, problem) => {
    let server: http.Server | undefined
    try {
      const started = await serve((_, res) => {
        if (problem === TIMED_OUT) {
          // The headers, then a body that never ends.
          res.writeHead(200, { "content-type": "application/json" })
          res.write("{")
        } else {
          res.writeHead(200, { "content-type": "text/html" })
          res.end("<html>")
        }
      })
      server = started.server
      if (problem.startsWith("can't reach")) {
        const closed = once(server, "close")
        stop(server)
        await closed
        server = undefined
      }
      const base = `http://127.0.0.1:${started.port}/openai/v1/`
      const error = await rejection(azureDeployments(base, SENTINEL, { timeoutMs: problem === TIMED_OUT ? 300 : 5000 }))
      expect(error.message).toBe(problem)
    } finally {
      stop(server)
    }
  },
)

// The cache.

/** A mutable clock for the cache's entries. */
function clock(): { now: number; read: () => number } {
  const c = { now: 1_000_000, read: () => c.now }
  return c
}

/** A promise the test opens with `resolve`. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake `listModels` (`list`): offers `models` (by connection name), waiting first for `delays` ms, then up to
 *  its deadline for `gates` that name it, and failing with `errors`; `deadlines` records the deadline each call
 *  got, and `started` resolves on the first call. */
class Lister {
  readonly models: Map<string, string[]>
  readonly gates: Map<string, { promise: Promise<void> }>
  readonly delays: Map<string, number>
  readonly errors: Map<string, string>
  readonly calls: string[] = []
  readonly deadlines = new Map<string, number>()
  readonly started: Promise<void>
  #start = () => {}

  constructor(
    options: {
      models?: Record<string, string[]>
      gates?: Record<string, { promise: Promise<void> }>
      delays?: Record<string, number>
      errors?: Record<string, string>
    } = {},
  ) {
    this.models = new Map(Object.entries(options.models ?? {}))
    this.gates = new Map(Object.entries(options.gates ?? {}))
    this.delays = new Map(Object.entries(options.delays ?? {}))
    this.errors = new Map(Object.entries(options.errors ?? {}))
    this.started = new Promise((resolve) => {
      this.#start = resolve
    })
  }

  readonly list = async (
    _conn: ConnectionFile,
    name: string,
    { deadlineMs }: { deadlineMs: number; authFile: string | null },
  ): Promise<ModelListing> => {
    this.calls.push(name)
    this.deadlines.set(name, deadlineMs)
    this.#start()
    await sleep(this.delays.get(name) ?? 0)
    const gated = this.gates.get(name)
    if (gated !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs)
      })
      const opened = await Promise.race([gated.promise.then(() => true), late])
      clearTimeout(timer)
      if (!opened) return { connection: name, models: [], listed: false, error: TIMED_OUT }
    }
    const error = this.errors.get(name)
    if (error !== undefined) return { connection: name, models: [], listed: false, error }
    const ids = this.models.get(name) ?? ["m"]
    return { connection: name, models: ids.map((id) => ({ id, name: null })), listed: true, error: null }
  }
}

/** An office whose `office` connection holds the sentinel key, with `fast`, `slow` and `second` added. */
async function connections(): Promise<Connections> {
  const office = path.join(tempDir(), "office")
  fs.mkdirSync(office, { mode: 0o700 })
  const conns = new Connections(office)
  const dir = conns.ensureDir()
  await writePrivate(
    path.join(dir, "office.json"),
    JSON.stringify({ llm_config: { provider: "anthropic", api_key: SENTINEL } }),
  )
  for (const name of ["fast", "slow", "second"]) await conns.put(name, openai())
  return conns
}

test("the cache refreshes after five minutes and on refresh", async () => {
  const conns = await connections()
  const lister = new Lister()
  const time = clock()
  const cache = new ModelCache(conns, { lister: lister.list, clock: time.read })
  const first = await cache.get("office")
  expect(await cache.get("office")).toBe(first)
  time.now += FRESH_MS - 1
  expect(await cache.get("office")).toBe(first)
  expect(lister.calls).toEqual(["office"])
  time.now += 2
  expect(await cache.get("office")).not.toBe(first)
  expect(lister.calls).toEqual(["office", "office"])
  await cache.get("office", { refresh: true })
  expect(lister.calls).toEqual(["office", "office", "office"])
})

test("a failed listing or a changed connection is listed again", async () => {
  const conns = await connections()
  const fast = gate()
  const lister = new Lister({ gates: { fast } })
  const cache = new ModelCache(conns, { lister: lister.list })
  try {
    expect((await cache.get("fast", { deadlineMs: 100 })).error).toBe(TIMED_OUT)
  } finally {
    fast.resolve()
  }
  lister.gates.clear()
  expect((await cache.get("fast")).error).toBeNull()
  expect(lister.calls).toEqual(["fast", "fast"])
  await conns.put("fast", openai("gpt-6"))
  await cache.get("fast")
  expect(lister.calls).toEqual(["fast", "fast", "fast"])
})

test("an unknown connection raises", async () => {
  const conns = await connections()
  await expect(new ModelCache(conns, { lister: new Lister().list }).get("nope")).rejects.toBeInstanceOf(ConnectionGone)
})

test("warm lists every connection in the background", async () => {
  const conns = await connections()
  const slow = gate()
  const lister = new Lister({ gates: { slow } })
  const cache = new ModelCache(conns, { lister: lister.list })
  let settled = false
  let warming: Promise<void> | undefined
  try {
    const start = performance.now()
    warming = cache.warm().then(() => {
      settled = true
    })
    expect(performance.now() - start).toBeLessThan(500)
    await waitFor(() => lister.calls.length === 4, { timeout: 5000, what: "every connection to be listed" })
    expect(settled).toBe(false)
  } finally {
    slow.resolve()
    await warming
  }
  expect(settled).toBe(true)
  expect([...lister.calls].sort()).toEqual(["fast", "office", "second", "slow"])
  await cache.get("slow")
  expect(lister.calls).toHaveLength(4)
})

test("a caller waits for an in flight listing instead of listing again", async () => {
  const conns = await connections()
  const slow = gate()
  const lister = new Lister({ gates: { slow } })
  const cache = new ModelCache(conns, { lister: lister.list })
  let first: Promise<ModelListing> | undefined
  let second: Promise<ModelListing> | undefined
  try {
    first = cache.get("slow")
    await lister.started
    second = cache.get("slow")
    await sleep(100)
  } finally {
    slow.resolve()
  }
  const [gotFirst, gotSecond] = await Promise.all([first, second])
  expect(lister.calls).toEqual(["slow"])
  expect(gotFirst).toBe(gotSecond!)
})

test("a slow connection never blocks another", async () => {
  const conns = await connections()
  const slow = gate()
  const cache = new ModelCache(conns, { lister: new Lister({ gates: { slow } }).list })
  let settled = false
  const listing = cache.get("slow").finally(() => {
    settled = true
  })
  try {
    const start = performance.now()
    expect((await cache.get("fast")).listed).toBe(true)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(settled).toBe(false)
  } finally {
    slow.resolve()
    await listing
  }
})

test("offers uses an old entry and lists a missing one", async () => {
  const conns = await connections()
  const lister = new Lister({ models: { office: ["claude-x"], second: ["gpt-5", "claude-x"], fast: ["gpt-5"] } })
  const time = clock()
  const cache = new ModelCache(conns, { lister: lister.list, clock: time.read })
  await cache.get("office")
  time.now += 10 * FRESH_MS
  expect(await cache.offers(["office", "second", "fast"], "claude-x", { deadlineMs: 5000 })).toEqual([
    "office",
    "second",
  ])
  expect(lister.calls).toEqual(["office", "second", "fast"])
})

test("a listed connection offers its own model first when its host doesnt list it", async () => {
  // Anthropic lists dated ids, not the aliases that answer as well.
  const conn = ConnectionFile.parse({
    llm_config: { provider: "anthropic", api_key: ANTHROPIC_KEY, model: "claude-sonnet-4-5" },
  })
  const dated = ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"]
  const request = new FakeRequest(new HttpResponse(200, { data: dated.map((id) => ({ id })), has_more: false }))
  let got = await listModels(conn, "anthropic", { request: request.send })
  expect([got.listed, got.models.map((m) => m.id)]).toEqual([true, ["claude-sonnet-4-5", ...dated]])
  const conns = await connections()
  await conns.put("anthropic", conn)
  const cache = new ModelCache(conns, { lister: (conn, name) => listModels(conn, name, { request: request.send }) })
  expect(await cache.offers(["anthropic", "fast"], "claude-sonnet-4-5", { deadlineMs: 5000 })).toEqual(["anthropic"])
  const o3 = () => new FakeRequest(new HttpResponse(200, { data: [{ id: "o3" }] })).send
  got = await listModels(openai("gpt-5"), "openai", { request: o3() })
  expect(got.models.map((m) => m.id)).toEqual(["gpt-5", "o3"])
  got = await listModels(openai("o3"), "openai", { request: o3() })
  expect(got.models.map((m) => m.id)).toEqual(["o3"])
})

test("offers gives every connection together only the deadline", async () => {
  const conns = await connections()
  const slow = gate()
  const lister = new Lister({ gates: { slow }, delays: { fast: 300 } })
  const cache = new ModelCache(conns, { lister: lister.list })
  const start = performance.now()
  try {
    await expect(cache.offers(["fast", "slow"], "m", { deadlineMs: 500 })).rejects.toBeInstanceOf(ListTimeout)
  } finally {
    slow.resolve()
  }
  const took = performance.now() - start
  expect(took).toBeGreaterThan(450)
  expect(took).toBeLessThan(2000)
  expect(lister.calls).toEqual(["fast", "slow"])
  expect(lister.deadlines.get("slow")!).toBeLessThan(250)
})

test("a host that times out in composer makes offers time out", async () => {
  const conns = await connections()
  let server: http.Server | undefined
  let requests = 0
  try {
    // Accepts each request and never answers it.
    const started = await serve(() => {
      requests += 1
    })
    server = started.server
    const host = ConnectionFile.parse({
      llm_config: { provider: "vllm", model: "gpt-5" },
      env: { VLLM_BASE_URL: `http://127.0.0.1:${started.port}/v1` },
    })
    const cache = new ModelCache(conns, { lister: (_, name) => listModels(host, name, { deadlineMs: 300 }) })
    const start = performance.now()
    await expect(cache.offers(["fast"], "gpt-5", { deadlineMs: 5000 })).rejects.toBeInstanceOf(ListTimeout)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(requests).toBe(1)
  } finally {
    stop(server)
  }
})

test.each([
  ["timed out", TIMED_OUT],
  ["cant reach", "can't reach api.openai.com"],
  ["the listing failed", "the listing failed"],
] as const)("offers lists again a connection whose last listing failed [%s]", async (_, error) => {
  const conns = await connections()
  const lister = new Lister({ errors: { slow: error } })
  const cache = new ModelCache(conns, { lister: lister.list })
  expect((await cache.get("slow")).error).toBe(error)
  lister.errors.clear()
  expect(await cache.offers(["slow"], "m", { deadlineMs: 5000 })).toEqual(["slow"])
  expect(lister.calls).toEqual(["slow", "slow"])
})

test("offers uses a kept listing of a connection that cant list", async () => {
  const conns = await connections()
  await conns.put(
    "other",
    ConnectionFile.parse({ llm_config: { provider: "anthropic", api_key: SENTINEL, model: "claude-x" } }),
  )
  const calls: string[] = []
  const cache = new ModelCache(conns, {
    lister: async (conn, name) => {
      calls.push(name)
      return ownModels(conn, name)
    },
  })
  await cache.get("other")
  expect(await cache.offers(["other"], "claude-x", { deadlineMs: 5000 })).toEqual(["other"])
  expect(calls).toEqual(["other"])
})

test("warm survives a connection that cant be read", async () => {
  const conns = await connections()
  await writePrivate(path.join(conns.dir, "broken.json"), JSON.stringify({ llm_config: 1 }))
  const lines: string[] = []
  const lister = new Lister()
  const cache = new ModelCache(conns, { lister: lister.list, log: (line) => void lines.push(line) })
  await cache.warm()
  expect(lines).toContain("connection broken can't be read; its models aren't listed ahead of time")
  expect([...lister.calls].sort()).toEqual(["fast", "office", "second", "slow"])
})

test("invalidate forgets one listing or all", async () => {
  const conns = await connections()
  const lister = new Lister()
  const cache = new ModelCache(conns, { lister: lister.list })
  await cache.get("fast")
  await cache.get("second")
  await cache.get("fast")
  expect(lister.calls).toEqual(["fast", "second"])
  cache.invalidate("fast")
  await cache.get("fast")
  await cache.get("second")
  expect(lister.calls).toEqual(["fast", "second", "fast"])
  cache.invalidate()
  await cache.get("fast")
  await cache.get("second")
  expect(lister.calls).toEqual(["fast", "second", "fast", "fast", "second"])
})
