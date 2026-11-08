/** This office's model connections: office/connections/office.json (`office`) and office/connections/<name>.json. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { AuthError, AuthStore } from "@ngocbh/yian/llm_clients"
import { type Connection, OFFICE } from "@opencorp/protocol"
import type { z } from "zod"
import { PrivateFileError, readPrivate, writePrivate } from "../secrets.ts"
import {
  checked,
  checkLlmConfig,
  type LlmConfig,
  loadProvider,
  Provider,
  ProviderError,
  providerSchema,
} from "./provider.ts"

/** Names no added connection may take: `default` and `login` are routes under /connections. */
export const RESERVED: ReadonlySet<string> = new Set([OFFICE, "default", "login"])

/** Valid names of added connections: lower-case letters, digits and inner `-`, at most 32 characters. */
export const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** The variable that points yian at a subscription's own auth store. */
export const AUTH_FILE_ENV = "YIAN_AUTH_FILE"

/** How long `remove` (and a failed `add`'s rollback) waits for yian's lock on a sign-in, in ms; yian's own store
 *  waits as long. */
export const SIGN_IN_LOCK_TIMEOUT_MS = 30_000

/** A connection is no longer on this office. */
export class ConnectionGone extends ProviderError {
  override name = "ConnectionGone"
}

/** A name that can't name a connection: malformed or reserved. */
export class BadConnectionName extends RangeError {
  override name = "BadConnectionName"
}

/** A run's connection is gone, or no longer gives the endpoint, key or config the run had. */
export class RunMoved extends ProviderError {
  override name = "RunMoved"
}

/** A run's connection, `connection`, is there but can't be read or used now, which may pass. */
export class ConnectionUnusable extends RunMoved {
  override name = "ConnectionUnusable"
  readonly connection: string

  constructor(message: string, connection: string) {
    super(message)
    this.connection = connection
  }
}

/** Whether `error` is a plain `AuthError`: fixed text naming what failed and its HTTP status, never a path or a
 *  key. yian's credential store throws a subclass, whose message names the auth file and how to fix it. */
export function plainAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError && Object.getPrototypeOf(error) === AuthError.prototype
}

type Method = "api_key" | "subscription"

/** A connection file: a `Provider` plus how it signs in. */
export class ConnectionFile extends Provider {
  readonly method: Method

  protected constructor(fields: z.output<typeof providerSchema>, method: Method) {
    super(fields)
    this.method = method
  }

  /** `data` checked as a connection file (`method` defaults to `api_key`); throws `ProviderError` with
   *  value-free text. Never uses `this`, so it can be passed unbound. */
  static override parse(data: unknown = {}): ConnectionFile {
    let method: unknown = "api_key"
    let rest = data
    if (typeof data === "object" && data !== null && Object.hasOwn(data, "method")) {
      ;({ method, ...rest } = data as Record<string, unknown>)
    }
    if (method !== "api_key" && method !== "subscription") {
      throw new ProviderError("method: expected api_key or subscription")
    }
    const fields = checked(providerSchema, rest)
    // The office sets it to the connection's own sign-in; one in the file could point at another account's.
    if (Object.hasOwn(fields.env, AUTH_FILE_ENV)) {
      throw new ProviderError(`env: ${AUTH_FILE_ENV} is set by the office, not the connection`)
    }
    // A key would make yian bill it instead of the subscription.
    const llm = fields.llm_config ?? {}
    if (method === "subscription" && (llm.provider !== "openai" || "api_key" in llm)) {
      throw new ProviderError("provider: a subscription connection is provider openai with no api_key")
    }
    return new ConnectionFile(fields, method)
  }

  /** The office connection: `provider`'s fields as `Provider.parse` checked them, with method `api_key` (the
   *  checks only an added connection needs, such as no `YIAN_AUTH_FILE`, don't apply to it). */
  static office(provider: Provider): ConnectionFile {
    const { llm_config, env, prices } = provider
    return new ConnectionFile({ llm_config, env, prices }, "api_key")
  }
}

