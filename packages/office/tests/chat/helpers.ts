/** Chat test helpers (Python's `tests/chat/conftest.py`): the fake LLM, the chat flow and OpenAI's
 *  sign-in, faked. */
import { expect, onTestFinished } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HttpResponse } from "@ngocbh/yian/llm_clients"
import type { Scheduler } from "@ngocbh/yian/platform"
import { iterRunRecords, type RunLogEntry } from "@ngocbh/yian/run"
import { FakeLLM, type ScriptedReply } from "../../src/testing/fake_llm.ts"
import { type Delivery, Job, type JobInput } from "../../src/worker/job.ts"
import type { OfficeTool } from "../../src/worker/rpc.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { advanceJob, inProcessWorker, makeJob, Recorder, run, waitsOf } from "../worker/helpers.ts"

/** The template's chat flow, as a hire's main points at it. */
export const CHAT_FLOW = fs.readFileSync(
  new URL("../../src/company_template/template/shared/flows/chat.yaml", import.meta.url),
  "utf8",
)

/** The template's `compact_history.yaml`, which the chat flow uses. */
export const COMPACT_HISTORY = fs.readFileSync(
  new URL("../../src/company_template/template/shared/flows/compact_history.yaml", import.meta.url),
  "utf8",
)

/** The chat flow and the flow it uses, by repo path. */
export const CHAT_FILES = {
  "shared/flows/chat.yaml": CHAT_FLOW,
  "shared/flows/compact_history.yaml": COMPACT_HISTORY,
}

/** A started fake LLM, closed when the current test finishes. Call inside a test. */
export async function fakeLlm(): Promise<FakeLLM> {
  const fake = await FakeLLM.start()
  onTestFinished(() => fake.close())
  return fake
}

// OpenAI's device sign-in, faked: its replies and a token whose signature and refresh are fake secrets.

export const SIGNATURE = "fake-signature-6e2a90d4"
export const REFRESH = "fake-refresh-b81c5f37"

