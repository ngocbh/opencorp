/** Who sent each request: device tokens, and `actingPerson` for routes. */
import { Roster, loadRoster } from "../auth/roster.ts"
import { AuthError, authenticate, bearerToken, tokenSha256 } from "../auth/tokens.ts"
import { HttpError, type RequestInfo, errorType } from "./http.ts"
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

/** An open socket stream: who its request acted as, the sha256 of the token it sent (none for a tokenless one), and
 *  how to end it. */
interface Tracked {
  person: string | null
  device: string | null
  sha: string | undefined
  end: () => void
}

/** Whether `stream` still acts as the same person and device at `roster`: its token still maps to them, or, without a
 *  token, tokens aren't enforced and the CEO is still the one it acts as. */
function counts(stream: Tracked, roster: Roster): boolean {
  if (stream.sha === undefined) return !roster.enforced && roster.ceo === stream.person
  const owner = roster.tokens.get(stream.sha)
  return owner !== undefined && owner[0] === stream.person && owner[1] === stream.device
}

/**
 * Ties each request to a person by its `Authorization: Bearer` token, and ends open streams once theirs stops
 * counting.
 *
 * While no human in the company (at HEAD) lists a device, a request without a token acts as the CEO; after that
 * every request but those in `OPEN` needs one. A token sent is always checked. The person, device and token sha256 go
 * in the request's context.
 *
 * A stream is checked once, when it opens, so the socket's streams are tracked: each roster change (`changed`,
 * `recheck`) ends those whose token no longer maps to the same person and device, and the tokenless ones once tokens
 * are enforced or the CEO changes. Only token sha256s are kept.
 */
export class DeviceTokens {
  #roster: Roster | undefined
  readonly #streams = new Set<Tracked>()
  #checking: Promise<void> | null = null
  #again = false

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
    const header = info.headers.authorization
    try {
      const [person, device] = authenticate(header, roster)
      // authenticate found the token, so the header carries one.
      return { ...base, person, device, tokenSha256: tokenSha256(bearerToken(header!)!) }
    } catch (error) {
      if (!(error instanceof AuthError)) throw error
      if (error.code !== "unauthenticated" || roster.enforced) throw new HttpError(401, error.code, error.message)
      return { ...base, person: roster.ceo, device: null }
    }
  }

  /** Tracks an open stream of the request `ctx`, so a roster change that takes its token away calls `end`; returns
   *  the untrack to call once the stream ends. */
  track(ctx: RequestContext, end: () => void): () => void {
    const stream: Tracked = { person: ctx.person, device: ctx.device, sha: ctx.tokenSha256, end }
    this.#streams.add(stream)
    // A change committed between the request's check and now would otherwise go unseen until the next one.
    void this.recheck()
    return () => this.#streams.delete(stream)
  }

  /** The company may have changed: rechecks the open streams in the background. */
  changed(): void {
    void this.recheck()
  }

  /** Ends the open streams that don't count at HEAD; never rejects. A call while one runs makes it run once more,
   *  so a change it started too early to see still counts; one runs at a time. */
  recheck(): Promise<void> {
    if (this.#checking !== null) {
      this.#again = true
      return this.#checking
    }
    // Nothing to end. Returning here also means the loop below always awaits before it can finish: one that
    // finished without awaiting would clear `#checking` before it was set, leaving a settled promise for every later
    // call to join.
    if (this.#streams.size === 0) return Promise.resolve()
    this.#checking = (async () => {
      try {
        do {
          this.#again = false
          if (this.#streams.size > 0) await this.#pass()
        } while (this.#again)
      } finally {
        // Cleared in the same step as the last look at `#again`, so a call landing after the pass still finds one to
        // join or starts its own.
        this.#checking = null
      }
    })()
    return this.#checking
  }

  /** Ends each tracked stream that doesn't count at HEAD, or all of them when the roster can't be loaded. */
  async #pass(): Promise<void> {
    let roster: Roster | null = null
    try {
      roster = await this.roster()
    } catch (error) {
      // A stream that can't be checked can't be trusted; its client reconnects and is checked again. Streams that
      // all ended meanwhile (the office stopping) leave nothing to report.
      if (this.#streams.size > 0)
        this.office.log(`couldn't load the roster to recheck open streams; ending them: ${errorType(error)}`)
    }
    for (const stream of [...this.#streams]) {
      if (roster !== null && counts(stream, roster)) continue
      this.#streams.delete(stream)
      stream.end()
    }
  }
}
