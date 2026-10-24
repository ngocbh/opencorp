/** Secret-named fields, which the company snapshot and `GET /api/company` leave out of the people they send. */
import { z } from "zod"

/**
 * Word breaks in a camelCase or PascalCase key: an acronym before a word (`APIKey`), and a capital after a
 * lowercase letter or digit (`accessToken`). Lookarounds only, so a long run of capitals is read in linear time.
 */
const CAMEL = [/(?<=[A-Z])(?=[A-Z][a-z])/g, /(?<=[a-z0-9])(?=[A-Z])/g] as const

/** Keys whose values are secrets, as `isSecretKey` normalizes them. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["devices", "password", "passwd", "password_hash", "token",
  "token_sha256", "secret", "client_secret", "api_key", "apikey", "access_token", "refresh_token", "private_key"])

/** Endings that make a normalized key a secret key too. */
export const SECRET_SUFFIXES = ["_password", "_token", "_secret", "_api_key", "_private_key"] as const

/**
 * `key` as the secret rules read it: camelCase words split by `_`, lowercased, `-`, `.` and spaces as `_`
 * (so `spring.datasource.password` ends in `_password`).
 */
export function keyName(key: string): string {
  for (const pattern of CAMEL) key = key.replace(pattern, "_")
  return key.toLowerCase().replace(/[-. ]/g, "_")
}

/** Whether `key`, read by `keyName` (so `accessToken` is `access_token`), names a secret. */
export function isSecretKey(key: unknown): boolean {
  if (typeof key !== "string") return false
  const norm = keyName(key)
  return SECRET_KEYS.has(norm) || SECRET_SUFFIXES.some((suffix) => norm.endsWith(suffix))
}

/**
 * A copy of `value` with every secret-named field of `schema` (a person's devices and password hash) set to its
 * default. Throws if a secret-named field has no default.
 */
export function blankSecrets<S extends z.ZodObject>(schema: S, value: z.output<S>): z.output<S> {
  const blank: Record<string, unknown> = { ...value }
  for (const [name, field] of Object.entries(schema.shape)) {
    if (!isSecretKey(name)) continue
    // A required field has no default to blank it to; the schema must give secret fields one.
    if (!(field instanceof z.ZodDefault)) throw new Error(`the secret field ${name} has no default`)
    blank[name] = field.parse(undefined)
  }
  return blank as z.output<S>
}
