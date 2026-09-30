// A stand-in office for tests and `bun run dev`: an in-memory office on a unix socket that
// speaks the office's HTTP routes and SSE framing, with no Python.
import type {
  Comment,
  Debrief,
  Event,
  Feedback,
  HireRequest,
  HireResponse,
  LiveEvent,
  Message,
  Person,
  Profile,
  ProfileProposal,
  PromptRequest,
  RepoIssue,
  Question,
  Session,
  WorkItem,
} from "@agent-corp/protocol"
import { createTwoFilesPatch } from "diff"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import type { TuiInput } from "../src/app"
import { HANDLE } from "../src/routes/picker/people"
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
  /** cwd → person ids, most recent first. */
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
  /** Hire previews by the previewed person's id. */
  hires: Record<string, HireRequest>
}

/** The routes the office answers with 501 today; pass as `notImplemented` to match it. */
export const OFFICE_501_ROUTES = [
  "POST /people",
  "POST /sessions",
  "POST /sessions/:id/prompt",
  "POST /sessions/:id/steer",
  "POST /sessions/:id/interrupt",
  "POST /sessions/:id/end",
  "POST /sessions/:id/cost-cap",
  "POST /questions/:id/side",
  "POST /questions/:id/send-back",
  "POST /questions/:id/stop",
  "POST /profiles/:person/manager",
  "GET /profiles/:person/proposals",
  "POST /profile-proposals/:id/apply",
  "POST /feedback",
  "GET /debriefs/:session",
  "POST /debriefs/:session/confirm",
]

const now = () => new Date().toISOString()

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

