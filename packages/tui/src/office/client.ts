import type {
  Ack,
  AddDeviceRequest,
  AnswerRequest,
  Comment,
  ConfirmFollowUpsRequest,
  CostCapRequest,
  CreateSessionRequest,
  Debrief,
  Feedback,
  FeedbackRequest,
  HireRequest,
  HireResponse,
  LoginRequest,
  Message,
  Person,
  Profile,
  ProfileManagerRequest,
  ProfileProposal,
  ProfileWriteRequest,
  PromptRequest,
  Question,
  SendBackRequest,
  Session,
  SetPasswordRequest,
  SideChatRequest,
  WorkItem,
} from "@agent-corp/protocol"
import { request, seg, type Method } from "./http"
import { subscribe, type StreamEvent, type SubscribeOptions } from "./sse"

export type OfficeClient = ReturnType<typeof createOfficeClient>

/** How long a read waits for the office before failing with `OfficeTimeout`. */
export const READ_TIMEOUT_MS = 15_000

/** Who the office takes a request to be from: `GET /whoami`. */
export type WhoAmI = { person: string; device: string | null }

/**
 * A typed client for the office's HTTP API on `socket`, sending `token` (this device's) with
 * every request. Every method throws `OfficeError` on failure, `UnknownDevice` on a 401.
 */
export function createOfficeClient(opts: { socket: string; timeoutMs?: number; token?: string }) {
  const { socket, timeoutMs = READ_TIMEOUT_MS, token } = opts
  const call = <T>(method: Method, path: string, body?: unknown) => request<T>(socket, method, path, body, { token })
  // A hung read would stall the bootstrap or a session load forever; writes aren't retried,
  // so they wait for the office's answer.
  const get = <T>(path: string) => request<T>(socket, "GET", path, undefined, { timeoutMs, token })
  const post = <T>(path: string, body?: unknown) => call<T>("POST", path, body)
  const s = (id: string) => `/sessions/${seg(id)}`
  const q = (id: string) => `/questions/${seg(id)}`
  return {
    socket,
    whoami: () => get<WhoAmI>("/whoami"),
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
      list: (opts: { person?: string; limit?: number } = {}) => get<Session[]>(`/sessions${query(opts)}`),
      create: (req: CreateSessionRequest) => post<Session>("/sessions", req),
      get: (id: string) => get<Session>(s(id)),
      messages: (id: string) => get<Message[]>(`${s(id)}/messages`),
      prompt: (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/prompt`, req),
      steer: (id: string, req: PromptRequest) => post<Ack>(`${s(id)}/steer`, req),
      interrupt: (id: string) => post<Ack>(`${s(id)}/interrupt`),
      end: (id: string) => post<Ack>(`${s(id)}/end`),
      costCap: (id: string, req: CostCapRequest) => post<Session>(`${s(id)}/cost-cap`, req),
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
      subscribe: (handler: (e: StreamEvent) => void, opts?: SubscribeOptions) => subscribe(socket, handler, { token, ...opts }),
    },
  }
}

function query(params: Record<string, string | number | undefined>) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][]
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : ""
}
