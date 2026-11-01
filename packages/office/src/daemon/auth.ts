/** Who sent each request: device tokens, and `actingPerson` for routes. */
import { Roster, loadRoster } from "../auth/roster.ts"
import { AuthError, authenticate, bearerToken, tokenSha256 } from "../auth/tokens.ts"
import { HttpError, type RequestInfo, errorType, logLine } from "./http.ts"
import type { Office, RequestContext } from "./office.ts"

/** Requests served without a token even once tokens are enforced: the "is the office up" probe of `opencorp`,
 *  `opencorp start`, `opencorp doctor` and onboarding, and logging in with a password. Matched against the method
 *  and the raw path before routing, so an encoded spelling of one of these paths needs a token. */
export const OPEN: ReadonlySet<string> = new Set(["GET /health", "HEAD /health", "POST /login"])

const LOGGER = "opencorp.daemon.auth"

/** The 401's message while the company repo's HEAD can't be read. It doesn't send the owner to `opencorp doctor`:
 *  doctor takes a lost ref for an init that stopped early, and running init again would rewrite the company. */
const NO_HEAD = "the company repo's branch ref can't be read; restore it with git"

/** The 401's message for a tokenless request while no human CEO is named at HEAD. It names the fix rather than
 *  `opencorp doctor`, which says to run init again when company.yaml is gone. */
const NO_CEO =
  "this request has no person to act as: the company repo names no human CEO at HEAD; " +
  "make `ceo` in company.yaml name a human and commit it"

/** Added to a refusal while a person file at HEAD doesn't load. The caller isn't signed in, so it names no file. */
const UNREADABLE_HINT = "; a person.yaml at HEAD doesn't load: run `opencorp doctor`"

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
 * in the request's context. Without a human CEO at HEAD a tokenless request is refused, and while HEAD can't be read
 * every request but those in `OPEN` is.
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
  /** Whether the last read of HEAD failed, so that is logged once each time it starts. */
  #headUnreadable = false
  /** The `path\0code` of each unreadable person file last logged, so a file staying broken is logged once. */
  #logged = new Set<string>()

  constructor(readonly office: Office) {}

  /** The roster at HEAD, reloaded only when HEAD moves. While HEAD can't be read: an enforced roster with no
   *  tokens and no CEO, never kept. */
  async roster(): Promise<Roster> {
    const git = this.office.git
    let head: string
    try {
      head = await git.readHead()
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      // Init refuses to run while an office answers, so a running office always had a commit: the ref is gone.
      if (!this.#headUnreadable) {
        const company = JSON.stringify(this.office.paths.company)
        this.#warn(
          `the company repo's branch ref can't be read; every request but /health and /login is refused ` +
            `until it is restored with git in ${company}`,
        )
      }
      this.#headUnreadable = true
      return new Roster("", null, new Map(), true)
    }
    this.#headUnreadable = false
    if (this.#roster?.head !== head) {
      const roster = await loadRoster(git, head)
      this.#logUnreadable(roster)
      this.#roster = roster
    }
    return this.#roster
  }

  /** Logs each person file that doesn't load in `roster` and wasn't in the last one logged: its path and code only,
   *  since a message can quote the file. */
  #logUnreadable(roster: Roster): void {
    const keys = new Set<string>()
    for (const { path, code } of roster.unreadable) {
      const key = `${path}\0${code}`
      keys.add(key)
      if (!this.#logged.has(key)) {
        this.#warn(`${JSON.stringify(path)} doesn't load (${code}); no one signs in through it; run \`opencorp doctor\``)
      }
    }
    this.#logged = keys
  }

  #warn(message: string): void {
    this.office.log(logLine("WARNING", LOGGER, message))
  }

  /** The request's context: its person and device, or the CEO for a tokenless request while tokens aren't
   *  enforced. Throws `HttpError` 401 for a refused request, and for a tokenless one with no CEO to act as. */
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
      if (roster.head === "") throw new HttpError(401, error.code, NO_HEAD)
      if (error.code !== "unauthenticated" || roster.enforced) {
        const hint = roster.unreadable.length ? UNREADABLE_HINT : ""
        throw new HttpError(401, error.code, error.message + hint)
      }
      if (roster.ceo === null) throw new HttpError(401, "unauthenticated", NO_CEO)
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
