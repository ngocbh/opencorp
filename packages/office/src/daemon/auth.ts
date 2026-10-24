/** Who sent each request: device tokens, and `actingPerson` for routes. */
import { Roster, loadRoster } from "../auth/roster.ts"
import { AuthError, authenticate } from "../auth/tokens.ts"
import { HttpError, type RequestInfo } from "./http.ts"
import type { Office, RequestContext } from "./office.ts"

/** Requests served without a token even once tokens are enforced: the "is the office up" probe of `opencorp`,
 *  `opencorp start`, `opencorp doctor` and onboarding, and logging in with a password. Matched against the method
 *  and the raw path before routing, so an encoded spelling of one of these paths needs a token. */
export const OPEN: ReadonlySet<string> = new Set(["GET /health", "HEAD /health", "POST /login"])

/** The handle the request acts as: its token's person, or the CEO while no human has a device. Throws
 *  `HttpError` 401 when there is none. */
export function actingPerson(ctx: RequestContext): string {
  if (ctx.person === null) throw new HttpError(401, "unauthenticated", "this request has no person to act as")
  return ctx.person
}

/**
 * Ties each request to a person by its `Authorization: Bearer` token.
 *
 * While no human in the company (at HEAD) lists a device, a request without a token acts as the CEO; after that
 * every request but those in `OPEN` needs one. A token sent is always checked. The person and device go in the
 * request's context.
 */
export class DeviceTokens {
  #roster: Roster | undefined

  constructor(readonly office: Office) {}

  /** The roster at HEAD, reloaded only when HEAD moves. */
  async roster(): Promise<Roster> {
    const git = this.office.git
    let head: string
    try {
      head = await git.readHead()
    } catch (error) {
      if (error instanceof RangeError) return new Roster("", null) // no commit yet
      throw error
    }
    if (this.#roster?.head !== head) this.#roster = await loadRoster(git, head)
    return this.#roster
  }

  /** The request's context: its person and device, or the CEO for a tokenless request while tokens aren't
   *  enforced. Throws `HttpError` 401 for a refused request. */
  readonly context = async (info: RequestInfo): Promise<RequestContext> => {
    const base = { office: this.office, signal: info.signal, query: info.query }
    if (OPEN.has(`${info.method} ${info.path}`)) return { ...base, person: null, device: null }
    const roster = await this.roster()
    try {
      const [person, device] = authenticate(info.headers.authorization, roster)
      return { ...base, person, device }
    } catch (error) {
      if (!(error instanceof AuthError)) throw error
      if (error.code !== "unauthenticated" || roster.enforced) throw new HttpError(401, error.code, error.message)
      return { ...base, person: roster.ceo, device: null }
    }
  }
}
