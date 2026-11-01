/** The connection and model a chat runs on (Python's `tests/chat/test_session_model.py`). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { AuthStore, OAuthCredentials } from "@ngocbh/yian/llm_clients"
import { AUTH_FILE_ENV, ConnectionFile } from "../../src/chat/connections.ts"
import { DEFAULT_PRICE } from "../../src/chat/cost.ts"
import { type Lister, TIMED_OUT, ownModels } from "../../src/chat/models.ts"
import { WOKEN_NOTE, refusedKey } from "../../src/chat/session_actor.ts"
import { HarnessError } from "../../src/chat/state.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { writePrivate } from "../../src/secrets.ts"
import type { SessionRecord } from "../../src/store/store.ts"
import { person } from "../company/helpers.ts"
import { waitFor } from "../helpers.ts"
import {
  ACCESS,
  type ChatOffice,
  errors,
  fakeLlm,
  makeHarness,
  noWorkersLeft,
  REFRESH,
  replyRunning,
  type ScriptedWorker,
  scriptedWorker,
  status,
  texts,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Records the env of each spawn through `o`'s registry; returns them, in order. */
function recordEnvs(o: ChatOffice): Record<string, string>[] {
  const envs: Record<string, string>[] = []
  const spawn = o.registry.spawn.bind(o.registry)
  o.registry.spawn = (job, sessionDir, handlers, options) => {
    envs.push(options?.env ?? {})
    return spawn(job, sessionDir, handlers, options)
  }
  return envs
}

/** Reports a model call of `model` on `scripted`'s run that took `input` and gave `output` tokens. */
function modelCall(scripted: ScriptedWorker, model: string, input: number, output: number): void {
  const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output }
  scripted.handlers.event(scripted.worker, { type: "event", name: "ModelCallFinished", data: { model, usage } })
}

/** Waits for session `sid`'s first usage row; returns its model and price. */
async function charged(o: ChatOffice, sid: string): Promise<[string, number]> {
  await waitFor(() => o.office.store.listUsage(sid).length > 0, { what: "the charge" })
  const [usage] = o.office.store.listUsage(sid)
  return [usage!.model, usage!.usd]
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** Company files in which minh's person.yaml asks for `model`. */
function wants(model: string): Record<string, unknown> {
  return { "people/minh/person.yaml": person("minh", { model }) }
}

/** Starts minh's chat in `h.folder` on `pick` and waits for its first turn; returns it as stored. */
async function start(h: Harness, pick: { connection?: string; model?: string } = {}): Promise<SessionRecord> {
  const s = await h.harness.startSession("minh", h.folder, pick)
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  return h.store.getSession(s.id)!
}

/** minh as `h`'s company has him now. */
async function minh(h: Harness) {
  return loadRepo(await h.office.git.pin(await h.office.git.head())).people.get("minh")!
}

/** A session's connection, model and note. */
function picked(s: SessionRecord): [string | null, string | null, string | null] {
  return [s.connection, s.model, s.model_note]
}

/** A choice's connection, model and note. */
function choice(c: { connection: string; model: string | null; note: string | null }) {
  return [c.connection, c.model, c.note]
}

/** Sends `text` to session `sid` through the harness and waits for its reply; returns the reply's text. */
async function tell(h: Harness, sid: string, text: string): Promise<string> {
  const n = texts(h, sid).length
  await h.harness.prompt(sid, text)
  await waitFor(() => texts(h, sid).length > n && status(h, sid) === "idle", { what: `the reply to ${text}` })
  return texts(h, sid).at(-1)!
}

/** The connection and model of session `sid`'s current run, as its runs row records them. */
function recordOf(h: Harness, sid: string): [string | null, string | null] {
  const run = h.store.getRun(h.store.getSession(sid)!.run_ids.at(-1)!)!
  return [run.connection, run.model]
}

/** What `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HarnessError)
      return error as HarnessError
    },
  )
}

/** The text of each user message in a model request, in order. */
function userTexts(request: Record<string, unknown>): string[] {
  return (request.messages as { role: string; content: unknown }[])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
}

test("a new chat records the default connection and its own model", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual(["office", null, null])
})

