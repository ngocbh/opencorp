/** The office object and its paths: what the routes and services share. */
import path from "node:path"
import type { MarkdownStore } from "@ngocbh/yian"
import { now } from "@opencorp/protocol"
import { Hiring } from "../chat/hire.ts"
import type { CompanyGit } from "../company/git.ts"
import { CompanySnapshots } from "../company/snapshot.ts"
import type { Hq } from "../hq/core.ts"
import { GitProfileStore } from "../profile/store.ts"
import { SecretStore } from "../secrets.ts"
import type { Store } from "../store/store.ts"
import type { Bus } from "./bus.ts"

/** Where the office keeps its files under an OpenCorp home. */
export class OfficePaths {
  readonly home: string
  readonly company: string
  readonly office: string
  readonly store: string
  readonly socket: string
  readonly pidfile: string
  /** The single-daemon lock. */
  readonly lock: string
  readonly worktrees: string
  readonly runs: string
  readonly memory: string
  readonly secrets: string

  constructor(home: string) {
    this.home = home
    this.company = path.join(home, "company")
    this.office = path.join(home, "office")
    this.store = path.join(this.office, "store.sqlite")
    this.socket = path.join(this.office, "office.sock")
    this.pidfile = path.join(this.office, "office.pid")
    this.lock = path.join(this.office, "office.lock")
    this.worktrees = path.join(this.office, "worktrees")
    this.runs = path.join(this.office, "runs")
    this.memory = path.join(this.office, "memory")
    this.secrets = path.join(this.office, "secrets")
  }

  /** The directory a session's worker runs in. */
  runDir(sessionId: string): string {
    return path.join(this.runs, sessionId)
  }
}

/** The worker registry, as the office sees it. */
export interface WorkerPool {
  /** Stop every worker. */
  closeAll(): void | Promise<void>
}

/** What a route sees: the office, who the request acts as and from which device (device tokens fill them),
 *  and the request's abort signal and query. */
export interface RequestContext {
  office: Office
  /** The handle the request acts as; null on the open requests and for a tokenless request while HEAD names no
   *  CEO. Routes that need one call `actingPerson`. */
  person: string | null
  device: string | null
  signal: AbortSignal
  query: URLSearchParams
}

/** Everything the routes and services share: store, company git, bus, hiring, workers, and start and stop hooks. */
export class Office {
  readonly paths: OfficePaths
  readonly store: Store
  readonly git: CompanyGit
  readonly bus: Bus
  /** Hire previews and confirms; one for the office's life, since previews live in memory. */
  readonly hiring: Hiring
  /** The company at a commit, cached for HQ. */
  readonly snapshots: CompanySnapshots
  /** Asset secrets under `office/secrets`, read per call. */
  readonly secrets: SecretStore
  workers: WorkerPool | undefined
  /** HQ, once `attach` put it here. */
  hq: Hq | undefined
  /** Builds the profile store for one person, per request; null means the profile routes answer 501. */
  profileStore: ((handle: string) => MarkdownStore) | null
  /** When this office object was built, which is the daemon's start, as a protocol timestamp. */
  readonly startedAt: string = now()
  /** Run in order by `start`, each awaited. */
  readonly onStart: (() => unknown)[] = []
  /** Run in reverse order by `stop`, each awaited. */
  readonly onStop: (() => unknown)[] = []
  readonly #log: (message: string) => void
  #unlisten: (() => void) | undefined

  constructor({
    paths,
    store,
    git,
    bus,
    workers,
    profileStore,
    log = console.error,
  }: {
    paths: OfficePaths
    store: Store
    git: CompanyGit
    bus: Bus
    workers?: WorkerPool
    /** Builds a person's profile store; defaults to their `profile.md` in `git`'s clone, null for none. */
    profileStore?: ((handle: string) => MarkdownStore) | null
    /** Gets raw log messages. */
    log?: (message: string) => void
  }) {
    this.paths = paths
    this.store = store
    this.git = git
    this.bus = bus
    this.hiring = new Hiring(git)
    this.snapshots = new CompanySnapshots(git)
    this.secrets = new SecretStore(paths.secrets)
    this.workers = workers
    this.profileStore = profileStore === undefined ? (handle) => new GitProfileStore(git, handle) : profileStore
    this.#log = log
  }

  /**
   * Feed the bus store events, and run `onStart`.
   *
   * If anything fails, `stop` runs before the error propagates, so what earlier callbacks started (workers,
   * watchers) is shut down.
   */
  async start(): Promise<void> {
    try {
      this.#unlisten = this.store.addListener((event) => this.bus.publishMeta(event))
      for (const callback of this.onStart) await callback()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /**
   * End SSE streams, stop the workers, and run `onStop` in reverse order.
   *
   * Every `onStop` callback runs: one that throws is logged and the rest still run. `stop` also runs after a failed
   * `start`, so an `onStop` callback must cope with its `onStart` never having run. It is not idempotent: a second
   * call runs the callbacks again.
   */
  async stop(): Promise<void> {
    this.bus.close()
    this.#unlisten?.()
    this.#unlisten = undefined
    await this.workers?.closeAll()
    for (const callback of [...this.onStop].reverse()) {
      try {
        await callback()
      } catch (error) {
        // The type only: a message (or a settable `.name`) can quote a secret.
        const type = error instanceof Error ? error.constructor.name : typeof error
        this.#log(`office on_stop callback failed: ${type}`)
      }
    }
  }
}
