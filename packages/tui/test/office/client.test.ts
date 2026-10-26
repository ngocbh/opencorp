// The client against the fake office, for what needs its knobs: holds and timeouts, its request log, questions it
// adds, and connection flows that need a real key check or sign-in. real.test.ts runs the rest on a real office.
import { afterEach, expect, spyOn, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../fixture/fake-office"
import {
  ADD_CONNECTION_TIMEOUT_MS,
  CREATE_TIMEOUT_MS,
  START_LOGIN_TIMEOUT_MS,
  createOfficeClient,
  OfficeError,
  OfficeTimeout,
} from "@opencorp/client"

let office: FakeOffice
afterEach(() => office?.stop())
const client = () => createOfficeClient({ socket: office.socket })
/** The error `p` rejects with; fails the test if it resolves. */
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => {
      throw new Error("expected the request to fail")
    },
    (e) => e,
  )

test("a prompt sent while an interrupted reply ends waits for the next reply", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((_, req) => prompts.push(req.text))
  const id = office.state.sessions[0].id
  await client().sessions.prompt(id, { text: "go" })
  await client().sessions.interrupt(id)
  await client().sessions.prompt(id, { text: "then this" })
  expect(prompts).toEqual(["go"])
  office.replyEnded(id)
  expect(prompts).toEqual(["go", "then this"])
})

test("a prompt to a waiting session answers its open ask_user question", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((_, req) => prompts.push(req.text))
  const id = office.state.sessions[0].id
  const q = office.addQuestion({ session_id: id, source: "ask_user" })
  office.updateSession(id, { status: "waiting", waiting_on: ["ngocbh"] })
  await client().sessions.prompt(id, { text: "yes, go on" })
  const answered = await client().questions.get(q.id)
  expect([answered.status, answered.answer, answered.answer_kind, answered.answered_by]).toEqual([
    "answered",
    "yes, go on",
    "text",
    "ngocbh",
  ])
  expect(prompts).toEqual([])
})

test("the first answer wins; the second gets 409 not_open", async () => {
  office = createFakeOffice()
  const q = office.addQuestion({ options: ["yes", "no"] })
  expect((await client().questions.answer(q.id, { answer: "yes", answer_kind: "option" })).status).toBe("answered")
  const err = await failure(client().questions.answer(q.id, { answer: "no", answer_kind: "option" }))
  expect(err).toBeInstanceOf(OfficeError)
  expect([err.status, err.code]).toEqual([409, "not_open"])
})

test("open questions are listed by session and status", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const a = office.addQuestion({})
  const b = office.addQuestion({})
  office.addQuestion({ session_id: "OTHER" })
  await client().questions.answer(b.id, { answer: "x", answer_kind: "text" })
  expect((await client().questions.list({ session: id, status: "open" })).map((q) => q.id)).toEqual([a.id])
  expect((await client().questions.list({ session: id, status: ["open", "answered"] })).map((q) => q.id)).toEqual([a.id, b.id])
  expect(office.requests.at(-1)?.raw).toBe(`/questions?session=${id}&status=open%2Canswered`)
})

test("today's office serves hires, the session routes, and the question card routes", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  await client().people.hire({ name: "Lan", handle: "lan", title: "QA", manager: "ngocbh", confirm: false })
  expect((await client().sessions.create({ person: "minh", cwd: "/tmp/proj" })).status).toBe("starting")
  await client().sessions.prompt(id, { text: "go" })
  await client().sessions.steer(id, { text: "faster" })
  await client().sessions.interrupt(id)
  await client().sessions.costCap(id, { cost_cap_usd: 5 })
  await client().sessions.end(id)
  const q = office.addQuestion({ session_id: id, source: "ask_user" })
  expect((await client().questions.stop(q.id)).answer_kind).toBe("interrupted")
})

test("reads give up after timeoutMs with an OfficeTimeout", async () => {
  office = createFakeOffice()
  const release = office.hold("GET /sessions/:id/messages")
  const c = createOfficeClient({ socket: office.socket, timeoutMs: 50 })
  const err = await failure(c.sessions.messages(office.state.sessions[0].id))
  release()
  expect(err).toBeInstanceOf(OfficeTimeout)
  expect(err.message).toContain("/messages")
})

test("a models refresh asks with ?refresh=1", async () => {
  office = createFakeOffice()
  await client().connections.models("azure-2", { refresh: true })
  expect(office.requests.at(-1)?.raw).toBe("/connections/azure-2/models?refresh=1")
})

