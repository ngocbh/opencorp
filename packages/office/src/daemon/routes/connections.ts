/**
 * Connection routes: the office's model connections, the models each offers, the default, and subscription sign-ins.
 *
 * Anyone signed in sees them; only those `mayManageConnections` allows add, remove, sign in or change the default,
 * and only the person who started a sign-in sees or cancels it. No reply, log line or event holds a key or token.
 */
import {
  Ack,
  AddConnectionRequest,
  Connection,
  ConnectionList,
  ConnectionLogin,
  ModelList,
  OFFICE,
  SetDefaultConnectionRequest,
  StartLoginRequest,
} from "@opencorp/protocol"
import type { z } from "zod"
import { identityPath, readIdentity } from "../../auth/identity.ts"
import {
  azureBaseUrl,
  BadConnectionName,
  ConnectionFile,
  ConnectionGone,
  type Connections,
  providerLabel,
} from "../../chat/connections.ts"
import { LoginNotFound, LoginsClosed } from "../../chat/logins.ts"
import { DEADLINE_MS, DEFAULT_MODELS, type Listing } from "../../chat/models.ts"
import { type LlmConfig, Provider, ProviderError } from "../../chat/provider.ts"
import { loadRepo } from "../../company/loader.ts"
import { checkProvider } from "../../install/onboard.ts"
import { OnboardError } from "../../install/prompts.ts"
import { mayManageConnections } from "../../perm/office.ts"
import { RegistryClosed } from "../../worker/spawn.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Params, type Route } from "../http.ts"
import type { Office, RequestContext } from "../office.ts"

type AddBody = z.output<typeof AddConnectionRequest>
type SetDefaultBody = z.output<typeof SetDefaultConnectionRequest>

/** Whether `person` may manage the office's connections: its owner, or a grant in the company at HEAD. */
async function mayManage(office: Office, person: string): Promise<boolean> {
  const identity = await readIdentity(identityPath(office.paths.home))
  // At HEAD: an uncommitted edit grants nothing until it is committed.
  const repo = loadRepo(await office.git.pin(await office.git.head()))
  return mayManageConnections(repo, person, { owner: identity?.handle ?? null })
}

/** The guard of the routes that change connections: 403 unless the asking person may manage them. */
async function checkManage(ctx: RequestContext): Promise<void> {
  if (!(await mayManage(ctx.office, actingPerson(ctx)))) {
    throw new HttpError(403, "forbidden", "managing this office's connections needs its owner or a grant")
  }
}

/** `fn()`, with no such connection as a 404 and one that can't be used as a 409. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    // ConnectionGone is a ProviderError, so it goes first.
    if (error instanceof ConnectionGone || error instanceof BadConnectionName) {
      throw new HttpError(404, "not_found", error.message)
    }
    if (error instanceof ProviderError) throw new HttpError(409, "connection_unusable", error.message)
    throw error
  }
}

/** `fn()`, with no such sign-in, or another person's, as a 404. */
async function starters<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof LoginNotFound) throw new HttpError(404, "not_found", error.message)
    throw error
  }
}

/** Every connection, the default, and `canManage`. */
async function connectionList(connections: Connections, canManage: boolean): Promise<ConnectionList> {
  // The default may be a connection whose file can't be read, and so missing from the list; it is still the default.
  const [found, defaultName] = await guarded(() => connections.infos())
  return { connections: found, default: defaultName, can_manage: canManage }
}

/** The `llm_config` of the connection `body` asks for, as `opencorp onboard` builds one. */
function llmConfig(body: AddBody): LlmConfig {
  const endpoint = (body.endpoint ?? "").trim()
  let llm: LlmConfig
  if (body.provider === "azure") {
    if (!endpoint) {
      throw new HttpError(422, "invalid_connection", "an Azure connection needs its endpoint or resource name")
    }
    // Yian's azure client reads its endpoint from variables the office doesn't have; a resource's v1 endpoint takes
    // the openai client with the key and the deployment as the model.
    llm = { provider: "openai", base_url: azureBaseUrl(endpoint), api_key: body.api_key }
  } else if (endpoint) {
    if (body.provider !== "openai") {
      throw new HttpError(422, "invalid_connection", "only provider azure or openai takes an endpoint")
    }
    if (!body.model) throw new HttpError(422, "invalid_connection", "an OpenAI-compatible endpoint needs a model")
    llm = { provider: "openai", base_url: endpoint, api_key: body.api_key }
  } else {
    llm = { provider: body.provider, api_key: body.api_key }
  }
  return body.model ? { ...llm, model: body.model } : llm
}