/** A seeded office: @minh (agent, worked in /tmp/proj), @ngocbh (human), one idle main session. */
export function seed(nextId = counter()): FakeState {
  const at = now()
  const people: Person[] = [
    { id: "minh", handle: "minh", name: "Minh", kind: "agent", title: "Software engineer", manager: "ngocbh" },
    { id: "ngocbh", handle: "ngocbh", name: "Ngoc Bui", kind: "human", title: "CEO", manager: null },
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
  const profile = "# Minh\n\nWrites small, tested changes.\n"
  return {
    people,
    folders: { "/tmp/proj": ["minh"] },
    sessions: [session],
    messages: { [session.id]: [] },
    questions: {},
    profiles: { minh: { person: "minh", text: profile, version: blobId(profile), over_budget: false } },
    proposals: {},
    workItems: {},
    comments: {},
    debriefs: {},
    feedback: [],
    hires: {},
  }
}

type Ctx = { params: Record<string, string>; query: URLSearchParams; body: any; path: string }
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
    /** The company's `profile_max_chars`; a longer profile is `over_budget`. */
    profileMaxChars?: number
  } = {},
) {
  const nextId = counter()
  const profileMaxChars = opts.profileMaxChars ?? 32000
  const state = opts.seed ?? seed(nextId)
  const notImplemented = new Set(opts.notImplemented ?? [])
  const requests: { method: string; path: string; raw: string; body: unknown }[] = []
  const holds = new Map<string, Promise<void>>()
  const replyHolds = new Map<string, Promise<void>>()
  const prompts: ((sessionId: string, req: PromptRequest) => void)[] = []
  const streams = new Set<Stream>()
  const encoder = new TextEncoder()
  // The run each debrief was written in; the protocol's Debrief doesn't carry it.
  const debriefRuns = new Map<string, string>()

  const fail = (status: number, error: string, message: string) => new Fail(status, error, message)
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw fail(404, "not_found", `no ${what}`)
    return value
  }
  const check = (ok: unknown, message: string) => {
    if (!ok) throw fail(422, "invalid_body", message)
  }
  const str = (v: unknown) => typeof v === "string" && v.length > 0
  const human = () => state.people.find((p) => p.kind === "human")?.id ?? "ngocbh"

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
  function newSession(fields: Partial<Session> & Pick<Session, "person" | "cwd">): Session {
    const at = now()
    return upsertSession(
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
  }
  function userMessage(sessionId: string, text: string) {
    const msg: Message = {
      id: nextId(),
      session_id: sessionId,
      role: "user",
      parts: [{ id: nextId(), type: "text", text }],
      created_at: now(),
    }
    state.messages[sessionId] = [...(state.messages[sessionId] ?? []), msg]
    live({ type: "message.updated", session_id: sessionId, data: structuredClone(msg) as unknown as LiveEvent["data"] })
    return msg
  }
  function turn(id: string, body: any) {
    check(str(body?.text), "text must be a non-empty string")
    const s = session(id)
    if (s.status === "ended" || s.status === "failed") throw fail(409, "session_ended", `session ${id} has ended`)
    userMessage(id, body.text)
    setStatus(id, "busy")
    for (const fn of prompts) fn(id, { text: body.text })
    return Response.json({ ok: true })
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
    return updateQuestion({ ...q, status: "answered", answered_by: human(), updated_at: now(), ...fields })
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
      state.people.find((p) => p.id === person),
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
   * preview's fields and id, and is refused while lint has an error.
   */
  function hire(body: any) {
    const fields = ["name", "handle", "title", "manager"] as const
    for (const f of fields) check(str(body?.[f]), `${f} must be a non-empty string`)
    const extra = Object.keys(body).filter((k) => ![...fields, "id", "confirm"].includes(k))
    check(!extra.length, `unexpected fields: ${extra.join(", ")}`)
    check(HANDLE.test(body.handle), "handle must be lowercase letters, digits and dashes")
    check(!state.people.some((p) => p.id === body.id), `id ${body.id} already belongs to a person`)
    const id: string = body.id ?? nextId()
    const file = `people/${id}/person.yaml`
    const owner = state.people.find((p) => p.handle === body.handle)
    const issues: RepoIssue[] = [
      ...(owner
        ? [{ path: file, code: "person.duplicate_handle", message: `@${body.handle} is already used by ${owner.id}` }]
        : []),
      ...(state.people.some((p) => p.id === body.manager)
        ? []
        : [{ path: file, code: "person.unknown_manager", message: body.manager }]),
    ].map((i) => ({ ...i, severity: "error" as const }))
    const person: Person = {
      id,
      handle: body.handle,
      name: body.name,
      kind: "agent",
      title: body.title,
      manager: body.manager,
    }
    const diff = `+++ b/${file}\n+name: ${person.name}\n+handle: ${person.handle}\n+kind: agent\n+title: ${person.title}\n+manager: ${person.manager}\n`
    if (!body.confirm) {
      state.hires[id] = body
      return Response.json({ person, diff, issues, commit: null } satisfies HireResponse)
    }
    const previewed = state.hires[body.id]
    check(body.id && previewed, "confirm needs the id of a preview")
    if (fields.some((f) => previewed[f] !== body[f])) {
      throw fail(422, "lint_failed", "confirm must repeat the previewed fields")
    }
    if (issues.length) throw fail(422, "lint_failed", issues[0].message)
    delete state.hires[id]
    state.people.push(person)
    return Response.json({ person, diff, issues, commit: blobId(diff) } satisfies HireResponse)
  }

  const routes: [string, string, Handler][] = [
    ["GET", "/people", () => Response.json(state.people)],
    [
      "GET",
      "/folders/:cwd/people",
      ({ params }) =>
        Response.json((state.folders[params.cwd] ?? []).flatMap((id) => state.people.filter((p) => p.id === id))),
    ],
    ["POST", "/people", ({ body }) => hire(body)],
    [
      "GET",
      "/sessions",
      ({ query }) => {
        const limit = query.has("limit") ? Number(query.get("limit")) : 50
        check(Number.isInteger(limit) && limit >= 1 && limit <= 500, "limit must be an integer from 1 to 500")
        const person = query.get("person")
        const list = state.sessions
          .filter((s) => !person || s.person === person)
          .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
        return Response.json(list.slice(0, limit))
      },
    ],
    [
      "POST",
      "/sessions",
      ({ body }) => {
        check(str(body?.person) && str(body?.cwd), "person and cwd must be non-empty strings")
        need(
          state.people.find((p) => p.id === body.person),
          `person ${body.person}`,
        )
        state.folders[body.cwd] = [body.person, ...(state.folders[body.cwd] ?? []).filter((p) => p !== body.person)]
        return Response.json(newSession({ person: body.person, cwd: body.cwd, harness: body.harness ?? "composer" }))
      },
    ],
    ["GET", "/sessions/:id", ({ params }) => Response.json(session(params.id))],
    [
      "GET",
      "/sessions/:id/messages",
      ({ params }) => (session(params.id), Response.json(state.messages[params.id] ?? [])),
    ],
    ["POST", "/sessions/:id/prompt", ({ params, body }) => turn(params.id, body)],
    ["POST", "/sessions/:id/steer", ({ params, body }) => turn(params.id, body)],
    [
      "POST",
      "/sessions/:id/interrupt",
      ({ params }) => (setStatus(params.id, "interrupted"), Response.json({ ok: true })),
    ],
    [
      "POST",
      "/sessions/:id/end",
      ({ params }) => {
        // A main session is debriefed before it ends; addDebrief ends it. Other kinds end at once.
        if (session(params.id).kind !== "main") setStatus(params.id, "ended")
        else {
          setStatus(params.id, "ending")
          setStatus(params.id, "debriefing")
        }
        return Response.json({ ok: true })
      },
    ],
    [
      "POST",
      "/sessions/:id/cost-cap",
      ({ params, body }) => {
        const s = session(params.id)
        check(typeof body?.cost_cap_usd === "number", "cost_cap_usd must be a number")
        check(body.cost_cap_usd > (s.cost ?? 0), "the cap must be above the session's cost")
        return Response.json(upsertSession({ ...s, cost_cap_usd: body.cost_cap_usd, updated_at: now() }))
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
        const parent = session(q.session_id)
        const side = newSession({ person: q.asker, cwd: parent.cwd, kind: "side", question_id: q.id, seed: q.question })
        userMessage(side.id, body.text)
        updateQuestion({ ...q, side_session_id: side.id, updated_at: now() })
        return Response.json(side)
      },
    ],
    [
      "POST",
      "/questions/:id/send-back",
      ({ params, body }) => {
        check(str(body?.note), "note must be a non-empty string")
        return Response.json(close(params.id, { answer: body.note, answer_kind: "sent_back" }))
      },
    ],
    [
      "POST",
      "/questions/:id/stop",
      ({ params }) => Response.json(close(params.id, { answer: null, answer_kind: "interrupted" })),
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
          state.people.find((p) => p.id === params.person),
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
          state.people.find((p) => p.id === params.person),
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
    requests.push({ method: req.method, path: decodeURIComponent(url.pathname) + url.search, raw, body })
    const segs = url.pathname.split("/")
    const found = routes.flatMap(([method, pattern, h]) => {
      const params = match(pattern, segs)
      return params ? [{ method, pattern, h, params }] : []
    })
    if (!found.length)
      return Response.json({ error: "no_route", message: `no route for ${url.pathname}` }, { status: 404 })
    const route = found.find((r) => r.method === req.method)
    if (!route)
      return Response.json(
        { error: "method_not_allowed", message: `${req.method} is not allowed on ${url.pathname}` },
        { status: 405, headers: { allow: found.map((r) => r.method).join(", ") } },
      )
    const key = `${route.method} ${route.pattern}`
    await holds.get(key)
    if (notImplemented.has(key) || notImplemented.has(`${req.method} ${url.pathname}`))
      return Response.json(
        { error: "not_implemented", message: `${req.method} ${url.pathname} is not implemented yet` },
        { status: 501 },
      )
    let res: Response
    try {
      res = await route.h({ params: route.params, query: url.searchParams, body, path: url.pathname })
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
    /** Every request received, in order: `path` is decoded and keeps the query string, `raw` is as sent. */
    requests,
    /** Route keys (`"POST /sessions/:id/prompt"`) or exact paths (`"GET /sessions/S2/messages"`) answered with 501. */
    notImplemented,
    nextId,
    emit,
    live,
    addQuestion,
    setStatus,
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
     * Delays requests to a route (`"GET /sessions"`, `"GET /sessions/:id/messages"`) until the
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
    /**
     * Calls `fn` after each prompt or steer is recorded and the session is set busy, and after a
     * new profile manager session's first message (that session stays `starting`).
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
