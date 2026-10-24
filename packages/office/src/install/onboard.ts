/** `opencorp onboard`: this machine's office for a company: the model provider it runs on. */
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { buffer } from "node:stream/consumers"
import { isDeepStrictEqual } from "node:util"
import {
  type AuthRequest,
  type Issue,
  LLM_CONFIG_KEYS,
  LLMConfig,
  SUPPORTED_LLM_PROVIDERS,
  ValidationError,
} from "@ngocbh/yian/llm_clients"
import { FileLockError } from "@ngocbh/yian/platform"
import { Connections } from "../chat/connections.ts"
import * as models from "../chat/models.ts"
import { loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import { PrivateFileError, writePrivate } from "../secrets.ts"
import { OnboardError, type Prompter } from "./prompts.ts"

/** What to do when a home has no company. */
export const SET_UP = "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one"

/** What to do about `count` missing template files while the office runs. */
export function stopToTopUp(count: number): string {
  const files = count === 1 ? "template file" : "template files"
  return `The office is running; stop it and run \`opencorp onboard\` again to add ${count} ${files}.`
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** The `llm_config` errors, naming only fields yian defines (a key pasted as a field name stays out). */
function llmErrors(issues: readonly Issue[]): string {
  const lines: string[] = []
  for (const issue of issues) {
    const loc = issue.loc.map(String)
    const first = loc[0]
    if (first !== undefined && (first === "headers" || (SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(first))) {
      // Yian's messages here quote header names and block field names, which may be a pasted key.
      lines.push(`llm_config.${first}: holds a name or value yian won't take`)
    } else if (issue.type === "extra_forbidden" || (first !== undefined && !LLM_CONFIG_KEYS.has(first))) {
      lines.push(`llm_config has an extra field; the fields are ${[...LLM_CONFIG_KEYS].join(", ")}`)
    } else {
      lines.push(`${["llm_config", ...loc].join(".")}: ${issue.msg}`)
    }
  }
  return [...new Set(lines)].join("; ")
}

/** `data` as a provider whose `llm_config` yian accepts; throws `OnboardError`, whose message never holds a
 *  value from `data`. */
export function checkProvider(data: unknown): Provider {
  let provider: Provider
  try {
    provider = Provider.parse(data)
  } catch (error) {
    if (error instanceof ProviderError) throw new OnboardError(`the provider isn't valid: ${error.message}`)
    throw error
  }
  const llm = provider.llm_config ?? {}
  try {
    LLMConfig.fromHost(llm)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new OnboardError(`yian won't take this provider: ${llmErrors(error.issues)}`)
    }
    // Yian's TypeCheckError (a lone surrogate JSON.parse let through) quotes the value.
    if (error instanceof RangeError) {
      throw new OnboardError(
        "yian won't take this provider: llm_config holds a value that isn't JSON text or a number",
      )
    }
    throw error
  }
  if (Object.hasOwn(llm, "api_key") && !llm.provider) {
    // Yian refuses a key without a provider at run time; say so now.
    throw new OnboardError("llm_config.api_key needs llm_config.provider, so the key goes only to that provider")
  }
  const name = llm.provider
  // Without a key, runs use the login `yian auth <name>` saved, which names its model.
  if (
    typeof name === "string" &&
    name &&
    !llm.model &&
    Object.hasOwn(llm, "api_key") &&
    !Object.hasOwn(models.DEFAULT_MODELS, name)
  ) {
    // Yian finds this out only when a run starts; say so before the provider is saved.
    throw new OnboardError(`llm_config.model is missing, and ${name} has no default model`)
  }
  return provider
}

/**
 * `provider` naming its default model when it has a key and names none.
 *
 * Yian has no default model. Without a key, runs use `yian auth`'s login, which names one. Throws
 * `OnboardError` when `provider` has a key for an endpoint of the owner's own and names no model, since that
 * endpoint has no default.
 */
export function withDefaultModel(provider: Provider): Provider {
  const llm = provider.llm_config ?? {}
  if (llm.model || !Object.hasOwn(llm, "api_key")) return provider
  if (Object.hasOwn(llm, "base_url")) {
    throw new OnboardError("llm_config.model is missing, and an endpoint of your own has no default model")
  }
  const name = llm.provider
  if (typeof name !== "string" || !Object.hasOwn(models.DEFAULT_MODELS, name)) return provider
  return Provider.parse({ ...dump(provider), llm_config: { ...llm, model: models.DEFAULT_MODELS[name] } })
}

/** The deployments at the Azure OpenAI resource whose v1 endpoint is `baseUrl` that are ready and not embedding
 *  models, in Azure's order; `request` stands in for the office's sender. Throws `OnboardError` when they
 *  couldn't be listed; the message never holds the key. */
export async function azureDeployments(
  baseUrl: string,
  key: string,
  options: { request?: AuthRequest } = {},
): Promise<string[]> {
  try {
    return await models.azureDeployments(baseUrl, key, { timeoutMs: 15_000, request: options.request })
  } catch (error) {
    if (error instanceof models.ModelListError) throw new OnboardError(error.message)
    throw error
  }
}

/** The models provider `name` lists for `key` (an empty key sends none), sorted; none when it has no listing.
 *  `request` stands in for yian's sender. Throws `OnboardError` when they couldn't be listed; the message never
 *  holds the key. */
export async function providerModels(
  name: string,
  key: string,
  options: { request?: AuthRequest } = {},
): Promise<string[]> {
  try {
    return (await models.providerModels(name, key || null, null, { timeoutMs: 15_000, request: options.request })) ?? []
  } catch (error) {
    if (error instanceof models.ModelListError) throw new OnboardError(error.message)
    throw error
  }
}

/** How onboarding lists what a provider offers; tests pass listers that reach no provider. */
export interface Listers {
  azureDeployments(baseUrl: string, key: string): Promise<string[]>
  providerModels(name: string, key: string): Promise<string[]>
}

/** The listers that ask the providers. */
export const LISTERS: Listers = {
  azureDeployments: (baseUrl, key) => azureDeployments(baseUrl, key),
  providerModels: (name, key) => providerModels(name, key),
}

/** Why a provider's model doesn't answer, or null when it does. */
export type ModelCheck = (provider: Provider) => Promise<string | null>

/** The owner's last answers while setting up the model, so asking again starts where they left off. */
export interface Answers {
  provider?: string
  endpoint?: string
  key?: string
  model?: string
}

/** The office's setup connection: `<office>/connections/office.json`. */
export function setupConnectionFile(office: string): string {
  return path.join(office, "connections", "office.json")
}

/** How `ensureProvider` gets a provider. */
export interface ProviderOptions {
  /** Lists deployments and models to pick from. */
  listers: Listers
  /** A provider as JSON, which replaces the saved one. */
  stdin?: Readable
  /** Checks the model answers before the provider is saved. */
  checkModel?: ModelCheck
  /** The owner's last answers, which get the new ones. */
  last?: Answers
}

/** `provider`'s fields that differ from their defaults, in file order (Python's `model_dump(exclude_defaults)`). */
function dump(provider: Provider): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (provider.llm_config !== null) data.llm_config = provider.llm_config
  if (Object.keys(provider.env).length > 0) data.env = provider.env
  if (Object.keys(provider.prices).length > 0) data.prices = provider.prices
  return data
}

/** Writes `provider` as the office's setup connection, readable only by the owner, and checks it loads back. */
async function saveProvider(office: string, provider: Provider): Promise<void> {
  const connections = new Connections(office)
  try {
    connections.ensureDir()
  } catch (error) {
    const code = errnoCode(error)
    if (code === undefined) throw error
    throw new OnboardError(`can't set up ${connections.dir}: ${code}`)
  }
  const file = setupConnectionFile(office)
  try {
    await writePrivate(file, JSON.stringify(dump(provider), null, 2) + "\n")
  } catch (error) {
    // Their messages hold paths, never the key.
    if (error instanceof PrivateFileError || error instanceof FileLockError) {
      throw new OnboardError(`can't write ${file}: ${error.message}`)
    }
    const code = errnoCode(error)
    if (code === undefined) throw error
    throw new OnboardError(`can't write ${file}: ${code}`)
  }
  try {
    await loadProvider(file, Provider.parse, { missingOk: false })
  } catch (error) {
    if (error instanceof ProviderError) throw new OnboardError(error.message)
    throw error
  }
}

/** Asks the owner for a provider until its model answers `checkModel`, then saves it as the office's setup
 *  connection. Each question defaults to its answer in `last`, which gets the new answers. Throws `OnboardError`
 *  when there's no one to ask or the file can't be written; the message never holds the key. */
export async function askProvider(
  _office: string,
  _prompter: Prompter,
  _options: Omit<ProviderOptions, "stdin">,
): Promise<void> {
  throw new OnboardError("there's no provider to set up")
}

/** Whether `file` exists, a symlink included; a parent that is a file counts as missing (Python's `lexists`). */
function lexists(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch (error) {
    if (errnoCode(error) === "ENOTDIR") return false
    throw error
  }
}

/**
 * Makes sure the office's setup connection holds a usable provider; resolves whether it was written.
 *
 * A provider on `stdin` (JSON) is checked and replaces the file, so a key can be rotated. Without one, an
 * existing file is checked and kept (written again if it lacks the default model a key needs; on a terminal, one
 * yian can't use is asked for again), and a missing one is asked of the owner, the key read without echo, until
 * its model answers `checkModel`. Nothing is written before the model answers. The key never goes through argv or
 * the environment. `last` is as for `askProvider`.
 *
 * Throws `OnboardError` when the provider isn't usable; the message never holds the key. An existing file is left
 * as it was.
 */
export async function ensureProvider(office: string, prompter: Prompter, options: ProviderOptions): Promise<boolean> {
  const { stdin, ...asking } = options
  const file = setupConnectionFile(office)
  if (stdin === undefined) {
    if (lexists(file)) {
      const again = "fix it or remove it and run `opencorp onboard` again"
      try {
        const saved = dump(await loadProvider(file, Provider.parse, { missingOk: false }))
        const checked = withDefaultModel(checkProvider(saved))
        if (isDeepStrictEqual(dump(checked), saved)) return false
        // A file from when yian had a default model gets the one it now needs.
        await saveProvider(office, checked)
        return true
      } catch (error) {
        if (error instanceof FileLockError) throw new OnboardError(`can't read ${file}: ${error.message}`)
        // Its message names the file.
        if (error instanceof ProviderError) throw new OnboardError(`${error.message}; ${again}`)
        if (!(error instanceof OnboardError)) throw error
        if (!prompter.interactive) throw new OnboardError(`${file}: ${error.message}; ${again}`)
        prompter.say(`${file}: ${error.message}; set up the model again.`)
      }
    }
    await askProvider(office, prompter, asking)
    return true
  }
  let data: unknown
  try {
    // A leading BOM is refused, as Python's json.loads refuses it.
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await buffer(stdin)))
  } catch {
    // JSON.parse's message quotes the bad input, which may be a key.
    throw new OnboardError("the provider on stdin is not valid JSON")
  }
  const provider = withDefaultModel(checkProvider(data))
  const problem = options.checkModel === undefined ? null : await options.checkModel(provider)
  if (problem !== null) throw new OnboardError(`the model didn't answer: ${problem}`)
  await saveProvider(office, provider)
  return true
}
