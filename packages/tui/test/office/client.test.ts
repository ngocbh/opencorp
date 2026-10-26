import { afterEach, expect, spyOn, test } from "bun:test"
import { createFakeOffice, type FakeOffice } from "../../script/stub"
import {
  ADD_CONNECTION_TIMEOUT_MS,
  CREATE_TIMEOUT_MS,
  START_LOGIN_TIMEOUT_MS,
  createOfficeClient,
  OfficeError,
  OfficeTimeout,
  VersionConflictError,
  request,
} from "@opencorp/client"
import { until } from "../fixture/until"

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

test("people and folder people; the cwd is one encoded segment", async () => {
  office = createFakeOffice()
  expect((await client().people.list()).map((p) => p.handle)).toEqual(["minh", "ngocbh"])
  expect((await client().people.inFolder("/tmp/proj")).map((p) => p.handle)).toEqual(["minh"])
  expect(office.requests.at(-1)?.raw).toBe("/folders/%2Ftmp%2Fproj/people")
})

test("create a session, prompt it, list it by person", async () => {
  office = createFakeOffice()
  const prompts: string[] = []
  office.onPrompt((_, req) => prompts.push(req.text))
  const s = await client().sessions.create({ person: "minh", cwd: "/tmp/proj" })
  expect([s.person, s.kind, s.status]).toEqual(["minh", "main", "starting"])
  // A prompt sent while the session starts is queued until it is ready.
  expect(await client().sessions.prompt(s.id, { text: "hi" })).toEqual({ ok: true })
  await until(() => prompts.length > 0)
  expect(prompts).toEqual(["hi"])
  expect((await client().sessions.messages(s.id)).map((m) => m.role)).toEqual(["user"])
  expect((await client().sessions.get(s.id)).status).toBe("busy")
  expect((await client().sessions.list({ person: "minh", limit: 1 }))[0].id).toBe(s.id)
})

test("interrupt, end, and the cost cap", async () => {
  office = createFakeOffice()
  const id = office.state.sessions[0].id
  await client().sessions.prompt(id, { text: "go" })
  await client().sessions.interrupt(id)
  // The session stays busy until the stopped reply ends.
  expect((await client().sessions.get(id)).status).toBe("busy")
  expect((await client().sessions.costCap(id, { cost_cap_usd: 5 })).cost_cap_usd).toBe(5)
  // A cap at or below the cost so far is the office's cap_too_low; a cap that isn't a number is invalid_body.
  expect((await failure(client().sessions.costCap(id, { cost_cap_usd: 0 }))).code).toBe("cap_too_low")
  const notNumber = request(office.socket, "POST", `/sessions/${id}/cost-cap`, { cost_cap_usd: "5" })
  expect((await failure(notNumber)).code).toBe("invalid_body")
  await client().sessions.end(id)
  expect((await client().sessions.get(id)).status).toBe("ending")
  await until(() => office.state.sessions[0].status === "ended")
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

test("a stale profile write is a VersionConflictError", async () => {
  office = createFakeOffice()
  const p = await client().profiles.get("minh")
  await client().profiles.put("minh", { text: "v2", base_version: p.version })
  const err = await failure(client().profiles.put("minh", { text: "v3", base_version: p.version }))
  expect(err).toBeInstanceOf(VersionConflictError)
})

test("hire previews, then confirms by handle with no id", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  const preview = await client().people.hire({ ...req, confirm: false })
  expect([preview.commit, preview.diff.includes("people/lan/person.yaml"), "id" in preview.person]).toEqual([
    null,
    true,
    false,
  ])
  const done = await client().people.hire({ ...req, confirm: true })
  expect(done.commit).not.toBeNull()
  expect((await client().people.list()).map((p) => p.handle)).toContain("lan")
})

test("a hire confirm repeats the preview; a taken handle is a lint issue on preview and a 422 on confirm", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  await client().people.hire({ ...req, confirm: false })
  const changed = await failure(client().people.hire({ ...req, title: "Lead", confirm: true }))
  expect([changed.status, changed.code]).toEqual([422, "lint_failed"])
  const dup = await client().people.hire({ ...req, handle: "minh", confirm: false })
  expect(dup.issues).toEqual([
    { path: "people/minh/person.yaml", code: "person.duplicate_handle", message: "@minh is already taken", severity: "error" },
  ])
  const refused = await failure(client().people.hire({ ...req, handle: "minh", confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "@minh is already taken"])
})

test("a hire confirm never previewed is lint_failed", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  const unseen = await failure(client().people.hire({ ...req, confirm: true }))
  expect([unseen.status, unseen.code]).toEqual([422, "lint_failed"])
  expect(unseen.message).toContain("preview it again")
})

