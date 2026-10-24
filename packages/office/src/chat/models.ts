/** The models each connection offers, listed from its provider. */
import {
  AuthError,
  type AuthRequest,
  AuthStore,
  ModelListError as HostListError,
  HttpResponse,
  listModels as hostModels,
  OAuthCredentials,
  OpenAIAuth,
} from "@ngocbh/yian/llm_clients"
import type { ModelList } from "@opencorp/protocol"
import type { z } from "zod"
import { type ConnectionFile, type Connections, configHash, providerLabel } from "./connections.ts"
import type { LlmConfig, Provider } from "./provider.ts"

/** How long one listing may take, in ms: under the TUI's 15 s read timeout. */
export const DEADLINE_MS = 8_000

/** How long a listing is used before the connection is listed again, in ms. */
export const FRESH_MS = 300_000

/** The fixed reason a listing that ran out of time gives; yian uses the same words. */
export const TIMED_OUT = "timed out"

/** The last Azure OpenAI API version whose data plane lists a resource's deployments with only its key. */
export const AZURE_DEPLOYMENTS_API = "2022-12-01"

/** The model a connection to these providers is saved with when the owner names none; yian has no default model. */
export const DEFAULT_MODELS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null), { openai: "gpt-5.5", anthropic: "claude-sonnet-4-5" }),
)

/** Providers whose runs need no key, so they are listed without one. */
export const KEYLESS: readonly string[] = Object.freeze(["ollama", "vllm"])

/** The variable yian's client for a provider reads its endpoint from when `llm_config` gives none. */
const ENV_BASE_URL: Readonly<Record<string, string>> = { ollama: "OLLAMA_BASE_URL", vllm: "VLLM_BASE_URL" }

/** Variables the SDK under yian's client for a provider reads to send runs to another host than the one yian
 *  lists, when `llm_config` gives no endpoint. */
const ENV_ELSEWHERE: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_BASE", "OPENAI_BASE_URL"],
  anthropic: ["ANTHROPIC_API_URL", "ANTHROPIC_BASE_URL"],
  google: ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI"],
}

/** Models couldn't be listed; the message says why and never holds the key. `status` is the HTTP status of a reply
 *  that refused the listing. */
export class ModelListError extends Error {
  override name = "ModelListError"
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

/** A connection's `ModelList`, as the protocol gives it. */
export type ModelListing = z.output<typeof ModelList>

/** A connection's `ModelList`, and whether its provider refused the key: `refused` is non-enumerable, so it never
 *  reaches JSON or a client. */
export type Listing = ModelListing & { readonly refused: boolean }

/** `fields` with `refused` as a non-enumerable property. */
function listing(fields: ModelListing, refused: boolean): Listing {
  return Object.defineProperty(fields, "refused", { value: refused, enumerable: false }) as Listing
}

/** The office's sender for Azure: one exchange, body included, within `timeoutMs`, never following a redirect (the
 *  `api-key` header would go with it); a body that isn't JSON gives `null` data. */
const fetchJson: AuthRequest = async (method, url, { headers, timeoutMs }) => {
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    const reply = await fetch(url, { method, headers, redirect: "manual", signal: timeout })
    const text = await reply.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      // not JSON: no data
    }
    return new HttpResponse(reply.status, data)
  } catch (error) {
    // The same error however far the exchange got.
    if (timeout.aborted) throw timeout.reason
    throw error
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The deployments at the Azure OpenAI resource whose v1 endpoint is `baseUrl` that are ready and not embedding
 * models, in Azure's order. `request` stands in for the office's sender.
 *
 * Throws `ModelListError`: they couldn't be listed.
 */
export async function azureDeployments(
  baseUrl: string,
  key: string,
  options: { timeoutMs: number; request?: AuthRequest },
): Promise<string[]> {
  const { timeoutMs, request = fetchJson } = options
  let root = baseUrl.replace(/\/+$/, "")
  if (root.endsWith("/openai/v1")) root = root.slice(0, -"/openai/v1".length)
  let reply: HttpResponse
  try {
    reply = await request("GET", `${root}/openai/deployments?api-version=${AZURE_DEPLOYMENTS_API}`, {
      headers: { "api-key": key },
      timeoutMs,
    })
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError") {
      throw new ModelListError(TIMED_OUT)
    }
    throw new ModelListError(`can't reach ${URL.parse(root)?.hostname || null}`)
  }
  if (reply.status !== 200) throw new ModelListError(`HTTP ${reply.status}`, reply.status)
  const data = isObject(reply.data) ? reply.data["data"] : undefined
  if (!Array.isArray(data)) throw new ModelListError("the reply isn't a deployment list")
  const ids: string[] = []
  // Entries say no more about what a model can do than its name.
  for (const entry of data) {
    if (!isObject(entry)) throw new ModelListError("the reply isn't a deployment list")
    if (entry["status"] !== "succeeded") continue
    const model = Object.hasOwn(entry, "model") ? entry["model"] : ""
    if (typeof model !== "string") throw new ModelListError("the reply isn't a deployment list")
    if (model.includes("embedding")) continue
    const id = entry["id"]
    if (typeof id !== "string") throw new ModelListError("the reply isn't a deployment list")
    ids.push(id)
  }
  return ids
}

