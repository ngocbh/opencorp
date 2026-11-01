/** The model provider a run uses: a connection file's llm_config, env and prices, read at each spawn. */
import { inspect } from "node:util"
import {
  type Issue,
  LLM_CONFIG_KEYS,
  LLMConfig,
  SUPPORTED_LLM_PROVIDERS,
  ValidationError,
} from "@ngocbh/yian/llm_clients"
import { z } from "zod"
import { unsafeEnvName } from "../platform.ts"
import { PrivateFileError, readPrivate } from "../secrets.ts"

const CREDENTIAL_NAME = /(_KEY|_APIKEY|_TOKEN|_SECRET|_PASS|_CREDENTIALS)$|PASSWORD/
const VARIABLE = /^[A-Z_][A-Z0-9_]{0,63}$/
const USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@]*@/ // scheme://user[:pass]@host
// Python's str.strip() also strips \x1c-\x1f and \x85, which JS's \s leaves.
const LEADING_SPACE = /^[\s\x1c-\x1f\x85]+/

/** The provider file can't be used; the message says why. */
export class ProviderError extends Error {
  override name = "ProviderError"
}

const priceSchema = z.strictObject({ input: z.number().min(0), output: z.number().min(0) })

/** USD per million tokens. */
export type Price = z.output<typeof priceSchema>

/** Yian's `llm_config`. */
export type LlmConfig = Record<string, unknown>

/** The fields of a provider file, with their defaults. */
export const providerSchema = z.strictObject({
  llm_config: z.record(z.string(), z.unknown()).nullable().default(null),
  env: z
    .record(z.string(), z.string())
    .superRefine((env, ctx) => {
      const problem = envProblem(env)
      if (problem) ctx.addIssue({ code: "custom", message: problem })
    })
    .default(() => ({})),
  prices: z.record(z.string(), priceSchema).default(() => ({})),
})

/** Why `env` can't be a worker's env, or undefined: the first name a spawn can't pass as given, credential-like
 *  or runtime name, else the first value holding a NUL or URL with credentials in it. */
function envProblem(env: Record<string, string>): string | undefined {
  for (const name of Object.keys(env)) {
    // A spawn joins name and value as `name=value`, so a name holding `=` would set another variable.
    if (name === "" || name.includes("=") || name.includes("\0")) return "an env name isn't a variable name"
    if (CREDENTIAL_NAME.test(name.toUpperCase()))
      return `${shown(name)} looks like a credential; put the model key in llm_config.api_key`
    if (unsafeEnvName(name))
      return `${shown(name)} changes how the worker's runtime or loader starts; it can't be set in env`
  }
  for (const [name, value] of Object.entries(env)) {
    // A spawn refuses a NUL with an error that echoes the value.
    if (value.includes("\0")) return `${shown(name)} holds a NUL character`
    if (USERINFO.test(value.replace(LEADING_SPACE, "")))
      return (
        `${shown(name)} is a URL with credentials in it; keep credentials out of env ` +
        "(the model key goes in llm_config.api_key)"
      )
  }
  return undefined
}

/**
 * What every run gets: yian's `llm_config`, the worker's `Job.env`, and model prices.
 *
 * The model key goes in `llm_config.api_key`: it travels only in a worker's start frame and lives only in the
 * worker's memory (yian keeps credential keys out of the run log and manifest). `env` is for settings that
 * aren't secret (`VLLM_BASE_URL`, proxy and CA settings); it becomes the worker's env, which other processes of
 * the same user can read, so a credential-like name, a URL with credentials, a name that changes how the
 * runtime or loader starts, and a name or value a spawn can't pass as given are refused. `llm_config` null means
 * yian's defaults (and its own auth store). `toJSON` and `inspect` leave `llm_config` out.
 */
export class Provider {
  readonly llm_config: LlmConfig | null
  readonly env: Readonly<Record<string, string>>
  readonly prices: Readonly<Record<string, Price>>

  protected constructor(fields: z.output<typeof providerSchema>) {
    this.llm_config = fields.llm_config
    this.env = fields.env
    this.prices = fields.prices
  }

