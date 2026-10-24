/** Browser sessions on HQ: a session cookie with per-browser revocation. Office-local rows hold the sha256 of a
 *  32-byte secret, last 30 days, and end when the person at HEAD stops being a human or their password changes. */
import { createHash } from "node:crypto"
import { Person } from "@opencorp/protocol"
import type { CompanyGit } from "../company/git.ts"
import { parseFile } from "../company/issues.ts"

/** A session's fixed lifetime, in ms: a session isn't extended by use. */
export const TTL = 30 * 24 * 3600_000

/** How often `lastUsedAt` is written at most, in ms. */
export const TOUCH_EVERY = 3600_000

/** The first 16 hex of sha256 of the person's password hash (of "" without one). */
export function passwordFp(passwordHash: string | null | undefined): string {
  return createHash("sha256")
    .update(passwordHash ?? "")
    .digest("hex")
    .slice(0, 16)
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
