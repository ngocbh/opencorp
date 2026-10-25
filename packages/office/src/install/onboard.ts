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
import {
  type AuthRequest,
  type Issue,
  LLM_CONFIG_KEYS,
  LLMConfig,
  SUPPORTED_LLM_PROVIDERS,
  ValidationError,
} from "@ngocbh/yian/llm_clients"
import { FileLockError, withWarnings } from "@ngocbh/yian/platform"
import type { RunFlowOptions, RunResult } from "@ngocbh/yian/run"
import { addDevice, DeviceRefused } from "../auth/devices.ts"
import { deviceName, Identity, identityPath, readIdentity, writeIdentity } from "../auth/identity.ts"
import { checkPassword } from "../auth/passwords.ts"
import { newToken, tokenSha256 } from "../auth/tokens.ts"
import { azureBaseUrl, Connections } from "../chat/connections.ts"
import * as models from "../chat/models.ts"
import { loadProvider, Provider, ProviderError } from "../chat/provider.ts"
import { CompanyGit, CompanyGitError } from "../company/git.ts"
import { lint } from "../company/lint.ts"
import { loadRepo } from "../company/loader.ts"
import { isNew, missingFiles, type Owner, writeCompany } from "../company_template/index.ts"
import { makeOfficeDir, OfficeStartError } from "../daemon/sockets.ts"
import { repr } from "../perm/redact.ts"
import { embedded } from "../platform.ts"
import { strerror } from "../sandbox/fs_helper.ts"
import { PrivateFileError, writePrivate } from "../secrets.ts"
import type { WorkerEnv } from "../worker/main.ts"
import { workerEnv } from "../worker/spawn.ts"
import checkModelYaml from "./flows/check_model.yaml" with { type: "file" }
import { type Completed, defaultHost, type Env, type Host, launch, runCommand, ServiceError } from "./launch.ts"
import { NoTerminal, OnboardError, type Prompter, TRIES } from "./prompts.ts"
import * as service from "./service.ts"

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
  const problem = options.checkModel === undefined ? null : await options.checkModel(provider)
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

/** Makes the home and office dirs, both 0700. Throws `OnboardError` when they can't be made, or the office dir
 *  isn't this user's. */
export function makeHome(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    // mkdir leaves an existing home's mode alone; the home holds the company and the office.
    fs.chmodSync(home, 0o700)
    makeOfficeDir(path.join(home, "office"))
  } catch (error) {
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
  if (await isNew(dest)) {
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
  if (known !== undefined) {
    const sha = tokenSha256(known.token)
    if (people.get(known.handle)?.devices.some((d) => d.token_sha256 === sha)) return known
  }
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
 * Throws `OnboardError` when a step failed, or there's no company here and no repo to clone; earlier steps stay
 * done.
 */
export async function onboard(home: string, prompter: Prompter, options: OnboardOptions): Promise<void> {
  const host = options.host ?? defaultHost()
  const environ = options.environ ?? process.env
  const one = launch(home, { environ, userHome: host.userHome })
  const company = path.join(one.home, "company")
  const worktrees = path.join(one.office, "worktrees")
  makeHome(one.home)
  prompter.say(`Office home: ${one.home}`)

  const step = (number: number, title: string, why: string) => {
    if (options.steps ?? true) prompter.step(number, STEPS, title, why)
  }

  step(1, "Company", "This office works for one company, whose people and flows live in its git repo.")
  // A running office is the only writer of its company clone (CompanyGit's lock is in-process), so the template
  // top-up waits until it is stopped.
  const running = await host.answers(one.socket)
  const fresh = await isNew(company)
  let root = company
  if (fresh) {
    if (running) {
      throw new OnboardError(
        `the office is running, but ${company} has no company yet; stop it and run \`opencorp onboard\` again`,
      )
    }
    if (fs.statSync(company, { throwIfNoEntry: false })?.isDirectory() && fs.readdirSync(company).length > 0) {
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
    if (missing.length > 0) {
      prompter.say(`Company repo: ${company}. ${stopToTopUp(missing.length)}`)
    } else if (written.length > 0 || !fresh) {
      const done = written.length > 0 ? `added ${written.length} template files to` : "up to date at"
      prompter.say(`Company repo: ${done} ${company}`)
    }
    const errors = (await lint(loadRepo(root))).filter((issue) => issue.severity === "error")
    if (errors.length > 0) {
      throw new OnboardError(
        "the company repo has errors; fix them and run `opencorp onboard` again:\n" +
          errors.map((issue) => `  ${issue.path}: ${issue.code}: ${issue.message}`).join("\n"),
      )
    }

    step(2, "This device", "The office takes requests only from devices its humans list, once any human lists one.")
    me = fresh
      ? await join(root, worktrees, one.home, prompter, options.loginDefaults ?? loginDefaults)
      : ((await knownIdentity(one.home)) ?? null)
    if (fresh) {
      // An empty dir: rename can't put a directory over a full one.
      if (fs.statSync(company, { throwIfNoEntry: false })?.isDirectory()) fs.rmdirSync(company)
      fs.renameSync(root, company)
    }
  } catch (error) {
    if (fresh) removePath(root)
    throw error
  }
  if (me) {
    prompter.say(`This device: ${me.device}, acting as @${me.handle} (its token is in ${identityPath(one.home)})`)
  } else {
    prompter.say("This device has no identity yet; run `opencorp login` to use opencorp from it.")
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
    await service.wait(one, host)
  } catch (error) {
    if (error instanceof ServiceError || error instanceof OfficeStartError) throw new OnboardError(error.message)
    throw error
  }
  prompter.say(`Office: running under ${installed.mode ?? "a process started by hand"}; log at ${one.log}`)
  prompter.say("Done. Run `opencorp` in a project folder to talk to your team.")
}

/**
 * Runs `flow` with `provider`'s model as an office run would; resolves its result (null when the run threw), and
 * why it failed (null when it didn't), without the key or URL credentials. The run's environment is `env` (by
 * default a worker's, from this process's) with `provider.env` on top.
 */
export async function runSetup(
  flow: ComposedFlow,
  inputs: Readonly<Record<string, unknown>>,
  provider: Provider,
  {
    tools,
    context,
    env: base,
  }: {
    tools: NonNullable<RunFlowOptions["tools"]>
    context?: unknown
    env?: WorkerEnv
  },
): Promise<{ result: RunResult | null; message: string | null }> {
  // The run gets the environment office runs get, so it authenticates the way they will: a shell variable the
  // office never sees can't make it work.
  const vars: Record<string, string | undefined> = { ...(base ?? workerEnv(process.env)), ...provider.env }
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
      runFlow(flow, inputs, { llmConfig: provider.llm_config, tools, numWorkers: 0, context, env }),
    )
    if (result.status === "failed") message = result.failure?.message ?? "the run failed"
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (message !== null) {
    const key = provider.llm_config?.api_key
    if (typeof key === "string" && key) message = message.replaceAll(key, "***")
    message = redact(message).replace(/\.+$/, "")
  }
  return { result, message }
}

/** Why `provider`'s model doesn't answer a one-word request made as an office run makes it, or null when it
 *  answers; the run's environment is as `runSetup`'s, `env` replacing the default base. */
export async function modelProblem(
  provider: Provider,
  { env }: { env?: WorkerEnv } = {},
): Promise<string | null> {
  const flow = await loadFlow(embedded(checkModelYaml).toString("utf8"), {
    sourceLabel: "install/flows/check_model.yaml",
  })
  return (await runSetup(flow, {}, provider, { tools: {}, env })).message
}