test("the requested pick wins", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" }, files: wants("stub") })
  fake.script({ content: "on two" })
  const s = await start(h, { connection: "second" })
  expect(picked(s)).toEqual(["second", null, null])
  expect(await tell(h, s.id, "hi")).toBe("on two")
  expect(fake.requests().at(-1)!.model).toBe("stub-2")
})

test("a requested model alone is on the default", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  await h.office.connections.setDefault("second")
  fake.script({ content: "on five" })
  const s = await start(h, { model: "stub-5" })
  expect(picked(s)).toEqual(["second", "stub-5", null])
  await tell(h, s.id, "hi")
  expect(fake.requests().at(-1)!.model).toBe("stub-5")
})

test("a pick equal to the connections own model is stored as null", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder, { connection: "second", model: "stub-2" })
  expect(picked(s)).toEqual(["second", null, null])
})

test("an unknown requested connection falls through with a note", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder, { connection: "gone", model: "stub-2" })
  expect(picked(s)).toEqual(["office", null, "Your last pick 'gone' isn't on this office; this chat uses office/stub."])
})

test("an unknown pick falls through to the persons model", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" }, files: wants("stub-2") })
  const s = await h.harness.startSession("minh", h.folder, { connection: "gone" })
  expect(picked(s)).toEqual([
    "second",
    null,
    "Your last pick 'gone' isn't on this office; this chat uses second/stub-2.",
  ])
})

test("person model resolves to a connection that lists it", async () => {
  const fake = await fakeLlm()
  // A fresh office: nothing is listed yet, so second is listed now.
  const h = await makeHarness(fake, {
    connections: { second: "stub-3" },
    listings: { second: ["stub-2", "stub-3"] },
    files: wants("stub-2"),
  })
  fake.script({ content: "on two" })
  const s = await start(h)
  expect(picked(s)).toEqual(["second", "stub-2", null])
  await tell(h, s.id, "hi")
  expect(fake.requests().at(-1)!.model).toBe("stub-2")
})

test("the default connection wins when two offer it", async () => {
  const h = await makeHarness(await fakeLlm(), {
    connections: { second: "stub-2", third: "stub-3" },
    listings: { second: ["stub-7"], third: ["stub-7"] },
    files: wants("stub-7"),
  })
  await h.office.connections.setDefault("third")
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual(["third", "stub-7", null])
})

test("after the default the others are tried by name", async () => {
  const h = await makeHarness(await fakeLlm(), {
    connections: { zed: "stub-2", abe: "stub-3" },
    listings: { zed: ["stub-7"], abe: ["stub-7"] },
    files: wants("stub-7"),
  })
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual(["abe", "stub-7", null])
})

test("after a default other than office the others are tried by name", async () => {
  const h = await makeHarness(await fakeLlm(), {
    connections: { zed: "stub-2", abe: "stub-3" },
    listings: { office: ["stub-7"], abe: ["stub-7"], zed: [] },
    files: wants("stub-7"),
  })
  await h.office.connections.setDefault("zed")
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual(["abe", "stub-7", null])
})

test("a pick that cant be used falls through with a note", async () => {
  const h = await makeHarness(await fakeLlm(), {
    connections: { second: "stub-2", third: "stub-3" },
    files: wants("stub-3"),
  })
  await writePrivate(path.join(h.office.connections.dir, "second.json"), "{not json")
  const s = await h.harness.startSession("minh", h.folder, { connection: "second", model: "stub-5" })
  expect(picked(s)).toEqual([
    "third",
    null,
    "Your last pick 'second' can't be used on this office; this chat uses third/stub-3.",
  ])
  expect(h.logs.join("\n")).not.toContain(h.office.connections.dir)
})

test("a default that cant be read still takes the pick and the persons model", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" }, files: wants("stub-2") })
  await writePrivate(path.join(h.office.connections.dir, "_default.json"), "[]")
  expect(choice(await h.harness.choose(await minh(h), "second", "stub-5"))).toEqual(["second", "stub-5", null])
  expect(choice(await h.harness.choose(await minh(h), null, null))).toEqual(["second", null, null])
  expect(h.logs.join("\n")).toContain("default connection can't be read")
  expect(h.logs.join("\n")).not.toContain(h.office.connections.dir)
})