  /** `data` checked as a provider; throws `ProviderError` with value-free text. Never uses `this`, so it can be
   *  passed unbound. */
  static parse(data: unknown = {}): Provider {
    return new Provider(checked(providerSchema, data))
  }

  /** Every own field but `llm_config`, which holds the model key. */
  toJSON(): object {
    const { llm_config: _, ...fields } = this
    return fields
  }

  /** The class name and `toJSON()`, never `llm_config`. */
  [inspect.custom](): string {
    return `${this.constructor.name} ${inspect(this.toJSON())}`
  }
}

/** Throws `ProviderError` unless yian takes `llm` as an `llm_config` (`LLMConfig.fromHost`) and a key in it names
 *  its provider; the message never holds a value from `llm`. */
export function checkLlmConfig(llm: LlmConfig): void {
  try {
    LLMConfig.fromHost(llm)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ProviderError(`yian won't take this provider: ${llmErrors(error.issues)}`)
    }
    // Yian's TypeCheckError (a lone surrogate JSON.parse let through) quotes the value.
    if (error instanceof RangeError) {
      throw new ProviderError("yian won't take this provider: llm_config holds a value that isn't JSON text or a number")
    }
    throw error
  }
  if (Object.hasOwn(llm, "api_key") && !llm.provider) {
    // Yian refuses a key without a provider at run time; say so now.
    throw new ProviderError("llm_config.api_key needs llm_config.provider, so the key goes only to that provider")
  }
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

/** `data` checked against `schema`; throws `ProviderError(validationErrors(error))`, with no cause. */
export function checked<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) throw new ProviderError(validationErrors(result.error))
  return result.data
}

/** An env name as errors show it: an upper-case variable name, or a placeholder. */
function shown(name: string): string {
  return VARIABLE.test(name) ? name : "an env name"
}

/** The issues as `loc: phrase` joined by "; ", naming only provider fields and env variable names. */
export function validationErrors(error: z.ZodError): string {
  // Never zod's messages or inputs: the file holds keys, and a key pasted as an extra field, a model name or an
  // env name would be echoed.
  const lines: string[] = []
  for (const issue of error.issues) {
    const loc = issue.path.map(String)
    if (loc.length > 1 && loc[0] === "env") loc[1] = shown(loc[1]!)
    if (loc.length > 1 && loc[0] === "prices") loc[1] = "a model"
    const phrase =
      issue.code === "unrecognized_keys"
        ? "is not allowed"
        : issue.code === "custom"
          ? issue.message
          : issue.code === "invalid_type"
            ? `expected ${issue.expected}`
            : issue.code === "too_small"
              ? `must be at least ${issue.minimum}`
              : "is not valid"
    const locs = issue.code === "unrecognized_keys" ? issue.keys.map(() => [...loc, "an extra field"]) : [loc]
    for (const l of locs) lines.push(`${l.join(".") || "provider"}: ${phrase}`)
  }
  return lines.join("; ")
}

/**
 * The provider in `file`, checked by `parse` (passed unbound); `parse({})` when there is no file and `missingOk`
 * (default true). The file holds the model key, so it must be a regular file private to its owner, read through
 * `readPrivate`.
 *
 * Rejects with the `ENOENT` error when there is no file and not `missingOk`, `ProviderError` when the file is a
 * symlink, readable by others, not JSON, or not a valid provider, and yian's `FileLockError` when the folder's
 * lock can't be taken.
 */
export async function loadProvider<P extends Provider>(
  file: string,
  parse: (data: unknown) => P,
  { missingOk = true }: { missingOk?: boolean } = {},
): Promise<P> {
  let bytes: Buffer
  try {
    bytes = await readPrivate(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT" && missingOk) return parse({})
    if (error instanceof PrivateFileError) throw new ProviderError(error.message)
    throw error
  }
  let data: unknown
  try {
    // Invalid UTF-8 or a leading BOM is "not valid JSON", never silently repaired (stricter than Python).
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    // JSON.parse's message quotes the bad input, which may be a key.
    throw new ProviderError(`${file}: not valid JSON`)
  }
  try {
    return parse(data)
  } catch (error) {
    if (error instanceof ProviderError) throw new ProviderError(`${file}: ${error.message}`)
    throw error
  }
}
