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
import { azureBaseUrl, Connections } from "../chat/connections.ts"
import * as models from "../chat/models.ts"
import { loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import { repr } from "../perm/redact.ts"
import { PrivateFileError, writePrivate } from "../secrets.ts"
import { NoTerminal, OnboardError, type Prompter, TRIES } from "./prompts.ts"

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
 *  models, in Azure's order; `request` stands in for the HTTP sender. Throws `OnboardError` when they
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
 *  `request` stands in for the HTTP sender. Throws `OnboardError` when they couldn't be listed; the message never
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
export const LISTERS: Listers = { azureDeployments, providerModels }

/** Asks `question` until `problem` finds nothing wrong with the answer, at most `TRIES` times; with `options`, the
 *  owner picks the answer from them. Throws `OnboardError` when no answer worked. */
export async function askUntil(
  prompter: Prompter,
  question: string,
  defaultAnswer: string,
  problem: (answer: string) => string | null,
  options: readonly string[] = [],
): Promise<string> {
  for (let i = 0; i < TRIES; i++) {
    const answer =
      options.length > 0
        ? await prompter.choose(question, options, defaultAnswer)
        : await prompter.ask(question, defaultAnswer)
    const why = problem(answer)
    if (why === null) return answer
    prompter.say(`That doesn't work: ${why}`)
  }
  throw new OnboardError(`no usable answer to ${repr(question)}`)
}

/** The deployment to use at the resource whose v1 endpoint is `baseUrl`, picked from its list when it can be
 *  listed, `last` for an empty answer. */
export async function askDeployment(
  prompter: Prompter,
  baseUrl: string,
  key: string,
  last: string,
  listers: Listers,
): Promise<string> {
  let deployments: string[]
  try {
    deployments = await listers.azureDeployments(baseUrl, key)
  } catch (error) {
    if (!(error instanceof OnboardError)) throw error
    prompter.say(`Couldn't list the deployments (${error.message}); type the name instead.`)
    deployments = []
  }
  if (deployments.length > 0) {
    return (await prompter.choose("Deployment", deployments, last || deployments[0], true)).trim()
  }
  const name = await askUntil(prompter, "Deployment name", last, (m) =>
    m.trim() ? null : "type the deployment's name",
  )
  return name.trim()
}

/** Why `answer` doesn't name an Azure OpenAI endpoint, or null when it does. */
function azureProblem(answer: string): string | null {
  try {
    new LLMConfig({ provider: "openai", base_url: azureBaseUrl(answer), api_key: "-" })
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    return "give the resource name, or its endpoint like https://<resource>.openai.azure.com"
  }
  return null
}

/** The key for provider `name`, read without echo; empty only when not `required`, and `last` for an empty answer
 *  when there is one. */
async function askKey(prompter: Prompter, name: string, required: boolean, last = ""): Promise<string> {
  let question: string
  if (last) question = `${name} API key (empty keeps the one you just typed; not shown)`
  else if (required) question = `${name} API key (not shown)`
  else question = `${name} API key (empty to use \`yian auth ${name}\`; not shown)`
  for (let i = 0; i < TRIES; i++) {
    let key: string
    try {
      key = (await prompter.secret(question)) || last
    } catch (error) {
      if (!(error instanceof NoTerminal)) throw error
      throw new OnboardError(
        "there is no terminal to read the key without echo; pass the provider with --provider-stdin instead",
      )
    }
    if (key || !required) return key
    prompter.say(`That doesn't work: ${name} needs a key`)
  }
  throw new OnboardError(`no usable answer to ${repr(question)}`)
}

/** The model for provider `name`, picked from those it lists for `key` when it can be listed, `last` for an empty
 *  answer; empty, without a key, for the model of yian's own login. */
export async function askModel(
  prompter: Prompter,
  name: string,
  last: string,
  key: string,
  listers: Listers,
): Promise<string> {
  if (!key && !models.KEYLESS.includes(name)) {
    // The runs use yian's own login, which saved its model and which the listing can't use.
    const login = `the model \`yian auth ${name}\` saved`
    const picked = await prompter.choose("Model", [login], last || login, true)
    return picked === login ? "" : picked
  }
  let listed: string[] = []
  if (prompter.interactive) {
    try {
      listed = await listers.providerModels(name, key)
    } catch (error) {
      if (!(error instanceof OnboardError)) throw error
      prompter.say(`Couldn't list the models (${error.message}).`)
    }
  }
  const defaultModel = Object.hasOwn(models.DEFAULT_MODELS, name) ? models.DEFAULT_MODELS[name] : undefined
  if (key && defaultModel) {
    const first = `${defaultModel} (the default)`
    // Typing a name picks another model; the one typed last time is the answer for nothing.
    const options = [first, ...listed.filter((m) => m !== defaultModel)]
    const picked = await prompter.choose("Model", options, last || first, true)
    return picked === first ? defaultModel : picked
  }
  if (listed.length > 0) return prompter.choose("Model", listed, last || listed[0], true)
  return askUntil(prompter, `Model name (${name} has no default model)`, last, (m) =>
    m.trim() ? null : "type the model's name",
  )
}

/** The provider the owner gives, each question defaulting to its answer in `last`, which gets these answers. */
async function askProviderData(prompter: Prompter, last: Answers, listers: Listers): Promise<unknown> {
  const choices = SUPPORTED_LLM_PROVIDERS.join(", ")
  const name = await askUntil(
    prompter,
    "Model provider",
    last.provider ?? "anthropic",
    (n) => ((SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(n) ? null : `choose one of: ${choices}`),
    SUPPORTED_LLM_PROVIDERS,
  )
  if (name !== last.provider) {
    // A key goes only to the provider it was typed for.
    for (const field of Object.keys(last)) delete last[field as keyof Answers]
    last.provider = name
  }
  if (name === "azure") {
    // Yian's azure client reads its endpoint from variables the office doesn't have; a resource's v1 endpoint takes
    // the openai client with the key and the deployment as the model.
    const question = "Azure OpenAI endpoint or resource name"
    last.endpoint = await askUntil(prompter, question, last.endpoint ?? "", azureProblem)
    last.key = await askKey(prompter, name, true, last.key ?? "")
    const baseUrl = azureBaseUrl(last.endpoint)
    last.model = await askDeployment(prompter, baseUrl, last.key, last.model ?? "", listers)
    return { llm_config: { provider: "openai", base_url: baseUrl, api_key: last.key, model: last.model } }
  }
  const llm: Record<string, string> = { provider: name }
  last.key = await askKey(prompter, name, false, last.key ?? "")
  if (last.key) llm.api_key = last.key
  else prompter.say(`No key saved; runs will use yian's own login (\`yian auth ${name}\`).`)
  last.model = (await askModel(prompter, name, last.model ?? "", last.key, listers)).trim()
  if (last.model) llm.model = last.model
  return { llm_config: llm }
}

/** When the model doesn't answer: check the same provider again. */
export const TRY_AGAIN = "Try again"
/** When the model doesn't answer: ask for the provider again, starting from the last answers. */
export const SET_UP_AGAIN = "Set up the model again"

/** Why a provider's model doesn't answer, or null when it does. */
export type ModelCheck = (provider: Provider) => Promise<string | null>

/** Tells the owner why the model failed and asks what to do; resolves whether they want to set it up again. */
export async function modelFailed(prompter: Prompter, problem: string): Promise<boolean> {
  prompter.say(problem.slice(0, 1).toUpperCase() + problem.slice(1))
  return (await prompter.choose("What now?", [TRY_AGAIN, SET_UP_AGAIN], TRY_AGAIN)) === SET_UP_AGAIN
}

/** Whether `provider`'s model answers, checking again for as long as the owner chooses to try again. */
async function answers(prompter: Prompter, provider: Provider, checkModel: ModelCheck): Promise<boolean> {
  for (;;) {
    prompter.say("Checking that the model answers...")
    const problem = await checkModel(provider)
    if (problem === null) return true
    if (!prompter.interactive) throw new OnboardError(`the model didn't answer: ${problem}`)
    if (await modelFailed(prompter, `the model didn't answer: ${problem}`)) return false
  }
}

/** Asks for a provider until yian takes it and its model answers `checkModel`, starting from the answers in
 *  `last`; only Ctrl-C or the input ending stops it. */
async function workingProvider(
  prompter: Prompter,
  checkModel: ModelCheck | undefined,
  last: Answers,
  listers: Listers,
): Promise<Provider> {
  for (;;) {
    const data = await askProviderData(prompter, last, listers)
    let provider: Provider
    try {
      provider = checkProvider(data)
    } catch (error) {
      if (!(error instanceof OnboardError) || !prompter.interactive) throw error
      prompter.say(`That doesn't work: ${error.message}`)
      continue
    }
    if (checkModel === undefined || (await answers(prompter, provider, checkModel))) return provider
  }
}

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
    // Its message is value-free and names the folder.
    if (error instanceof ProviderError) throw new OnboardError(error.message)
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
    if (error instanceof FileLockError) throw new OnboardError(`can't read ${file}: ${error.message}`)
    if (error instanceof ProviderError) throw new OnboardError(error.message)
    throw error
  }
}