test("a chat on the office because the default cant be read says so", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  await writePrivate(path.join(h.office.connections.dir, "_default.json"), "[]")
  const s = await h.harness.startSession("minh", h.folder)
  expect(picked(s)).toEqual([
    "office",
    null,
    "The office's default connection can't be read; this chat uses office/stub.",
  ])
  // Picked, not fallen back on.
  expect(choice(await h.harness.choose(await minh(h), "office", null))).toEqual(["office", null, null])
  expect(choice(await h.harness.choose(await minh(h), null, "stub-5"))).toEqual([
    "office",
    "stub-5",
    "The office's default connection can't be read; this chat uses office/stub-5.",
  ])
})

/** A harness whose default connection is `third`, whose file can't be parsed (`more` adds connections). */
async function brokenDefault(more: Record<string, string> = {}, files: Record<string, unknown> = {}) {
  const h = await makeHarness(await fakeLlm(), { connections: { third: "stub-3", ...more }, files })
  await h.office.connections.setDefault("third")
  await writePrivate(path.join(h.office.connections.dir, "third.json"), "{not json")
  return h
}

/** Whether `h`'s log says the default can't be used, and names none of the connections' files. */
function saysBroken(h: Harness): void {
  expect(h.logs.join("\n")).toContain("the office's default connection 'third' can't be used")
  expect(h.logs.join("\n")).not.toContain(h.office.connections.dir)
}

test("a default that cant be used gives way to the office with a note", async () => {
  const h = await brokenDefault()
  expect(choice(await h.harness.choose(await minh(h), null, null))).toEqual([
    "office",
    null,
    "The office's default connection 'third' can't be used; this chat uses office/stub.",
  ])
  // A pick of it falls back the same way, and says both.
  expect(choice(await h.harness.choose(await minh(h), "third", null))).toEqual([
    "office",
    null,
    "Your last pick 'third' can't be used on this office. The office's default connection 'third' can't be used; " +
      "this chat uses office/stub.",
  ])
  // A model picked alone is on the default, which is office now.
  expect(choice(await h.harness.choose(await minh(h), null, "stub-5"))).toEqual([
    "office",
    "stub-5",
    "The office's default connection 'third' can't be used; this chat uses office/stub-5.",
  ])
  saysBroken(h)
})

test("a default that cant be used leaves a working pick alone", async () => {
  const h = await brokenDefault({ second: "stub-2" })
  expect(choice(await h.harness.choose(await minh(h), "second", "stub-5"))).toEqual(["second", "stub-5", null])
  saysBroken(h)
})

test("a persons model no connection offers falls back past a default that cant be used", async () => {
  const h = await brokenDefault({}, wants("nowhere-1"))
  expect(choice(await h.harness.choose(await minh(h), null, null))).toEqual([
    "office",
    null,
    "@minh asks for nowhere-1, which no connection on this office offers. The office's default connection 'third' " +
      "can't be used; this chat uses office/stub.",
  ])
  saysBroken(h)
})

test("a default subscription with no sign in gives way to the office", async () => {
  const h = await makeHarness(await fakeLlm())
  const auth = await subscribe(h, "third")
  await h.office.connections.setDefault("third")
  fs.rmSync(auth)
  expect(choice(await h.harness.choose(await minh(h), null, null))).toEqual([
    "office",
    null,
    "The office's default connection 'third' can't be used; this chat uses office/stub.",
  ])
  saysBroken(h)
})

test("a chat whose default cant be used starts on the office and says so", async () => {
  const h = await brokenDefault()
  const s = await start(h)
  expect(picked(s)).toEqual([
    "office",
    null,
    "The office's default connection 'third' can't be used; this chat uses office/stub.",
  ])
  saysBroken(h)
})

test("a connection that cant be read offers nothing", async () => {
  const h = await makeHarness(await fakeLlm(), {
    connections: { zed: "stub-2" },
    listings: { zed: ["stub-7"] },
    files: wants("stub-7"),
  })
  await writePrivate(path.join(h.office.connections.dir, "bad.json"), "{not json")
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual(["zed", "stub-7", null])
  expect(h.logs).toContain("connection bad can't be read; a new chat doesn't start on it")
})

