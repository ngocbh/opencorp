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
  ConfirmFollowUpsRequest,
  Connection,
  ConnectionList,
  ConnectionLogin,
  CostCapRequest,
  CostReport,
  CreateSessionRequest,
  Debrief,
  Feedback,
  FeedbackRequest,
  Health,
  HireRequest,
  HireResponse,
  HqLoginRequest,
  HqStatus,
  LoginRequest,
  Message,
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
  RunDetail,
  RunEvent,
  RunEventPage,
  RunNodePage,
  RunPage,
  RunSummary,
  SendBackRequest,
  Session,
  SetDefaultConnectionRequest,
  SetModelRequest,
  SetPasswordRequest,
  SideChatRequest,
  StartLoginRequest,
  WorkItem,
} from "@opencorp/protocol"
import { OfficeError, OfficeTimeout, UnknownDevice } from "./errors"
import { request, seg, transportOf, where, type Method, type Transport } from "./http"
import { subscribe, type StreamEvent, type SubscribeOptions } from "./sse"

export type OfficeClient = ReturnType<typeof createOfficeClient>

/** How long a read waits for the office before failing with `OfficeTimeout`. */
export const READ_TIMEOUT_MS = 15_000

/** How long starting a chat waits for the office before failing with `OfficeTimeout`. */
export const CREATE_TIMEOUT_MS = 30_000

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
  const s = (id: string) => `/sessions/${seg(id)}`
  const q = (id: string) => `/questions/${seg(id)}`
  const r = (id: string) => `/runs/${seg(id)}`
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
      /** Top-level runs, newest first, each with its children; `before` is the last page's `next`. */
      list: (
        opts: { flow?: string; person?: string; status?: RunSummary["status"]; q?: string; before?: string; limit?: number } = {},
      ) => get<RunPage>(`/runs${query(opts)}`),
      /** Every run started from run `id`: the list's "Show all". */
      children: (id: string) => get<RunSummary[]>(`/runs${query({ parent: id })}`),
      /** One run's header: summary, parent, children, fingerprint, pinned commit, models, usage and log state. */
      get: (id: string) => get<RunDetail>(r(id)),
      /**
       * Node attempts, newest start first; `before` is the last page's `next_before`. Fails with
       * `isUnsupportedSchema`, `isNoLog` or `isSecretsUnavailable`.
       */
      nodes: (id: string, before?: number) => get<RunNodePage>(`${r(id)}/nodes${query({ before })}`),
      /** Records after seq `after`, scrubbed, evidence left out; fails as `nodes` does. */
      events: (id: string, after?: number) => get<RunEventPage>(`${r(id)}/events${query({ after })}`),
      /** One record by seq, scrubbed, evidence included; fails as `nodes` does, or with `isIndexing`. */
      event: (id: string, seq: number) => get<RunEvent>(`${r(id)}/events/${seq}`),
      /** Where the scrubbed log downloads from, for a link (HQ only: the browser's cookie authorizes it). */
      logUrl: (id: string) => `${socket}${r(id)}/log`,
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
      removeBrowser: (id: string) => call<Ack>("DELETE", `/hq/browsers/${seg(id)}`),
    },
    /** Adds a device for a human who gives their password; served without a token. */
    login: (req: LoginRequest) => post<Person>("/login", req),
    people: {
      list: () => get<Person[]>("/people"),
      inFolder: (cwd: string) => get<Person[]>(`/folders/${seg(cwd)}/people`),
      hire: (req: HireRequest) => post<HireResponse>("/people", req),
      setPassword: (person: string, req: SetPasswordRequest) =>
        call<Person>("PUT", `/people/${seg(person)}/password`, req),
    },
    devices: {
      add: (person: string, req: AddDeviceRequest) => post<Person>(`/people/${seg(person)}/devices`, req),
      remove: (person: string, name: string) => call<Person>("DELETE", `/people/${seg(person)}/devices/${seg(name)}`),
    },
    sessions: {
      /** Sessions, newest updated first; several statuses are sent comma-separated. */
      list: (opts: { person?: string; limit?: number; status?: Session["status"] | Session["status"][] } = {}) =>
        get<Session[]>(
          `/sessions${query({
            person: opts.person,
            limit: opts.limit,
            status: [opts.status ?? []].flat().join(",") || undefined,
          })}`,
        ),
      // Starting a chat may wait up to 8 s for the connections' model lists, so it gets a limit of its own.
      create: (req: CreateSessionRequest) =>
        request<Session>(transport, "POST", "/sessions", req, { timeoutMs: CREATE_TIMEOUT_MS, token }).catch((e) => {
          if (e instanceof OfficeTimeout)
            e.message += "; the chat may have started, so look for it in the session list (/sessions)"
          throw e
        }),
      get: (id: string) => get<Session>(s(id)),
      messages: (id: string) => get<Message[]>(`${s(id)}/messages`),
      prompt: (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/prompt`, req),
      steer: (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/steer`, req),
      interrupt: (id: string) => post<Ack>(`${s(id)}/interrupt`),
      end: (id: string) => post<Ack>(`${s(id)}/end`),
      /** Continues an ended Codex session on its thread, as a new session. */
      continue: (id: string) =>
        request<Session>(transport, "POST", `${s(id)}/continue`, undefined, { timeoutMs: CREATE_TIMEOUT_MS, token }),
      costCap: (id: string, req: CostCapRequest) => post<Session>(`${s(id)}/cost-cap`, req),
      /** Switches a live chat's connection and model; its next reply runs on them. */
      setModel: (id: string, req: SetModelRequest) => post<Session>(`${s(id)}/model`, req),
    },
    connections: {
      list: () => get<ConnectionList>("/connections"),
      /** The models a connection offers, as the office last listed them; `refresh` lists them again. */
      models: (name: string, opts: { refresh?: boolean } = {}) =>
        get<ModelList>(`/connections/${seg(name)}/models${query({ refresh: opts.refresh ? 1 : undefined })}`),
      add: (req: AddConnectionRequest) =>
        request<Connection>(transport, "POST", "/connections", req, { timeoutMs: ADD_CONNECTION_TIMEOUT_MS, token }).catch(
          (e) => {
            if (e instanceof OfficeTimeout) e.message += "; the connection may have been added, so look in /connect"
            throw e
          },
        ),
      remove: (name: string) => call<Ack>("DELETE", `/connections/${seg(name)}`),
      setDefault: (req: SetDefaultConnectionRequest) => call<ConnectionList>("PUT", "/connections/default", req),
      /** Starts a subscription sign-in, which adds a connection once the human approves it at its URL with its code. */
      startLogin: (req: StartLoginRequest) =>
        request<ConnectionLogin>(transport, "POST", "/connections/login", req, { timeoutMs: START_LOGIN_TIMEOUT_MS, token }),
      /** A sign-in this person started, as it is now. */
      login: (id: string) => get<ConnectionLogin>(`/connections/login/${seg(id)}`),
      cancelLogin: (id: string) => call<Ack>("DELETE", `/connections/login/${seg(id)}`),
    },
    workItems: {
      get: (id: string) => get<WorkItem>(`/work-items/${seg(id)}`),
      comments: (id: string) => get<Comment[]>(`/work-items/${seg(id)}/comments`),
    },
    questions: {
      /** Questions by session and status, oldest first; several statuses are sent comma-separated. */
      list: (opts: { session?: string; status?: Question["status"] | Question["status"][] } = {}) =>
        get<Question[]>(
          `/questions${query({ session: opts.session, status: [opts.status ?? []].flat().join(",") || undefined })}`,
        ),
      get: (id: string) => get<Question>(q(id)),
      answer: (id: string, req: AnswerRequest) => post<Question>(`${q(id)}/answer`, req),
      side: (id: string, req: SideChatRequest) => post<Session>(`${q(id)}/side`, req),
      sendBack: (id: string, req: SendBackRequest) => post<Question>(`${q(id)}/send-back`, req),
      stop: (id: string) => post<Question>(`${q(id)}/stop`),
      dismissCarried: (id: string) => post<Question>(`${q(id)}/carried/dismiss`),
    },
    profiles: {
      get: (person: string) => get<Profile>(`/profiles/${seg(person)}`),
      put: (person: string, req: ProfileWriteRequest) => call<Profile>("PUT", `/profiles/${seg(person)}`, req),
      manager: (person: string, req: ProfileManagerRequest) => post<Session>(`/profiles/${seg(person)}/manager`, req),
      proposals: (person: string) => get<ProfileProposal[]>(`/profiles/${seg(person)}/proposals`),
    },
    proposals: { apply: (id: string) => post<Profile>(`/profile-proposals/${seg(id)}/apply`) },
    feedback: { create: (req: FeedbackRequest) => post<Feedback>("/feedback", req) },
    debriefs: {
      get: (session: string) => get<Debrief>(`/debriefs/${seg(session)}`),
      confirm: (session: string, req: ConfirmFollowUpsRequest) =>
        post<Debrief>(`/debriefs/${seg(session)}/confirm`, req),
    },
    events: {
      /** Follows `GET /events`, reconnecting until `close()`; see `subscribe`. */
      subscribe: (handler: (e: StreamEvent) => void, opts?: SubscribeOptions) => subscribe(transport, handler, { token, ...opts }),
    },
  }
}

function query(params: Record<string, string | number | undefined>) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][]
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : ""
}