test("managing connections: add, set the default, remove; office can't be removed; others get 403", async () => {
  office = createFakeOffice()
  const added = await client().connections.add({ provider: "openai", api_key: "sk-test", model: "gpt-4.1" })
  expect([added.name, added.provider, added.model]).toEqual(["openai", "openai", "gpt-4.1"])
  expect(office.requests.at(-1)).toMatchObject({ method: "POST", path: "/connections" })
  expect((await client().connections.setDefault({ connection: "openai" })).default).toBe("openai")
  expect(office.requests.at(-1)).toMatchObject({ method: "PUT", path: "/connections/default", body: { connection: "openai" } })
  expect(await client().connections.remove("openai")).toEqual({ ok: true })
  expect(office.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/connections/openai" })
  const onboard = await failure(client().connections.remove("office"))
  expect([onboard.status, onboard.code]).toEqual([422, "set_up_by_onboard"])
  office.state.managers = []
  const forbidden = await failure(client().connections.add({ provider: "openai", api_key: "sk-test" }))
  expect([forbidden.status, forbidden.code]).toEqual([403, "forbidden"])
})

test("adding a connection waits 120 s, as the office's key check (listing, then one reply) takes about 95 s at most", async () => {
  office = createFakeOffice()
  expect(ADD_CONNECTION_TIMEOUT_MS).toBe(120_000)
  // The client asks for a 120 s limit; the test gets a 50 ms one so the held request times out.
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => (asked.push(ms), timeout(50)))
  const release = office.hold("POST /connections")
  const err = await failure(client().connections.add({ provider: "anthropic", api_key: "sk-test" })).finally(() => {
    spy.mockRestore()
    release()
  })
  expect(asked).toEqual([ADD_CONNECTION_TIMEOUT_MS])
  expect(err).toBeInstanceOf(OfficeTimeout)
  expect(err.timeoutMs).toBe(ADD_CONNECTION_TIMEOUT_MS)
  expect(err.message).toContain("/connect")
})