test("an unresolved person model falls back with a note", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" }, files: wants("stub-9") })
  expect(picked(await h.harness.startSession("minh", h.folder))).toEqual([
    "office",
    null,
    "@minh asks for stub-9, which no connection on this office offers; this chat uses office/stub.",
  ])
})

test("the note names a default with no configured model by its name", async () => {
  const h = await makeHarness(await fakeLlm(), { files: wants("stub-9"), llmConfig: { provider: "vllm" } })
  // A run without a model can't start; only the choice matters here.
  expect(choice(await h.harness.choose(await minh(h), null, null))).toEqual([
    "office",
    null,
    "@minh asks for stub-9, which no connection on this office offers; this chat uses office.",
  ])
})

test("resolution has one deadline and falls back with a note", async () => {
  // Each listing alone fits the deadline; the two together don't.
  const slow: Lister = async (conn, name, { deadlineMs }) => {
    await Bun.sleep(Math.min(600, deadlineMs))
    if (deadlineMs < 600) return ownModels(conn, name, TIMED_OUT)
    return { connection: name, models: [{ id: "stub-8", name: null }], listed: true, error: null }
  }
  const h = await makeHarness(await fakeLlm(), {
    connections: { second: "stub-2" },
    lister: slow,
    chooseDeadlineMs: 1000,
    files: wants("stub-9"),
  })
  const began = performance.now()
  const chosen = await h.harness.choose(await minh(h), null, null)
  expect(performance.now() - began).toBeLessThan(3000)
  expect(choice(chosen)).toEqual([
    "office",
    null,
    "Couldn't check in time which connection offers stub-9; this chat uses office/stub.",
  ])
})

test("changing the default never moves an existing chat", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "still one" })
  const s = await start(h)
  await h.office.connections.setDefault("second")
  expect(await tell(h, s.id, "hi")).toBe("still one")
  expect(fake.requests().at(-1)!.model).toBe("stub")
  expect(picked(h.store.getSession(s.id)!)).toEqual(["office", null, null])
  expect(h.store.getSession(s.id)!.run_ids).toHaveLength(1)
})

test("a new chat on a second connection records it", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await start(h, { connection: "second", model: "stub-5" })
  expect(recordOf(h, s.id)).toEqual(["second", "stub-5"])
})

test("set model takes effect on the next turn with a fresh run", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "on one" }, { content: "on five" })
  const s = await start(h)
  await tell(h, s.id, "first-turn-text")
  const switched = await h.harness.setModel(s.id, "second", "stub-5")
  expect(picked(switched)).toEqual(["second", "stub-5", null])
  // Nothing restarts before the next turn.
  expect(h.store.getSession(s.id)!.run_ids).toHaveLength(1)
  expect(await tell(h, s.id, "b")).toBe("on five")
  expect(fake.requests().at(-1)!.model).toBe("stub-5")
  expect(h.store.getSession(s.id)!.run_ids).toHaveLength(2)
  expect(recordOf(h, s.id)).toEqual(["second", "stub-5"])
  // The fresh run's seeded history carried it over.
  expect(JSON.stringify(fake.requests().at(-1)!.messages)).toContain("first-turn-text")
})

test("a switch during a reply lets it finish on the old model", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "Done on one.", hold: 30 }, { content: "on two" })
  const s = await start(h)
  await h.harness.prompt(s.id, "a")
  await fake.waitForRequests(1)
  await h.harness.setModel(s.id, "second", "stub-2")
  fake.release()
  await waitFor(() => texts(h, s.id).at(-1) === "Done on one." && status(h, s.id) === "idle", { what: "the reply" })
  expect(fake.requests().map((r) => r.model)).toEqual(["stub"])
  expect(h.store.getSession(s.id)!.run_ids).toHaveLength(1)
  expect(await tell(h, s.id, "b")).toBe("on two")
  expect(fake.requests().at(-1)!.model).toBe("stub-2")
})