/** Adds the connection `body` asks for once its key works, and returns its name; nothing is saved otherwise. */
async function buildAndCheck(office: Office, body: AddBody): Promise<string> {
  const llm = llmConfig(body)
  try {
    checkProvider({ llm_config: llm })
  } catch (error) {
    // Its message never holds a value.
    if (error instanceof OnboardError) throw new HttpError(422, "invalid_connection", error.message)
    throw error
  }
  const label = providerLabel(llm)
  // Listed without the model asked for, which a listing would offer as the connection's own.
  const { model: _, ...withoutModel } = llm
  const listed = await office.models.lister(ConnectionFile.parse({ llm_config: withoutModel }), label, {
    deadlineMs: DEADLINE_MS,
    authFile: null,
  })
  // Read before anything copies the listing: `refused` isn't enumerable.
  const refused = (listed as Partial<Listing>).refused === true
  // Some gateways refuse their model list yet serve chat, so at an endpoint of the owner's own one reply decides.
  if (refused && label !== "custom") throw new HttpError(422, "key_refused", `The key didn't work (${listed.error})`)
  if (listed.error && label === "azure" && !body.model) {
    // A deployment is named by its owner, so there is no default to check.
    throw new HttpError(
      422,
      "models_unlisted",
      `Couldn't list the deployments (${listed.error}); name a model to check it with one reply`,
    )
  }
  let needsCheck = true
  const provider = llm.provider as string
  const fallback = label !== "azure" && Object.hasOwn(DEFAULT_MODELS, provider) ? DEFAULT_MODELS[provider]! : null
  if (listed.listed) {
    const ids = listed.models.map((m) => m.id)
    const model = body.model || fallback || (ids[0] ?? null)
    if (model === null) throw new HttpError(422, "invalid_connection", `${label} lists no model to use; give one`)
    llm.model = model
    // A host may not list a model it serves, such as an alias of a dated id, so one reply decides.
    needsCheck = !ids.includes(model)
  } else if (!body.model && fallback) {
    // Yian has no default model, so the connection is checked, and saved, on this one.
    llm.model = fallback
  }
  if (needsCheck) {
    let problem: string | null
    try {
      // Not through checkProvider again: it passed this config, and only the model changed since.
      problem = await office.checkModel(Provider.parse({ llm_config: llm }))
    } catch (error) {
      if (error instanceof RegistryClosed) throw new HttpError(503, "stopping", error.message)
      throw error
    }
    if (problem) {
      if (body.model) throw new HttpError(422, "model_refused", `The model didn't answer: ${problem}`)
      throw new HttpError(
        422,
        "model_refused",
        `The model '${llm.model}' didn't answer: ${problem}; name another model`,
      )
    }
  }
  let name: string
  try {
    name = await office.connections.add(label, ConnectionFile.parse({ llm_config: llm }))
  } catch (error) {
    if (error instanceof ProviderError) throw new HttpError(409, "connection_unusable", error.message)
    throw error
  }
  // Not awaited: the reply doesn't wait for the listings; warm never rejects.
  void office.models.warm()
  return name
}

/** Every connection, without keys, and whether the asking person may manage them. */
export async function listConnections(ctx: RequestContext): Promise<ConnectionList> {
  const canManage = await mayManage(ctx.office, actingPerson(ctx))
  return connectionList(ctx.office.connections, canManage)
}

/** Adds an API-key connection whose key works; the connection, without its key. */
export async function add(ctx: RequestContext, _params: Params, body: unknown) {
  const name = await buildAndCheck(ctx.office, body as AddBody)
  return guarded(() => ctx.office.connections.info(name))
}

/** Removes a connection and its sign-in; `office` can't be removed. */
export async function remove(ctx: RequestContext, params: Params): Promise<Ack> {
  const name = params.name!
  if (name === OFFICE) {
    throw new HttpError(
      422,
      "set_up_by_onboard",
      "office is office/connections/office.json; `opencorp onboard` changes it",
    )
  }
  const { connections, models } = ctx.office
  await guarded(() => connections.remove(name))
  models.invalidate(name)
  // Not awaited: the reply doesn't wait for the listings; warm never rejects.
  void models.warm()
  return { ok: true }
}

/** Makes a connection the one new chats start on; every connection afterwards. */
export async function setDefault(ctx: RequestContext, _params: Params, body: unknown): Promise<ConnectionList> {
  const { connection } = body as SetDefaultBody
  const connections = ctx.office.connections
  await guarded(() => connections.setDefault(connection))
  return connectionList(connections, true)
}

/** The models a connection offers, kept five minutes; `?refresh=1` lists them again. */
export async function listModels(ctx: RequestContext, params: Params) {
  const refresh = ctx.query.get("refresh") === "1"
  return guarded(() => ctx.office.models.get(params.name!, { refresh }))
}

/** Starts a subscription sign-in that adds a connection once approved; its URL and code to approve it with. */
export async function startLogin(ctx: RequestContext) {
  try {
    return await ctx.office.logins.start({ by: actingPerson(ctx) })
  } catch (error) {
    if (error instanceof LoginsClosed) throw new HttpError(503, "stopping", error.message)
    throw error
  }
}

/** A sign-in the asking person started, as it is now. */
export async function getLogin(ctx: RequestContext, params: Params) {
  return starters(() => ctx.office.logins.get(params.id!, { by: actingPerson(ctx) }))
}

/** Cancels a sign-in the asking person started, saving nothing. */
export async function cancelLogin(ctx: RequestContext, params: Params): Promise<Ack> {
  await starters(() => ctx.office.logins.cancel(params.id!, { by: actingPerson(ctx) }))
  return { ok: true }
}

/** The connection routes, in Python's order: `/connections/login/models` is a sign-in lookup. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // Anyone signed in; `can_manage` says whether they may change them.
  { method: "GET", path: "/connections", reply: ConnectionList, handler: listConnections },
  // Managing routes check the person in their guard, before the body is read.
  {
    method: "POST",
    path: "/connections",
    guard: checkManage,
    body: AddConnectionRequest,
    reply: Connection,
    handler: add,
  },
  {
    method: "PUT",
    path: "/connections/default",
    guard: checkManage,
    body: SetDefaultConnectionRequest,
    reply: ConnectionList,
    handler: setDefault,
  },
  {
    method: "POST",
    path: "/connections/login",
    guard: checkManage,
    body: StartLoginRequest,
    reply: ConnectionLogin,
    handler: startLogin,
  },
  // Only the person who started a sign-in sees or cancels it.
  { method: "GET", path: "/connections/login/:id", reply: ConnectionLogin, handler: getLogin },
  { method: "DELETE", path: "/connections/login/:id", reply: Ack, handler: cancelLogin },
  { method: "DELETE", path: "/connections/:name", guard: checkManage, reply: Ack, handler: remove },
  { method: "GET", path: "/connections/:name/models", reply: ModelList, handler: listModels },
]
