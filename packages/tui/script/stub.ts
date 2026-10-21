// A stand-in office for tests and `bun run dev`: an in-memory office on a unix socket that
// speaks the office's HTTP routes and SSE framing, with no Python.
import type {
  BrowserSession,
  Comment,
  Connection,
  ConnectionList,
  ConnectionLogin,
  Debrief,
  Event,
  Feedback,
  HireRequest,
  HireResponse,
  HqStatus,
  LiveEvent,
  Message,
  ModelList,
  PairCode,
  PairCodeRequest,
  Person,
  Profile,
  ProfileProposal,
  PromptRequest,
  RepoIssue,
  Question,
  Session,
  WorkItem,
} from "@opencorp/protocol"
import { createTwoFilesPatch } from "diff"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { TuiInput } from "../src/app"
import { isTurn } from "@opencorp/client"
import { HANDLE, harnessesOf } from "../src/routes/picker/people"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"

/** Returns `run()` input (minus `args`) wired to `office`, or to a socket nothing listens on. */
export function createStub(office?: FakeOffice): Omit<TuiInput, "args"> {
  return { socket: office?.socket ?? "/tmp/act-none/o.sock", cwd: "/tmp/proj", config: createTuiResolvedConfig() }
}

/** Serves `fetch` on a new unix socket under /tmp (macOS caps socket paths at 104 bytes). */
export function serveUnix(fetch: (req: Request) => Response | Promise<Response>, socket?: string) {
  const dir = socket ? undefined : mkdtempSync("/tmp/act-")
  const at = socket ?? path.join(dir!, "o.sock")
  // Bun's types omit idleTimeout for unix sockets, but it still applies: without 0 an event
  // stream that is quiet for 10 s is closed.
  const server = Bun.serve({ unix: at, fetch, ...({ idleTimeout: 0 } as {}) })
  return {
    socket: at,
    stop: () => {
      server.stop(true)
      rmSync(dir ?? at, { recursive: true, force: true })
    },
  }
}

export type FakeState = {
  people: Person[]
  /** cwd → handles, most recent first. */
  folders: Record<string, string[]>
  sessions: Session[]
  messages: Record<string, Message[]>
  questions: Record<string, Question>
  profiles: Record<string, Profile>
  proposals: Record<string, ProfileProposal>
  workItems: Record<string, WorkItem>
  comments: Record<string, Comment[]>
  debriefs: Record<string, Debrief>
  feedback: Feedback[]
  /** Hire previews by handle. */
  hires: Record<string, HireRequest>
  /** The office's model connections, in the order it lists them; `default` comes from `defaultConnection`. */
  connections: Connection[]
  defaultConnection: string
  /** What each connection's models route answers; a connection with none offers only its own model. */
  models: Record<string, ModelList>
  /** Who may add, remove or set the default connection. */
  managers: string[]
}

const now = () => new Date().toISOString()

/** Words a side chat refuses, in any case: only the office ends a side run. */
const SIDE_EXIT = new Set(["/end", "/exit", "/quit"])
/** The connection the office sets up at onboarding, which can't be removed. */
const OFFICE = "office"
/** The providers composer has a default model for; any other needs one named. */
const DEFAULT_MODELS = new Set(["openai", "anthropic"])
/** Statuses with a live run, which take interrupt and end. */
const LIVE: Session["status"][] = ["starting", "idle", "busy", "waiting", "ending"]

/** A git blob id for `text`, so fake profile versions look like the office's. */
export function blobId(text: string) {
  const body = Buffer.from(text)
  return new Bun.CryptoHasher("sha1").update(`blob ${body.length}\0`).update(body).digest("hex")
}

/** Ids that sort like ULIDs: a 26-character, zero-padded counter. */
function counter() {
  let n = 0
  return () => String(++n).padStart(26, "0")
}

/**
 * A seeded office: @minh (agent, worked in /tmp/proj), @ngocbh (human, who manages connections),
 * one idle main session waiting on its first turn, and two Azure connections.
 */
export function seed(nextId = counter()): FakeState {
  const at = now()
  const people: Person[] = [
    { handle: "minh", name: "Minh", kind: "agent", title: "Software engineer", manager: "ngocbh" },
    { handle: "ngocbh", name: "Ngoc Bui", kind: "human", title: "CEO", manager: null },
  ]
  const session: Session = {
    id: nextId(),
    person: "minh",
    harness: "composer",
    office: "laptop",
    cwd: "/tmp/proj",
    repo_commit: blobId("company"),
    status: "idle",
    kind: "main",
    cost: 0,
    cost_cap_usd: null,
    created_at: at,
    updated_at: at,
  }
  // An idle chat waits on its open turn, the chat flow's `chat#1/ask` human_input.
  const turn: Question = {
    id: nextId(),
    session_id: session.id,
    run_id: "run-1",
    node_id: "chat#1/ask",
    source: "human_input",
    asker: "minh",
    question: "You:",
    status: "open",
    created_at: at,
    updated_at: at,
  }
  const profile = "# Minh\n\nWrites small, tested changes.\n"
  return {
    people,
    folders: { "/tmp/proj": ["minh"] },
    sessions: [session],
    messages: { [session.id]: [] },
    questions: { [turn.id]: turn },
    profiles: { minh: { person: "minh", text: profile, version: blobId(profile), over_budget: false } },
    proposals: {},
    workItems: {},
    comments: {},
    debriefs: {},
    feedback: [],
    hires: {},
    connections: [
      { name: OFFICE, provider: "azure", method: "api_key", model: "gpt-4o" },
      { name: "azure-2", provider: "azure", method: "api_key", model: "gpt-4o-mini" },
    ],
    defaultConnection: OFFICE,
    models: {
      [OFFICE]: { connection: OFFICE, models: [{ id: "gpt-4.1" }, { id: "gpt-4o" }], listed: true, error: null },
      "azure-2": { connection: "azure-2", models: [{ id: "gpt-4o-mini" }, { id: "o3-mini" }], listed: true, error: null },
    },
    managers: ["ngocbh"],
  }
}

/** `actor` is who the request acts as and `device` the device it came from, as the office's `/whoami` says. */
type Ctx = {
  params: Record<string, string>
  query: URLSearchParams
  body: any
  path: string
  actor: string
  device: string | null
}
type Handler = (ctx: Ctx) => Response | Promise<Response>
type Stream = { ctl: ReadableStreamDefaultController<Uint8Array>; session?: string }

/** Thrown by a handler to answer with an `ApiError` body. */
class Fail {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly message: string,
  ) {}
}

export type FakeOffice = ReturnType<typeof createFakeOffice>