test(
  "a steer during a switched reply is read on the old model and the next message reaches the new model once",
  async () => {
    const fake = await fakeLlm()
    const h = await makeHarness(fake, { connections: { second: "stub-2" } })
    const echo = { name: "fake__echo", arguments: { text: "x" } }
    fake.script(
      { content: "Working", tool_calls: [echo], hold: 30 },
      { content: "Done on one." },
      { content: "on two" },
    )
    const s = await start(h)
    const statuses: string[] = []
    onTestFinished(
      h.store.addListener((event) => {
        const data = event.data as { id?: string; status?: string }
        if (event.type === "session.updated" && data.id === s.id) statuses.push(data.status!)
      }),
    )
    await h.harness.prompt(s.id, "a")
    await fake.waitForRequests(1)
    await replyRunning(h)
    expect(await h.harness.prompt(s.id, "steered-1")).toBe("steer")
    await h.harness.setModel(s.id, "second", "stub-2")
    fake.release()
    await waitFor(() => texts(h, s.id).at(-1) === "Done on one." && status(h, s.id) === "idle", { what: "the reply" })
    // The running reply read it on the old model: a late steer.
    const [, read] = fake.requests()
    expect(read!.model).toBe("stub")
    expect(userTexts(read!).at(-1)).toContain("steered-1")
    expect(h.store.getSession(s.id)!.run_ids).toHaveLength(1)
    // The next message, which no reply reads, moves to the fresh run and reaches the new model once.
    expect(await tell(h, s.id, "queued-1")).toBe("on two")
    const requests = fake.requests()
    expect(requests.at(-1)!.model).toBe("stub-2")
    expect(requests.filter((r) => JSON.stringify(r.messages).includes("queued-1"))).toEqual([requests.at(-1)!])
    expect(userTexts(requests.at(-1)!).at(-1)).toContain("queued-1")
    expect(statuses.filter((st) => st === "ending" || st === "ended")).toEqual([])
    expect(h.store.getSession(s.id)!.run_ids).toHaveLength(2)
  },
)

test("set model refuses ended sessions and unknown connections", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await start(h)
  const unknown = await rejection(h.harness.setModel(s.id, "gone", "stub-2"))
  expect([unknown.status, unknown.code, unknown.message]).toEqual([
    422,
    "unknown_connection",
    "no such connection on this office",
  ])
  const missing = await rejection(h.harness.setModel("01J0000000000000000000000Z", "second", "stub-2"))
  expect([missing.status, missing.code]).toEqual([404, "not_found"])
  await h.harness.end(s.id)
  await waitFor(() => status(h, s.id) === "ended", { what: "the end" })
  const ended = await rejection(h.harness.setModel(s.id, "second", "stub-2"))
  expect([ended.status, ended.code]).toEqual([409, "not_live"])
  expect(picked(h.store.getSession(s.id)!)).toEqual(["office", null, null])
})

test("set model refuses a session that is ending", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "never", hold: 30 })
  const s = await start(h)
  await h.harness.prompt(s.id, "hi")
  await fake.waitForRequests(1)
  await h.harness.end(s.id)
  expect(status(h, s.id)).toBe("ending")
  const ending = await rejection(h.harness.setModel(s.id, "second", "stub-2"))
  expect([ending.status, ending.code]).toEqual([409, "ending"])
  fake.release()
  await waitFor(() => status(h, s.id) === "ended", { what: "the end" })
})

test("set model refuses a connection that cant be read without naming its file", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder)
  await writePrivate(path.join(h.office.connections.dir, "second.json"), "{not json")
  const refused = await rejection(h.harness.setModel(s.id, "second", "stub-5"))
  expect([refused.status, refused.code]).toEqual([409, "connection_unusable"])
  expect(refused.message).toContain("second")
  expect(refused.message).not.toContain(h.office.connections.dir)
  expect(h.logs).toContain(`connection second can't be used; session ${s.id} stays where it is`)
  expect(picked(h.store.getSession(s.id)!)).toEqual(["office", null, null])
})

test("set model clears the note", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder, { connection: "gone" })
  expect(s.model_note).toBeTruthy()
  const seen: Record<string, unknown>[] = []
  onTestFinished(
    h.store.addListener((event) => {
      if (event.type === "session.updated") seen.push(event.data as Record<string, unknown>)
    }),
  )
  expect(picked(await h.harness.setModel(s.id, "second", "stub-5"))).toEqual(["second", "stub-5", null])
  const last = seen.at(-1)!
  expect([last.connection, last.model, last.model_note]).toEqual(["second", "stub-5", null])
})

