/** Signing a browser in with a handle and password, checked against the person's hash at HEAD. */
import { checkPassword, DUMMY_HASH } from "../auth/passwords.ts"
import { type BrowserSessions, passwordFp } from "./sessions.ts"

/** How long a failure counts, the longest wait, and how long a pair is remembered after its last failure, in
 *  seconds. */
export const WINDOW_S = 15 * 60

/** Failures within `WINDOW_S` that lock a pair. */
export const LIMIT = 5

/** The first lock's length in seconds; each lock after it doubles, up to `WINDOW_S`. */
export const FIRST_WAIT_S = 60

/** The most pairs the throttle remembers. */
export const MAX_KEYS = 1000

/** The most password checks at a time: each holds about 64 MiB and a core for a tenth of a second. */
export const CHECKS = 2

/** (peer address, handle). */
export type Key = readonly [peer: string, handle: string]

/** The handle and password don't sign anyone in; which part was wrong is never said. */
export class BadCredentials extends Error {
  constructor() {
    super("wrong handle or password")
    this.name = "BadCredentials"
  }
}

/** `CHECKS` password checks are running already; the caller tries again later instead of queueing. */
export class Busy extends Error {
  constructor() {
    super("password checks are busy")
    this.name = "Busy"
  }
}

/** Too many failed sign-ins for this peer and handle; `retryAfter` is the wait in whole seconds, and `first`
 *  whether this is the first refusal under this lock. */
export class Throttled extends Error {
  constructor(
    readonly retryAfter: number,
    readonly first: boolean,
  ) {
    super(`retry after ${retryAfter} s`)
    this.name = "Throttled"
  }
}

interface Tries {
  /** The times of the last `LIMIT` failures, oldest first. */
  failures: number[]
  locks: number
  until: number
}

/**
 * Failed sign-ins per (peer, handle), in memory: `LIMIT` failures within `WINDOW_S` lock the pair for
 * `FIRST_WAIT_S`, and each failure after a lock locks it again for twice as long, up to `WINDOW_S`.
 *
 * A pair is forgotten, locks and all, `WINDOW_S` after its last failure; at most `MAX_KEYS` are kept, the least
 * recently failed unlocked pair going first, and a lock is never evicted. `clock` reads seconds, monotonic.
 */
export class Throttle {
  /** In order of last failure, oldest first; keyed by `JSON.stringify(key)`. */
  #tries = new Map<string, Tries>()
  /** The lock end each pair was last refused under, for logging it once; null for a full table. */
  #told = new Map<string | null, number>()

  constructor(
    /** Public and swappable on purpose, so a test can move time on the HQ app's throttle. */
    public clock: () => number = () => performance.now() / 1000,
  ) {}

  /** How many pairs are remembered. */
  get size(): number {
    return this.#tries.size
  }

  /** The seconds left on `key`'s lock, or null when it isn't locked. A pair not remembered while every remembered
   *  pair is locked waits for the first lock to end: there's no room to count its failures. */
  wait(key: Key): number | null {
    const now = this.clock()
    const until = this.#until(JSON.stringify(key), now)
    return until === null ? null : Math.ceil(until - now)
  }

  /** `wait(key)` and whether this is the first refusal under that lock, or null when it isn't locked. */
  refuse(key: Key): [number, boolean] | null {
    const now = this.clock()
    const k = JSON.stringify(key)
    const until = this.#until(k, now)
    if (until === null) return null
    const told = this.#tries.has(k) ? k : null // refusals for a full table share one entry, so this stays bounded
    const first = until !== this.#told.get(told)
    this.#told.set(told, until)
    return [Math.ceil(until - now), first]
  }

