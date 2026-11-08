/** The office object and its paths: what the routes and services share. */
import path from "node:path"
import { type Message, Session, now } from "@opencorp/protocol"
import { Connections, type ConnectionsOptions } from "../chat/connections.ts"
import { Hiring } from "../chat/hire.ts"
import { Logins, type LoginsOptions } from "../chat/logins.ts"
import { ModelCache, type ModelCacheOptions } from "../chat/models.ts"
import type { Transcript } from "../chat/transcript.ts"
import { type CompanyGit, PIN_GRACE_MS } from "../company/git.ts"
import { CompanySnapshots } from "../company/snapshot.ts"
import type { CodexSessions } from "../harness/sessions.ts"
import type { Hq } from "../hq/core.ts"
import type { ModelCheck } from "../install/onboard.ts"
import type { Tools } from "../install/tools.ts"
import { GitProfileStore } from "../profile/store.ts"
import type { CardActor, Cards } from "../questions/cards.ts"
import { RunIndexer } from "../runs/indexer.ts"
import { RunNotifier } from "../runs/notify.ts"
import { Live } from "../runs/records.ts"
import { RunLogs } from "../runs/service.ts"
import type { OfficePaths as SandboxOfficePaths } from "../sandbox/policy.ts"
import { SecretStore } from "../secrets.ts"
import type { SessionRecord, Store } from "../store/store.ts"
import { DeviceTokens } from "./auth.ts"
import type { Bus } from "./bus.ts"
import { errorType } from "./http.ts"
import type { LiveRelay } from "./live.ts"

// Every status but the two a session never leaves, so a status added later keeps its session's pin.
const NOT_TERMINAL = Session.shape.status.options.filter((status) => status !== "ended" && status !== "failed")

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
  readonly sessions: string
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
    this.sessions = path.join(this.office, "sessions")
    this.memory = path.join(this.office, "memory")
    this.secrets = path.join(this.office, "secrets")
  }

  /** HQ's unix socket, in the office dir. */
  get hqSocket(): string {
    return path.join(this.office, "hq.sock")
  }

  /** The directory a session's worker runs in. */
  runDir(sessionId: string): string {
    return path.join(this.runs, sessionId)
  }

  /** The directory a chat session's workers run in. */
  sessionDir(sessionId: string): string {
    return path.join(this.sessions, sessionId)
  }
}

/** The office's harness for the session routes: the card actions, plus what the session routes call. Each call
 *  throws `HarnessError` for an API error (404 not_found, 409 not_live, 422 refused, 501 not_implemented, ...). */
