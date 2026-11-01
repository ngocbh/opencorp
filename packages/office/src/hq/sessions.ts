/** Browser sessions on HQ: a session cookie with per-browser revocation. Office-local rows hold the sha256 of a
 *  32-byte secret, last 30 days, and end when the person at HEAD stops being a human or their password changes. */
import { createHash, randomBytes, randomInt } from "node:crypto"
import { inspect } from "node:util"
import {
  type BrowserSession as BrowserSessionSchema,
  type CompanyView as CompanyViewSchema,
  Person,
  stamp,
} from "@opencorp/protocol"
import type { z } from "zod"
import type { CompanyGit } from "../company/git.ts"
import { parseFile } from "../company/issues.ts"
import type { CompanySnapshots } from "../company/snapshot.ts"
import type { Subscription } from "../daemon/bus.ts"
import { HttpError } from "../daemon/http.ts"
import { HqSessionRecord, newId, type Store } from "../store/store.ts"

type BrowserSession = z.output<typeof BrowserSessionSchema>
type CompanyView = z.output<typeof CompanyViewSchema>

/** A session's fixed lifetime, in ms: a session isn't extended by use. */
export const TTL = 30 * 24 * 3600_000

/** How often `lastUsedAt` is written at most, in ms. */
export const TOUCH_EVERY = 3600_000

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

/** The first 16 hex of sha256 of the person's password hash (of "" without one). */
export function passwordFp(passwordHash: string | null | undefined): string {
  return createHash("sha256")
    .update(passwordHash ?? "")
    .digest("hex")
    .slice(0, 16)
}

