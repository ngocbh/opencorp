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
import { ConnectionFile } from "../../src/chat/connections.ts"
import {
  azureDeployments,
  listModels,
  ModelListError,
  type ModelListing,
  providerModels,
  TIMED_OUT,
} from "../../src/chat/models.ts"
import { tempDir } from "../helpers.ts"

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
    if (url.endsWith("/oauth/token")) await Bun.sleep(300)
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