/** What a run was started on: its connection and model, and a hash of what they gave it; the values
 *  `Store.setRunConfig` keeps in the run's row. */
export type RunRecord = {
  connection: string
  model: string | null
  /** For resume: the `configHash` of the provider the run was started with (its whole config without the key,
   *  plus the key's sha256). */
  configSha256: string
}

export interface ConnectionsOptions {
  /** Where log lines go (default `console.error`). */
  log?: (line: string) => void
  /** How long `remove` (and a failed `add`'s rollback) waits for yian's lock on a sign-in, in ms (default
   *  `SIGN_IN_LOCK_TIMEOUT_MS`). */
  signInLockTimeoutMs?: number
}

function errnoCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** Throws `BadConnectionName` unless `name` may name an added connection. */
function checkName(name: string): void {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new BadConnectionName(`a connection name must match ${NAME.source}`)
  }
  if (RESERVED.has(name)) {
    throw new BadConnectionName(`'${name}' is reserved${name === OFFICE ? " for office/connections/office.json" : ""}`)
  }
}

/** The text of a connection file, in the Python office's layout (key order, two-space indent). */
function connectionText(conn: ConnectionFile): string {
  const { llm_config, env, prices, method } = conn
  return JSON.stringify({ llm_config, env, prices, method }, null, 2)
}

/** The own field `key` of the JSON object in `bytes`; undefined if `bytes` isn't UTF-8 JSON of an object
 *  with that field. */
function jsonField(bytes: Buffer, key: string): unknown {
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return undefined
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || !Object.hasOwn(data, key)) return undefined
  return (data as Record<string, unknown>)[key]
}

/** `readPrivate(file)`, or undefined when there is no file; a `PrivateFileError` as a `ProviderError`. */
async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readPrivate(file)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined
    if (error instanceof PrivateFileError) throw new ProviderError(error.message)
    throw error
  }
}

/**
 * Reads, writes and resolves the office's connections; every file 0600, the directory 0700.
 *
 * Writes through one `Connections` are serialised, so two adds never take the same name and two writes of one
 * file never share `writePrivate`'s temporary file. Only within one instance: two instances could both take the
 * same free name, so the office keeps one `Connections` per office folder, as the Python daemon kept one.
 */
export class Connections {
  readonly office: string
  readonly dir: string
  readonly #log: (line: string) => void
  readonly #signInLockTimeoutMs: number
  #tail: Promise<unknown> = Promise.resolve()

  constructor(office: string, options?: ConnectionsOptions) {
    this.office = office
    this.dir = path.join(office, "connections")
    this.#log = options?.log ?? console.error
    this.#signInLockTimeoutMs = options?.signInLockTimeoutMs ?? SIGN_IN_LOCK_TIMEOUT_MS
  }

