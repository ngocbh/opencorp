// One request script, run against the fake office and against a real office on a temp home: each step's status,
// error code and reply shape must match, so the frame tests' fake answers as the office does.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { officeFetch, seg } from "@opencorp/client"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import {
  Ack,
  ConnectionList,
  HireResponse,
  HqStatus,
  Message,
  ModelList,
  Person,
  Profile,
  Question,
  Session,
} from "@opencorp/protocol"
import fs from "node:fs"
import path from "node:path"
import { createFakeOffice, type FakeOffice } from "../fixture/fake-office"

/** What a script run keeps: its folder, the chat it started, and the profile version the office gave. */
type Ctx = { cwd: string; id: string; version: string }

type Step = {
  name: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: (ctx: Ctx) => string
  body?: (ctx: Ctx) => unknown
  /** Waits, before sending, until the chat `ctx.id` is idle. */
  idle?: true
  /** The protocol schema a 2xx reply parses with. */
  schema?: Schema
  /** Keeps a value of the reply (the profile version) for later steps. */
  keep?: (reply: any, ctx: Ctx) => void
  /** A value of the reply both offices must agree on. */
  pick?: (reply: any) => unknown
}

/** A protocol zod schema, as far as the script uses it: this package doesn't depend on zod. */
type Schema = { safeParse(value: unknown): { success: boolean; error?: { message: string } } }

/** A step's answer, as compared across the offices. */
type Answer = { status: number; error?: string; keys?: string[]; picked?: unknown; invalid?: string }

/** A well-formed session id that neither office has. */
const NO_SESSION = "01JZZZZZZZZZZZZZZZZZZZZZZZ"
const lan = { name: "Lan", handle: "lan", title: "QA", manager: "ngocbh" }
/** The chat's one prompt, and the assistant's reply to it on both offices. */
const PROMPT = "Hi, who are you?"
const REPLY = "Hello from minh."

const STEPS: Step[] = [
  { name: "health", method: "GET", path: () => "/health", schema: Ack },
  { name: "whoami", method: "GET", path: () => "/whoami" },
  { name: "hq status", method: "GET", path: () => "/hq", schema: HqStatus },
  { name: "people", method: "GET", path: () => "/people", schema: Person.array() },
  {
    name: "start a chat",
    method: "POST",
    path: () => "/sessions",
    body: (c) => ({ person: "minh", cwd: c.cwd }),
    schema: Session,
    keep: (s, c) => (c.id = s.id),
    pick: (s) => [s.status, s.opened_by],
  },
  { name: "people in a folder", method: "GET", path: (c) => `/folders/${seg(c.cwd)}/people`, schema: Person.array() },
  { name: "read a chat", method: "GET", path: (c) => `/sessions/${c.id}`, schema: Session },
  { name: "read a chat neither office has", method: "GET", path: () => `/sessions/${NO_SESSION}` },
  { name: "list chats", method: "GET", path: () => "/sessions?person=minh&limit=1", schema: Session.array() },
  { name: "prompt with a bad body", method: "POST", path: (c) => `/sessions/${c.id}/prompt`, body: () => ({}) },
  {
    name: "prompt",
    method: "POST",
    path: (c) => `/sessions/${c.id}/prompt`,
    body: () => ({ text: PROMPT }),
    idle: true,
    schema: Ack,
  },
  {
    name: "read messages",
    method: "GET",
    path: (c) => `/sessions/${c.id}/messages`,
    idle: true,
    schema: Message.array(),
    pick: (r) => r.map((m: Message) => [m.role, m.author, m.parts.map((p) => (p.type === "text" ? p.text : p.type))]),
  },
  {
    name: "raise a cost cap",
    method: "POST",
    path: (c) => `/sessions/${c.id}/cost-cap`,
    body: () => ({ cost_cap_usd: 5 }),
    schema: Session,
    pick: (s) => s.cost_cap_usd,
  },
  {
    name: "a cost cap of zero",
    method: "POST",
    path: (c) => `/sessions/${c.id}/cost-cap`,
    body: () => ({ cost_cap_usd: 0 }),
  },
  {
    name: "a cost cap as text",
    method: "POST",
    path: (c) => `/sessions/${c.id}/cost-cap`,
    body: () => ({ cost_cap_usd: "5" }),
  },
  // The body is checked before the chat is looked up.
  {
    name: "a cost cap as text on a chat neither office has",
    method: "POST",
    path: () => `/sessions/${NO_SESSION}/cost-cap`,
    body: () => ({ cost_cap_usd: "5" }),
  },
  {
    name: "open questions",
    method: "GET",
    path: (c) => `/questions?session=${c.id}&status=open`,
    schema: Question.array(),
  },
  {
    name: "read a profile",
    method: "GET",
    path: () => "/profiles/minh",
    schema: Profile,
    keep: (p, c) => (c.version = p.version),
  },
  {
    name: "write a profile",
    method: "PUT",
    path: () => "/profiles/minh",
    body: (c) => ({ text: "# Minh\n\nTests first.\n", base_version: c.version }),
    schema: Profile,
  },
  {
    name: "write a profile on a stale version",
    method: "PUT",
    path: () => "/profiles/minh",
    body: (c) => ({ text: "# Minh\n\nStale.\n", base_version: c.version }),
  },
  { name: "preview a hire", method: "POST", path: () => "/people", body: () => ({ ...lan, confirm: false }), schema: HireResponse },
  { name: "confirm a hire", method: "POST", path: () => "/people", body: () => ({ ...lan, confirm: true }), schema: HireResponse },
  {
    name: "preview a hire of a taken handle",
    method: "POST",
    path: () => "/people",
    body: () => ({ ...lan, confirm: false }),
    schema: HireResponse,
    pick: (r) => r.issues.map((i: { code: string; severity: string }) => [i.code, i.severity]),
  },
  { name: "connections", method: "GET", path: () => "/connections", schema: ConnectionList },
  { name: "the models of the office connection", method: "GET", path: () => "/connections/office/models", schema: ModelList },
  { name: "end a chat", method: "POST", path: (c) => `/sessions/${c.id}/end`, schema: Ack },
  { name: "no such route", method: "GET", path: () => "/no/such/route" },
  { name: "a wrong method", method: "DELETE", path: () => "/people" },
]