/** Asks the owner for a provider until its model answers `checkModel`, then saves it as the office's setup
 *  connection. Each question defaults to its answer in `last`, which gets the new answers. Throws `OnboardError`
 *  when there's no one to ask or the file can't be written; the message never holds the key. */
export async function askProvider(
  office: string,
  prompter: Prompter,
  options: Omit<ProviderOptions, "stdin">,
): Promise<void> {
  await saveProvider(office, await workingProvider(prompter, options.checkModel, options.last ?? {}, options.listers))
}

/** Whether `file` exists, a symlink included; one that can't be looked at counts as missing (Python's `lexists`). */
function lexists(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch (error) {
    if (errnoCode(error) !== undefined) return false
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
  const file = setupConnectionFile(office)
  if (options.stdin === undefined) {
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
        const code = errnoCode(error)
        if (code !== undefined) throw new OnboardError(`can't read ${file}: ${code}`)
        if (!(error instanceof OnboardError)) throw error
        if (!prompter.interactive) throw new OnboardError(`${file}: ${error.message}; ${again}`)
        prompter.say(`${file}: ${error.message}; set up the model again.`)
      }
    }
    await askProvider(office, prompter, options)
    return true
  }
  // Outside the try: a read error is the stream's, not bad JSON.
  const bytes = await buffer(options.stdin)
  let data: unknown
  try {
    // A leading BOM is refused, as Python's json.loads refuses it.
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
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