  /** `office` first, then the added connections, sorted. */
  async names(): Promise<string[]> {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.dir)
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return [OFFICE]
      throw error
    }
    const removed = await this.#removed()
    const stems = entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length))
    return [OFFICE, ...stems.filter((s) => NAME.test(s) && !RESERVED.has(s) && !removed.has(s)).sort()]
  }

  /** Connection `name`, key included. Rejects with `BadConnectionName` when `name` isn't a connection name,
   *  `ConnectionGone` when there is no such connection or it was removed, and `ProviderError` when its file
   *  can't be used. */
  async get(name: string): Promise<ConnectionFile> {
    if (name === OFFICE) {
      return ConnectionFile.office(await loadProvider(path.join(this.dir, "office.json"), Provider.parse))
    }
    checkName(name)
    if ((await this.#removed()).has(name)) throw new ConnectionGone(`connection '${name}' was removed`)
    return this.#load(name)
  }

  /** Connection `name` as clients see it, without its key. */
  async info(name: string): Promise<Connection> {
    return this.#info(name, await this.get(name), await this.default())
  }

  /** Every connection as clients see it, and the default; one that can't be read is left out. */
  async infos(): Promise<[Connection[], string]> {
    const names = await this.names()
    const defaultName = await this.#default(names)
    const found: Connection[] = []
    for (const name of names) {
      // names() has left out the removed ones
      try {
        found.push(this.#info(name, name === OFFICE ? await this.get(OFFICE) : await this.#load(name), defaultName))
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        this.#log(`connection ${name} can't be read; leaving it out of the list`)
      }
    }
    return [found, defaultName]
  }

  /** The connection new chats start on: the one `_default.json` names, or `office` if it is gone. Rejects
   *  with `ProviderError` when `_default.json` isn't a private regular file, or isn't a default. */
  async default(): Promise<string> {
    return this.#default(await this.names())
  }

  /** The connection and model a chat on `connection` and `model` runs on, and whether it moved. A chat whose
   *  connection was removed moves to the default, on the default's own model. */
  async choice(connection: string | null, model: string | null): Promise<[string, string | null, boolean]> {
    const name = connection || OFFICE
    if ((await this.names()).includes(name)) return [name, model, false]
    return [await this.default(), null, true]
  }

  /** Makes `name` the default; rejects with `ConnectionGone` if there is no such connection, and `ProviderError` when
   *  office/connections isn't a private directory of this user. */
  async setDefault(name: string): Promise<void> {
    if (name !== OFFICE) checkName(name)
    return this.#queued(async () => {
      if (!(await this.names()).includes(name)) {
        throw new ConnectionGone(`there is no connection '${name}' on this office`)
      }
      this.ensureDir()
      await writePrivate(path.join(this.dir, "_default.json"), JSON.stringify({ name }))
    })
  }

  /** office/connections, made 0700 (yian's auth store refuses a directory others can open). Throws `ProviderError`
   *  when it is a symlink, not a directory, another user's or unreadable, before any mode change. */
  ensureDir(): string {
    try {
      fs.mkdirSync(this.dir, { mode: 0o700 })
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error
    }
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants
    let fd: number
    try {
      // Through the fd: a chmod by path would follow a symlink planted there and change its target's mode.
      fd = fs.openSync(this.dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    } catch (error) {
      const code = errnoCode(error)
      // A symlink or a file gives ENOTDIR (O_DIRECTORY is checked first), else ELOOP; FreeBSD says EMLINK.
      if (code === "ENOTDIR" || code === "ELOOP" || code === "EMLINK") {
        throw new ProviderError(`${this.dir} must be a directory of its own, not a file or a symlink`)
      }
      // A folder this process can't read, its own or another user's: refused with a fix, not repaired through a path.
      if (code === "EACCES") throw new ProviderError(`can't open ${this.dir}; it must be this user's folder, mode 0700`)
      throw error
    }
    try {
      if (fs.fstatSync(fd).uid !== process.geteuid!()) throw new ProviderError(`${this.dir} belongs to another user`)
      fs.fchmodSync(fd, 0o700) // the umask may have narrowed it, or it was made by hand
    } finally {
      fs.closeSync(fd)
    }
    return this.dir
  }

  /** Writes connection `name`; a removed name is refused. */
  async put(name: string, conn: ConnectionFile): Promise<void> {
    checkName(name)
    return this.#queued(() => this.#put(name, conn))
  }

  /**
   * Adds `conn` under the first free name of `base`, `base-2`, …, and returns that name.
   *
   * `signIn`, when given, saves the connection's sign-in to the path it is passed before the connection file is
   * written; if either fails, the sign-in is removed again. It runs in the queue of writes, so it must be quick:
   * a save of a sign-in already made, not a device login. `signIn` must not call `put`, `add`, `remove` or
   * `setDefault` on this `Connections`: the queue isn't re-entrant, so the call would wait forever.
   *
   * Rejects with `RangeError` when `base` can't make a free connection name, `ProviderError` when `_removed.json`
   * can't be read or office/connections isn't a private directory of this user, and otherwise with the error that
   * stopped `signIn` or the write.
   */
  async add(
    base: string,
    conn: ConnectionFile,
    options?: { signIn?: (auth: string) => void | Promise<void> },
  ): Promise<string> {
    const signIn = options?.signIn
    return this.#queued(async () => {
      const name = await this.#freeName(base)
      this.ensureDir()
      const auth = this.authFile(name)
      try {
        if (signIn) await signIn(auth)
        await this.#put(name, conn)
      } catch (error) {
        if (signIn) {
          try {
            await this.#removeSignIn(name)
          } catch {
            // the error that stopped the add is the one to throw
            this.#log(`couldn't remove the sign-in of connection ${name} after its add failed`)
          }
        }
        throw error
      }
      return name
    })
  }

  /**
   * Removes connection `name` and its sign-in. Rejects with `RangeError` for `office`, `ConnectionGone` when
   * neither exists, and `ProviderError` when office/connections isn't a private directory of this user or the
   * sign-in can't be removed, such as when yian holds its lock for longer than `signInLockTimeoutMs`.
   *
   * A running reply keeps the key it has, but one on a subscription may fail once it next reads or refreshes the
   * sign-in, which is gone.
   */
  async remove(name: string): Promise<void> {
    if (name === OFFICE) {
      throw new RangeError(
        "office is office/connections/office.json; `opencorp onboard` changes it, and it can't be removed",
      )
    }
    const file = this.#path(name)
    const auth = this.authFile(name)
    return this.#queued(async () => {
      // By its files, not names(): a retry after a remove cut short must still clean up a retired name.
      if (!lexists(file) && !lexists(auth)) throw new ConnectionGone(`there is no connection '${name}' on this office`)
      // The name is retired before its files go: a connection re-added under it would move that name's chats and
      // runs to a new account without a word, and a remove cut short still reads as removed.
      const removed = await this.#removed()
      if (!removed.has(name)) {
        this.ensureDir()
        await writePrivate(path.join(this.dir, "_removed.json"), JSON.stringify({ names: [...removed, name].sort() }))
      }
      try {
        fs.unlinkSync(file)
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error
      }
      await this.#removeSignIn(name)
    })
  }

  /** Where subscription `name` keeps its sign-in (yian's own auth store). */
  authFile(name: string): string {
    checkName(name)
    return path.join(this.dir, `${name}.auth.json`)
  }

  /** What a run on connection `name` (null: `office`) and `model` (null: the connection's own) gets. Rejects
   *  with `BadConnectionName` when `name` isn't a connection name, `ConnectionGone` when there is no such
   *  connection or it was removed, and `ProviderError` when its file can't be used, its `llm_config` isn't one yian
   *  takes (`checkLlmConfig`), or a subscription has no sign-in. */
  async resolve(name: string | null, model: string | null): Promise<Provider> {
    name = name ?? OFFICE
    const conn = await this.get(name)
    let llm = conn.llm_config
    if (model) llm = { ...(llm ?? {}), model } // for Azure, the deployment name
    const env: Record<string, string> = { ...conn.env }
    if (conn.method === "subscription") {
      const auth = this.authFile(name)
      if (!isFile(auth)) {
        // Without its store, yian would fall back to no credentials at all.
        throw new ProviderError(`connection '${name}' has no sign-in; remove it and connect again`)
      }
      env[AUTH_FILE_ENV] = auth
    }
    try {
      // A run on a config yian won't take fails only once its worker starts it.
      checkLlmConfig(llm ?? {})
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(`connection '${name}': ${error.message}`)
      throw error
    }
    return Provider.parse({ llm_config: llm, env, prices: conn.prices })
  }

  /** The provider to resume run `runId` on, which was started with `record`. Rejects with `RunMoved` when the
   *  run's connection is gone, can't be used (`ConnectionUnusable`), or no longer gives what the run had; the
   *  message says why. I/O errors and yian's `FileLockError` from reading the files propagate, as Python's
   *  `OSError` did. */
  async forRun(record: RunRecord, runId: string): Promise<Provider> {
    const name = record.connection
    if (name !== OFFICE && (!NAME.test(name) || RESERVED.has(name))) {
      throw new RunMoved(`run ${runId}'s record names no connection`)
    }
    const provider = await this.#forRun(name, record.model)
    if (configHash(provider) !== record.configSha256) {
      throw new RunMoved(`connection '${name}' changed since run ${runId}`)
    }
    return provider
  }

  /** Runs `body` after every queued body before it, failed or not. */
  #queued<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => body())
    this.#tail = run.catch(() => undefined)
    return run
  }

  /** `resolve(name, model)`, with each reason it can't be used as a `RunMoved`, without a cause. */
  async #forRun(name: string, model: string | null): Promise<Provider> {
    try {
      return await this.resolve(name, model)
    } catch (error) {
      if (error instanceof ConnectionGone) throw new RunMoved(`connection '${name}' was removed`)
      // A ProviderError's message is value-free, so it is the only part of the error carried over.
      if (error instanceof ProviderError) throw new ConnectionUnusable(error.message, name)
      throw error
    }
  }

  async #put(name: string, conn: ConnectionFile): Promise<void> {
    if ((await this.#removed()).has(name)) {
      throw new RangeError(`connection name '${name}' was removed and is never used again`)
    }
    this.ensureDir()
    await writePrivate(this.#path(name), connectionText(conn))
  }

  /** `base`, or `base-2`, `base-3`, …: the first that no file, reservation or removal holds. */
  async #freeName(base: string): Promise<string> {
    const removed = await this.#removed()
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`
      // also ends the loop once the suffix makes the name too long
      if (!NAME.test(name)) throw new RangeError(`a connection name must match ${NAME.source}`)
      if (RESERVED.has(name) || removed.has(name)) continue
      if (!lexists(this.#path(name)) && !lexists(this.authFile(name))) return name
    }
  }

  /** Deletes the sign-in of connection `name` through yian's own store, under the lock yian refreshes it under;
   *  the lock file stays. */
  async #removeSignIn(name: string): Promise<void> {
    try {
      await new AuthStore(this.authFile(name), { lockTimeoutMs: this.#signInLockTimeoutMs }).delete()
    } catch (error) {
      if (plainAuthError(error)) {
        throw new ProviderError(`can't remove the sign-in of connection '${name}': ${error.message}`)
      }
      if (!(error instanceof AuthError)) throw error
      // The store's own error names the auth file: the log says which connection, the person gets no path.
      this.#log(`couldn't remove the sign-in of connection ${name} (${error.constructor.name})`)
      throw new ProviderError(`can't remove the sign-in of connection '${name}': its sign-in file can't be used`)
    }
  }

  /** The file of added connection `name`, removed or not; `ConnectionGone` if there is none. */
  async #load(name: string): Promise<ConnectionFile> {
    try {
      // Not an exists-then-read: a remove between the two would read as an empty connection.
      return await loadProvider(this.#path(name), ConnectionFile.parse, { missingOk: false })
    } catch (error) {
      if (errnoCode(error) === "ENOENT") throw new ConnectionGone(`there is no connection '${name}' on this office`)
      throw error
    }
  }

  #info(name: string, conn: ConnectionFile, defaultName: string): Connection {
    const llm = conn.llm_config ?? {}
    const model = llm.model ?? null
    if (model !== null && typeof model !== "string") {
      throw new ProviderError(`connection '${name}' names a model that isn't text`)
    }
    if (llm.provider != null && typeof llm.provider !== "string") {
      throw new ProviderError(`connection '${name}' names a provider that isn't text`)
    }
    // Without a key, office runs on yian's own login.
    const method = name === OFFICE ? ("api_key" in llm ? "api_key" : "none") : conn.method
    const provider = conn.method === "subscription" ? "chatgpt" : providerLabel(llm)
    return { name, provider, method, model, default: name === defaultName }
  }

  async #default(names: string[]): Promise<string> {
    const file = path.join(this.dir, "_default.json")
    const bytes = await readOptional(file)
    if (bytes === undefined) return OFFICE
    const name = jsonField(bytes, "name")
    if (typeof name !== "string") throw new ProviderError(`${file} isn't a default connection`)
    return names.includes(name) ? name : OFFICE
  }

  #path(name: string): string {
    checkName(name)
    return path.join(this.dir, `${name}.json`)
  }

  /** The names of removed connections, which are never used again. */
  async #removed(): Promise<Set<string>> {
    const file = path.join(this.dir, "_removed.json")
    const bytes = await readOptional(file)
    if (bytes === undefined) return new Set()
    const names = jsonField(bytes, "names")
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
      // Reading a garbled list as empty would let a removed name come back.
      throw new ProviderError(`${file} can't be read`)
    }
    return new Set(names)
  }
}