/** Waits until the chat `ctx.id` on the office on `socket` is idle; fails after 20 s. */
async function idle(socket: string, ctx: Ctx) {
  const deadline = performance.now() + 20_000
  for (;;) {
    const res = await officeFetch({ socket }, `/sessions/${ctx.id}`, {})
    const { status } = await res.json()
    if (status === "idle") return
    if (performance.now() >= deadline) throw new Error(`chat ${ctx.id} is ${status}, not idle, after 20 s`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Sends `step` to the office on `socket` and reduces its answer to what is compared. */
async function send(socket: string, step: Step, ctx: Ctx): Promise<Answer> {
  if (step.idle) await idle(socket, ctx)
  const body = step.body?.(ctx)
  const res = await officeFetch({ socket }, step.path(ctx), {
    method: step.method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  if (!res.ok) return { status: res.status, error: json?.error }
  step.keep?.(json, ctx)
  const answer: Answer = { status: res.status }
  if (step.schema) {
    const parsed = step.schema.safeParse(json)
    if (!parsed.success) answer.invalid = parsed.error?.message
  }
  const first = Array.isArray(json) ? json[0] : json
  if (first && typeof first === "object") answer.keys = Object.keys(first).sort()
  if (step.pick) answer.picked = step.pick(json)
  return answer
}

let fake: FakeOffice
let real: TestOffice
const fakeCtx: Ctx = { cwd: "/tmp/proj", id: "", version: "" }
let realCtx: Ctx

beforeAll(async () => {
  fake = createFakeOffice()
  // The fake's reply, as its tests drive one: the assistant message, then the reply ends.
  fake.onPrompt((id) => {
    fake.state.messages[id]!.push({
      id: fake.nextId(),
      session_id: id,
      role: "assistant",
      author: null,
      parts: [{ id: fake.nextId(), type: "text", text: REPLY }],
      created_at: new Date().toISOString(),
    })
    fake.replyEnded(id)
  })
  real = await startOffice()
  real.llm.script({ match: PROMPT, content: REPLY })
  realCtx = { cwd: path.join(real.root, "proj"), id: "", version: "" }
  fs.mkdirSync(realCtx.cwd)
}, 60_000)
afterAll(async () => {
  fake?.stop()
  await real?.stop()
})

for (const step of STEPS) {
  test(`${step.name}: ${step.method} answers as the real office does`, async () => {
    const want = await send(real.socket, step, realCtx)
    const got = await send(fake.socket, step, fakeCtx)
    // An empty list has no keys to compare; the other office's list is then checked by its schema only.
    if (!want.keys || !got.keys) {
      delete want.keys
      delete got.keys
    }
    expect({ step: step.name, ...got }).toEqual({ step: step.name, ...want })
  }, 30_000)
}