function secretSha256(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

/** The humans' password fingerprints at one commit, and the handles whose `person.yaml` can't be read there. */
export interface Humans {
  fps: ReadonlyMap<string, string>
  unreadable: ReadonlySet<string>
}

/**
 * The humans' password hashes at commit `sha` (null for no password), read from git objects in one batch, and the
 * handles whose `person.yaml` can't be read there.
 *
 * The company snapshot drops password hashes, since it goes to browsers, so they are read here.
 */
async function humans(git: CompanyGit, sha: string): Promise<[Map<string, string | null>, Set<string>]> {
  const blobs = new Map<string, [path: string, blob: string]>()
  for (const [path, blob] of await git.files("people", sha)) {
    const parts = path.split("/")
    if (parts.length === 3 && path.endsWith("/person.yaml")) blobs.set(parts[1]!, [path, blob])
  }
  const data = await git.readBlobs([...blobs.values()].map(([, blob]) => blob))
  const found = new Map<string, string | null>()
  const unreadable = new Set<string>()
  for (const [handle, [path, blob]] of blobs) {
    // The snapshot reports a broken file; here it only counts as unreadable.
    const person = parseFile(path, data.get(blob) ?? new Uint8Array(), Person, [])
    if (person === null || person.handle !== handle) unreadable.add(handle)
    else if (person.kind === "human") found.set(handle, person.password_hash ?? null)
  }
  return [found, unreadable]
}

/** The humans' password fingerprints at commit `sha`. */
export async function passwordFps(git: CompanyGit, sha: string): Promise<Humans> {
  const [hashes, unreadable] = await humans(git, sha)
  return { fps: new Map([...hashes].map(([handle, hash]) => [handle, passwordFp(hash)])), unreadable }
}

/** `passwordFps` by commit, loaded once however many checks ask at the same time; the last `KEEP` are kept. */
export class Fingerprints {
  static readonly KEEP = 4
  readonly git: CompanyGit
  readonly #load: (git: CompanyGit, sha: string) => Promise<Humans>
  // A Map keeps insertion order, so its first key is the oldest load.
  readonly #loads = new Map<string, Promise<Humans>>()

  constructor(git: CompanyGit, load: (git: CompanyGit, sha: string) => Promise<Humans> = passwordFps) {
    this.git = git
    this.#load = load
  }

  /** The humans' password fingerprints at commit `sha`. */
  at(sha: string): Promise<Humans> {
    const cached = this.#loads.get(sha)
    if (cached !== undefined) return cached
    const load = this.#load(this.git, sha)
    this.#loads.set(sha, load)
    // Callers see the error through `load` itself; this only drops the failed load, so the next call tries again,
    // and keeps the rejection from counting as unobserved.
    load.catch(() => {
      if (this.#loads.get(sha) === load) this.#loads.delete(sha)
    })
    while (this.#loads.size > Fingerprints.KEEP) this.#loads.delete(this.#loads.keys().next().value!)
    return load
  }
}

/** The session a request's cookie carries, and the company at HEAD it was checked against. */
export interface Who {
  id: string
  person: string
  name: string
  view: CompanyView
}

/** What each frame of an open stream checks without a store read, and what a commit is checked against. */
interface Live {
  expiresAt: string
  person: string
  passwordFp: string
  revoked: boolean
  streams: Set<Subscription>
}

/** A live, unrevoked entry for the session `record`. */
function entry(record: HqSessionRecord): Live {
  const { expiresAt, person, passwordFp } = record
  return { expiresAt, person, passwordFp, revoked: false, streams: new Set() }
}

/** Issues, checks and revokes browser sessions. Holds no cookie secret; inspect and JSON show only how many
 *  sessions it tracks, since the in-memory entries hold password fingerprints. */
export class BrowserSessions {
  readonly store: Store
  readonly snapshots: CompanySnapshots
  /** What time it is; tests swap it. */
  clock: () => Date
  readonly #fingerprints: Fingerprints
  readonly #live = new Map<string, Live>()

  constructor(
    store: Store,
    snapshots: CompanySnapshots,
    {
      clock = () => new Date(),
      passwordFps: load = passwordFps,
    }: { clock?: () => Date; passwordFps?: (git: CompanyGit, sha: string) => Promise<Humans> } = {},
  ) {
    this.store = store
    this.snapshots = snapshots
    this.clock = clock
    this.#fingerprints = new Fingerprints(snapshots.git, load)
  }

  /** How many sessions are held in memory (live, or revoked and not yet expired). */
  get tracked(): number {
    return this.#live.size
  }

  /** The company at HEAD and its humans' password fingerprints. */
  async #atHead(): Promise<[CompanyView | null, Humans]> {
    const view = await this.snapshots.head()
    return [view, view === null ? { fps: new Map(), unreadable: new Set() } : await this.#fingerprints.at(view.sha)]
  }

  /** `person`'s password hash at HEAD, or null unless they are a human with a password there. */
  async passwordHash(person: string): Promise<string | null> {
    const view = await this.snapshots.head()
    if (view === null) return null
    const [hashes] = await humans(this.snapshots.git, view.sha)
    return hashes.get(person) ?? null
  }

  /**
   * A new session for the human `person`; returns it and the cookie value `<id>.<secret>`.
   *
   * `checked` is the fingerprint of the password hash a sign-in was just checked against: when the password at HEAD
   * is no longer that one, the session isn't issued (`HttpError(409, "password_changed")`), since a password change
   * ends the sessions of the old password.
   *
   * The name is made here (`web-<6 characters>`), so no name conflict can fail the request after a pairing code is
   * spent.
   */
  async issue(
    person: string,
    {
      issuedBy,
      label,
      via = "pair",
      checked,
    }: { issuedBy: string; label: string | null; via?: BrowserSession["via"]; checked?: string },
  ): Promise<[BrowserSession, string]> {
    const [, { fps }] = await this.#atHead()
    const fp = fps.get(person)
    // A 422 names the field, not its value.
    if (fp === undefined) throw new HttpError(422, "not_a_human", "the person isn't a human in the company at HEAD")
    if (checked !== undefined && fp !== checked)
      throw new HttpError(409, "password_changed", `@${person}'s password changed while signing in`)
    const secret = randomBytes(32).toString("base64url")
    const at = this.clock()
    let name = "web-"
    for (let i = 0; i < 6; i++) name += NAME_CHARS[randomInt(NAME_CHARS.length)]
    const record = new HqSessionRecord({
      id: newId(),
      person,
      name,
      label,
      secretSha256: secretSha256(secret),
      passwordFp: fp,
      issuedBy,
      via,
      createdAt: stamp(at),
      expiresAt: stamp(new Date(at.getTime() + TTL)),
      lastUsedAt: null,
    })
    this.store.addHqSession(record)
    this.#live.set(record.id, entry(record))
    return [record.public(), `${record.id}.${secret}`]
  }

  /** The session `cookie` carries, if it's live and its person, at HEAD, is still a human with the same password; a
   *  session failing those checks is ended. */
  async check(cookie: string | null | undefined): Promise<Who | null> {
    const text = cookie ?? ""
    const dot = text.indexOf(".")
    const sid = dot < 0 ? text : text.slice(0, dot)
    const secret = dot < 0 ? "" : text.slice(dot + 1)
    if (!sid || !secret) return null
    const at = this.clock()
    const now = stamp(at)
    this.#forgetExpired(now)
    const row = this.store.hqSessionBySecret(secretSha256(secret), now)
    if (row === undefined || row.id !== sid) return null // only a cookie that proves the secret gets past here
    const [view, humans] = await this.#atHead()
    // A typo, or a field from a newer writer, isn't offboarding: refuse until the file reads again.
    if (humans.unreadable.has(row.person)) return null
    if (view === null || humans.fps.get(row.person) !== row.passwordFp) {
      await this.revoke(sid)
      return null
    }
    // A revoke that ran while this check loaded HEAD left a revoked entry here, which wins.
    let live = this.#live.get(sid)
    if (live === undefined) {
      live = entry(row)
      this.#live.set(sid, live)
    }
    if (live.revoked) return null
    const before = stamp(new Date(at.getTime() - TOUCH_EVERY))
    if (row.lastUsedAt === null || row.lastUsedAt < before) this.store.touchHqSession(sid, now, before)
    return { id: sid, person: row.person, name: row.name, view }
  }

  /**
   * Ends session `sid`: deletes its row and closes its open streams; whether it existed.
   *
   * A live session stays in memory as revoked until it would have expired, so a check that read its row just before
   * the delete still refuses it. An unknown or expired id adds nothing.
   */
  async revoke(sid: string): Promise<boolean> {
    // The row and the entry are read with no await between, so no check can make the entry meanwhile; an existing
    // entry is marked, never replaced.
    const row = this.store.getHqSession(sid)
    let live = this.#live.get(sid)
    if (live === undefined && row !== undefined && row.expiresAt > stamp(this.clock())) {
      live = entry(row)
      this.#live.set(sid, live)
    }
    if (live !== undefined) {
      live.revoked = true
      for (const sub of [...live.streams]) sub.end()
    }
    return this.store.deleteHqSession(sid)
  }

  /**
   * `person`'s unexpired sessions, newest first, as checked against commit `sha`: a session whose person's password
   * changed there is ended (its row deleted, its streams closed) and left out, as `check` would on its next use. A
   * `person.yaml` that can't be read there ends none, as `check` doesn't.
   */
  async listLive(person: string, sha: string): Promise<HqSessionRecord[]> {
    const now = stamp(this.clock())
    const rows = this.store.listHqSessions(person).filter((r) => r.expiresAt > now)
    const humans = await this.#fingerprints.at(sha)
    if (humans.unreadable.has(person)) return rows
    const fp = humans.fps.get(person)
    const live: HqSessionRecord[] = []
    for (const row of rows) {
      if (row.passwordFp === fp) live.push(row)
      else await this.revoke(row.id)
    }
    return live
  }

  /** Tracks an open stream of session `sid`, so revoking the session ends it; a revoked or unknown session ends it
   *  now (expiry is left to the stream's `alive` check). */
  register(sid: string, sub: Subscription): void {
    const live = this.#live.get(sid)
    if (live === undefined || live.revoked) sub.end()
    else live.streams.add(sub)
  }

  /** Forgets a stream that ended. */
  unregister(sid: string, sub: Subscription): void {
    this.#live.get(sid)?.streams.delete(sub)
  }

  /** How many open streams session `sid` has; 0 when unknown. */
  streams(sid: string): number {
    return this.#live.get(sid)?.streams.size ?? 0
  }

  /** Whether `sid` is neither revoked nor expired, without a store read: checked on every frame. */
  alive(sid: string): boolean {
    const live = this.#live.get(sid)
    return live !== undefined && !live.revoked && live.expiresAt > stamp(this.clock())
  }

  /** Whether `sid`'s person is still a human with the same password at commit `sha`; ends the session if not. A
   *  `person.yaml` that can't be read there refuses without ending it, as `check` does. */
  async stillValid(sid: string, sha: string): Promise<boolean> {
    const live = this.#live.get(sid)
    if (live === undefined || live.revoked) return false
    const humans = await this.#fingerprints.at(sha)
    if (humans.unreadable.has(live.person)) return false
    if (humans.fps.get(live.person) === live.passwordFp) return !live.revoked // a revoke during the load wins
    await this.revoke(sid)
    return false
  }

  /** Shows how many sessions are tracked, never a fingerprint. */
  toJSON(): { tracked: number } {
    return { tracked: this.tracked }
  }

  /** Shows how many sessions are tracked, never a fingerprint. */
  [inspect.custom](): string {
    return `BrowserSessions ${inspect(this.toJSON())}`
  }

  /** Drops the in-memory entries of sessions past their expiry that no stream holds, so the entries stay bounded by
   *  the sessions of the last 30 days. */
  #forgetExpired(now: string): void {
    for (const [sid, live] of this.#live) if (live.expiresAt <= now && live.streams.size === 0) this.#live.delete(sid)
  }
}