export interface SessionHarness extends CardActor {
  /** Starts `handle`'s main chat in `cwd` on `harness`, opened by `openedBy`; `connection` and `model` are their
   *  pick, which the harness may pass over. */
  startSession(
    handle: string,
    cwd: string,
    options: {
      harness: SessionRecord["harness"]
      openedBy: string | null
      connection: string | null
      model: string | null
    },
  ): Promise<SessionRecord>
  /** Opens a profile-manager session over `handle`'s profile, opened by `by`, with `text` as its first message.
   *  Only the chat harness runs one; Codex sessions don't. */
  startManager?(handle: string, text: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** A message from `by` (the opener when null): a turn, a steer, an answer or queued. */
  prompt(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Steers the running reply as `by`; with no reply running it is a `prompt`. */
  steer(sessionId: string, text: string, options?: { by?: string | null }): Promise<string>
  /** Ends the session, interrupting a busy reply first; ending one already ending is a no-op. */
  end(sessionId: string): Promise<void>
  /** Continues an ended session as a new one opened by `by`. */
  continueSession(sessionId: string, options?: { by?: string | null }): Promise<SessionRecord>
  /** Sets the session's cost cap. */
  setCostCap(sessionId: string, usd: number): Promise<SessionRecord>
  /** Switches the session's connection and model for its next turn. */
  setModel(sessionId: string, connection: string, model: string): Promise<SessionRecord>
  /** What a client reads of the session before following its live events. */
  messages(sessionId: string): Message[] | Promise<Message[]>
  /** What memory says about its runs, for Run Logs; the chat harness implements it. */
  live?(): Live
  /** Closes each parked worker whose connection changed; the chat harness implements it. Never rejects. */
  connectionsChanged?(): Promise<void>
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
  /** The sha256 of the device token the request authenticated with; absent for a tokenless or open request. Never
   *  the token. */
  tokenSha256?: string
  signal: AbortSignal
  query: URLSearchParams
}

/** Everything the routes and services share: store, company git, bus, hiring, connections, models and sign-ins,
 *  workers, and start and stop hooks. */
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
  /** The programs the daemon resolved at start; spawn only these. */
  readonly tools: Tools
  /** What every workspace must stay clear of; pass as `office` to `SandboxPolicy`/`checkWorkspace`. */
  readonly guards: SandboxOfficePaths
  /** The office's model connections; the one `Connections` of `office/` (two could both take a free name). */
  readonly connections: Connections
  /** Each connection's models; `buildOffice`'s office lists them ahead of time on start. */
  readonly models: ModelCache
  /** Subscription sign-ins; `buildOffice`'s office cancels those still waiting on stop. */
  readonly logins: Logins
  /** The one-reply model check; `buildOffice`'s runs it as a worker job of its registry. */
  readonly checkModel: ModelCheck
  /** yian's run index over `paths.runs`, kept up to date from here; closed on stop. */
  readonly runIndex: RunIndexer
  /** Run Logs: the list of runs and one run's page. Assignable, so a test can give it a fake run index. */
  runs: RunLogs
  /** run.updated for what the store doesn't see, coalesced per run; closed on stop. */
  readonly runNotifier: RunNotifier
  workers: WorkerPool | undefined
  /** HQ, once `attach` put it here. */
  hq: Hq | undefined
  /** The session harness that card actions and the session routes go through; set before the extensions load. */
  harness: SessionHarness | undefined
  /** The question cards, once the questions extension built them. */
  cards: Cards | undefined
  /** The office's live Codex sessions; set by buildOffice. */
  codex: CodexSessions | undefined
  /** The office's one transcript of the run logs, set by `buildOffice`; the session actors' context takes it. */
  transcript: Transcript | undefined
  /** The office's one live relay, set by `buildOffice`; the session actors' context takes it. */
  live: LiveRelay | undefined
  /** Builds the profile store for one person at a `profile_max_chars`, per request; null means the profile routes
   *  answer 501. */
  profileStore: ((handle: string, maxChars: number) => GitProfileStore) | null
  /** When this office object was built, which is the daemon's start, as a protocol timestamp. */
  readonly startedAt: string = now()
  /** Run in order by `start`, each awaited. */
  readonly onStart: (() => unknown)[] = []
  /** Run in reverse order by `stop`, each awaited. */
  readonly onStop: (() => unknown)[] = []
  /** Gets raw log messages: the office log. */
  readonly log: (message: string) => void
  /** Who each request acts as, and the open socket streams to end when their token stops counting. */
  readonly tokens: DeviceTokens
  #unlisten: (() => void) | undefined
  readonly #pinGraceMs: number
  #pruning: Promise<void> | undefined
  #pruneAgain = false
  #pinTimer: ReturnType<typeof setTimeout> | undefined
  readonly #pinsAbort = new AbortController()
  #unlistenPins: (() => void) | undefined

  constructor({
    paths,
    store,
    git,
    bus,
    workers,
    profileStore,
    tools = {},
    guards = {},
    connections,
    models,
    logins,
    checkModel = () => Promise.reject(new Error("this office has no model check")),
    runIndex,
    pinGraceMs = PIN_GRACE_MS,
    log = console.error,
  }: {
    paths: OfficePaths
    store: Store
    git: CompanyGit
    bus: Bus
    workers?: WorkerPool
    /** Builds a person's profile store; defaults to their memory folder in `git`'s clone, null for none. */
    profileStore?: ((handle: string, maxChars: number) => GitProfileStore) | null
    tools?: Tools
    guards?: SandboxOfficePaths
    connections?: ConnectionsOptions
    models?: ModelCacheOptions
    logins?: Omit<LoginsOptions, "models">
    checkModel?: ModelCheck
    runIndex?: ConstructorParameters<typeof RunIndexer>[1]
    /** How long a pin `pin` handed out is spared by `prunePins` (default `PIN_GRACE_MS`). */
    pinGraceMs?: number
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
    this.connections = new Connections(paths.office, { log, ...connections })
    this.models = new ModelCache(this.connections, { log, ...models })
    this.logins = new Logins(this.connections, { log, ...logins, models: this.models })
    this.checkModel = checkModel
    this.runIndex = new RunIndexer(paths.runs, { log, ...runIndex })
    this.runs = new RunLogs({
      store,
      runsDir: paths.runs,
      live: () => this.harness?.live?.() ?? new Live(),
      // The rows the index thread read after the last update: no SQLite read or lock probe on this thread.
      index: () => this.runIndex.rows(),
      pin: (commit) => git.pin(commit),
      log,
    })
    this.runNotifier = new RunNotifier((event) => this.bus.publishMeta(event), { log })
    this.workers = workers
    this.profileStore =
      profileStore === undefined ? (handle, maxChars) => new GitProfileStore(git, handle, { maxChars }) : profileStore
    this.tools = tools
    this.guards = guards
    this.log = log
    this.tokens = new DeviceTokens(this)
    this.#pinGraceMs = pinGraceMs
  }

  /**
   * Feed the bus store events, and run `onStart`.
   *
   * If anything fails, `stop` runs before the error propagates, so what earlier callbacks started (workers,
   * watchers) is shut down.
   */
  async start(): Promise<void> {
    try {
      this.#unlisten = this.store.addListener((event) => {
        this.bus.publishMeta(event)
        // A commit (the office's own, a hand edit, a removed person) may take a token out of the roster.
        if (event.type === "company.updated") this.tokens.changed()
      })
      for (const callback of this.onStart) await callback()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** The commits whose pins are in use: each session's that hasn't ended or failed, and each recorded worker's
   *  session's (a worker may outlive its session's end). */
  #pinsInUse(): string[] {
    const live = this.store.listSessions({ status: NOT_TERMINAL }).map((session) => session.repo_commit)
    // A worker key that isn't a session (a workspace call, the model check) names no pin.
    const working = this.store.listWorkers().flatMap((worker) => this.store.getSession(worker.key)?.repo_commit ?? [])
    return [...live, ...working]
  }