test("set model to the connections own model stores null", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder)
  expect(picked(await h.harness.setModel(s.id, "second", "stub-2"))).toEqual(["second", null, null])
  expect(picked(await h.harness.setModel(s.id, "office", "stub"))).toEqual(["office", null, null])
  expect(picked(await h.harness.setModel(s.id, "office", "stub-2"))).toEqual(["office", "stub-2", null])
})

test("a new actor after a switch starts a fresh run with the woken note", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "on two" })
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  const s = await start(h)
  const old = h.store.getSession(s.id)!.run_ids
  await h.harness.setModel(s.id, "second", "stub-2")
  // The office stopped and started again: its next message wakes the chat on the new model.
  await h.reopen()
  expect(await tell(h, s.id, "b")).toBe("on two")
  const stored = h.store.getSession(s.id)!
  expect(stored.run_ids).toHaveLength(2)
  expect(old).not.toContain(stored.run_ids.at(-1))
  expect(recordOf(h, s.id)[0]).toBe("second")
  expect(stored.model_note).toBe(WOKEN_NOTE)
  expect(fake.requests().at(-1)!.model).toBe("stub-2")
})

// Subscriptions.

/** A subscription runs against chatgpt.com; should a test's worker ever call it, the call goes nowhere. */
const NO_NETWORK = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" }

/** Adds subscription `name` on model `gpt-sub`, signed in with fake tokens good for a year; returns its auth file. */
async function subscribe(o: ChatOffice, name = "chatgpt", prices: Record<string, unknown> = {}): Promise<string> {
  const creds = new OAuthCredentials({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: Date.now() / 1000 + 365 * 86400,
    accountId: "account-test",
  })
  const conn = ConnectionFile.parse({
    method: "subscription",
    llm_config: { provider: "openai", model: "gpt-sub" },
    env: NO_NETWORK,
    prices,
  })
  await o.office.connections.add(name, conn, {
    signIn: async (auth) => void (await new AuthStore(auth).save("openai", creds, "gpt-sub")),
  })
  return o.office.connections.authFile(name)
}

test("a subscription chat runs on its own sign in without a key", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake)
  const auth = await subscribe(h)
  const envs = recordEnvs(h)
  const s = await start(h, { connection: "chatgpt" })
  const [job] = h.jobs
  const [env] = envs
  expect(h.jobs).toHaveLength(1)
  expect(env![AUTH_FILE_ENV]).toBe(auth)
  expect(job!.llm_config).toEqual({ provider: "openai", model: "gpt-sub" })
  for (const text of [JSON.stringify(env), JSON.stringify(job!.llm_config), h.logs.join("\n")]) {
    expect(text).not.toContain(ACCESS)
    expect(text).not.toContain(REFRESH)
  }
  expect(picked(h.store.getSession(s.id)!)).toEqual(["chatgpt", null, null])
  expect(fake.requests()).toEqual([])
})

test.each([
  ["unpriced", {}, 0],
  ["priced", { "gpt-sub": { input: 1, output: 2 } }, 3],
] as const)("a subscriptions usage is free unless its file prices it [%s]", async (_case, prices, usd) => {
  const h = await makeHarness(await fakeLlm())
  await subscribe(h, "chatgpt", prices)
  const workers = scriptedWorker(h)
  const s = await h.harness.startSession("minh", h.folder, { connection: "chatgpt" })
  modelCall(workers[0]!, "gpt-sub", 1_000_000, 1_000_000)
  const [model, price] = await charged(h, s.id)
  expect(model).toBe("gpt-sub")
  expect(price).toBeCloseTo(usd)
  expect(h.store.getSession(s.id)!.cost).toBeCloseTo(usd)
})

test("a subscription run is recorded on it and resumed and learned from on the same sign in", async () => {
  const h = await makeHarness(await fakeLlm())
  const auth = await subscribe(h)
  const workers = scriptedWorker(h)
  const envs = recordEnvs(h)
  const s = await h.harness.startSession("minh", h.folder, { connection: "chatgpt" })
  const runId = s.run_ids.at(-1)!
  expect(recordOf(h, s.id)).toEqual(["chatgpt", null])
  // The worker is killed: its retry advances the same run on the same sign-in.
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", run_id: runId })
  expect(h.kinds.map((kind, i) => [kind, envs[i]![AUTH_FILE_ENV]])).toEqual([
    ["chat", auth],
    ["advance", auth],
  ])
  // Still free: a model its file doesn't price costs nothing on the retried run.
  modelCall(workers[1]!, "gpt-sub", 1_000_000, 0)
  expect(await charged(h, s.id)).toEqual(["gpt-sub", 0])
})