/** An in-memory office on a unix socket, speaking the office's HTTP routes and SSE framing. */
export function createFakeOffice(
  opts: {
    seed?: FakeState
    socket?: string
    notImplemented?: Iterable<string>
    /** Route keys an older office doesn't have: it answers them `404 no_route`. */
    missing?: Iterable<string>
    /** The company's `profile_max_chars`; a longer profile is `over_budget`. */
    profileMaxChars?: number
    /** HQ's TCP listener: off by default; on, it listens unless `listening` is false (`error` says why not). */
    hq?: { tcp?: boolean; listening?: boolean; port?: number; error?: string }
  } = {},
) {
  const nextId = counter()
  const profileMaxChars = opts.profileMaxChars ?? 32000
  const state = opts.seed ?? seed(nextId)
  const notImplemented = new Set(opts.notImplemented ?? [])
  const broken = new Set<string>()
  const missing = new Set(opts.missing ?? [])
  const staleOnAnswer = new Set<string>()
  const requests: { method: string; path: string; raw: string; body: unknown; at: number; authorization?: string }[] = []
  // Humans' passwords by handle, kept as given: the office keeps only a hash, and never serves it.
  const passwords = new Map<string, string>()
  const holds = new Map<string, Promise<void>>()
  const replyHolds = new Map<string, Promise<void>>()
  const refusals: { error: string; message: string }[] = []
  const loginFailures: string[] = []
  const loginCodeReads: number[] = []
  // Subscription sign-ins by id, with who started each, how often it was read, the read that brings its code, and
  // why it will fail, if it will.
  const logins = new Map<
    string,
    { login: ConnectionLogin; by: string; polls: number; codeAt: number; failure?: string }
  >()
  const CODE = { url: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH" }
  const prompts: ((sessionId: string, req: PromptRequest) => void)[] = []
  const interrupts: ((sessionId: string) => void)[] = []
  // Messages sent with no open turn and no reply running, by session; the next turn takes them.
  const queued = new Map<string, string[]>()
  const streams = new Set<Stream>()
  const encoder = new TextEncoder()
  // The run each debrief was written in; the protocol's Debrief doesn't carry it.
  const debriefRuns = new Map<string, string>()

  const fail = (status: number, error: string, message: string) => new Fail(status, error, message)
  const refused = () => fail(422, "refused", "use /back to return to the question")
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw fail(404, "not_found", `no ${what}`)
    return value
  }
  const check = (ok: unknown, message: string) => {
    if (!ok) throw fail(422, "invalid_body", message)
  }
  const str = (v: unknown) => typeof v === "string" && v.length > 0
  const human = () => state.people.find((p) => p.kind === "human")?.handle ?? "ngocbh"
  const ceo = () => state.people.find((p) => p.kind === "human" && !p.manager)?.handle ?? human()

  /**
   * Who a request with `header` acts as, as the office decides: a token must be one a human lists;
   * no token acts as the CEO until some human has a device.
   */
  function authenticate(header: string | null): { actor: string; device: string | null } {
    const humans = state.people.filter((p) => p.kind === "human")
    if (header === null) {
      if (humans.some((p) => p.devices?.length))
        throw fail(401, "unauthenticated", "this office needs a device token; run `opencorp login`")
      return { actor: ceo(), device: null }
    }
    const token = /^bearer +(act_[A-Za-z0-9_-]{43})$/i.exec(header)?.[1]
    if (!token) throw fail(401, "bad_token", "the Authorization header isn't `Bearer <device token>`")
    const hash = createHash("sha256").update(token).digest("hex")
    for (const p of humans)
      for (const d of p.devices ?? []) if (d.token_sha256 === hash) return { actor: p.handle, device: d.name }
    throw fail(401, "bad_token", "the office doesn't know this device; run `opencorp login`")
  }

  /** The human `handle`, if `actor` may change their `what`: themselves, or the CEO. */
  function deviceOwner(handle: string, actor: string, what = "devices") {
    const person = need(
      state.people.find((p) => p.handle === handle),
      `person @${handle}`,
    )
    if (person.kind !== "human") throw fail(422, "not_a_human", `@${handle} is an agent; agents have no ${what}`)
    if (actor !== handle && actor !== ceo())
      throw fail(403, "forbidden", `only @${handle} or the CEO can change @${handle}'s ${what}`)
    return person
  }

  function addDevice(handle: string, body: any, actor: string) {
    check(
      typeof body?.name === "string" && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(body.name),
      "name must be a device name",
    )
    check(typeof body.token_sha256 === "string" && /^[0-9a-f]{64}$/.test(body.token_sha256), "token_sha256 must be a sha256")
    check(Object.keys(body).length === 2, "only name and token_sha256 are allowed")
    const person = deviceOwner(handle, actor)
    const same = person.devices?.find((d) => d.name === body.name)
    if (same?.token_sha256 === body.token_sha256) return person
    if (same) throw fail(409, "device_exists", `@${handle} already has a device named ${body.name}`)
    if (state.people.some((p) => p.devices?.some((d) => d.token_sha256 === body.token_sha256)))
      throw fail(409, "token_in_use", "another device already lists this token")
    person.devices = [...(person.devices ?? []), { name: body.name, token_sha256: body.token_sha256 }]
    return person
  }

  function login(body: any) {
    check(str(body?.handle) && str(body.password), "handle and password are required")
    const person = state.people.find((p) => p.handle === body.handle && p.kind === "human")
    if (person && !passwords.has(person.handle))
      throw fail(409, "no_password", `@${person.handle} has no password; set one with \`opencorp password\``)
    if (!person || passwords.get(person.handle) !== body.password)
      throw fail(401, "bad_login", "wrong handle or password")
    return addDevice(body.handle, { name: body.device, token_sha256: body.token_sha256 }, body.handle)
  }

  function setPassword(handle: string, body: any, actor: string) {
    check(typeof body?.password === "string" && body.password.length >= 12, "use at least 12 characters")
    deviceOwner(handle, actor, "password")
    passwords.set(handle, body.password)
    return state.people.find((p) => p.handle === handle)!
  }

  function removeDevice(handle: string, name: string, actor: string) {
    const person = deviceOwner(handle, actor)
    need(
      person.devices?.find((d) => d.name === name),
      `device ${name} for @${handle}`,
    )
    person.devices = person.devices!.filter((d) => d.name !== name)
    // An empty list drops the field, as the office writes person.yaml.
    if (!person.devices.length) delete person.devices
    return person
  }

  function write(text: string, filter?: (s: Stream) => boolean) {
    for (const s of streams) {
      if (filter && !filter(s)) continue
      try {
        s.ctl.enqueue(encoder.encode(text))
      } catch {
        streams.delete(s)
      }
    }
  }
  function closeAll() {
    for (const s of streams) {
      try {
        s.ctl.close()
      } catch {}
    }
    streams.clear()
  }

  /** Publishes a metadata event, as the office's outbox would. */
  function emit(e: Event) {
    const wants = (s: Stream) => !s.session || e.subject_id === s.session || e.data.session_id === s.session
    write(`event: meta\nid: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`, wants)
  }
  /** Publishes a live transcript event. */
  function live(e: LiveEvent) {
    write(`event: live\ndata: ${JSON.stringify(e)}\n\n`, (s) => !s.session || s.session === e.session_id)
  }
  const publish = (type: Event["type"], subject: string, data: object) =>
    emit({ id: nextId(), type, at: now(), subject_id: subject, data: structuredClone(data) as Event["data"] })

  const session = (id: string) =>
    need(
      state.sessions.find((s) => s.id === id),
      `session ${id}`,
    )
  function upsertSession(s: Session, type: "session.created" | "session.updated" = "session.updated") {
    const i = state.sessions.findIndex((x) => x.id === s.id)
    if (i >= 0) state.sessions[i] = s
    else state.sessions.unshift(s)
    state.messages[s.id] ??= []
    publish(type, s.id, s)
    return s
  }
  function setStatus(id: string, status: Session["status"]) {
    return upsertSession({ ...session(id), status, updated_at: now() })
  }
  /** Creates a session (an idle composer one waits on its first turn), as `POST /sessions` would. */
  function newSession(fields: Partial<Session> & Pick<Session, "person" | "cwd">): Session {
    const at = now()
    const s = upsertSession(
      {
        id: nextId(),
        harness: "composer",
        office: "laptop",
        repo_commit: blobId("company"),
        status: "idle",
        kind: "main",
        cost: 0,
        cost_cap_usd: null,
        created_at: at,
        updated_at: at,
        ...fields,
      },
      "session.created",
    )
    // A Codex session has no turn questions: every message is a Codex turn.
    if (s.status === "idle" && s.harness !== "codex") openTurn(s.id)
    return s
  }
  function userMessage(sessionId: string, text: string, author?: string) {
    const msg: Message = {
      id: nextId(),
      session_id: sessionId,
      role: "user",
      parts: [{ id: nextId(), type: "text", text }],
      created_at: now(),
      ...(author ? { author } : {}),
    }
    state.messages[sessionId] = [...(state.messages[sessionId] ?? []), msg]
    live({ type: "message.updated", session_id: sessionId, data: structuredClone(msg) as unknown as LiveEvent["data"] })
    return msg
  }
  /** A session with a live run, else the office's `409 not_live`. */
  function liveSession(id: string) {
    const s = session(id)
    if (!LIVE.includes(s.status)) throw fail(409, "not_live", `session ${id} has no live run`)
    return s
  }
  /** Adds a side chat's user message to its question's discussion. */
  function discuss(side: Session, text: string) {
    const q = side.question_id ? state.questions[side.question_id] : undefined
    if (!q) return
    updateQuestion({ ...q, discussion: [...(q.discussion ?? []), { role: "user", text }], updated_at: now() })
  }
  /**
   * The office's prompt: answers the open turn and starts a reply; while a reply runs it is a
   * steer (written to the transcript, no new reply); otherwise it is queued for the next turn.
   */
  function turn(id: string, body: any, actor?: string) {
    check(str(body?.text), "text must be a non-empty string")
    const s = liveSession(id)
    if (s.status === "ending") throw fail(409, "ending", `session ${id} is ending`)
    if (s.harness === "codex") {
      // Codex takes every message as a turn, or as a steer of the running one; the sender is its author.
      userMessage(id, body.text, actor)
      if (s.status !== "busy") setStatus(id, "busy")
      return Response.json({ ok: true })
    }
    if (s.kind === "side" && SIDE_EXIT.has(body.text.trim().toLowerCase())) throw refused()
    userMessage(id, body.text)
    if (s.kind === "side") discuss(s, body.text)
    const open = Object.values(state.questions).find((q) => q.session_id === id && q.status === "open" && isTurn(q))
    if (open) takeTurn(open, body.text)
    else if (s.status !== "busy") queued.set(id, [...(queued.get(id) ?? []), body.text])
    return Response.json({ ok: true })
  }
  /** Answers a turn with `text` and starts its reply. */
  function takeTurn(q: Question, text: string) {
    const answered = { status: "answered", answer: text, answer_kind: "text", answered_by: human() } as const
    updateQuestion({ ...q, ...answered, updated_at: now() })
    setStatus(q.session_id, "busy")
    for (const fn of prompts) fn(q.session_id, { text })
  }
  /**
   * Esc: answers the open `ask_user` questions (of one run, when given) and stops the reply. The
   * session stays busy until the stopped reply's next turn opens; `onInterrupt` drivers open it.
   */
  function interrupt(s: Session, runId?: string) {
    for (const q of Object.values(state.questions))
      if (q.session_id === s.id && q.status === "open" && q.source === "ask_user" && (!runId || q.run_id === runId))
        close(q.id, { answer: "[interrupted by the user]", answer_kind: "interrupted" })
    for (const fn of interrupts) fn(s.id)
  }

  const question = (id: string) => need(state.questions[id], `question ${id}`)
  function updateQuestion(q: Question, type: "question.created" | "question.updated" = "question.updated") {
    state.questions[q.id] = q
    publish(type, q.id, q)
    return q
  }
  function close(id: string, fields: Partial<Question>) {
    const q = question(id)
    if (q.status !== "open") throw fail(409, "not_open", `question ${id} is ${q.status}, not open`)
    // The office ends a question's side chat when the question closes.
    const side = state.sessions.find((s) => s.id === q.side_session_id)
    if (side && side.status !== "ended") setStatus(side.id, "ended")
    return updateQuestion({ ...q, status: "answered", answered_by: human(), updated_at: now(), ...fields })
  }
  /** Marks an open question stale, as the office does when its run restarts, and ends its side chat. */
  function expire(id: string) {
    const q = question(id)
    const side = state.sessions.find((s) => s.id === q.side_session_id)
    if (side && side.status !== "ended") setStatus(side.id, "ended")
    return updateQuestion({ ...q, status: "stale", updated_at: now() })
  }
  /**
   * The office's answer check, loosely: a model question takes text (an option one of its
   * options), a question with pages a record with a label (a list for multi-select) per header.
   */
  function checkAnswer(q: Question, answer: unknown, kind: string) {
    const invalid = (message: string) => fail(422, "invalid_answer", message)
    const label = (v: unknown) => typeof v === "string" && v.trim().length > 0
    // A Codex question card (it has pages) is answered like a human_input; a Codex approval like a model question.
    if (q.source !== "human_input" && !(q.source === "harness" && q.questions?.length)) {
      if (!label(answer)) throw invalid("the answer must be text")
      if (kind === "option" && !q.options?.includes(answer as string))
        throw invalid(`${JSON.stringify(answer)} is not one of the options`)
      return
    }
    if (!q.questions?.length) return
    if (!answer || typeof answer !== "object" || Array.isArray(answer))
      throw invalid("the answer must be a record with one entry per question header")
    const record = answer as Record<string, unknown>
    const extra = Object.keys(record).find((h) => !q.questions!.some((p) => p.header === h))
    if (extra) throw invalid(`no question has the header ${JSON.stringify(extra)}`)
    for (const page of q.questions) {
      if (!(page.header in record)) throw invalid(`${JSON.stringify(page.header)} has no answer`)
      const value = record[page.header]
      const ok = page.multi_select ? Array.isArray(value) && value.every(label) : label(value)
      const shape = page.multi_select ? "a list of labels" : "one label"
      if (!ok) throw invalid(`${JSON.stringify(page.header)} takes ${shape}`)
    }
  }
  /**
   * An answer as the office stores it: on a card with a secret page, only its other pages' values are kept, and
   * anything else is `[secret]`.
   */
  function masked(q: Question, answer: unknown) {
    const pages = q.questions ?? []
    if (!pages.some((p) => p.secret)) return answer
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return "[secret]"
    const safe = new Set(pages.filter((p) => !p.secret).map((p) => p.header))
    return Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, safe.has(k) ? v : "[secret]"]))
  }
  /** An open question for send back or stop, which a `human_input` question doesn't offer (`code`). */
  function openModelQuestion(id: string, code: string) {
    const q = question(id)
    if (q.status !== "open") throw fail(409, "not_open", `question ${q.id} is ${q.status}, not open`)
    if (q.source === "human_input") throw fail(422, code, `question ${q.id} is a human_input`)
    return q
  }
  /** Opens a question in a session (the seeded one by default), as a harness `ask_user` would. */
  function addQuestion(fields: Partial<Question>) {
    const at = now()
    const q: Question = {
      id: nextId(),
      session_id: state.sessions[0]?.id ?? "",
      run_id: "run-1",
      node_id: null,
      source: "ask_user",
      asker: "minh",
      question: "Proceed?",
      status: "open",
      created_at: at,
      updated_at: at,
      ...fields,
    }
    return updateQuestion(q, "question.created")
  }
  /**
   * Opens a session's next turn, as the chat flow's `chat#N/ask` human_input does when a reply ends:
   * the session goes idle, or the queued messages take the turn at once.
   */
  function openTurn(sessionId: string) {
    const n = Object.values(state.questions).filter((q) => q.session_id === sessionId && isTurn(q)).length + 1
    const q = addQuestion({ session_id: sessionId, source: "human_input", node_id: `chat#${n}/ask`, question: "You:" })
    const pending = queued.get(sessionId)
    queued.delete(sessionId)
    if (pending) takeTurn(q, pending.join("\n\n"))
    else if (["busy", "starting"].includes(session(sessionId).status)) setStatus(sessionId, "idle")
    return question(q.id)
  }

  /**
   * Stores a session's debrief, as the office's debrief flow would, and publishes it. A ready
   * debrief ends a debriefing session; a pending one leaves it debriefing (the flow may still run).
   * `run` is the debrief's own run, which feedback may name once the debrief is ready.
   */
  function addDebrief(sessionId: string, fields: Partial<Debrief> = {}, opts: { run?: string } = {}) {
    const type = state.debriefs[sessionId] ? "debrief.updated" : "debrief.created"
    const s = session(sessionId)
    if (opts.run) debriefRuns.set(s.id, opts.run)
    const d: Debrief = { session_id: s.id, state: "ready", updated_at: now(), ...fields }
    state.debriefs[sessionId] = d
    publish(type, sessionId, d)
    if (d.state === "ready" && s.status === "debriefing") setStatus(s.id, "ended")
    return d
  }
  /** Moves a feedback item along the learning queue, as the office's backward job would. */
  function feedbackStatus(id: string, status: Feedback["status"], fields: Partial<Feedback> = {}) {
    const i = state.feedback.findIndex((f) => f.id === id)
    const f: Feedback = { ...need(state.feedback[i], `feedback ${id}`), status, ...fields }
    state.feedback[i] = f
    publish("feedback.updated", id, f)
    return f
  }

  function profile(person: string) {
    need(
      state.people.find((p) => p.handle === person),
      `person ${person}`,
    )
    const p = need(state.profiles[person], `profile for ${person}`)
    return { ...p, over_budget: p.text.length > profileMaxChars }
  }
  function writeProfile(person: string, text: string) {
    state.profiles[person] = { ...profile(person), text, version: blobId(text) }
    const p = profile(person)
    publish("profile.updated", person, p)
    return p
  }
  function updateProposal(p: ProfileProposal, type: "profile_proposal.created" | "profile_proposal.updated") {
    state.proposals[p.id] = p
    publish(type, p.id, p)
    return p
  }
  /**
   * Records the profile manager's proposal for a `profile_manager` session, as its propose tool
   * would: the diff is against the current profile, and the session's older open proposals are
   * discarded.
   */
  function propose(sessionId: string, text: string) {
    const s = session(sessionId)
    const current = profile(s.person)
    for (const old of Object.values(state.proposals))
      if (old.session_id === s.id && old.status === "open")
        updateProposal({ ...old, status: "discarded" }, "profile_proposal.updated")
    const file = `people/${s.person}/profile.md`
    // Without the `===` line, like the office's difflib diff.
    const diff = createTwoFilesPatch(`a/${file}`, `b/${file}`, current.text, text).replace(/^=+\n/, "")
    return updateProposal(
      {
        id: nextId(),
        session_id: s.id,
        person: s.person,
        base_version: current.version,
        text,
        diff,
        status: "open",
        commit: null,
        created_at: now(),
      },
      "profile_proposal.created",
    )
  }

  /**
   * The office's hire: a preview writes nothing and returns lint issues; a confirm must repeat the
   * preview's fields, and is refused while lint has an error or when the handle was never previewed.
   */
  function hire(body: any) {
    const fields = ["name", "handle", "title", "manager"] as const
    for (const f of fields) check(str(body?.[f]), `${f} must be a non-empty string`)
    const extra = Object.keys(body).filter((k) => ![...fields, "confirm"].includes(k))
    check(!extra.length, `unexpected fields: ${extra.join(", ")}`)
    check(HANDLE.test(body.handle), "handle must be lowercase letters, digits and dashes")
    const file = `people/${body.handle}/person.yaml`
    const issues: RepoIssue[] = [
      ...(state.people.some((p) => p.handle === body.handle)
        ? [{ path: file, code: "person.duplicate_handle", message: `@${body.handle} is already taken` }]
        : []),
      ...(state.people.some((p) => p.handle === body.manager)
        ? []
        : [{ path: file, code: "person.unknown_manager", message: body.manager }]),
    ].map((i) => ({ ...i, severity: "error" as const }))
    const person: Person = {
      handle: body.handle,
      name: body.name,
      kind: "agent",
      title: body.title,
      manager: body.manager,
    }
    const diff = `+++ b/${file}\n+name: ${person.name}\n+handle: ${person.handle}\n+kind: agent\n+title: ${person.title}\n+manager: ${person.manager}\n`
    if (!body.confirm) {
      state.hires[body.handle] = body
      return Response.json({ person, diff, issues, commit: null } satisfies HireResponse)
    }
    const previewed = state.hires[body.handle]
    // The office keeps previews in memory, so a hire it never previewed (or lost on restart) is a lint failure.
    if (!previewed) throw fail(422, "lint_failed", `no preview of @${body.handle}; preview it again`)
    if (fields.some((f) => previewed[f] !== body[f])) {
      throw fail(422, "lint_failed", "confirm must repeat the previewed fields")
    }
    if (issues.length) throw fail(422, "lint_failed", issues[0].message)
    delete state.hires[body.handle]
    state.people.push(person)
    return Response.json({ person, diff, issues, commit: blobId(diff) } satisfies HireResponse)
  }

  const connection = (name: string) =>
    need(
      state.connections.find((c) => c.name === name),
      `connection ${name}`,
    )
  function connectionList(actor: string): ConnectionList {
    return {
      connections: state.connections.map((c) => ({ ...c, default: c.name === state.defaultConnection })),
      default: state.defaultConnection,
      can_manage: state.managers.includes(actor),
    }
  }
  function checkManage(actor: string) {
    if (!state.managers.includes(actor))
      throw fail(403, "forbidden", "managing this office's connections needs its owner or a grant")
  }
  /**
   * Adds an API-key connection named for its provider as the office labels it (`azure`, `custom` for another
   * OpenAI-compatible endpoint, or the provider), checking its fields as the office does; the key is checked
   * only by `refusals`.
   */
  function addConnection(body: any) {
    check(str(body?.provider) && str(body?.api_key), "provider and api_key are required")
    const invalid = (message: string) => fail(422, "invalid_connection", message)
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : ""
    if (body.provider === "azure" && !endpoint) throw invalid("an Azure connection needs its endpoint or resource name")
    if (endpoint && body.provider !== "azure" && body.provider !== "openai")
      throw invalid("only provider azure or openai takes an endpoint")
    if (endpoint && body.provider === "openai" && !body.model) throw invalid("an OpenAI-compatible endpoint needs a model")
    if (!body.model && !endpoint && !DEFAULT_MODELS.has(body.provider))
      throw invalid(`llm_config.model is missing, and ${body.provider} has no default model`)
    const refusal = refusals.shift()
    if (refusal) throw fail(422, refusal.error, refusal.message)
    const label = body.provider === "openai" && endpoint ? "custom" : body.provider
    const taken = (name: string) => state.connections.some((c) => c.name === name)
    let name = label
    for (let n = 2; taken(name); n++) name = `${label}-${n}`
    const c: Connection = { name, provider: label, method: "api_key", model: body.model ?? null }
    state.connections.push(c)
    return c
  }
  /** A sign-in `actor` started; the office answers 404 to anyone else. */
  function startedLogin(id: string, actor: string) {
    const found = logins.get(id)
    if (!found || found.by !== actor) throw fail(404, "not_found", `no sign-in ${id}`)
    return found
  }
  /**
   * A sign-in as it is now: a waiting one signs in on its third read, adding a subscription connection named
   * `chatgpt` (then `chatgpt-2`, …), or fails on its first read if `loginFailures` gave it a message.
   */
  function readLogin(id: string, actor: string) {
    const found = startedLogin(id, actor)
    const { login } = found
    if (login.state !== "waiting") return login
    found.polls++
    if (found.polls >= found.codeAt) Object.assign(login, CODE)
    if (found.failure !== undefined) {
      Object.assign(login, { state: "failed", message: found.failure })
    } else if (found.polls >= 3) {
      const taken = (name: string) => state.connections.some((c) => c.name === name)
      let name = "chatgpt"
      for (let n = 2; taken(name); n++) name = `chatgpt-${n}`
      state.connections.push({ name, provider: "chatgpt", method: "subscription", model: "gpt-5" })
      Object.assign(login, { state: "signed_in", connection: name })
    }
    return login
  }
  /** The office's switch: the next reply runs on `connection`; its own model is stored as null. */
  function setModel(id: string, body: any) {
    check(str(body?.connection) && str(body?.model), "connection and model are required")
    const s = liveSession(id)
    if (s.status === "ending") throw fail(409, "ending", `session ${id} is ending`)
    const c = state.connections.find((x) => x.name === body.connection)
    if (!c) throw fail(422, "unknown_connection", `no connection '${body.connection}' on this office`)
    const model = body.model === c.model ? null : body.model
    return upsertSession({ ...s, connection: c.name, model, model_note: null, updated_at: now() })
  }

  /**
   * The office's choice for a new chat: the pick when its connection is here (its own model stored as null), else
   * the default on its own model with a note saying why. Unlike the office, it skips the agent's model: the fake
   * people have none.
   */
  function choose(body: any): Pick<Session, "connection" | "model" | "model_note"> {
    if (body.connection == null && body.model == null)
      return { connection: state.defaultConnection, model: null, model_note: null }
    const picked: string = body.connection ?? state.defaultConnection
    const c = state.connections.find((x) => x.name === picked)
    if (c) return { connection: c.name, model: body.model === c.model ? null : (body.model ?? null), model_note: null }
    const own = state.connections.find((x) => x.name === state.defaultConnection)?.model
    const uses = own ? `${state.defaultConnection}/${own}` : state.defaultConnection
    return {
      connection: state.defaultConnection,
      model: null,
      model_note: `Your last pick '${picked}' isn't on this office; this chat uses ${uses}.`,
    }
  }

  const hqOpts = { tcp: false, port: 49380, ...opts.hq }
  // The socket's path is known only once serveUnix has run, after the routes are built: read it at request time.
  const hqSocket = () => path.join(path.dirname(server.socket), "hq.sock")
  const hqListening = () => hqOpts.tcp && (hqOpts.listening ?? true)
  function hqStatus(): HqStatus {
    return {
      socket: hqSocket(),
      tcp: {
        enabled: hqOpts.tcp,
        port: hqOpts.port,
        listening: hqListening(),
        error: hqOpts.error ?? null,
        next_retry_at: null,
      },
      url: hqListening() ? `http://127.0.0.1:${hqOpts.port}/` : null,
      health: { ok: true, office: { api: "0.0.1+fake" }, app: null },
      warnings: [],
    }
  }
  /** Refuses unless `handle` is a human and `actor` is them or the CEO: HQ's rule, the one for devices. */
  function hqFor(handle: string, actor: string) {
    const person = need(
      state.people.find((p) => p.handle === handle),
      `person @${handle}`,
    )
    if (person.kind !== "human") throw fail(422, "not_a_human", `@${handle} is an agent; agents don't sign in to HQ`)
    if (actor !== handle && actor !== ceo())
      throw fail(403, "forbidden", `only @${handle} or the CEO can do this for @${handle}`)
  }
  /** A one-time HQ link for `body.handle` (the actor by default), under the rule for devices. */
  function mintPair(body: PairCodeRequest, actor: string): PairCode {
    const handle = body.handle ?? actor
    hqFor(handle, actor)
    const code = randomBytes(16).toString("base64url")
    const url = hqListening() ? `http://127.0.0.1:${hqOpts.port}/pair#${code}` : null
    return {
      path: `/pair#${code}`,
      url,
      socket: hqSocket(),
      port: hqOpts.port,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      // Only the path: the fake writes no file.
      open_file:
        body.open_file && url
          ? path.join(path.dirname(server.socket), `pair-${randomBytes(8).toString("hex")}.html`)
          : null,
    }
  }

  // This office's browser sessions, newest first. Office-local, so not part of FakeState (person.yaml's view).
  const browsers: BrowserSession[] = []
  /** Adds a browser session, as `opencorp pair` and a browser's POST /api/pair would. */
  function addBrowser(fields: Partial<BrowserSession> & Pick<BrowserSession, "person" | "issued_by">): BrowserSession {
    const at = new Date()
    const b: BrowserSession = {
      id: nextId(),
      // From a-z0-9, as the office names them.
      name: `web-${Array.from(randomBytes(6), (x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("")}`,
      label: null,
      via: "pair",
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + 30 * 86_400_000).toISOString(),
      last_used_at: null,
      ...fields,
    }
    browsers.unshift(b)
    return b
  }

  const routes: [string, string, Handler][] = [
    ["GET", "/health", () => Response.json({ ok: true })],
    ["GET", "/whoami", ({ actor, device }) => Response.json({ person: actor, device })],
    ["GET", "/hq", () => Response.json(hqStatus())],
    ["POST", "/hq/pair", ({ body, actor }) => Response.json(mintPair(body ?? {}, actor))],
    [
      "GET",
      "/hq/browsers",
      ({ query, actor }) => {
        const handle = query.get("person") || actor
        hqFor(handle, actor)
        return Response.json(browsers.filter((b) => b.person === handle))
      },
    ],
    [
      "DELETE",
      "/hq/browsers/:id",
      ({ params, actor }) => {
        const b = need(
          browsers.find((x) => x.id === params.id),
          `browser session ${params.id}`,
        )
        hqFor(b.person, actor)
        browsers.splice(browsers.indexOf(b), 1)
        return Response.json({ ok: true })
      },
    ],
    ["POST", "/people/:handle/devices", ({ params, body, actor }) => Response.json(addDevice(params.handle, body, actor))],
    ["POST", "/login", ({ body }) => Response.json(login(body))],
    [
      "PUT",
      "/people/:handle/password",
      ({ params, body, actor }) => Response.json(setPassword(params.handle, body, actor)),
    ],
    [
      "DELETE",
      "/people/:handle/devices/:name",
      ({ params, actor }) => Response.json(removeDevice(params.handle, params.name, actor)),
    ],
    ["GET", "/people", () => Response.json(state.people)],
    [
      "GET",
      "/folders/:cwd/people",
      ({ params }) =>
        Response.json(
          (state.folders[params.cwd] ?? []).flatMap((handle) => state.people.filter((p) => p.handle === handle)),
        ),
    ],
    ["POST", "/people", ({ body }) => hire(body)],
    [
      "GET",
      "/sessions",
      ({ query }) => {
        const limit = query.has("limit") ? Number(query.get("limit")) : 50
        check(Number.isInteger(limit) && limit >= 1 && limit <= 500, "limit must be an integer from 1 to 500")
        const person = query.get("person"),
          kind = query.get("kind"),
          cwd = query.get("cwd")
        const list = state.sessions
          .filter((s) => (!person || s.person === person) && (!kind || s.kind === kind) && (!cwd || s.cwd === cwd))
          .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
        return Response.json(list.slice(0, limit))
      },
    ],
    [
      "POST",
      "/sessions",
      ({ body }) => {
        check(str(body?.person) && str(body?.cwd), "person and cwd must be non-empty strings")
        const person = need(
          state.people.find((p) => p.handle === body.person),
          `person ${body.person}`,
        )
        const harness = body.harness ?? "composer"
        // Like the office, refuse a harness the person doesn't use before recording the folder.
        if (!(harnessesOf(person) as string[]).includes(harness))
          throw fail(422, "unsupported_harness", `@${person.handle} doesn't use the ${harness} harness`)
        state.folders[body.cwd] = [body.person, ...(state.folders[body.cwd] ?? []).filter((p) => p !== body.person)]
        if (harness === "codex") {
          const s = newSession({ person: body.person, cwd: body.cwd, harness, status: "starting" })
          // The office's owner load: the session goes idle with no turn question.
          setTimeout(() => session(s.id).status === "starting" && setStatus(s.id, "idle"), 10)
          return Response.json(s)
        }
        const s = newSession({ person: body.person, cwd: body.cwd, harness, status: "starting", ...choose(body) })
        // Like the office, the session starts its run first and goes idle when that run opens its first turn.
        setTimeout(() => session(s.id).status === "starting" && openTurn(s.id), 10)
        return Response.json(s)
      },
    ],
    [
      "POST",
      "/sessions/:id/continue",
      ({ params, actor }) => {
        const old = session(params.id)
        if (old.harness !== "codex") throw fail(422, "not_continuable", "only a Codex session can be continued")
        if (!old.harness_session_id)
          throw fail(
            422,
            "not_continuable",
            "this Codex session never loaded its thread, so there is nothing to continue",
          )
        if (LIVE.includes(old.status)) throw fail(409, "live", `session ${old.id} is still open`)
        const thread = state.sessions.filter(
          (s) => s.harness === "codex" && s.harness_session_id === old.harness_session_id,
        )
        const holder = thread.find((s) => LIVE.includes(s.status))
        if (holder) throw fail(409, "live", `this Codex thread is open in session ${holder.id}`)
        // Like the office, the newest stretch on the thread is the parent, whichever one was asked for.
        const newest = thread.reduce((a, b) =>
          (b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) > 0 ? b : a,
        )
        const s = newSession({
          person: old.person,
          cwd: old.cwd,
          harness: "codex",
          status: "starting",
          opened_by: actor,
          connection: old.connection,
          model: old.model,
          harness_session_id: old.harness_session_id,
          parent_session_id: newest.id,
        })
        // Like the office, the session resumes the thread and goes idle.
        setTimeout(() => session(s.id).status === "starting" && setStatus(s.id, "idle"), 10)
        return Response.json(s)
      },
    ],
    ["GET", "/sessions/:id", ({ params }) => Response.json(session(params.id))],
    [
      "GET",
      "/sessions/:id/messages",
      ({ params }) => (session(params.id), Response.json(state.messages[params.id] ?? [])),
    ],
    ["POST", "/sessions/:id/prompt", ({ params, body, actor }) => turn(params.id, body, actor)],
    ["POST", "/sessions/:id/steer", ({ params, body, actor }) => turn(params.id, body, actor)],
    [
      "POST",
      "/sessions/:id/interrupt",
      ({ params }) => {
        interrupt(liveSession(params.id))
        return Response.json({ ok: true })
      },
    ],
    [
      "POST",
      "/sessions/:id/end",
      ({ params }) => {
        const s = liveSession(params.id)
        if (s.status === "ending") return Response.json({ ok: true })
        setStatus(s.id, "ending")
        // A main session is debriefed before it ends, and ends once its debrief is written.
        const next = s.kind === "main" ? "debriefing" : "ended"
        setTimeout(() => session(s.id).status === "ending" && setStatus(s.id, next), 20)
        return Response.json({ ok: true })
      },
    ],
    [
      "POST",
      "/sessions/:id/cost-cap",
      ({ params, body }) => {
        const s = session(params.id)
        check(typeof body?.cost_cap_usd === "number", "cost_cap_usd must be a number")
        if (body.cost_cap_usd <= (s.cost ?? 0)) {
          throw fail(422, "cap_too_low", `the cap must be above the session's cost of $${s.cost ?? 0}`)
        }
        return Response.json(upsertSession({ ...s, cost_cap_usd: body.cost_cap_usd, updated_at: now() }))
      },
    ],
    ["POST", "/sessions/:id/model", ({ params, body }) => Response.json(setModel(params.id, body))],
    ["GET", "/connections", ({ actor }) => Response.json(connectionList(actor))],
    [
      "GET",
      "/connections/:name/models",
      ({ params }) => {
        const c = connection(params.name)
        const own = c.model ? [{ id: c.model }] : []
        return Response.json(state.models[c.name] ?? { connection: c.name, models: own, listed: false, error: null })
      },
    ],
    ["POST", "/connections", ({ body, actor }) => (checkManage(actor), Response.json(addConnection(body)))],
    [
      "POST",
      "/connections/login",
      ({ body, actor }) => {
        checkManage(actor)
        check(body?.provider === "openai", "provider must be openai")
        const codeAt = loginCodeReads.shift() ?? 0
        const login: ConnectionLogin = {
          id: nextId(),
          state: "waiting",
          ...(codeAt ? { url: null, user_code: null } : CODE),
          connection: null,
          message: null,
        }
        logins.set(login.id, { login, by: actor, polls: 0, codeAt, failure: loginFailures.shift() })
        return Response.json(login)
      },
    ],
    ["GET", "/connections/login/:id", ({ params, actor }) => Response.json(readLogin(params.id, actor))],
    [
      "DELETE",
      "/connections/login/:id",
      ({ params, actor }) => {
        const { login } = startedLogin(params.id, actor)
        if (login.state === "waiting") login.state = "cancelled"
        return Response.json({ ok: true })
      },
    ],
    [
      "DELETE",
      "/connections/:name",
      ({ params, actor }) => {
        checkManage(actor)
        if (params.name === OFFICE)
          throw fail(422, "set_up_by_onboard", "office is office/provider.json; `opencorp onboard` changes it")
        connection(params.name)
        state.connections = state.connections.filter((c) => c.name !== params.name)
        return Response.json({ ok: true })
      },
    ],
    [
      "PUT",
      "/connections/default",
      ({ body, actor }) => {
        checkManage(actor)
        check(str(body?.connection), "connection is required")
        state.defaultConnection = connection(body.connection).name
        return Response.json(connectionList(actor))
      },
    ],
    [
      "GET",
      "/work-items/:id",
      ({ params }) => Response.json(need(state.workItems[params.id], `work item ${params.id}`)),
    ],
    [
      "GET",
      "/work-items/:id/comments",
      ({ params }) => (
        need(state.workItems[params.id], `work item ${params.id}`),
        Response.json(state.comments[params.id] ?? [])
      ),
    ],
    [
      "GET",
      "/questions",
      ({ query }) => {
        const session = query.get("session")
        const statuses = query
          .getAll("status")
          .flatMap((s) => s.split(","))
          .filter(Boolean)
        const list = Object.values(state.questions)
          .filter((q) => (!session || q.session_id === session) && (!statuses.length || statuses.includes(q.status)))
          .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        return Response.json(list)
      },
    ],
    ["GET", "/questions/:id", ({ params }) => Response.json(question(params.id))],
    [
      "POST",
      "/questions/:id/answer",
      ({ params, body }) => {
        check(
          body && "answer" in body && ["option", "text"].includes(body.answer_kind),
          "answer_kind must be option or text",
        )
        const q = question(params.id)
        checkAnswer(q, body.answer, body.answer_kind)
        if (q.source === "harness") {
          // Like the office: the answer becomes Codex's reply and the card is consumed, or Codex no longer waits
          // and the card goes stale, keeping no answer.
          if (q.status !== "open") throw fail(409, "not_open", `question ${q.id} is ${q.status}, not open`)
          const answered = { answer: masked(q, body.answer), answer_kind: body.answer_kind, answered_by: human() }
          const fields = staleOnAnswer.has(q.id)
            ? { status: "stale" as const }
            : { ...answered, status: "consumed" as const }
          return Response.json(updateQuestion({ ...q, ...fields, updated_at: now() }))
        }
        return Response.json(close(params.id, { answer: body.answer, answer_kind: body.answer_kind }))
      },
    ],
    [
      "POST",
      "/questions/:id/side",
      ({ params, body }) => {
        check(str(body?.text), "text must be a non-empty string")
        const q = question(params.id)
        if (q.status !== "open") throw fail(409, "not_open", `question ${q.id} is ${q.status}, not open`)
        if (isTurn(q)) throw fail(422, "not_a_card", "a chat turn is not a question card; reply in the chat")
        if (SIDE_EXIT.has(body.text.trim().toLowerCase())) throw refused()
        // One side session per question: later messages reach it too, and an ended one restarts.
        let side = state.sessions.find((x) => x.id === q.side_session_id)
        if (!side) {
          const cwd = session(q.session_id).cwd
          // The office keeps the seed in the side session's run dir, not on the session.
          side = newSession({ person: q.asker, cwd, kind: "side", question_id: q.id })
          updateQuestion({ ...q, side_session_id: side.id, updated_at: now() })
        } else if (!LIVE.includes(side.status)) {
          setStatus(side.id, "idle")
          const waiting = Object.values(state.questions).some(
            (x) => x.session_id === side!.id && x.status === "open" && isTurn(x),
          )
          if (!waiting) openTurn(side.id)
        }
        turn(side.id, body)
        return Response.json(session(side.id))
      },
    ],
    [
      "POST",
      "/questions/:id/send-back",
      ({ params, body }) => {
        check(typeof body?.note === "string", "note must be a string")
        const q = openModelQuestion(params.id, "cannot_send_back")
        if (!q.discussion?.length && !q.carried_from)
          throw fail(422, "no_discussion", `question ${q.id} has no discussion to send back`)
        // A non-blank note becomes the discussion's last entry.
        const note = body.note.trim() ? [{ role: "user" as const, text: body.note }] : []
        const discussion = [...(q.discussion ?? []), ...note]
        return Response.json(close(q.id, { answer: null, answer_kind: "sent_back", discussion }))
      },
    ],
    [
      "POST",
      "/questions/:id/stop",
      ({ params }) => {
        const q = openModelQuestion(params.id, "cannot_stop")
        // Stopping a live main chat's ask_user is Esc on that chat, for every open ask_user of its run.
        const asker = session(q.session_id)
        if (q.source === "ask_user" && asker.kind === "main" && LIVE.includes(asker.status)) {
          interrupt(asker, q.run_id)
          return Response.json(question(q.id))
        }
        return Response.json(close(q.id, { answer: "[interrupted by the user]", answer_kind: "interrupted" }))
      },
    ],
    [
      "POST",
      "/questions/:id/carried/dismiss",
      ({ params }) => {
        const q = question(params.id)
        if (q.status !== "open") throw fail(409, "not_open", `question ${q.id} is ${q.status}, not open`)
        return Response.json(updateQuestion({ ...q, carried_from: null, updated_at: now() }))
      },
    ],
    ["GET", "/profiles/:person", ({ params }) => Response.json(profile(params.person))],
    [
      "PUT",
      "/profiles/:person",
      ({ params, body }) => {
        check(typeof body?.text === "string" && str(body?.base_version), "text and base_version are required")
        const current = profile(params.person)
        if (current.version !== body.base_version)
          return Response.json({ expected: body.base_version, current: current.version }, { status: 409 })
        return Response.json(writeProfile(params.person, body.text))
      },
    ],
    [
      "POST",
      "/profiles/:person/manager",
      ({ params, body }) => {
        check(str(body?.text), "text must be a non-empty string")
        need(
          state.people.find((p) => p.handle === params.person),
          `person ${params.person}`,
        )
        const s = newSession({ person: params.person, cwd: "/", kind: "profile_manager", status: "starting" })
        // The first message is the chat's first turn; the session answers while still starting.
        userMessage(s.id, body.text)
        for (const fn of prompts) fn(s.id, { text: body.text })
        return Response.json(session(s.id))
      },
    ],
    [
      "GET",
      "/profiles/:person/proposals",
      ({ params }) => {
        need(
          state.people.find((p) => p.handle === params.person),
          `person ${params.person}`,
        )
        return Response.json(Object.values(state.proposals).filter((p) => p.person === params.person))
      },
    ],
    [
      "POST",
      "/profile-proposals/:id/apply",
      ({ params }) => {
        const proposal = need(state.proposals[params.id], `proposal ${params.id}`)
        if (proposal.status !== "open")
          throw fail(409, "not_open", `proposal ${proposal.id} is ${proposal.status}, not open`)
        const current = profile(proposal.person)
        if (current.version !== proposal.base_version) {
          updateProposal({ ...proposal, status: "stale" }, "profile_proposal.updated")
          return Response.json({ expected: proposal.base_version, current: current.version }, { status: 409 })
        }
        // The proposal is marked applied before the profile's event, as the office does.
        const commit = blobId(`commit ${blobId(proposal.text)}`)
        updateProposal({ ...proposal, status: "applied", commit }, "profile_proposal.updated")
        return Response.json(writeProfile(proposal.person, proposal.text))
      },
    ],
    [
      "POST",
      "/feedback",
      ({ body }) => {
        check(str(body?.session_id) && str(body?.text), "session_id and text are required")
        const s = session(body.session_id)
        if (s.kind !== "main") throw fail(422, "not_learnable", `${s.id} is a ${s.kind} session`)
        const runId: string | undefined = body.run_id ?? s.run_ids?.at(-1)
        const runs = new Set(s.run_ids ?? [])
        const debriefRun = debriefRuns.get(s.id)
        if (debriefRun && state.debriefs[s.id]?.state === "ready") runs.add(debriefRun)
        check(runId, `${s.id} has no runs`)
        // A run of another session would be learned into the wrong person's profile.
        check(runs.has(runId!), `run ${runId} is not in ${s.id}`)
        // A session's latest run is still going (or may be killed) until the session has stopped.
        const stopped = ["ended", "failed", "debriefing"].includes(s.status)
        if (runId === s.run_ids?.at(-1) && !stopped) throw fail(409, "run_unfinished", `run ${runId} has not finished`)
        const f: Feedback = {
          id: nextId(),
          session_id: s.id,
          run_id: runId!,
          author: human(),
          text: body.text,
          status: "queued",
          attempts: 0,
          created_at: now(),
        }
        state.feedback.push(f)
        publish("feedback.created", f.id, f)
        return Response.json(f)
      },
    ],
    [
      "GET",
      "/debriefs/:session",
      ({ params }) => {
        const s = session(params.session)
        const d = state.debriefs[s.id]
        if (d) return Response.json(d)
        // A debriefing session has a debrief, pending until the flow stores it.
        if (s.status === "debriefing")
          return Response.json({ session_id: s.id, state: "pending", updated_at: s.updated_at } satisfies Debrief)
        throw fail(404, "not_found", `no debrief for ${s.id}`)
      },
    ],
    [
      "POST",
      "/debriefs/:session/confirm",
      ({ params, body }) => {
        const s = session(params.session)
        const d = state.debriefs[s.id]
        if (d?.state !== "ready") throw fail(409, "not_ready", `the debrief for ${s.id} is not ready`)
        const ups = d.follow_ups ?? []
        check(
          Array.isArray(body?.indices) && body.indices.every((i: unknown) => Number.isInteger(i) && ups[i as number]),
          "indices must name follow-ups",
        )
        const picked = new Set<number>(body.indices)
        // A follow-up is confirmed once: confirming it again keeps its work item.
        const follow_ups = ups.map((f, i) => {
          if (!picked.has(i) || f.confirmed) return f
          const at = now()
          const item: WorkItem = {
            id: nextId(),
            title: f.text,
            kind: "task",
            status: "open",
            // The fake's only client is the local human, so they are the one confirming.
            requester: human(),
            assignee: s.person,
            parent_id: s.work_item_id ?? null,
            created_at: at,
            updated_at: at,
          }
          state.workItems[item.id] = item
          publish("work_item.created", item.id, item)
          return { ...f, confirmed: true, work_item_id: item.id }
        })
        const next: Debrief = { ...d, follow_ups, updated_at: now() }
        state.debriefs[params.session] = next
        publish("debrief.updated", params.session, next)
        return Response.json(next)
      },
    ],
    [
      "GET",
      "/events",
      ({ query }) => {
        let entry: Stream
        const body = new ReadableStream<Uint8Array>({
          start(ctl) {
            entry = { ctl, session: query.get("session") ?? undefined }
            streams.add(entry)
            ctl.enqueue(encoder.encode(": connected\n\n"))
          },
          cancel() {
            streams.delete(entry)
          },
        })
        return new Response(body, {
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        })
      },
    ],
  ]

  function match(pattern: string, segs: string[]) {
    const want = pattern.split("/")
    if (want.length !== segs.length) return
    const params: Record<string, string> = {}
    for (const [i, w] of want.entries()) {
      if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(segs[i])
      else if (w !== segs[i]) return
    }
    return params
  }

  async function handle(req: Request) {
    const url = new URL(req.url)
    const raw = url.pathname + url.search
    const text = req.method === "GET" ? "" : await req.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      return Response.json({ error: "invalid_body", message: "the body is not JSON" }, { status: 422 })
    }
    const authorization = req.headers.get("authorization")
    requests.push({
      method: req.method,
      path: decodeURIComponent(url.pathname) + url.search,
      raw,
      body,
      at: Date.now(),
      ...(authorization !== null && { authorization }),
    })
    let who: { actor: string; device: string | null } = { actor: ceo(), device: null }
    // Only the liveness probe and logging in are served without a token once the office enforces them.
    const open =
      url.pathname === "/health"
        ? req.method === "GET" || req.method === "HEAD"
        : url.pathname === "/login" && req.method === "POST"
    if (!open) {
      try {
        who = authenticate(authorization)
      } catch (e) {
        if (!(e instanceof Fail)) throw e
        return Response.json({ error: e.error, message: e.message }, { status: e.status })
      }
    }
    const segs = url.pathname.split("/")
    const found = routes.flatMap(([method, pattern, h]) => {
      const params = match(pattern, segs)
      return params && !missing.has(`${method} ${pattern}`) ? [{ method, pattern, h, params }] : []
    })
    if (!found.length)
      return Response.json({ error: "no_route", message: `no route ${req.method} ${url.pathname}` }, { status: 404 })
    const route = found.find((r) => r.method === req.method)
    if (!route)
      return Response.json(
        { error: "method_not_allowed", message: `${req.method} is not allowed on ${url.pathname}` },
        { status: 405, headers: { allow: found.map((r) => r.method).join(", ") } },
      )
    const key = `${route.method} ${route.pattern}`
    await holds.get(key)
    await holds.get(`${req.method} ${url.pathname}`)
    if (broken.has(key))
      return Response.json({ error: "internal", message: `${req.method} ${url.pathname} failed` }, { status: 500 })
    if (notImplemented.has(key) || notImplemented.has(`${req.method} ${url.pathname}`))
      return Response.json(
        { error: "not_implemented", message: `${req.method} ${url.pathname} is not implemented yet` },
        { status: 501 },
      )
    let res: Response
    try {
      res = await route.h({ params: route.params, query: url.searchParams, body, path: url.pathname, ...who })
    } catch (e) {
      if (!(e instanceof Fail)) throw e
      res = Response.json({ error: e.error, message: e.message }, { status: e.status })
    }
    await replyHolds.get(key)
    return res
  }

  const server = serveUnix(handle, opts.socket)

  return {
    socket: server.socket,
    /** The office's data; tests may edit it directly (no events are sent for direct edits). */
    state,
    /**
     * Every request received, in order: `path` is decoded and keeps the query string, `raw` is as sent, and `at` is
     * when it came in (ms since the epoch).
     */
    requests,
    /** Humans' passwords by handle; set one to give a human a password. */
    passwords,
    /** Route keys (`"POST /sessions/:id/prompt"`) or exact paths (`"GET /sessions/S2/messages"`) answered with 501. */
    notImplemented,
    /** Codex card ids whose answer comes back stale, as when Codex no longer waits for the card. */
    staleOnAnswer,
    /** Route keys (`"GET /connections"`) answered with 500, as an office that hit an error. */
    broken,
    /** How the office refuses the next `POST /connections`, in order: each is sent as a 422 with that code. */
    refusals,
    /** Why the next sign-ins fail, in order: each fails with that message on its first read. */
    loginFailures,
    /**
     * The read that brings each next sign-in its code, in order: until then it waits with no URL or code, as the
     * office's does when the provider is slow to give one.
     */
    loginCodeReads,
    /** Adds a browser session for tests; returns it. */
    addBrowser,
    /** Subscription sign-ins by id, as they are now. */
    logins: () => [...logins.values()].map((l) => l.login),
    nextId,
    emit,
    live,
    addQuestion,
    newSession,
    openTurn,
    expire,
    setStatus,
    /** Changes a session's fields and publishes `session.updated`, as the office does. */
    updateSession: (id: string, fields: Partial<Session>) => upsertSession({ ...session(id), ...fields, updated_at: now() }),
    propose,
    addDebrief,
    feedbackStatus,
    /** Writes an SSE comment line (`: text`) to every stream. */
    comment: (text: string) => write(`: ${text}\n\n`),
    ping: () => write(": ping\n\n"),
    /** Tells every stream to re-read state, then closes them (the office dropped its subscribers). */
    reset() {
      write("event: reset\ndata:\n\n")
      closeAll()
    },
    /** Closes every stream without a frame. */
    dropStreams: closeAll,
    /** The number of open event streams. */
    streams: () => streams.size,
    /**
     * Delays requests to a route (`"GET /sessions"`, `"GET /sessions/:id/messages"`) or, before
     * they are handled only, to an exact path (`"GET /connections/office/models"`) until the
     * returned release is called: before they are handled, or with `"reply"`, after (so the
     * reply is what the state was when the request came in).
     */
    hold(key: string, at: "request" | "reply" = "request") {
      const map = at === "request" ? holds : replyHolds
      let release!: () => void
      map.set(key, new Promise<void>((r) => (release = r)))
      return () => {
        map.delete(key)
        release()
      }
    },
    /** Calls `fn` after an interrupt, as the reply's driver: it stops the reply and opens the next turn. */
    onInterrupt(fn: (sessionId: string) => void) {
      interrupts.push(fn)
    },
    /**
     * Calls `fn` after a prompt that starts a reply is recorded and the session is set busy (not for
     * a steer), and after a new profile manager session's first message (that session stays `starting`).
     */
    onPrompt(fn: (sessionId: string, req: PromptRequest) => void) {
      prompts.push(fn)
    },
    stop() {
      closeAll()
      server.stop()
    },
  }
}