/** A token shaped like OpenAI's, naming `account`; its signature part is a fake secret. */
function jwt(account = "account-test"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SIGNATURE}`
}

export const ACCESS = jwt()

export const USERCODE = new HttpResponse(200, { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1n })
export const PENDING = new HttpResponse(403, { error: "pending" })
export const APPROVED = new HttpResponse(200, { authorization_code: "auth-code", code_verifier: "verifier" })
export const TOKENS = new HttpResponse(200, {
  access_token: ACCESS,
  refresh_token: REFRESH,
  id_token: ACCESS,
  expires_in: 3600n,
})
export const CATALOG = new HttpResponse(200, {
  models: [
    { slug: "gpt-5.5-codex", visibility: "list", priority: 2n },
    { slug: "gpt-5.5", visibility: "list", priority: 1n },
  ],
})

/** A scheduler that moves its clock by each sleep, giving way for ~5 real ms; `now` starts at real time, so a token's
 *  expiry stays real. A sleep of a minute or more (the login's deadline) only ends by its abort, so it never fires
 *  while a test holds a request. */
export function testScheduler(): Scheduler {
  let slept = 0
  return {
    now: () => Date.now() + slept,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = () => {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (ms < 60_000) {
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort)
            slept += ms
            resolve()
          }, 5)
        }
      }),
  }
}

// The template's chat flows, run in an in-process worker.

/** The company template's root. */
export const ROOT = fileURLToPath(new URL("../../src/company_template/template/", import.meta.url))

/** The person a template run plays. */
export const PERSON = { name: "Minh", handle: "minh", title: "Engineer", company: "Acme", reports_to: "" }

/** The groups each template flow names; `ask_user` is the worker's own tool. */
export const GROUPS: Record<string, string[]> = {
  chat: ["toolbox", "workspace", "company"],
  side_chat: ["workspace", "work_items"],
  profile_manager: ["profile"],
}

/** A tool's schema that takes no arguments. */
export const EMPTY = { type: "object", properties: {} }

/** A user message saying `text`, from `author` when given. */
export function message(text: string, author?: string): Record<string, unknown> {
  return { role: "user", parts: [{ type: "text", text }], ...(author === undefined ? {} : { author }) }
}

/** A send of `text` to the messages inbox. */
export function send(id: string, text: string, author?: string): Delivery {
  return { id, op: "send", inbox: "messages", event: message(text, author) }
}

/** A close of the messages inbox. */
export const CLOSE: Delivery = { id: "close", op: "close", inbox: "messages" }

/** A `Recorder` serving one no-op tool, `<group>_stub`, for each group `name`'s flow names, and the tools of `extra`,
 *  by group, merged in. */
export class TemplateOffice extends Recorder {
  constructor(name = "chat", extra: Record<string, Record<string, OfficeTool>> = {}) {
    const tools: Record<string, Record<string, OfficeTool>> = Object.fromEntries(
      GROUPS[name]!.map((group) => [
        group,
        { [`${group}_stub`]: { description: "Does nothing.", parameters: EMPTY, call: () => "ok" } },
      ]),
    )
    for (const [group, named] of Object.entries(extra)) tools[group] = { ...tools[group], ...named }
    super({ tools })
  }
}

/** A chat job running the template flow `name` from a temp copy of the template, or, with `base`, from `base.pin`
 *  (which holds the flow at `shared/flows/<name>.yaml`) logging under `base.runs`; `inputs` replace the defaults. It
 *  logs under `runs` (a temp folder by default) as `runId` (`r1` by default); `over` replaces the job's fields. */
export function templateJob(
  name: string,
  handlers: Recorder,
  inputs: Record<string, unknown> = {},
  {
    runs,
    runId,
    base,
    ...over
  }: { runs?: string; runId?: string; base?: { pin: string; runs: string } } & Partial<JobInput> = {},
): Job {
  let where = base
  if (where === undefined) {
    const root = tempDir()
    where = { pin: path.join(root, "pin"), runs: runs ?? path.join(root, "runs") }
    fs.cpSync(ROOT, where.pin, { recursive: true })
  }
  const who = name === "profile_manager" ? {} : { person: PERSON, talking_to: "" }
  const fields: Partial<JobInput> = {
    inputs: { ...who, summary: "", history: [], turns: 0, max_turns: 500, ...inputs },
    ...(runId === undefined ? {} : { run_id: runId }),
    ...over,
  }
  return makeJob(where, `shared/flows/${name}.yaml`, fields, handlers)
}

/** A fresh chat job after `job`: run `r2` in the same runs folder, same pin, flow, inputs and grants, with no
 *  deliveries and no seed; `over` replaces fields. */
export function nextRun(job: Job, over: Partial<JobInput> = {}): Job {
  const runs = path.dirname(path.dirname(job.log))
  return Job.parse({
    ...job,
    kind: "chat",
    run_id: "r2",
    log: path.join(runs, "r2", "log.jsonl"),
    deliver: [],
    seed: null,
    ...over,
  })
}

/** Advances the run `chat` started, applying `deliver` first; returns its recorder. */
export function advance(chat: Job, fake: FakeLLM, deliver: Delivery[], name = "chat"): Promise<Recorder> {
  return run(advanceJob(chat, { deliver }), new TemplateOffice(name), { env: fake.env() })
}

/** The nodes a waiting result waits at. */
export function waitingAt(rec: Recorder): unknown[] {
  expect(rec.outcome?.status).toBe("waiting")
  return waitsOf(rec).map((wait) => wait.node)
}

/** The data of each NodeSucceeded event `rec` recorded for `node`. */
export function succeeded(rec: Recorder, node: string): Record<string, any>[] {
  return rec.frames
    .filter((frame) => frame.name === "NodeSucceeded" && (frame.data as Record<string, unknown>).node_id === node)
    .map((frame) => frame.data as Record<string, any>)
}

/** Starts a chat job of `name` with no deliveries and runs it to waiting at its first take; returns the job. `runs`
 *  and `runId` are `templateJob`'s. */
export async function waitingChat(
  fake: FakeLLM,
  name = "chat",
  inputs: Record<string, unknown> = {},
  { runs, runId }: { runs?: string; runId?: string } = {},
): Promise<Job> {
  const rec = new TemplateOffice(name)
  const job = templateJob(name, rec, inputs, { runs, runId })
  await run(job, rec, { env: fake.env() })
  expect(waitingAt(rec)).toEqual(["chat#0/heard"])
  return job
}

/** Holds the reply's first model call (answering `held`), sends "queued", interrupts, then releases; returns the
 *  recorder of that run, which answers "queued" as its next turn and waits at the one after. The run logs under
 *  `runs` (a temp folder by default) as `r1`. */
export async function interruptMidReply(
  fake: FakeLLM,
  held: ScriptedReply,
  { runs }: { runs?: string } = {},
): Promise<Recorder> {
  fake.script({ ...held, hold: true }, { content: "Got it." })
  const job = await waitingChat(fake, "chat", {}, { runs })
  const cut = new TemplateOffice()
  const worker = await inProcessWorker(advanceJob(job, { deliver: [send("s1", "one")] }), cut, { env: fake.env() })
  await fake.waitForRequests(1, 30_000)
  expect(await worker.deliver(send("queued", "queued"))).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "queued"), { timeout: 10_000, what: "the send" })
  expect(await worker.deliver({ id: "cut", op: "interrupt", inbox: "messages" })).toBe(true)
  await waitFor(() => cut.replies.some((reply) => reply.id === "cut"), { timeout: 10_000, what: "the interrupt" })
  fake.release()
  expect(await worker.wait()).not.toBeNull()
  // The queued message the cut reply never read is the next turn, taken by the same worker.
  expect(waitingAt(cut)).toEqual(["chat#2/heard"])
  return cut
}

/** Writes the leading records of the run log `log` while `keep` holds for each to `<runs>/<run id>/log.jsonl`, under
 *  the same run id: what a crash leaves. Returns the new log's path. */
export function logPrefix(log: string, keep: (entry: RunLogEntry) => boolean, runs: string): string {
  let end = 0
  for (const entry of iterRunRecords(log, { payloads: true })) {
    if (!keep(entry)) break
    end = entry.end
  }
  const out = path.join(runs, path.basename(path.dirname(log)), "log.jsonl")
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, fs.readFileSync(log).subarray(0, end))
  return out
}
