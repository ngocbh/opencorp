/** `opencorp onboard`: this machine's office for a company: the home, the company repo, this device, the model, the
 *  service. */
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { buffer } from "node:stream/consumers"
import { isDeepStrictEqual } from "node:util"
import type { Device } from "@opencorp/protocol"
import { type ComposedFlow, loadFlow, runFlow } from "@ngocbh/yian"
import { type AuthRequest, LLMConfig, SUPPORTED_LLM_PROVIDERS, ValidationError } from "@ngocbh/yian/llm_clients"
import { type FileLock, FileLockError, isLocked, sqliteErrorCode, waitForLock, withWarnings } from "@ngocbh/yian/platform"
import type { RunFlowOptions, RunResult } from "@ngocbh/yian/run"
import { addDevice, DeviceRefused } from "../auth/devices.ts"
import {
  deviceName,
  Identity,
  IdentityUnreadable,
  identityPath,
  loadIdentity,
  readIdentity,
  writeIdentity,
} from "../auth/identity.ts"
import { checkPassword } from "../auth/passwords.ts"
import { newToken, tokenSha256 } from "../auth/tokens.ts"
import { azureBaseUrl, Connections } from "../chat/connections.ts"
import * as models from "../chat/models.ts"
import { checkLlmConfig, loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import { CompanyGit, CompanyGitError } from "../company/git.ts"
import { lint } from "../company/lint.ts"
import { type CompanyRepo, loadRepo } from "../company/loader.ts"
import { type CompanyState, companyState, missingFiles, type Owner, writeCompany } from "../company_template/index.ts"
import { checkSocketPath, makeOfficeDir, OfficeStartError } from "../daemon/sockets.ts"
import { redact as redactSecrets, repr } from "../perm/redact.ts"
import { embedded } from "../platform.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { PrivateFileError, writePrivate } from "../secrets.ts"
import type { WorkerEnv } from "../worker/main.ts"
import { workerEnv } from "../worker/spawn.ts"
import { shQuote } from "./fallback.ts"
import checkModelYaml from "./flows/check_model.yaml" with { type: "file" }
import {
  type Completed,
  defaultHost,
  type Env,
  type Host,
  type Launch,
  launch,
  resolveHome,
  runCommand,
  ServiceError,
} from "./launch.ts"
import { NoTerminal, OnboardError, type Prompter, TRIES } from "./prompts.ts"
import * as service from "./service.ts"

/** What to do when a home has no company. */
export const SET_UP = "run `opencorp init` to create one, or `opencorp onboard --from URL` to join one"

/** What's wrong with the company at `root` (`state`) and how to fix it. */
export function damageMessage(root: string, state: Extract<CompanyState, { kind: "damaged" }>): string {
  const q = shQuote(root)
  const fixes: Record<typeof state.reason, string> = {
    "not-a-directory": "move it away, then run this again",
    unreadable: "make it readable or move it away, then run this again",
    "no-git": "restore its .git, or move it away to start over",
    "bad-git": "restore its .git, or move it away to start over",
    "no-company-yaml":
      `find the commit that removed it with \`git -C ${q} log -- company.yaml\`, restore it with` +
      ` \`git -C ${q} checkout <commit>~1 -- company.yaml\` and commit`,
    "company-yaml-deleted": `restore it with \`git -C ${q} checkout -- company.yaml\``,
  }
  return `${state.detail}; ${fixes[state.reason]}`
}

/** What to do about `count` missing template files while the office runs. */
export function stopToTopUp(count: number): string {
  const files = count === 1 ? "template file" : "template files"
  return `The office is running; run \`opencorp stop\`, then \`opencorp onboard\` again to add ${count} ${files}.`
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** The most characters `llm_config.api_key` may have. Servers cap a request's headers at 8-16 KiB in all, so a
 *  longer key can't be sent, and the scrubbers build a pattern from each form of the key that grows with it. */
export const MAX_KEY_CHARS = 16384

/** Valid HTTP header text: printable ASCII with inner spaces only, as yian's `checkHeaderValue`
 *  (`src/llm/auth.ts`) checks a key when it sends it. */
const HEADER_TEXT = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** `data` as a provider whose `llm_config` yian accepts and whose key can be sent as a header; throws
 *  `OnboardError`, whose message never holds a value from `data`. */
export function checkProvider(data: unknown): Provider {
  let provider: Provider
  try {
    provider = Provider.parse(data)
  } catch (error) {
    if (error instanceof ProviderError) throw new OnboardError(`the provider isn't valid: ${error.message}`)
    throw error
  }
  const llm = provider.llm_config ?? {}
  // Before yian's check, which refuses a key with a control character in words of its own.
  const key = llm.api_key
  if (typeof key === "string") {
    // Length first: a huge key is refused without a regex test.
    if (key.length > MAX_KEY_CHARS) {
      throw new OnboardError(`llm_config.api_key is too long (at most ${MAX_KEY_CHARS} characters)`)
    }
    if (!HEADER_TEXT.test(key)) {
      throw new OnboardError("llm_config.api_key must be printable ASCII with no leading or trailing spaces")
    }
  }
  try {
    checkLlmConfig(llm)
  } catch (error) {
    if (error instanceof ProviderError) throw new OnboardError(error.message)
    throw error
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

/** The models provider `name` lists for `key` (an empty key sends none) at `baseUrl` (empty or none: the
 *  provider's own host), sorted; none when it has no listing. `request` stands in for the HTTP sender. Throws
 *  `OnboardError` when they couldn't be listed; the message never holds the key. */
export async function providerModels(
  name: string,
  key: string,
  options: { request?: AuthRequest; baseUrl?: string } = {},
): Promise<string[]> {
  const { request, baseUrl } = options
  try {
    return (await models.providerModels(name, key || null, baseUrl || null, { timeoutMs: 15_000, request })) ?? []
  } catch (error) {
    if (error instanceof models.ModelListError) throw new OnboardError(error.message)
    throw error
  }
}

/** How onboarding lists what a provider offers; tests pass listers that reach no provider. */
export interface Listers {
  azureDeployments(baseUrl: string, key: string): Promise<string[]>
  /** `baseUrl`, when given and not empty, is the server to list instead of the provider's own. */
  providerModels(name: string, key: string, baseUrl?: string): Promise<string[]>
}

/** The listers that ask the providers. */
export const LISTERS: Listers = {
  azureDeployments,
  providerModels: (name, key, baseUrl) => providerModels(name, key, { baseUrl }),
}

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

/** Why `answer` isn't a server URL to save, or null when it is one or empty (the server on this machine). The
 *  reasons never hold the answer. */
function serverUrlProblem(answer: string): string | null {
  const text = answer.trim()
  if (!text) return null
  const url = URL.parse(text)
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    return "give an http:// or https:// URL like http://host:8000/v1"
  }
  // Yian reads the variable as written, and its parsers take only printable ASCII.
  if (!/^[\x21-\x7e]+$/.test(text)) return "give the URL in ASCII, without spaces"
  if (url.username || url.password || text.includes("@")) return "keep the user and password out of the URL"
  if (text.includes("?") || text.includes("#")) return "give the URL without a query or fragment"
  return null
}

/** Why a key can't go to a server at an http URL elsewhere. */
const KEY_OVER_HTTP = "a key goes only over https, or http to localhost, 127.0.0.1 or ::1"

/** Whether yian takes `url` as a `base_url` that a key may be sent to. */
function keyedBaseUrl(url: string): boolean {
  try {
    new LLMConfig({ provider: "openai", base_url: url, api_key: "-" })
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    return false
  }
  return true
}

/** Why a key can't be sent to the server at `url` (empty: the one on this machine), or null when it can. */
function keyProblem(url: string): string | null {
  // Yian's rule for where a key may be sent, which it applies to llm_config.base_url; VLLM_BASE_URL is used as
  // written, so it is applied here.
  if (!url || keyedBaseUrl(url)) return null
  if (url.startsWith("http:") && keyedBaseUrl(`https:${url.slice("http:".length)}`)) return KEY_OVER_HTTP
  return "yian sends a key only to a lowercase ASCII URL whose host has no underscore"
}

/** The key for provider `name`, read without echo; empty only when not `required`, and `last` for an empty answer
 *  when there is one. */
async function askKey(prompter: Prompter, name: string, required: boolean, last = ""): Promise<string> {
  let question: string
  if (last) question = `${name} API key (empty keeps the one you just typed; not shown)`
  else if (required) question = `${name} API key (not shown)`
  else if (models.KEYLESS.includes(name)) question = `${name} API key (empty for none; not shown)`
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

/** The model for provider `name`, picked from those it lists for `key` (at `baseUrl` when given) when it can be
 *  listed, `last` for an empty answer; empty, without a key, for the model of yian's own login. */
export async function askModel(
  prompter: Prompter,
  name: string,
  last: string,
  key: string,
  listers: Listers,
  baseUrl = "",
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
      listed = await listers.providerModels(name, key, baseUrl)
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
  if (models.KEYLESS.includes(name)) {
    // The server's URL goes in the env, where yian's client for the provider reads it; the caller's own variable
    // is never read, so setup works only as the office's runs will.
    for (let i = 0; ; i++) {
      // An empty answer keeps a URL typed before, so the server on this machine is then typed too.
      const question = last.endpoint
        ? `${name} server URL (empty keeps the one you just typed)`
        : `${name} server URL (empty for one on this machine)`
      last.endpoint = (await askUntil(prompter, question, last.endpoint ?? "", serverUrlProblem)).trim()
      // Yian's ollama client sends no key.
      last.key = name === "ollama" ? "" : await askKey(prompter, name, false, last.key ?? "")
      const problem = last.key ? keyProblem(last.endpoint) : null
      if (problem === null) break
      prompter.say(`That doesn't work: ${problem}`)
      // Dropped, so the next key question can be left empty for none.
      last.key = ""
      if (i + 1 >= TRIES) throw new OnboardError(problem)
    }
    if (last.key) llm.api_key = last.key
    last.model = (await askModel(prompter, name, last.model ?? "", last.key, listers, last.endpoint)).trim()
    if (last.model) llm.model = last.model
    if (!last.endpoint) return { llm_config: llm }
    return { llm_config: llm, env: { [models.ENV_BASE_URL[name]!]: last.endpoint } }
  }
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
  await writeProvider(setupConnectionFile(office), provider)
}

/** Writes `provider` to `file` (0600, in a folder that must already be private to this user) and checks it loads
 *  back. Throws `OnboardError` when it can't be written or read back; the message never holds the key. */
export async function writeProvider(file: string, provider: Provider): Promise<void> {
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

/** Asks the owner with init's picker until the model answers `checkModel`, then writes the provider to `file` (0600; a
 *  private folder of this user) and resolves to it. Throws as `askProvider` does. */
export async function askProviderTo(
  file: string,
  prompter: Prompter,
  options: Omit<ProviderOptions, "stdin">,
): Promise<Provider> {
  const provider = await workingProvider(prompter, options.checkModel, options.last ?? {}, options.listers)
  await writeProvider(file, provider)
  return provider
}

/** Whether `file` exists, a symlink included; one that can't be looked at counts as missing (Python's `lexists`). */
export function lexists(file: string): boolean {
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
  let problem: string | null = null
  if (options.checkModel !== undefined) {
    prompter.say("Checking that the model answers...")
    problem = await options.checkModel(provider)
  }
  if (problem !== null) throw new OnboardError(`the model didn't answer: ${problem}`)
  await saveProvider(office, provider)
  return true
}

/** `text` as a handle: lowercase letters, digits and single '-', at most 32 characters. */
export function slug(text: string): string {
  const dashed = text.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-")
  return dashed.replace(/^-+|-+$/g, "").slice(0, 32).replace(/^-+|-+$/g, "")
}

/** The owner's default name and handle: the account's full name and a slug of the login. */
export function ownerDefaults(login: string, gecos: string): [name: string, handle: string] {
  return [gecos.split(",")[0]!.trim() || login, slug(login) || "owner"]
}

/** The account's full name (its GECOS field's), or "" when it can't be read. */
function fullName(uid: number): string {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }
    if (process.platform === "darwin") return execFileSync("/usr/bin/id", ["-F"], options).trim()
    return execFileSync("getent", ["passwd", String(uid)], options).trim().split(":")[4] ?? ""
  } catch {
    return ""
  }
}

/** Gives an account's default name and handle, as `loginDefaults` does. */
export type LoginDefaults = () => [name: string, handle: string]

/** `ownerDefaults` for the account running this. Throws `OnboardError` when the user id has no account. */
export function loginDefaults(): [name: string, handle: string] {
  const uid = process.getuid!()
  let login: string
  try {
    login = os.userInfo().username
  } catch {
    throw new OnboardError(`user id ${uid} has no account in the password database`)
  }
  return ownerDefaults(login, fullName(uid))
}

/**
 * Makes this device's token for `owner` and saves the identity; resolves `owner` listing the device.
 *
 * The identity is written before the company, so the device the first commit lists always has its token here. A
 * new company replaces an identity from an earlier one. Throws `OnboardError` when the identity file can't be
 * written.
 */
export async function makeDevice(home: string, owner: Owner): Promise<Owner> {
  const me = new Identity(owner.handle, deviceName(), newToken())
  await saveIdentity(home, me)
  const device: Device = { name: me.device, token_sha256: tokenSha256(me.token) }
  return { ...owner, devices: [device] }
}

async function saveIdentity(home: string, me: Identity): Promise<void> {
  const file = identityPath(home)
  try {
    await writeIdentity(file, me)
  } catch (error) {
    // Their messages hold paths, never the token.
    if (error instanceof PrivateFileError || error instanceof FileLockError) {
      throw new OnboardError(`can't write ${file}: ${error.message}`)
    }
    const text = strerror(error)
    if (text === undefined) throw error
    throw new OnboardError(`can't write ${file}: ${text}`)
  }
}

/** Throws `OnboardError` when the office's socket at `socket` is too long for a unix socket, saying how to pick a
 *  shorter home. */
export function checkSocket(socket: string): void {
  try {
    checkSocketPath(socket)
  } catch (error) {
    if (!(error instanceof OfficeStartError)) throw error
    throw new OnboardError(`${error.message}; pick a shorter office home with --home or OPENCORP_HOME`)
  }
}

/**
 * Whether the office of `one` is running: it answers on its socket, or a process holds its lock (`office.lock`), as a
 * daemon that is starting, stopping, hung or stopped does. Throws `OnboardError` when the lock can't be checked, so
 * an office that may be running is never taken for a stopped one.
 */
export async function officeRunning(one: Launch, host: Host): Promise<boolean> {
  if (await host.answers(one.socket)) return true
  const lockPath = path.join(one.office, "office.lock")
  try {
    return (host.locked ?? isLocked)(lockPath)
  } catch (error) {
    const why = strerror(error) ?? (error instanceof Error ? error.message : String(error))
    throw new OnboardError(`can't tell whether the office is running: can't check ${lockPath}: ${why}`)
  }
}

/** Makes the home and office dirs, both 0700. Throws `OnboardError` when they can't be made, the home is there but
 *  isn't a directory, or the office dir isn't this user's. */
export function makeHome(home: string): void {
  try {
    if (fs.statSync(home, { throwIfNoEntry: false })?.isDirectory() === false)
      throw new OnboardError(`${home} is not a directory`)
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    // mkdir leaves an existing home's mode alone; the home holds the company and the office.
    fs.chmodSync(home, 0o700)
    makeOfficeDir(path.join(home, "office"))
  } catch (error) {
    if (error instanceof OnboardError) throw error
    if (error instanceof OfficeStartError) throw new OnboardError(error.message)
    const text = strerror(error)
    if (text === undefined) throw error
    throw new OnboardError(`can't set up the office home ${home}: ${text}`)
  }
}

/** `text` with the user and password taken out of any URL in it, since a remote URL can carry a token. */
export function redact(text: string): string {
  return text.replace(/(?<=:\/\/)[^/@\s]+@/g, "***@")
}

/** Runs git as the user would, in `env` (this process's by default), so their credentials and ssh setup reach a
 *  remote; never throws: git that can't start is exit 127, and one still running after 300 s exit 124. */
export async function userGit(args: readonly string[], { env = process.env }: { env?: Env } = {}): Promise<Completed> {
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined) vars[name] = value
  const done = await runCommand(["git", ...args], { env: vars, timeoutMs: 300_000 })
  return done.code === 127 ? { ...done, stderr: `can't run git: ${done.stderr}` } : done
}

/** What to do when a clone or push fails: under `opencorp`'s setup screen git has no terminal to ask on. */
export const GIT_ACCESS =
  "if git needs a login or a new host key, set that up in a terminal first (`gh auth login`, or `ssh -T git@HOST` once)"

/** Where onboarding clones a company before this device is added to it; renamed to `company` once done, so a
 *  stopped onboarding leaves no company that lacks this device. */
export const CLONE = ".company-clone"

/** The questions, by which command-line flags preset their answers. */
export const REPO_URL = "Company repo URL (empty if there's none yet)"
export const WHO = "Which of them are you?"

/** Removes `file`, whether a dir, a file, or a symlink (never what it points to); nothing if it's gone. */
export function removePath(file: string): void {
  fs.rmSync(file, { recursive: true, force: true })
}

/** Clones the company at `url` into `dest` with the user's git in `env`, replacing what an earlier, stopped clone
 *  left there. Throws `OnboardError` when the clone failed or isn't a company; nothing is left at `dest`. */
async function clone(url: string, dest: string, env: Env): Promise<void> {
  removePath(dest)
  const done = await userGit(["clone", "-q", "--", url, dest], { env })
  if (done.code !== 0) {
    removePath(dest)
    throw new OnboardError(
      `can't clone ${redact(url)}: ${redact(done.stderr.trim())}; ${GIT_ACCESS}, then run \`opencorp onboard\` again`,
    )
  }
  if ((await companyState(dest)).kind !== "ok") {
    removePath(dest)
    throw new OnboardError(`${redact(url)} isn't a company repo: it has no company.yaml at its top`)
  }
}

/** This account's default handle, or "" when it has none. */
function loginHandle(defaults: LoginDefaults): string {
  try {
    return defaults()[1]
  } catch (error) {
    if (error instanceof OnboardError) return ""
    throw error
  }
}

/** The identity saved at `home`, or undefined when there is none. Looked for first, since reading takes the
 *  home's `.lock`, which a failed onboarding must not leave behind. */
export async function knownIdentity(home: string): Promise<Identity | undefined> {
  const file = identityPath(home)
  return lexists(file) ? await readIdentity(file) : undefined
}

/** Whether `people` lists `me`'s token for its handle. */
function lists(people: CompanyRepo["people"], me: Identity): boolean {
  return people.get(me.handle)?.devices.some((d) => d.token_sha256 === tokenSha256(me.token)) ?? false
}

/**
 * This device's identity in the company at `root`: kept if the company lists it, else made and committed.
 *
 * A new identity is for the human you pick: the default is the human whose handle is this login's
 * (`loginDefaults`), otherwise the only human. A human with a password must give it; without a terminal to ask on,
 * the device is left out (null) for `opencorp login` to add. A device name the human already lists gets a `-2`
 * (`-3`, ...) suffix. Throws `OnboardError` when there's no human, no answer names one, the password never
 * matched, or the device can't be added.
 */
async function join(
  root: string,
  worktrees: string,
  home: string,
  prompter: Prompter,
  loginDefaults: LoginDefaults,
): Promise<Identity | null> {
  const people = loadRepo(root).people
  const known = await knownIdentity(home)
  if (known !== undefined && lists(people, known)) return known
  const humans = [...people.values()]
    .filter((p) => p.kind === "human")
    .map((p) => p.handle)
    .sort()
  if (humans.length === 0) throw new OnboardError("the company has no humans for this device to act as")
  const login = loginHandle(loginDefaults)
  const defaultHandle = humans.includes(login) ? login : humans.length === 1 ? humans[0]! : ""
  // With no one to ask, nothing is listed, so the problem names the humans and the flag.
  const pick = `say which one you are (${humans.map((h) => "@" + h).join(", ")}), or pass --handle`
  const handle = await askUntil(
    prompter,
    WHO,
    defaultHandle,
    (h) => (humans.includes(h) ? null : h ? `@${h} isn't one of them` : pick),
    humans,
  )
  const human = people.get(handle)!
  const passwordHash = human.password_hash
  if (passwordHash !== null) {
    try {
      await askPassword(prompter, handle, passwordHash)
    } catch (error) {
      if (!(error instanceof NoTerminal)) throw error
      prompter.say(`There's no terminal to ask for @${handle}'s password on, so this device isn't added.`)
      return null
    }
  }
  const taken = new Set(human.devices.map((d) => d.name))
  const base = deviceName()
  let name = base
  for (let suffix = 2; taken.has(name); suffix++) name = `${base.slice(0, 60)}-${suffix}`
  const me = new Identity(handle, name, newToken())
  try {
    await addDevice(new CompanyGit(root, worktrees), handle, { name, token_sha256: tokenSha256(me.token) }, handle)
  } catch (error) {
    if (!(error instanceof DeviceRefused || error instanceof CompanyGitError || strerror(error) !== undefined)) {
      throw error
    }
    throw new OnboardError(`can't add this device to @${handle}: ${(error as Error).message}`)
  }
  await saveIdentity(home, me)
  if (passwordHash === null) {
    prompter.say(`@${handle} has no password yet; set one with \`opencorp password\` so a new device has to give it`)
  }
  return me
}

/** Asks for `handle`'s password until it matches `passwordHash`, at most `TRIES` times. Throws `NoTerminal` when
 *  there's no terminal to ask on, and `OnboardError` when no answer matched. */
async function askPassword(prompter: Prompter, handle: string, passwordHash: string): Promise<void> {
  for (let i = 0; i < TRIES; i++) {
    if (await checkPassword(await prompter.secret(`@${handle}'s password (not shown)`), passwordHash)) return
    prompter.say("That doesn't work: wrong password")
  }
  throw new OnboardError(`wrong password for @${handle}`)
}

/**
 * Takes the lock `opencorp init` and `opencorp onboard` hold while they set up the office at `one`'s home, which
 * `makeHome` has made. Throws `OnboardError` when another init or onboard holds it, or it can't be taken.
 */
export async function setupLock(one: Launch): Promise<FileLock> {
  // Not the home's `.lock`: that is the private-file lock `writeIdentity` takes, and a second lock on it in this
  // process would wait for this one.
  const file = path.join(one.office, "setup.lock")
  try {
    // Two contenders can both see the lock as busy for a moment; a short wait lets one of them win.
    return await waitForLock(file, { private: true, timeoutMs: 1000 })
  } catch (error) {
    if (error instanceof FileLockError) {
      if (error.reason === "busy") {
        throw new OnboardError(
          `another \`opencorp init\` or \`opencorp onboard\` is running on ${one.home}; wait for it to finish`,
        )
      }
      throw new OnboardError(`can't lock ${file}: ${error.message}`)
    }
    if (sqliteErrorCode(error) !== undefined) throw new OnboardError(`can't lock ${file}: it isn't a lock file; remove it`)
    const text = strerror(error)
    if (text === undefined) throw error
    throw new OnboardError(`can't lock ${file}: ${text}`)
  }
}

/** Onboarding's steps: the company, this device, the model, and the office. */
export const STEPS = 4

/** How `onboard` runs. */
export interface OnboardOptions {
  /** Lists deployments and models to pick from. */
  listers: Listers
  /** Checks the model answers before the provider is saved (`modelProblem` in production). */
  checkModel: ModelCheck
  /** The service manager to run the office under; `auto` (the default) takes the first that works. */
  mode?: service.Mode | "auto"
  /** A provider as JSON, which replaces the saved one. */
  stdin?: Readable
  /** This machine (`defaultHost()` by default). */
  host?: Host
  /** The caller's environment: the daemon's is taken from it, and the user's git runs in it (`process.env` by
   *  default). */
  environ?: Env
  /** The company repo to clone when there's none here; asked for when not given. */
  source?: string
  /** Whether each step gets a numbered header (default true). */
  steps?: boolean
  /** This account's default name and handle (`loginDefaults` by default). */
  loginDefaults?: LoginDefaults
}

/**
 * Sets up this machine's office for the company at `home`; running it again only fills in what is missing.
 *
 * In order: the home and office dirs (0700); the company repo, cloned from `source` (or a URL asked for) when
 * there's none here, and topped up with any template files it lacks (lint errors stop here; left alone while the
 * office runs); this device, which for a cloned company is listed for the human you pick (after their password,
 * if they have one) and committed in the clone before the office starts, unless the company already lists this
 * device's identity; the office's setup connection; and the daemon under `mode`. With `steps`, each step gets a
 * numbered header (`opencorp init` turns them off, since onboarding is one of its steps).
 *
 * Holds the setup lock (see `setupLock`) from the home onward. Throws `OnboardError` when another init or onboard
 * holds it, a step failed, or there's no company here and no repo to clone; earlier steps stay done.
 */
export async function onboard(home: string, prompter: Prompter, options: OnboardOptions): Promise<void> {
  const environ = options.environ ?? process.env
  const one = launch(home, { environ, userHome: (options.host ?? defaultHost()).userHome })
  checkSocket(one.socket)
  // Checked before the home is made, so a damaged company is reported with nothing changed.
  const company = path.join(one.home, "company")
  const state = await companyState(company)
  if (state.kind === "damaged") throw new OnboardError(damageMessage(company, state))
  makeHome(one.home)
  const lock = await setupLock(one)
  try {
    await onboardLocked(one, prompter, options)
  } finally {
    lock.release()
  }
}

/** As `onboard`, for a caller that has made the home (`makeHome`) of the office at `one` and holds its
 *  `setupLock`. */
export async function onboardLocked(one: Launch, prompter: Prompter, options: OnboardOptions): Promise<void> {
  const host = options.host ?? defaultHost()
  const environ = options.environ ?? process.env
  const company = path.join(one.home, "company")
  const worktrees = path.join(one.office, "worktrees")
  prompter.say(`Office home: ${one.home}`)

  const step = (number: number, title: string, why: string) => {
    if (options.steps ?? true) prompter.step(number, STEPS, title, why)
  }

  step(1, "Company", "This office works for one company, whose people and flows live in its git repo.")
  // A running office is the only writer of its company clone (CompanyGit's lock is in-process), so the template
  // top-up waits until it is stopped. One that holds its lock but doesn't answer counts as running.
  const running = await officeRunning(one, host)
  const state = await companyState(company)
  if (state.kind === "damaged") throw new OnboardError(damageMessage(company, state))
  const fresh = state.kind !== "ok"
  let root = company
  if (fresh) {
    if (running) {
      throw new OnboardError(
        `the office is running, but ${company} has no company yet; run \`opencorp stop\`,` +
          " then `opencorp onboard` again",
      )
    }
    if (state.kind === "unfinished") {
      throw new OnboardError(
        `${company} holds a company that was never finished (no first commit);` +
          " run `opencorp init` to finish it, or remove it to join another",
      )
    }
    const url = options.source || (await prompter.ask(REPO_URL))
    if (!url) throw new OnboardError(`there's no company at ${company}; ${SET_UP}`)
    root = path.join(one.home, CLONE)
    await clone(url, root, environ)
    prompter.say(`Company repo: cloned ${redact(url)}`)
  }
  let me: Identity | null = null
  // Why this device acts as no one, when that isn't simply a missing identity.
  let note: string | undefined
  try {
    let written: string[] = []
    let missing: string[] = []
    try {
      if (running) missing = missingFiles(root)
      else written = await writeCompany(root, worktrees)
    } catch (error) {
      if (!(error instanceof CompanyGitError || error instanceof RangeError || strerror(error) !== undefined)) {
        throw error
      }
      throw new OnboardError(`can't write the company repo at ${company}: ${(error as Error).message}`)
    }
    // The repo is never cloned over a company, so a given --from does nothing; the URL isn't echoed, as it may
    // hold credentials.
    const ignored = !fresh && options.source ? " (--from ignored: there's a company here already)" : ""
    if (missing.length > 0) {
      prompter.say(`Company repo: ${company}. ${stopToTopUp(missing.length)}${ignored}`)
    } else if (written.length > 0 || !fresh) {
      const done = written.length > 0 ? `added ${written.length} template files to` : "up to date at"
      prompter.say(`Company repo: ${done} ${company}${ignored}`)
    }
    const repo = loadRepo(root)
    const errors = (await lint(repo)).filter((issue) => issue.severity === "error")
    if (errors.length > 0) {
      throw new OnboardError(
        "the company repo has errors; fix them and run `opencorp onboard` again:\n" +
          errors.map((issue) => `  ${issue.path}: ${issue.code}: ${issue.message}`).join("\n"),
      )
    }

    step(2, "This device", "The office takes requests only from devices its humans list, once any human lists one.")
    if (fresh) {
      me = await join(root, worktrees, one.home, prompter, options.loginDefaults ?? loginDefaults)
      try {
        // An empty dir: rename can't put a directory over a full one.
        if (fs.statSync(company, { throwIfNoEntry: false })?.isDirectory()) fs.rmdirSync(company)
        fs.renameSync(root, company)
      } catch (error) {
        const text = strerror(error)
        if (text === undefined) throw error
        throw new OnboardError(`can't move the clone into ${company}: ${text}`)
      }
    } else {
      const file = identityPath(one.home)
      let known: Identity | undefined
      try {
        known = await loadIdentity(file)
      } catch (error) {
        if (!(error instanceof IdentityUnreadable)) throw error
        note = `This device's identity can't be used: ${error.message}`
      }
      // The working tree, as join() reads it; the office's roster is HEAD's, which a later commit can change.
      if (known && lists(repo.people, known)) me = known
      else if (known) {
        note =
          `This device's identity (${file}) is @${known.handle}'s ${known.device}, but the company doesn't list its` +
          " token; `opencorp login` says how to get it listed."
      }
    }
  } catch (error) {
    if (fresh) removePath(root)
    throw error
  }
  if (me) {
    prompter.say(`This device: ${me.device}, acting as @${me.handle} (its token is in ${identityPath(one.home)})`)
  } else {
    prompter.say(note ?? "This device has no identity yet; run `opencorp login` to use opencorp from it.")
  }

  step(3, "Model", "Your agents think with this model; its key stays in this office, readable only by you.")
  const wrote = await ensureProvider(one.office, prompter, {
    listers: options.listers,
    stdin: options.stdin,
    checkModel: options.checkModel,
  })
  prompter.say(`Model provider: ${wrote ? "saved to" : "up to date at"} ${setupConnectionFile(one.office)}`)

  step(4, "Office", "The office runs as a service, so your agents keep working after this terminal closes.")
  let installed: service.Installed
  try {
    installed = await service.install(one, host, options.mode ?? "auto")
    for (const note of installed.notes) prompter.say(`  skipped ${note}`)
    await service.wait(one, host, undefined, installed.child)
  } catch (error) {
    if (error instanceof ServiceError || error instanceof OfficeStartError) throw new OnboardError(error.message)
    throw error
  }
  prompter.say(`Office: running under ${installed.mode ?? "a process started by hand"}; log at ${one.log}`)
  // Before the done line, so the export comes before the `opencorp` it says to run.
  if (!clientFinds(one.home, environ, host.userHome)) {
    prompter.say(
      "This shell's `opencorp` looks for its office elsewhere; to reach this one, first run " +
        `\`export OPENCORP_HOME=${shQuote(one.home)}\` (add it to your shell profile to keep it).`,
    )
  }
  prompter.say("Done. Run `opencorp` in a project folder to talk to your team.")
}

/** Whether `opencorp` run with `environ` finds the office at `home` (a real path): its home is `$OPENCORP_HOME`,
 *  else `<userHome>/.opencorp`, with a leading `~` expanded. */
function clientFinds(home: string, environ: Env, userHome: string): boolean {
  try {
    return resolveHome(environ.OPENCORP_HOME || path.join(userHome, ".opencorp")) === home
  } catch {
    // A home that can't be resolved can't be this one.
    return false
  }
}

/** How long, in ms, the model check waits for an answer: under the daemon's 90 s wait for its worker, so the
 *  worker's "timed out" reaches the daemon first. */
export const CHECK_DEADLINE_MS = 80_000

/** The yian settings the model check runs with: one slow request and one retry, then the deadline decides. */
export const CHECK_LIMITS: Readonly<Record<string, string>> = Object.freeze({
  YIAN_MODEL_FIRST_RESPONSE_TIMEOUT_SECONDS: "60",
  YIAN_MODEL_IDLE_TIMEOUT_SECONDS: "60",
  YIAN_MODEL_RETRIES: "1",
})

/**
 * Runs `flow` with `provider`'s model as an office run would; resolves its result (null when the run threw), and
 * why it failed (null when it didn't), without the key or URL credentials. The run's environment is `env` (by
 * default a worker's, from this process's) with `provider.env` on top, then `limits`. Rejects with `signal`'s reason
 * once it aborts.
 */
export async function runSetup(
  flow: ComposedFlow,
  inputs: Readonly<Record<string, unknown>>,
  provider: Provider,
  {
    tools,
    context,
    env: base,
    signal,
    limits,
  }: {
    tools: NonNullable<RunFlowOptions["tools"]>
    context?: unknown
    env?: WorkerEnv
    signal?: AbortSignal
    limits?: Readonly<Record<string, string>>
  },
): Promise<{ result: RunResult | null; message: string | null }> {
  // The run gets the environment office runs get, so it authenticates the way they will: a shell variable the
  // office never sees can't make it work.
  // The limits go after the provider's env, so it can't lift them.
  const vars: Record<string, string | undefined> = { ...(base ?? workerEnv(process.env)), ...provider.env, ...limits }
  const env = (name: string) => (Object.hasOwn(vars, name) ? vars[name] : undefined)
  // An Azure deployment or a gateway's model is never in yian's list; the owner chose it on purpose.
  const handler = (message: string, type: string | undefined) => {
    if (!/^Model .* is not in the known model list/s.test(message)) process.emitWarning(message, type)
  }
  let result: RunResult | null = null
  let message: string | null = null
  try {
    // No workers: the code nodes, and so the terminal, stay in this process.
    result = await withWarnings(handler, () =>
      runFlow(flow, inputs, { llmConfig: provider.llm_config, tools, numWorkers: 0, context, env, signal }),
    )
    if (result.status === "failed") message = result.failure?.message ?? "the run failed"
  } catch (error) {
    // A stopped run says nothing about the model.
    signal?.throwIfAborted()
    message = error instanceof Error ? error.message : String(error)
  }
  if (message !== null) {
    const key = provider.llm_config?.api_key
    // Every form of the key, as chat runs scrub theirs: yian scrubs the key only as written and escaped, and a
    // provider may quote it in another letter case or base64-encoded.
    if (typeof key === "string" && key) message = redactSecrets(message, [], [key])
    message = redact(message).replace(/\.+$/, "")
  }
  return { result, message }
}

/** Why `provider`'s model doesn't answer a one-word request made as an office run makes it, or null when it
 *  answers; `timed out` once `timeoutMs` passes. The run's environment is as `runSetup`'s, `env` replacing the
 *  default base, with `CHECK_LIMITS` on top. Rejects with `signal`'s reason once it aborts. */
export async function modelProblem(
  provider: Provider,
  { env, signal, timeoutMs = CHECK_DEADLINE_MS }: { env?: WorkerEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const flow = await loadFlow(embedded(checkModelYaml).toString("utf8"), {
    sourceLabel: "install/flows/check_model.yaml",
  })
  // Apart from the caller's signal: running out of time is a problem with the model, a caller's stop is not.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const both = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  try {
    const { message } = await runSetup(flow, {}, provider, { tools: {}, env, signal: both, limits: CHECK_LIMITS })
    // The run may end as failed, rather than throw, once its signal aborts.
    signal?.throwIfAborted()
    if (message !== null && deadline.signal.aborted) return models.TIMED_OUT
    return message
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.signal.aborted) return models.TIMED_OUT
    throw error
  } finally {
    clearTimeout(timer)
  }
}