test("a subscription sign-in: start it, read it until it signs in, or cancel it; an unknown one is not found", async () => {
  office = createFakeOffice()
  const login = await client().connections.startLogin({ provider: "openai" })
  expect([login.state, login.user_code]).toEqual(["waiting", "ABCD-EFGH"])
  expect(office.requests.at(-1)).toMatchObject({ method: "POST", path: "/connections/login", body: { provider: "openai" } })
  expect((await client().connections.login(login.id)).state).toBe("waiting")
  expect(office.requests.at(-1)).toMatchObject({ method: "GET", path: `/connections/login/${login.id}` })
  expect((await client().connections.login(login.id)).state).toBe("waiting")
  const done = await client().connections.login(login.id)
  expect([done.state, done.connection]).toEqual(["signed_in", "chatgpt"])
  expect(office.state.connections.at(-1)).toMatchObject({ name: "chatgpt", method: "subscription" })

  const other = await client().connections.startLogin({ provider: "openai" })
  expect(await client().connections.cancelLogin(other.id)).toEqual({ ok: true })
  expect(office.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/connections/login/${other.id}` })
  expect((await client().connections.login(other.id)).state).toBe("cancelled")
  expect((await failure(client().connections.login("nope"))).status).toBe(404)
})

test("starting a sign-in waits 30 s, as the office answers once the code is shown, up to 20 s", async () => {
  office = createFakeOffice()
  expect(START_LOGIN_TIMEOUT_MS).toBe(30_000)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => (asked.push(ms), timeout(50)))
  const release = office.hold("POST /connections/login")
  const err = await failure(client().connections.startLogin({ provider: "openai" })).finally(() => {
    spy.mockRestore()
    release()
  })
  expect(asked).toEqual([START_LOGIN_TIMEOUT_MS])
  expect(err).toBeInstanceOf(OfficeTimeout)
})

test("the office refuses a connection it can't use with a 422, and adds nothing", async () => {
  office = createFakeOffice()
  office.refusals.push({ error: "key_refused", message: "The key didn't work (HTTP 401)" })
  const refused = await failure(client().connections.add({ provider: "anthropic", api_key: "sk-test" }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "key_refused", "The key didn't work (HTTP 401)"])
  const azure = await failure(client().connections.add({ provider: "azure", api_key: "sk-test" }))
  expect([azure.status, azure.code]).toEqual([422, "invalid_connection"])
  const google = await failure(client().connections.add({ provider: "google", api_key: "sk-test" }))
  expect([google.status, google.code]).toEqual([422, "invalid_connection"])
  expect(office.state.connections.map((c) => c.name)).toEqual(["office", "azure-2"])
  // A custom endpoint is named for it, as the office labels it.
  const custom = await client().connections.add({
    provider: "openai",
    api_key: "sk-test",
    endpoint: "https://llm.example.com/v1",
    model: "my-model",
  })
  expect([custom.name, custom.provider, custom.model]).toEqual(["custom", "custom", "my-model"])
})

test("setModel switches a live session and publishes it; unknown connections and ended sessions fail", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  const s = await client().sessions.setModel(id, { connection: "azure-2", model: "o3-mini" })
  expect([s.connection, s.model, s.model_note]).toEqual(["azure-2", "o3-mini", null])
  expect(office.requests.at(-1)).toMatchObject({
    method: "POST",
    path: `/sessions/${id}/model`,
    body: { connection: "azure-2", model: "o3-mini" },
  })
  // The connection's own model is stored as null, so it follows that connection.
  expect((await client().sessions.setModel(id, { connection: "azure-2", model: "gpt-4o-mini" })).model).toBeNull()
  const unknown = await failure(client().sessions.setModel(id, { connection: "nope", model: "x" }))
  expect([unknown.status, unknown.code]).toEqual([422, "unknown_connection"])
  office.setStatus(id, "ended")
  const over = await failure(client().sessions.setModel(id, { connection: "office", model: "gpt-4o" }))
  expect([over.status, over.code]).toEqual([409, "not_live"])
})

test("create sends the pick and waits 30 s; a timeout says the chat may have started", async () => {
  office = createFakeOffice()
  expect(CREATE_TIMEOUT_MS).toBe(30_000)
  const s = await client().sessions.create({ person: "minh", cwd: "/tmp/proj", connection: "azure-2", model: "o3-mini" })
  expect([s.connection, s.model]).toEqual(["azure-2", "o3-mini"])
  expect(office.requests.at(-1)).toMatchObject({ method: "POST", path: "/sessions" })
  // The office records its default connection when none is asked for.
  expect((await client().sessions.create({ person: "minh", cwd: "/tmp/proj" })).connection).toBe("office")
  // A pick the office doesn't have falls back to the default, with a note saying so.
  const gone = await client().sessions.create({ person: "minh", cwd: "/tmp/proj", connection: "gone", model: "x" })
  expect([gone.connection, gone.model, gone.model_note]).toEqual([
    "office",
    null,
    "Your last pick 'gone' isn't on this office; this chat uses office/gpt-4o.",
  ])
  // The client asks for a 30 s limit; the test gets a 50 ms one so the held request times out.
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => (asked.push(ms), timeout(50)))
  const release = office.hold("POST /sessions")
  const err = await failure(client().sessions.create({ person: "minh", cwd: "/tmp/proj" })).finally(() => {
    spy.mockRestore()
    release()
  })
  expect(asked).toEqual([CREATE_TIMEOUT_MS])
  expect(err).toBeInstanceOf(OfficeTimeout)
  expect(err.timeoutMs).toBe(CREATE_TIMEOUT_MS)
  expect(err.message).toContain("the chat may have started")
  expect(err.message).toContain("session list")
})

test("continue posts no body; a Codex session continues; the office refuses a live one", async () => {
  office = createFakeOffice()
  const old = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    status: "ended",
    harness_session_id: "thr_1",
  })
  const next = await client().sessions.continue(old.id)
  expect(office.requests.at(-1)).toMatchObject({ method: "POST", path: `/sessions/${old.id}/continue`, body: undefined })
  expect([next.harness, next.parent_session_id, next.harness_session_id]).toEqual(["codex", old.id, "thr_1"])
  const live = await failure(client().sessions.continue(next.id))
  expect([live.status, live.code]).toEqual([409, "live"])
})

test("continue, as the office does it: from the newest stretch, with its connection and model, by the requester", async () => {
  office = createFakeOffice()
  const codex = { person: "minh", cwd: "/tmp/proj", harness: "codex" as const, status: "ended" as const }
  const first = office.newSession({ ...codex, harness_session_id: "thr_1", connection: "azure-2", model: "o3-mini" })
  const second = office.newSession({ ...codex, harness_session_id: "thr_1", parent_session_id: first.id })
  // A Codex session whose first load failed has no thread: it neither continues nor holds one.
  const unloaded = office.newSession({ ...codex, status: "idle", harness_session_id: null })
  const next = await client().sessions.continue(first.id)
  expect(next.parent_session_id).toBe(second.id)
  expect([next.connection, next.model, next.opened_by]).toEqual(["azure-2", "o3-mini", "ngocbh"])
  office.setStatus(unloaded.id, "ended")
  const never = await failure(client().sessions.continue(unloaded.id))
  expect([never.status, never.code]).toEqual([422, "not_continuable"])
})