test("a chat moved off a subscription pays for its unpriced models again", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  await subscribe(h)
  // Under the company's $5 cap.
  fake.script({ content: "on two", usage: { prompt_tokens: 100_000, completion_tokens: 0 } })
  const s = await start(h, { connection: "chatgpt" })
  await h.harness.setModel(s.id, "second", "stub-2")
  expect(await tell(h, s.id, "b")).toBe("on two")
  // stub-2 is priced nowhere: the key's default price, not the subscription's free one.
  const [model, usd] = await charged(h, s.id)
  expect(model).toBe("stub-2")
  expect(usd).toBeCloseTo(DEFAULT_PRICE.input / 10)
})

test("a connection removed as its chat starts is priced as a key", async () => {
  const h = await makeHarness(await fakeLlm(), { connections: { second: "stub-2" } })
  const workers = scriptedWorker(h)
  const connections = h.office.connections
  const resolve = connections.resolve.bind(connections)
  const calls: (string | null)[] = []
  connections.resolve = async (name, model) => {
    const provider = await resolve(name, model)
    calls.push(name)
    // The spawn's resolve, after the start checked it can be used: removed between resolving it and pricing it.
    if (calls.filter((c) => c === "second").length === 2) await connections.remove("second")
    return provider
  }
  const s = await h.harness.startSession("minh", h.folder, { connection: "second" })
  expect(h.store.getSession(s.id)!.connection).toBe("second")
  expect(await connections.names()).not.toContain("second")
  // Under the company's $5 cap.
  modelCall(workers[0]!, "unpriced", 100_000, 0)
  const [, usd] = await charged(h, s.id)
  expect(usd).toBeCloseTo(DEFAULT_PRICE.input / 10)
})

test("a refused key says which connection to check", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 401 }, { error: 500 })
  const h = await makeHarness(fake, { connections: { second: "stub-2" } })
  const s = await h.harness.startSession("minh", h.folder, { connection: "second" })
  await waitFor(() => status(h, s.id) === "idle", { what: "the first turn" })
  await h.harness.prompt(s.id, "hi")
  await waitFor(() => h.store.getSession(s.id)!.run_ids.length === 2 && status(h, s.id) === "idle", {
    what: "the new run",
  })
  const [error, ...rest] = errors(h, s.id)
  expect(rest).toEqual([])
  expect(error).toEndWith("Send your message again. Check connection 'second', or pick another model with /model.")
  await h.harness.prompt(s.id, "again")
  await waitFor(() => errors(h, s.id).length === 2, { what: "the second failure" })
  // A failure that isn't the key says nothing of it.
  expect(errors(h, s.id)[1]).not.toContain("/model")
})

test("a refused key is told by its cause or status not any 401", () => {
  expect(refusedKey({ cause_type: "OpenAIAuthenticationError" }, "")).toBe(true)
  expect(refusedKey({ cause_type: "PermissionDeniedError" }, "")).toBe(true)
  expect(refusedKey({ cause_type: "APIStatusError" }, "APIStatusError: Error code: 401 - unauthorized")).toBe(true)
  const tokens = "BadRequestError: your messages resulted in 140100 tokens"
  expect(refusedKey({ cause_type: "BadRequestError" }, tokens)).toBe(false)
  expect(refusedKey({}, "no reason given")).toBe(false)
})

test("a refused key is told by the provider error kind", () => {
  const why = (kind: string) => `ProviderError: azure returned HTTP 418 (${kind}): no`
  expect(refusedKey({ cause_type: "ProviderError" }, why("auth"))).toBe(true)
  expect(refusedKey({ cause_type: "ProviderError" }, why("permission"))).toBe(true)
  expect(refusedKey({ cause_type: "ProviderError" }, why("rate_limit"))).toBe(false)
})
