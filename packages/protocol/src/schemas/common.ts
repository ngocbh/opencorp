import { z } from "zod"

/**
 * A group or asset id: a ULID or a lowercase slug (ids name files, and macOS is case-insensitive). No '_',
 * '/', '.', or '--'.
 */
export const Id = z.string().regex(/^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9](?:-?[a-z0-9])*)$/u).max(64)
export type Id = z.input<typeof Id>

/** A person's unique, permanent name: shown as @handle, and the name of their people/<handle>/ directory. */
export const Handle = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u)
export type Handle = z.input<typeof Handle>

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
export type Ulid = z.input<typeof Ulid>

/** A git commit or blob id. */
export const GitId = z.string().regex(/^[0-9a-f]{40,64}$/u)
export type GitId = z.input<typeof GitId>

/** A device's name within one person, such as 'macbook'. */
export const DeviceName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/u)
export type DeviceName = z.input<typeof DeviceName>

/**
 * The lowercase hex sha256 of a device token. Tokens are long random secrets, so the hash is safe to publish.
 */
export const TokenHash = z.string().regex(/^[0-9a-f]{64}$/u)
export type TokenHash = z.input<typeof TokenHash>

/**
 * A password's salted hash as a PHC string, such as $scrypt$ln=15,r=8,p=1$<salt>$<hash>; never the password
 * itself.
 */
export const PasswordHash = z.string().regex(/^\$[a-z0-9-]+\$/u)
export type PasswordHash = z.input<typeof PasswordHash>

/** A connection's name on its office; `office` is office/provider.json. A removed name is never reused. */
export const ConnectionName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u)
export type ConnectionName = z.input<typeof ConnectionName>

/**
 * UTC, ISO-8601 in milliseconds with a Z suffix. Fixed width, so string order is time order; a plain string,
 * so it round-trips unchanged.
 */
export const Timestamp = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u)
export type Timestamp = z.input<typeof Timestamp>

/** The body of every error response, sent with its HTTP status. */
export const ApiError = z.strictObject({
  /** A short code, such as not_implemented or not_found. */
  error: z.string(),
  message: z.string(),
})
export type ApiError = z.input<typeof ApiError>

export const Ack = z.strictObject({
  ok: z.literal(true),
})
export type Ack = z.input<typeof Ack>
