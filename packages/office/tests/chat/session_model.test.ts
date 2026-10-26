/** The connection and model a chat runs on (Python's `tests/chat/test_session_model.py`). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { AuthStore, OAuthCredentials } from "@ngocbh/yian/llm_clients"
import { AUTH_FILE_ENV, ConnectionFile } from "../../src/chat/connections.ts"
import { DEFAULT_PRICE } from "../../src/chat/cost.ts"
import { type ActorContext, refusedKey } from "../../src/chat/session_actor.ts"
import { waitFor } from "../helpers.ts"
import {
  ACCESS,
  type ChatOffice,
  chatOffice,
  errors,
  fakeLlm,
  makeActor,
  makeHarness,
  newSession,
  noWorkersLeft,
  REFRESH,
  type ScriptedWorker,
  say,
  scriptedWorker,
  session,
  startActor,
  status,
} from "./helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

/** Session `sid`'s connection, model and note. */
function chose(o: ChatOffice, sid: string): [string | null, string | null, string | null] {
  const { connection, model, model_note } = session(o, sid)
  return [connection, model, model_note]
}

/** Workers for an actor's context that spawn through `o`'s registry, recording each spawn's env. */
function recordEnvs(o: ChatOffice): { workers: ActorContext["workers"]; envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = []
  return {
    envs,
    workers: {
      spawn: (job, sessionDir, handlers, options) => {
        envs.push(options.env)
        return o.ctx.workers.spawn(job, sessionDir, handlers, options)
      },
    },
  }
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

test("changing the default never moves an existing chat", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  fake.script({ content: "still one" })
  const { actor, sid } = await startActor(o)
  await o.office.connections.setDefault("second")
  expect(await say(o, actor, sid, "hi")).toBe("still one")
  expect(fake.requests().at(-1)!.model).toBe("stub")
  expect(chose(o, sid)).toEqual(["office", null, null])
  expect(session(o, sid).run_ids).toHaveLength(1)
})

test("a new chat on a second connection records it", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  scriptedWorker(o)
  const sid = await newSession(o, { connection: "second", model: "stub-5" })
  await makeActor(o, sid).start()
  const run = o.office.store.getRun(session(o, sid).run_ids.at(-1)!)!
  expect([run.connection, run.model]).toEqual(["second", "stub-5"])
  expect(o.jobs[0]!.llm_config).toMatchObject({ model: "stub-5" })
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
  const o = await chatOffice(fake)
  const auth = await subscribe(o)
  const { workers, envs } = recordEnvs(o)
  const sid = await newSession(o, { connection: "chatgpt" })
  await makeActor(o, sid, { workers }).start()
  await waitFor(() => status(o, sid) === "idle", { what: "the first turn" })
  const [job] = o.jobs
  const [env] = envs
  expect(o.jobs).toHaveLength(1)
  expect(env![AUTH_FILE_ENV]).toBe(auth)
  expect(job!.llm_config).toEqual({ provider: "openai", model: "gpt-sub" })
  for (const text of [JSON.stringify(env), JSON.stringify(job!.llm_config), o.logs.join("\n")]) {
    expect(text).not.toContain(ACCESS)
    expect(text).not.toContain(REFRESH)
  }
  expect(chose(o, sid)).toEqual(["chatgpt", null, null])
  expect(fake.requests()).toEqual([])
})

test.each([
  ["unpriced", {}, 0],
  ["priced", { "gpt-sub": { input: 1, output: 2 } }, 3],
] as const)("a subscriptions usage is free unless its file prices it [%s]", async (_case, prices, usd) => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  await subscribe(o, "chatgpt", prices)
  const workers = scriptedWorker(o)
  const sid = await newSession(o, { connection: "chatgpt" })
  await makeActor(o, sid).start()
  modelCall(workers[0]!, "gpt-sub", 1_000_000, 1_000_000)
  const [model, price] = await charged(o, sid)
  expect(model).toBe("gpt-sub")
  expect(price).toBeCloseTo(usd)
  expect(session(o, sid).cost).toBeCloseTo(usd)
})

test("a subscription run is recorded on it and resumed and learned from on the same sign in", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake)
  const auth = await subscribe(o)
  const workers = scriptedWorker(o)
  const { workers: recording, envs } = recordEnvs(o)
  const sid = await newSession(o, { connection: "chatgpt" })
  const actor = makeActor(o, sid, { workers: recording })
  await actor.start()
  const runId = actor.runId!
  const run = o.office.store.getRun(runId)!
  expect([run.connection, run.model]).toEqual(["chatgpt", null])
  // The worker is killed: its retry advances the same run on the same sign-in.
  workers[0]!.handlers.exited(workers[0]!.worker, 1)
  await waitFor(() => workers.length === 2, { what: "the retry" })
  expect(workers[1]!.job).toMatchObject({ kind: "advance", run_id: runId })
  expect(o.kinds.map((kind, i) => [kind, envs[i]![AUTH_FILE_ENV]])).toEqual([
    ["chat", auth],
    ["advance", auth],
  ])
  // Still free: a model its file doesn't price costs nothing on the retried run.
  modelCall(workers[1]!, "gpt-sub", 1_000_000, 0)
  expect(await charged(o, sid)).toEqual(["gpt-sub", 0])
})

test("a connection removed as its chat starts is priced as a key", async () => {
  const fake = await fakeLlm()
  const o = await chatOffice(fake, { connections: { second: "stub-2" } })
  const workers = scriptedWorker(o)
  const connections = o.office.connections
  const resolve = connections.resolve.bind(connections)
  connections.resolve = async (name, model) => {
    const provider = await resolve(name, model)
    // Removed between the spawn resolving it and pricing it.
    if (name === "second") await connections.remove(name)
    return provider
  }
  const sid = await newSession(o, { connection: "second" })
  await makeActor(o, sid).start()
  expect(session(o, sid).connection).toBe("second")
  expect(await connections.names()).not.toContain("second")
  // Under the company's $5 cap.
  modelCall(workers[0]!, "unpriced", 100_000, 0)
  const [, usd] = await charged(o, sid)
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