const TEXT_PREFIXES = ["gpt-", "chatgpt-", "o1", "o3", "o4"]
const NOT_TEXT = ["realtime", "audio", "image", "transcribe", "tts"]

/** The general text models among `models`, as `yian auth` offers them. */
function textModels(models: readonly string[]): string[] {
  return models.filter(
    (name) => TEXT_PREFIXES.some((prefix) => name.startsWith(prefix)) && !NOT_TEXT.some((part) => name.includes(part)),
  )
}

/**
 * The models the host of `provider` at `baseUrl` (null: the provider's own) lists for `key`, sorted, or null when
 * the provider has no listing; at OpenAI's own host, only its text models. `request` stands in for yian's sender.
 *
 * Throws `ModelListError`: they couldn't be listed.
 */
export async function providerModels(
  provider: string,
  key: string | null,
  baseUrl: string | null,
  options: { timeoutMs: number; request?: AuthRequest },
): Promise<string[] | null> {
  let ids: readonly string[] | null
  try {
    ids = await hostModels(provider, {
      apiKey: key,
      baseUrl,
      timeout: options.timeoutMs / 1000,
      request: options.request,
    })
  } catch (error) {
    // Yian's messages are fixed and safe to show; the status says whether the key was refused.
    if (error instanceof HostListError) throw new ModelListError(error.message, error.status)
    throw error
  }
  if (ids === null) return null
  return provider === "openai" && baseUrl === null ? textModels(ids) : [...ids]
}

/**
 * The models the ChatGPT subscription signed in at `authFile` offers, in its order, refreshing a sign-in about to
 * expire first; each request gets what is left of `timeoutMs`. `request` stands in for yian's sender.
 *
 * Throws `ModelListError`: they couldn't be listed.
 */
export async function subscriptionModels(
  authFile: string,
  options: { timeoutMs: number; request?: AuthRequest },
): Promise<string[]> {
  const { timeoutMs, request } = options
  const end = performance.now() + timeoutMs
  const auth = () => {
    const remaining = end - performance.now()
    if (remaining <= 0) throw new ModelListError(TIMED_OUT)
    return new OpenAIAuth({ request, requestTimeoutMs: remaining })
  }
  const store = new AuthStore(authFile)
  try {
    const selection = store.selection("openai")
    if (selection === null) throw new ModelListError("no sign-in")
    const credentials = await store.credentials("openai", selection.credentialId, {
      refresh: (old) => auth().refresh(old),
    })
    if (!(credentials instanceof OAuthCredentials)) throw new TypeError("not a subscription sign-in")
    return [...(await auth().subscriptionModels(credentials))]
  } catch (error) {
    // Yian's messages are status-only and safe to show.
    if (error instanceof AuthError) throw new ModelListError(error.message, error.status)
    throw error
  }
}

/** Whether the host a connection with `llm` and `env` runs on is known, and its base URL (null: the provider's
 *  own). */
function runsHost(llm: LlmConfig, env: Readonly<Record<string, string>>): [boolean, unknown] {
  if (llm["base_url"]) return [true, llm["base_url"]]
  const provider = llm["provider"]
  if (typeof provider !== "string") return [true, null]
  if (Object.hasOwn(ENV_ELSEWHERE, provider) && ENV_ELSEWHERE[provider]!.some((name) => Object.hasOwn(env, name))) {
    return [false, null]
  }
  const variable = Object.hasOwn(ENV_BASE_URL, provider) ? ENV_BASE_URL[provider]! : undefined
  return [true, variable !== undefined && Object.hasOwn(env, variable) ? env[variable] : null]
}