/** Whether anything, even a dangling symlink, is at `file`. */
function lexists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false
    throw error
  }
}

/** Whether `file` is a regular file, following symlinks. */
export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The sha256 hex of `provider`'s key, as yian identifies keys; null without one. */
export function keyId(provider: Provider): string | null {
  const key = provider.llm_config?.api_key
  return typeof key === "string" ? createHash("sha256").update(key, "utf8").digest("hex") : null
}

/** `value` as compact JSON with every object's keys sorted, so equal values always give the same text. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>
    return `{${Object.keys(fields)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(fields[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/** A hash of everything a run gets from `provider`: its config without the key, env, and the key's hash. */
export function configHash(provider: Provider): string {
  let llm = provider.llm_config
  if (llm !== null) {
    const { api_key: _, ...rest } = llm
    llm = rest
  }
  const text = sortedJson({ llm_config: llm, env: provider.env, key: keyId(provider) })
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The values a run started on `connection` and `model`, which give it `provider`, keeps: no key, only its hash
 *  inside `configSha256`. */
export function runRecord(connection: string, model: string | null, provider: Provider): RunRecord {
  return { connection, model, configSha256: configHash(provider) }
}

/** The host name of `llm`'s `base_url`, or "" when it has none or it isn't a URL. */
function baseUrlHost(llm: LlmConfig | null): string {
  if (!llm?.base_url) return ""
  return URL.parse(String(llm.base_url))?.hostname ?? ""
}

/** The host name ending of Azure OpenAI resources in the commercial cloud. */
const COMMERCIAL_AZURE = ".azure.com"

/** The host name endings of Azure OpenAI resources: the commercial, Government and China clouds. */
const AZURE_HOSTS = [COMMERCIAL_AZURE, ".azure.us", ".azure.cn"]

/** Whether `llm`'s `base_url` is an Azure OpenAI resource in the commercial cloud. */
export function commercialAzure(llm: LlmConfig | null): boolean {
  return baseUrlHost(llm).endsWith(COMMERCIAL_AZURE)
}

/** A short name for the provider of `llm`: `azure` (an Azure OpenAI resource in the commercial, Government or
 *  China cloud), `custom` (another OpenAI-compatible endpoint), the provider's own name, or `composer`, the label
 *  for yian's default provider. */
export function providerLabel(llm: LlmConfig | null): string {
  const provider = llm?.provider
  if (!provider) return "composer"
  if (provider === "openai" && llm.base_url) {
    const host = baseUrlHost(llm)
    return AZURE_HOSTS.some((ending) => host.endsWith(ending)) ? "azure" : "custom"
  }
  return String(provider)
}

/** The v1 endpoint of an Azure OpenAI resource given by its name or its endpoint URL. */
export function azureBaseUrl(answer: string): string {
  let url = answer.trim().replace(/\/+$/, "")
  if (url.endsWith("/openai/v1")) url = url.slice(0, -"/openai/v1".length)
  if (!url.includes("://")) url = url.includes(".") ? `https://${url}` : `https://${url}.openai.azure.com`
  return `${url}/openai/v1/`
}
