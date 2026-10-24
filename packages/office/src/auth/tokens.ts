/** Device tokens: long random secrets a device sends as `Authorization: Bearer <token>`.
 *
 *  The company repo lists only each token's sha256, which can't be reversed into the token. */
import { createHash, randomBytes } from "node:crypto"
import type { Roster } from "./roster.ts"

/** What every device token starts with. */
export const PREFIX = "act_"
const TOKEN = /^act_[A-Za-z0-9_-]{43}$/
const BEARER = /^[Bb][Ee][Aa][Rr][Ee][Rr] +(\S+)$/

/** A request the office can't tie to a person; `code` is the 401's error code. */
export class AuthError extends Error {
  override name = "AuthError"

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** A new device token: `act_` and 32 random bytes in unpadded base64url. */
export function newToken(): string {
  return PREFIX + randomBytes(32).toString("base64url")
}

/** The lowercase hex sha256 of `token`: what `person.yaml` lists. */
export function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** The `[handle, device]` whose token the `Authorization` header carries. Throws `AuthError`:
 *  `unauthenticated` with no header; `bad_token` for a malformed header or a token no human lists.
 *  Messages never include the token. */
export function authenticate(
  header: string | null | undefined,
  roster: Roster,
): readonly [handle: string, device: string] {
  if (header == null) throw new AuthError("unauthenticated", "this office needs a device token; run `opencorp login`")
  // JS trim() and Python's strip() differ on a few control characters and U+FEFF; that can't matter,
  // as the token regex is ASCII.
  const match = BEARER.exec(header.trim())
  if (match === null || !TOKEN.test(match[1]!)) {
    throw new AuthError("bad_token", "the Authorization header isn't `Bearer <device token>`")
  }
  const owner = roster.tokens.get(tokenSha256(match[1]!))
  if (owner === undefined) throw new AuthError("bad_token", "the office doesn't know this device; run `opencorp login`")
  return owner
}