/** Connection `name` unlisted: it offers only its configured model, and `error` says why when it couldn't be
 *  listed; `refused` says whether its provider refused the key. */
export function ownModels(
  conn: Provider,
  name: string,
  error: string | null = null,
  options: { refused?: boolean } = {},
): Listing {
  const model = conn.llm_config?.["model"]
  const models = typeof model === "string" && model ? [{ id: model, name: null }] : []
  return listing({ connection: name, models, listed: false, error }, options.refused ?? false)
}

/** Lists connection `name` within `timeoutMs` per request; never rejects. */
async function listed(
  conn: Provider,
  name: string,
  timeoutMs: number,
  request: AuthRequest | undefined,
  authFile: string | null,
  log: (line: string) => void,
): Promise<Listing> {
  const llm = conn.llm_config ?? {}
  const provider = llm["provider"]
  const key = llm["api_key"]
  let ids: string[]
  try {
    const [known, baseUrl] = runsHost(llm, conn.env)
    if (authFile !== null) {
      ids = await subscriptionModels(authFile, { timeoutMs, request })
    } else if (typeof key === "string" && providerLabel(llm) === "azure" && baseUrl) {
      ids = await azureDeployments(baseUrl as string, key, { timeoutMs, request })
    } else if (!provider || !known || !(typeof key === "string" || KEYLESS.includes(provider as string))) {
      // A connection's env can't hold a key, so a key not in llm_config is one its runs don't have either.
      return ownModels(conn, name)
    } else {
      // A value that isn't a string goes on to yian, which refuses it in its own words.
      const found = await providerModels(provider as string, (key ?? null) as string | null, baseUrl as string | null, {
        timeoutMs,
        request,
      })
      if (found === null) return ownModels(conn, name)
      ids = found
    }
  } catch (error) {
    if (error instanceof ModelListError) {
      return ownModels(conn, name, error.message, { refused: error.status === 401 || error.status === 403 })
    }
    // By type only: a client's message could quote the request.
    const type = error instanceof Error ? error.constructor.name : typeof error
    log(`listing the models of connection ${name} failed (${type})`)
    return ownModels(conn, name, "the listing failed")
  }
  // The configured model answered when the connection was added, though a host may list only dated ids for an
  // alias, and textModels may drop it.
  const model = llm["model"]
  if (typeof model === "string" && model && !ids.includes(model)) ids = [model, ...ids]
  return listing({ connection: name, models: ids.map((id) => ({ id, name: null })), listed: true, error: null }, false)
}

/** Options for `listModels`. */
export interface ListOptions {
  /** How long the listing may take, in ms; `DEADLINE_MS` by default. */
  deadlineMs?: number
  /** Stands in for the HTTP senders (yian's, and the office's for Azure). */
  request?: AuthRequest
  /** The auth file holding a subscription connection's sign-in; null for any other connection. */
  authFile?: string | null
  /** Where a failure's line goes; `console.error` by default. */
  log?: (line: string) => void
}

/**
 * The models connection `name` (`conn`) offers, within `deadlineMs`.
 *
 * A subscription is listed through its sign-in at `authFile`; without one, it offers only its configured model.
 * Azure is listed by its deployments, and any other provider by yian's listing of the host its runs go to, with
 * the key they use; a listed connection offers its configured model first if its host doesn't list it. A
 * connection whose provider has no listing, whose runs need a key it doesn't hold, or whose runs an environment
 * variable sends to another host offers only its configured model. A listing that fails offers the same, with
 * `error` giving the HTTP status or another reason, never the key.
 */