  #until(k: string, now: number): number | null {
    this.#forget(now)
    const tries = this.#tries.get(k)
    if (tries !== undefined) return tries.until <= now ? null : tries.until
    if (this.#tries.size < MAX_KEYS) return null
    const all = [...this.#tries.values()]
    return all.every((t) => t.until > now) ? Math.min(...all.map((t) => t.until)) : null
  }

  /** Counts a failure for `key`, locking it once there are `LIMIT` within `WINDOW_S` or it was locked before. */
  failed(key: Key): void {
    const now = this.clock()
    this.#forget(now)
    const k = JSON.stringify(key)
    const tries = this.#tries.get(k) ?? { failures: [], locks: 0, until: 0 }
    this.#tries.delete(k)
    this.#tries.set(k, tries)
    tries.failures.push(now)
    if (tries.failures.length > LIMIT) tries.failures.shift()
    if (tries.locks || (tries.failures.length === LIMIT && tries.failures[0]! > now - WINDOW_S)) {
      tries.until = now + Math.min(FIRST_WAIT_S * 2 ** tries.locks, WINDOW_S)
      tries.locks += 1
    }
    if (this.#tries.size > MAX_KEYS) {
      // Evicting a lock would let anyone clear it by failing on enough other handles: the oldest unlocked pair
      // goes, which is this one when every other pair is locked.
      for (const [other, t] of this.#tries) {
        if (t.until <= now) {
          this.#tries.delete(other)
          break
        }
      }
    }
  }

  /** Forgets `key`'s failures. */
  succeeded(key: Key): void {
    this.#tries.delete(JSON.stringify(key))
  }

  #forget(now: number): void {
    // A lock never outlasts its pair's entry: it ends at most WINDOW_S after the failure that set it.
    for (const [k, tries] of this.#tries) {
      if (tries.failures.at(-1)! > now - WINDOW_S) break
      this.#tries.delete(k)
    }
    // A refusal is remembered only while its lock lasts: at most the locked pairs, and one for a full table.
    for (const [k, until] of this.#told) if (until <= now) this.#told.delete(k)
  }
}

/** Checks sign-in passwords for HQ. */
export class Logins {
  readonly throttle: Throttle
  readonly #sessions: Pick<BrowserSessions, "passwordHash">
  readonly #check: (password: string, phc: string) => Promise<boolean>
  #running = 0

  constructor(
    sessions: Pick<BrowserSessions, "passwordHash">,
    {
      clock,
      checkPassword: check = checkPassword,
    }: { clock?: () => number; checkPassword?: (password: string, phc: string) => Promise<boolean> } = {},
  ) {
    this.#sessions = sessions
    this.#check = check
    this.throttle = new Throttle(clock)
  }

  /** How many password checks are in flight. */
  get running(): number {
    return this.#running
  }

  /**
   * The fingerprint of the password hash `password` matches, `handle`'s at HEAD; throws `BadCredentials` unless
   * `handle` is a human whose password it is, `Throttled` while `(peer, handle)` is locked, and `Busy` when
   * `CHECKS` checks are running.
   *
   * Pairing never comes here, so no number of failures here can lock anyone out of `opencorp pair`.
   */
  async check(peer: string, handle: string, password: string): Promise<string> {
    const key: Key = [peer, handle]
    const refused = this.throttle.refuse(key)
    if (refused !== null) throw new Throttled(...refused)
    if (this.#running >= CHECKS) throw new Busy() // never a queue without bound
    this.#running++
    const release = () => {
      this.#running--
    }
    let phc: string | null
    try {
      // Read from git on every sign-in, not cached: every handle, known or not, pays the same read, so timing
      // doesn't tell them apart, and the slot bounds how many reads run at once.
      phc = await this.#sessions.passwordHash(handle)
    } catch (error) {
      release()
      throw error
    }
    // The slot frees when the check settles, not when this caller stops waiting, so clients that go away
    // mid-check can't start more checks than CHECKS. A synchronous throw still becomes a rejection here.
    const checking = Promise.resolve().then(() => this.#check(password, phc ?? DUMMY_HASH))
    checking.then(release, release)
    const matched = await checking
    if (phc === null || !matched) {
      this.throttle.failed(key)
      throw new BadCredentials()
    }
    this.throttle.succeeded(key)
    return passwordFp(phc)
  }
}