test("a hire checks the body like the office; an unknown manager is a lint issue", async () => {
  office = createFakeOffice()
  const req = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
  for (const body of [
    { ...req, handle: "Lan" },
    { ...req, extra: 1 },
    { ...req, id: "minh" },
  ]) {
    const e = await failure(client().people.hire(body as any))
    expect([e.status, e.code]).toEqual([422, "invalid_body"])
  }
  const orphan = await client().people.hire({ ...req, manager: "kai", confirm: false })
  expect(orphan.issues).toEqual([
    { path: "people/lan/person.yaml", code: "person.unknown_manager", message: "kai", severity: "error" },
  ])
  const refused = await failure(client().people.hire({ ...req, manager: "kai", confirm: true }))
  expect([refused.status, refused.code, refused.message]).toEqual([422, "lint_failed", "kai"])
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

test("unknown paths and wrong methods", async () => {
  office = createFakeOffice()
  expect((await failure(request(office.socket, "GET", "/nope"))).code).toBe("no_route")
  expect((await failure(request(office.socket, "PUT", "/people", {}))).status).toBe(405)
  expect((await failure(client().sessions.get("NOPE"))).code).toBe("not_found")
  expect((await failure(request(office.socket, "POST", "/sessions", { person: 1 }))).code).toBe("invalid_body")
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

test("connections: the list with can_manage for the asker, a connection's models, and ?refresh=1", async () => {
  office = createFakeOffice()
  const list = await client().connections.list()
  expect(list.connections.map((c) => `${c.name} (${c.provider})`)).toEqual(["office (azure)", "azure-2 (azure)"])
  expect([list.default, list.can_manage]).toEqual(["office", true])
  const models = await client().connections.models("azure-2")
  expect([models.connection, models.listed, models.models.map((m) => m.id)]).toEqual([
    "azure-2",
    true,
    ["gpt-4o-mini", "o3-mini"],
  ])
  await client().connections.models("azure-2", { refresh: true })
  expect(office.requests.at(-1)?.raw).toBe("/connections/azure-2/models?refresh=1")
  expect((await failure(client().connections.models("nope"))).code).toBe("not_found")
  office.state.managers = []
  expect((await client().connections.list()).can_manage).toBe(false)
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

test("continue posts no body with the create limit; the office refuses a live or composer session", async () => {
  office = createFakeOffice()
  const old = office.newSession({
    person: "minh",
    cwd: "/tmp/proj",
    harness: "codex",
    status: "ended",
    harness_session_id: "thr_1",
  })
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) => (asked.push(ms), timeout(ms)))
  const next = await client().sessions.continue(old.id).finally(() => spy.mockRestore())
  expect(asked).toEqual([CREATE_TIMEOUT_MS])
  expect(office.requests.at(-1)).toMatchObject({ method: "POST", path: `/sessions/${old.id}/continue`, body: undefined })
  expect([next.harness, next.parent_session_id, next.harness_session_id]).toEqual(["codex", old.id, "thr_1"])
  const live = await failure(client().sessions.continue(next.id))
  expect([live.status, live.code]).toEqual([409, "live"])
  const composer = office.state.sessions.find((s) => s.harness === "composer")!
  const refused = await failure(client().sessions.continue(composer.id))
  expect([refused.status, refused.code]).toEqual([422, "not_continuable"])
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