  /** Removes the pins no session or worker needs, one run at a time with at most one queued. Never rejects; a
   *  failure is logged by its type. Does nothing once `stop` ran. */
  prunePins(): Promise<void> {
    const signal = this.#pinsAbort.signal
    if (signal.aborted) return Promise.resolve()
    if (this.#pruning) {
      this.#pruneAgain = true
      return this.#pruning
    }
    this.#pruning = (async () => {
      try {
        do {
          this.#pruneAgain = false
          const { retryInMs } = await this.git.prune(() => this.#pinsInUse(), { graceMs: this.#pinGraceMs, signal })
          clearTimeout(this.#pinTimer)
          // No later trigger may come for a pin spared only by its window, so one is set for when it ends.
          if (retryInMs !== null && !signal.aborted) {
            this.#pinTimer = setTimeout(() => void this.prunePins(), Math.ceil(retryInMs) + 10)
            this.#pinTimer.unref()
          }
        } while (this.#pruneAgain && !signal.aborted)
      } catch (error) {
        this.log(`pin prune failed: ${errorType(error)}`)
      } finally {
        this.#pruning = undefined
      }
    })()
    return this.#pruning
  }

  /** Prunes the pins now, then each time a session ends or fails, until `stop`. `buildOffice` calls it on start. */
  watchPins(): void {
    if (this.#unlistenPins || this.#pinsAbort.signal.aborted) return
    this.#unlistenPins = this.store.addListener((event) => {
      const ended = event.data.status === "ended" || event.data.status === "failed"
      if (event.type === "session.updated" && ended) void this.prunePins()
    })
    void this.prunePins()
  }

  /** A run's status, nodes or end may have changed: publishes its run.updated, coalesced per run. */
  runChanged(runId: string): void {
    this.runNotifier.changed(runId, () => this.runs.runUpdated(runId))
  }

  /**
   * Stop run.updated, end SSE streams, stop pin pruning (waiting for a run in flight), stop the workers, run `onStop`
   * in reverse order, and close the run index.
   *
   * Every `onStop` callback runs: one that throws is logged and the rest still run. `stop` also runs after a failed
   * `start`, so an `onStop` callback must cope with its `onStart` never having run. It is not idempotent: a second
   * call runs the callbacks again.
   */
  async stop(): Promise<void> {
    // First: a pending run.updated reads the store, and would go to a closed bus.
    this.runNotifier.close()
    this.bus.close()
    this.#unlisten?.()
    this.#unlisten = undefined
    // Before the workers close, so their exits prune nothing; awaited so no prune outlives the store.
    this.#pinsAbort.abort()
    clearTimeout(this.#pinTimer)
    this.#unlistenPins?.()
    await this.#pruning
    await this.workers?.closeAll()
    for (const callback of [...this.onStop].reverse()) {
      try {
        await callback()
      } catch (error) {
        this.log(`office on_stop callback failed: ${errorType(error)}`)
      }
    }
    await this.runIndex.close()
  }
}