export async function listModels(conn: Provider, name: string, options: ListOptions = {}): Promise<Listing> {
  const { deadlineMs = DEADLINE_MS, request, authFile = null, log = console.error } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  // A listing past the deadline is left to finish, not aborted: stopping a subscription mid-refresh could drop a
  // token OpenAI has already rotated.
  const late = new Promise<Listing>((resolve) => {
    timer = setTimeout(() => resolve(ownModels(conn, name, TIMED_OUT)), deadlineMs)
  })
  try {
    return await Promise.race([listed(conn, name, deadlineMs, request, authFile, log), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Listing a connection's models ran out of time. */
export class ListTimeout extends Error {
  override name = "ListTimeout"
}

/** Lists connection `name` (`conn`) within `deadlineMs`, through `authFile` for a subscription, as `listModels`
 *  does. */
export type Lister = (
  conn: ConnectionFile,
  name: string,
  options: { deadlineMs: number; authFile: string | null },
) => Promise<ModelListing>

/** Options for `ModelCache`. */
export interface ModelCacheOptions {
  /** Lists a connection; `listModels` by default. */
  lister?: Lister
  /** Dates the entries, in ms; `performance.now` by default. */
  clock?: () => number
  /** Where log lines go; `console.error` by default. */
  log?: (line: string) => void
}

type Entry = { at: number; hash: string; listing: ModelListing }

/** Whether `promise` settles, either way, within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms))
  })
  const settled = promise.then(
    () => true,
    () => true,
  )
  try {
    return await Promise.race([settled, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Each connection's listing, kept `FRESH_MS`, and made by one caller at a time per connection.
 *
 * A connection being listed has its flight, so a slow connection never holds up another, and a caller that finds a
 * listing under way waits for it rather than listing again. `clock` dates the entries.
 */
export class ModelCache {
  readonly connections: Connections
  readonly #lister: Lister
  readonly #clock: () => number
  readonly #log: (line: string) => void
  readonly #entries = new Map<string, Entry>()
  readonly #flights = new Map<string, Promise<ModelListing>>()

  constructor(connections: Connections, options: ModelCacheOptions = {}) {
    this.connections = connections
    this.#log = options.log ?? console.error
    const log = this.#log
    this.#lister =
      options.lister ?? ((conn, name, { deadlineMs, authFile }) => listModels(conn, name, { deadlineMs, authFile, log }))
    this.#clock = options.clock ?? (() => performance.now())
  }

  /**
   * The models connection `name` offers, listed again if `refresh`, if older than `FRESH_MS`, or if the last
   * listing failed; by `deadlineMs` (`DEADLINE_MS` by default).
   *
   * Rejects with `BadConnectionName` when `name` isn't a connection name, `ConnectionGone` when there is no such
   * connection, and `ProviderError` when its file can't be used.
   */
  async get(name: string, options: { refresh?: boolean; deadlineMs?: number } = {}): Promise<ModelListing> {
    const end = performance.now() + (options.deadlineMs ?? DEADLINE_MS)
    const conn = await this.connections.get(name)
    const entry = this.#entries.get(name)
    if (
      !options.refresh &&
      entry !== undefined &&
      entry.hash === configHash(conn) &&
      entry.listing.error === null &&
      this.#clock() - entry.at < FRESH_MS
    ) {
      return entry.listing
    }
    return this.#list(name, conn, entry, end)
  }

  /** Forgets the listing of connection `name`, or of every connection. */
  invalidate(name?: string): void {
    if (name === undefined) this.#entries.clear()
    else this.#entries.delete(name)
  }

  /** Lists every connection not listed in the last `FRESH_MS`; settles once each is listed, and never rejects. */
  async warm(): Promise<void> {
    let names: string[]
    try {
      names = await this.connections.names()
    } catch {
      this.#log("the office's connections can't be read; no models are listed ahead of time")
      return
    }
    await Promise.all(
      names.map(async (name) => {
        try {
          await this.get(name)
        } catch {
          this.#log(`connection ${name} can't be read; its models aren't listed ahead of time`)
        }
      }),
    )
  }

  /** Lists connection `name`, unless another caller lists it while this one waits; `seen` is the entry this caller
   *  found, and `end` the `performance.now()` it must be done by. */
  async #list(name: string, conn: ConnectionFile, seen: Entry | undefined, end: number): Promise<ModelListing> {
    for (let flight = this.#flights.get(name); flight !== undefined; flight = this.#flights.get(name)) {
      if (!(await settlesWithin(flight, end - performance.now()))) return ownModels(conn, name, TIMED_OUT)
      const entry = this.#entries.get(name)
      // listed while this caller waited
      if (entry !== undefined && entry !== seen && entry.hash === configHash(conn)) return entry.listing
    }
    const remaining = end - performance.now()
    if (remaining <= 0) return ownModels(conn, name, TIMED_OUT)
    const authFile = conn.method === "subscription" ? this.connections.authFile(name) : null
    const flight: Promise<ModelListing> = this.#lister(conn, name, { deadlineMs: remaining, authFile })
      .then((listing) => {
        this.#entries.set(name, { at: this.#clock(), hash: configHash(conn), listing })
        return listing
      })
      .finally(() => {
        if (this.#flights.get(name) === flight) this.#flights.delete(name)
      })
    this.#flights.set(name, flight)
    return flight
  }
}
