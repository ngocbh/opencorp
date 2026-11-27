import type {
  Ack,
  AddDeviceRequest,
  AddConnectionRequest,
  AnswerRequest,
  BrowserSession,
  Comment,
  CompanyFile,
  CompanyTree,
  CompanyView,
  Connection,
  ConnectionList,
  ConnectionLogin,
  CostCapRequest,
  CostReport,
  CreateSessionRequest,
  DeliveryReply,
  Health,
  HireRequest,
  HireResponse,
  HqLoginRequest,
  HqStatus,
  Instrument,
  InstrumentKeysRequest,
  InstrumentScreen,
  InstrumentSizeRequest,
  LoginRequest,
  Message,
  MessagePage,
  ModelList,
  PairCode,
  PairCodeRequest,
  PairRequest,
  Person,
  Profile,
  ProfileManagerRequest,
  ProfileProposal,
  ProfileWriteRequest,
  PromptRequest,
  Question,
  RemoveRuleRequest,
  RuleList,
  RunCall,
  RunCallList,
  RunDetail,
  RunEvent,
  RunEventPage,
  RunNodeDetail,
  RunNodePage,
  RunNodeView,
  RunPage,
  RunSummary,
  SendBackRequest,
  Session,
  SetDefaultConnectionRequest,
  SetDeliveryRequest,
  SetModeRequest,
  SetModelRequest,
  SetPasswordRequest,
  SideChatRequest,
  StartLoginRequest,
  WorkItem,
} from "@opencorp/protocol"
import { OfficeError, OfficeTimeout, UnknownDevice } from "./errors"
import { isSegment, request, seg, transportOf, where, type Method, type Transport } from "./http"
import { runLive, subscribe, type RunLiveFrame, type StreamEvent, type SubscribeOptions } from "./sse"

export type OfficeClient = ReturnType<typeof createOfficeClient>

/** How long a read waits for the office before failing with `OfficeTimeout`. */
export const READ_TIMEOUT_MS = 15_000

/** How long starting a chat waits for the office before failing with `OfficeTimeout`. */
export const CREATE_TIMEOUT_MS = 30_000

/**
 * How long a node's view waits for the office before failing with `OfficeTimeout`: the office replays the log up to
 * the node, which takes seconds on a long run, and gives a view up after 120 s.
 */
export const VIEW_TIMEOUT_MS = 130_000

/**
 * How long adding a connection waits for the office before failing with `OfficeTimeout`: the office checks the
 * key by listing the models, then with one reply, which takes about 95 s at most.
 */
export const ADD_CONNECTION_TIMEOUT_MS = 120_000

/**
 * How long starting a subscription sign-in waits for the office before failing with `OfficeTimeout`: the office
 * answers once the provider has given the code to show, which takes up to 20 s.
 */
export const START_LOGIN_TIMEOUT_MS = 30_000

/** Who the office takes a request to be from: `GET /whoami`. */
export type WhoAmI = { person: string; device: string | null }

/**
 * A typed client for the office's HTTP API over its socket or a base URL, sending `token` (this
 * device's) with every request. Every method throws `OfficeError` on failure, `UnknownDevice` on a 401.
 */
export function createOfficeClient(opts: Transport & { timeoutMs?: number; token?: string }) {
  const { timeoutMs = READ_TIMEOUT_MS, token } = opts
  const transport = transportOf(opts)
  /** The socket path, or the base URL in a browser. */
  const socket = where(transport)
  const call = <T>(method: Method, path: string, body?: unknown) => request<T>(transport, method, path, body, { token })
  // A hung read would stall the bootstrap or a session load forever; writes aren't retried,
  // so they wait for the office's answer.
  const get = <T>(path: string) => request<T>(transport, "GET", path, undefined, { timeoutMs, token })
  const post = <T>(path: string, body?: unknown) => call<T>("POST", path, body)
  // Each throws not_found, in the office's words, for an id no request can carry; the methods are async, so that
  // comes back as a rejected promise.
  const s = (id: string) => `/sessions/${part(id, `no session ${id}`)}`
  const instrument = (id: string, iid: string) => `${s(id)}/instruments/${part(iid, `no instrument ${iid}`)}`
  const waiting = (id: string, mid: string) => `${s(id)}/inbox/${part(mid, `no message ${mid} waits in session ${id}`)}`
  // Each shell's keys requests still in flight, by path: one goes at a time, so the office gets them in the order
  // they were typed.
  const typing = new Map<string, Promise<Ack>>()
  /** Sends keys to `path` once the requests before it to the same path have been answered, either way. */
  const typeAt = (path: string, req: InstrumentKeysRequest) => {
    const prior = typing.get(path)
    const send = () => post<Ack>(path, req)
    const sent = prior ? prior.then(send, send) : send()
    typing.set(path, sent)
    const done = () => void (typing.get(path) === sent && typing.delete(path))
    sent.then(done, done)
    return sent
  }
  const q = (id: string) => `/questions/${part(id, `no question ${id}`)}`
  const r = (id: string) => `/runs/${part(id, `no run ${id}`)}`
  const person = (handle: string) => `/people/${part(handle, `no person @${handle}`)}`
  const profile = (handle: string) => `/profiles/${part(handle, `no person ${handle}`)}`
  const connection = (name: string) =>
    `/connections/${part(name, `there is no connection '${name}' on this office`)}`
  const signIn = (id: string) => `/connections/login/${part(id, `no sign-in ${id}`)}`
  const workItem = (id: string) => `/work-items/${part(id, `no work item ${id}`)}`
  return {
    socket,
    whoami: () => get<WhoAmI>("/whoami"),
    /**
     * Liveness, and over a base URL (HQ's `/api/health`) the office's and app's compatibility keys; the socket's
     * `/health` answers only `{ok: true}`.
     */
    health: () => get<Health | { ok: true }>("/health"),
    company: {
      /** The company at HEAD (HQ only). */
      get: () => get<CompanyView>("/company"),
      /** The company repo's files at HEAD (HQ only). */
      tree: () => get<CompanyTree>("/company/tree"),
      /**
       * One file of the company repo at `at`, a commit a tree read returned (HQ only). Fails with `isStaleCommit`,
       * `isNoFile` or `isBadPath`.
       */
      file: (at: string, path: string) => get<CompanyFile>(`/company/file${query({ at, path })}`),
    },
    /** Spend per person since `since`, a Timestamp (HQ only). */
    costs: { since: (since: string) => get<CostReport>(`/costs${query({ since })}`) },
    runs: {
      /**
       * Top-level runs, newest first, each with how many runs were started from it (`children_total`; `children` is
       * left empty); `before` is the last page's `next`.
       */
      list: (opts: RunListOptions = {}) => get<RunPage>(`/runs${query(runParams(opts))}`),
      /**
       * One page of the runs started from run `id`, newest first, those matching `opts`'s filters as `list` matches
       * them; `before` is the last page's `next`.
       */
      children: (id: string, opts: RunListOptions = {}) =>
        get<RunPage>(`/runs${query({ parent: id, ...runParams(opts) })}`),
      /** One run's header: summary, parent, children, fingerprint, pinned commit, models, usage and log state. */
      get: async (id: string) => get<RunDetail>(r(id)),
      /**
       * Node attempts, newest start first; `before` is the last page's `next_before`. Fails with
       * `isUnsupportedSchema` or `isNoLog`.
       */
      nodes: async (id: string, before?: number) => get<RunNodePage>(`${r(id)}/nodes${query({ before })}`),
      /**
       * Node attempt `seq` (its start record's seq), read from the log: its row, model, record times, outputs, inputs
       * and error. Fails as `nodes` does, or with not_found when no attempt starts there.
       */
      node: async (id: string, seq: number) => get<RunNodeDetail>(`${r(id)}/nodes/${seq}`),
      /**
       * Node attempt `seq`'s inputs and outputs with their types, read by replaying the log up to it, which can take
       * seconds; `signal` aborting drops it while the office still has it queued. Fails as `node` does, with 409
       * `too_large` for a log too long to read it from, or 409 `not_supported` when the office can't read it.
       */
      view: async (id: string, seq: number, { signal }: { signal?: AbortSignal } = {}) =>
        request<RunNodeView>(transport, "GET", `${r(id)}/nodes/${seq}/view`, undefined, {
          timeoutMs: VIEW_TIMEOUT_MS,
          token,
          signal,
        }),
      /** Records after seq `after`; fails as `nodes` does. */
      events: async (id: string, after?: number) => get<RunEventPage>(`${r(id)}/events${query({ after })}`),
      /** One record by seq, evidence included; fails as `nodes` does. */
      event: async (id: string, seq: number) => get<RunEvent>(`${r(id)}/events/${seq}`),
      /**
       * The model calls agent node `node` made, oldest first; fails as `nodes` does, or with 409 `too_large` for a log
       * too long to read them from.
       */
      calls: async (id: string, node: string) => get<RunCallList>(`${r(id)}/calls${query({ node })}`),
      /**
       * Model call `n` of agent node `node` (the `n` of any of its attempts), rebuilt from the log: its request,
       * attempts, reply and tool results. Fails as `calls` does, or with 409 `not_supported` when the office can't
       * rebuild it. The node id's segments go as path segments, so one no path can carry is not_found.
       */
      call: async (id: string, node: string, n: number) =>
        get<RunCall>(`${r(id)}/calls/${node.split("/").map((s) => part(s, `no model call ${n} of ${node}`)).join("/")}/${n}`),
      /**
       * Where the log downloads from, as stored, for a link (HQ only: the browser's cookie authorizes it). Unguarded:
       * it sends nothing, and HQ shows the link only once `get` found the run.
       */
      logUrl: (id: string) => `${socket}/runs/${seg(id)}/log`,
      /**
       * Reads one live stream of run `id`: its records after seq `after`, then its model calls' frames while its worker
       * runs; see `runLive`. It never reconnects. An id no request can carry ends it `closed` with not_found, sending
       * nothing.
       */
      live: (id: string, handler: (f: RunLiveFrame) => void, opts: { after?: number; signal?: AbortSignal } = {}) => {
        let path: string
        try {
          path = `${r(id)}/live${query({ after: opts.after })}`
        } catch (error) {
          return refusedLive(error, handler, opts.signal)
        }
        return runLive(transport, path, handler, { token, signal: opts.signal })
      },
    },
    /** Spends a pairing code and signs this browser in (HQ only). */
    pair: (req: PairRequest) => post<BrowserSession>("/pair", req),
    /**
     * Signs this browser in with a human's handle and password (HQ only). A 401 here is `bad_credentials`, not
     * `UnknownDevice`: the browser has no session yet, so "pair this browser again" would be wrong. The exception is
     * `sign_in_required`, which stays `UnknownDevice`: an office without `/api/login` refuses it like any other
     * session-less request.
     */
    signIn: (req: HqLoginRequest) =>
      post<BrowserSession>("/login", req).catch((e) => {
        if (e instanceof UnknownDevice && e.code !== "sign_in_required")
          throw new OfficeError(401, "bad_credentials", "wrong handle or password")
        throw e
      }),
    /** Signs this browser out (HQ only). */
    logout: () => post<Ack>("/logout"),
    /** HQ's routes on the office socket. */
    hq: {
      status: () => get<HqStatus>("/hq"),
      pair: (req: PairCodeRequest) => post<PairCode>("/hq/pair", req),
      browsers: (person?: string) => get<BrowserSession[]>(`/hq/browsers${query({ person })}`),
      removeBrowser: async (id: string) =>
        call<Ack>("DELETE", `/hq/browsers/${part(id, `no browser session ${id}`)}`),
    },
    /** Adds a device for a human who gives their password; served without a token. */
    login: (req: LoginRequest) => post<Person>("/login", req),
    people: {
      list: () => get<Person[]>("/people"),
      // A folder path's slashes are its own; the office answers [] for a folder nobody worked in, and so for one no
      // request can name.
      inFolder: async (cwd: string) =>
        cwd === "" || cwd === "." || cwd.split("/").includes("..") ? [] : get<Person[]>(`/folders/${seg(cwd)}/people`),
      hire: (req: HireRequest) => post<HireResponse>("/people", req),
      setPassword: async (handle: string, req: SetPasswordRequest) =>
        call<Person>("PUT", `${person(handle)}/password`, req),
    },
    devices: {
      add: async (handle: string, req: AddDeviceRequest) => post<Person>(`${person(handle)}/devices`, req),
      remove: async (handle: string, name: string) =>
        call<Person>("DELETE", `${person(handle)}/devices/${part(name, `@${handle} has no device by that name`)}`),
    },
    sessions: {
      /** Sessions, newest updated first; several statuses are sent comma-separated. */
      list: (
        opts: {
          person?: string
          limit?: number
          status?: Session["status"] | Session["status"][]
          kind?: Session["kind"]
          cwd?: string
        } = {},
      ) =>
        get<Session[]>(
          `/sessions${query({
            person: opts.person,
            limit: opts.limit,
            kind: opts.kind,
            cwd: opts.cwd,
            status: joined(opts.status),
          })}`,
        ),
      // Starting a chat may wait up to 8 s for the connections' model lists, so it gets a limit of its own.
      create: (req: CreateSessionRequest) =>
        request<Session>(transport, "POST", "/sessions", req, { timeoutMs: CREATE_TIMEOUT_MS, token }).catch((e) => {
          if (e instanceof OfficeTimeout)
            e.message += "; the chat may have started, so look for it in the session list (/sessions)"
          throw e
        }),
      get: async (id: string) => get<Session>(s(id)),
      /** The whole transcript; `messagePage` reads it a page at a time. */
      messages: async (id: string) => get<Message[]>(`${s(id)}/messages`),
      /**
       * The newest `limit` messages (from 1 to 500; the office's default is 50) before `before`, a page's `next`, or
       * the newest of all; oldest first. Fails with `bad_cursor` for a cursor whose message the transcript no longer
       * has.
       */
      messagePage: async (id: string, opts: { limit?: number; before?: string } = {}) =>
        get<MessagePage>(`${s(id)}/messages${query({ limit: opts.limit, before: opts.before })}`),
      prompt: async (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/prompt`, req),
      steer: async (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/steer`, req),
      /** Queues a message for the chat's next turn, which the running reply never reads. */
      queue: async (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/queue`, req),
      /**
       * Moves one of your messages still unread to steer the running reply (`steer`) or to wait for the next turn
       * (`queue`); only the chat's approver may. Fails with `already_read` or `already_withdrawn` when it is too late;
       * a send there that failed after the run took it back is `moved: false`, with `why` and, when the message went
       * back nowhere, its `text`.
       */
      setDelivery: async (id: string, messageId: string, req: SetDeliveryRequest) =>
        call<DeliveryReply>("PATCH", waiting(id, messageId), req),
      /** Takes back one of your messages still unread, steer or queued; only the chat's approver may. Fails with
       *  `already_read` or `already_withdrawn` when it is too late. */
      withdraw: async (id: string, messageId: string) => call<Ack>("DELETE", waiting(id, messageId)),
      interrupt: async (id: string) => post<Ack>(`${s(id)}/interrupt`),
      end: async (id: string) => post<Ack>(`${s(id)}/end`),
      /** Continues an ended Codex session on its thread, as a new session. */
      continue: async (id: string) =>
        request<Session>(transport, "POST", `${s(id)}/continue`, undefined, { timeoutMs: CREATE_TIMEOUT_MS, token }),
      costCap: async (id: string, req: CostCapRequest) => post<Session>(`${s(id)}/cost-cap`, req),
      /** Switches a live chat's connection and model; its next reply runs on them. */
      setModel: async (id: string, req: SetModelRequest) => post<Session>(`${s(id)}/model`, req),
      /** Switches a session's mode (auto, default, ask or dontAsk); only its approver may. */
      setMode: async (id: string, req: SetModeRequest) => post<Session>(`${s(id)}/mode`, req),
      /** The chat's rules, each with its source (the session's, its agent's or the company's), and the rules files that
       *  don't load, while which every command asks. */
      rules: async (id: string) => get<RuleList>(`${s(id)}/rules`),
      /** Removes a session or agent rule; only the chat's approver may, and a company rule only by editing rules.yaml. */
      removeRule: async (id: string, req: RemoveRuleRequest) => post<Ack>(`${s(id)}/rules/remove`, req),
      /** The session's shells and harness sessions, oldest first; their output comes as `instrument.output` events. */
      instruments: async (id: string) => get<Instrument[]>(`${s(id)}/instruments`),
      /**
       * What the office still holds of a shell's raw output, for a view joining late; the view then applies the
       * `instrument.output` bytes past the screen's `end`.
       */
      instrumentScreen: async (id: string, iid: string) => get<InstrumentScreen>(`${instrument(id, iid)}/screen`),
      /**
       * The approver's keys to a shell, as typed; the office never logs or records them. Calls to one shell go one at
       * a time, in call order, and a refused one doesn't hold back the next.
       */
      keys: async (id: string, iid: string, req: InstrumentKeysRequest) => typeAt(`${instrument(id, iid)}/keys`, req),
      /** The size the approver's view draws a shell at, which its PTY takes and every other view then draws at. */
      resize: async (id: string, iid: string, req: InstrumentSizeRequest) =>
        post<Ack>(`${instrument(id, iid)}/size`, req),
      /** The approver closes a shell, as the agent's close does, signed as them; the agent is told. */
      closeShell: async (id: string, iid: string) => post<Ack>(`${instrument(id, iid)}/close`),
    },
    connections: {
      list: () => get<ConnectionList>("/connections"),
      /** The models a connection offers, as the office last listed them; `refresh` lists them again. */
      models: async (name: string, opts: { refresh?: boolean } = {}) =>
        get<ModelList>(`${connection(name)}/models${query({ refresh: opts.refresh ? 1 : undefined })}`),
      add: (req: AddConnectionRequest) =>
        request<Connection>(transport, "POST", "/connections", req, { timeoutMs: ADD_CONNECTION_TIMEOUT_MS, token }).catch(
          (e) => {
            if (e instanceof OfficeTimeout) e.message += "; the connection may have been added, so look in /connect"
            throw e
          },
        ),
      remove: async (name: string) => call<Ack>("DELETE", connection(name)),
      setDefault: (req: SetDefaultConnectionRequest) => call<ConnectionList>("PUT", "/connections/default", req),
      /** Starts a subscription sign-in, which adds a connection once the human approves it at its URL with its code. */
      startLogin: (req: StartLoginRequest) =>
        request<ConnectionLogin>(transport, "POST", "/connections/login", req, { timeoutMs: START_LOGIN_TIMEOUT_MS, token }),
      /** A sign-in this person started, as it is now. */
      login: async (id: string) => get<ConnectionLogin>(signIn(id)),
      cancelLogin: async (id: string) => call<Ack>("DELETE", signIn(id)),
    },
    workItems: {
      get: async (id: string) => get<WorkItem>(workItem(id)),
      comments: async (id: string) => get<Comment[]>(`${workItem(id)}/comments`),
    },
    questions: {
      /** Questions by session and status, oldest first; several statuses are sent comma-separated. */
      list: (opts: { session?: string; status?: Question["status"] | Question["status"][] } = {}) =>
        get<Question[]>(
          `/questions${query({ session: opts.session, status: joined(opts.status) })}`,
        ),
      get: async (id: string) => get<Question>(q(id)),
      answer: async (id: string, req: AnswerRequest) => post<Question>(`${q(id)}/answer`, req),
      side: async (id: string, req: SideChatRequest) => post<Session>(`${q(id)}/side`, req),
      sendBack: async (id: string, req: SendBackRequest) => post<Question>(`${q(id)}/send-back`, req),
      stop: async (id: string) => post<Question>(`${q(id)}/stop`),
      dismissCarried: async (id: string) => post<Question>(`${q(id)}/carried/dismiss`),
    },
    profiles: {
      get: async (handle: string) => get<Profile>(profile(handle)),
      put: async (handle: string, req: ProfileWriteRequest) => call<Profile>("PUT", profile(handle), req),
      manager: async (handle: string, req: ProfileManagerRequest) => post<Session>(`${profile(handle)}/manager`, req),
      proposals: async (handle: string) => get<ProfileProposal[]>(`${profile(handle)}/proposals`),
    },
    proposals: {
      apply: async (id: string) =>
        post<Profile>(`/profile-proposals/${part(id, `no profile proposal ${id}`)}/apply`),
    },
    events: {
      /** Follows `GET /events`, reconnecting until `close()`; see `subscribe`. */
      subscribe: (handler: (e: StreamEvent) => void, opts?: SubscribeOptions) => subscribe(transport, handler, { token, ...opts }),
    },
  }
}

/**
 * `GET /runs`'s filters and paging. `status` is one status or several (a run matches any of them); `since` (inclusive)
 * and `until` (exclusive) are Timestamps bounding when a run was launched. `recent`, a Timestamp, keeps open runs of
 * any age and runs launched at or after it; the office refuses it alongside `since` or `until`.
 */
export type RunListOptions = {
  flow?: string
  person?: string
  status?: RunSummary["status"] | RunSummary["status"][]
  since?: string
  until?: string
  recent?: string
  q?: string
  before?: string
  limit?: number
}

/** `id` as one path segment; throws not_found (with `missing`) for one no request can carry, as no record has it. */
function part(id: string, missing: string) {
  if (!isSegment(id)) throw new OfficeError(404, "not_found", missing)
  return seg(id)
}

/**
 * A live stream that ends `closed` with `error` without opening, reported on a later tick as `runLive` reports a
 * failure, and not at all once closed or aborted.
 */
function refusedLive(error: unknown, handler: (f: RunLiveFrame) => void, signal?: AbortSignal) {
  let closed = false
  queueMicrotask(() => {
    if (!closed && !signal?.aborted) handler({ type: "closed", error })
  })
  return {
    close() {
      closed = true
    },
  }
}

/** One value or several, comma-joined; undefined for none. */
const joined = (value?: string | string[]) => [value ?? []].flat().join(",") || undefined

/** `opts` as query params, the statuses comma-joined. */
const runParams = (opts: RunListOptions) => ({ ...opts, status: joined(opts.status) })

function query(params: Record<string, string | number | undefined>) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][]
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : ""
}
