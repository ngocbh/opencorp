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

/** What a script run keeps: its folder, and the profile version the office gave. */
type Ctx = { cwd: string; version: string }

type Step = {
  name: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: (ctx: Ctx) => string
  body?: (ctx: Ctx) => unknown
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

const STEPS: Step[] = [
  { name: "health", method: "GET", path: () => "/health", schema: Ack },
  { name: "whoami", method: "GET", path: () => "/whoami" },
  { name: "hq status", method: "GET", path: () => "/hq", schema: HqStatus },
  { name: "people", method: "GET", path: () => "/people", schema: Person.array() },
  { name: "people in a folder", method: "GET", path: (c) => `/folders/${seg(c.cwd)}/people`, schema: Person.array() },
  // Not compared: POST /sessions. The real office doesn't run composer chats yet (it answers 501 not_implemented),
  // so the session steps use a session neither office has, comparing the order of their checks.
  { name: "read a chat", method: "GET", path: () => `/sessions/${NO_SESSION}`, schema: Session },
  { name: "list chats", method: "GET", path: () => "/sessions?person=minh&limit=1", schema: Session.array() },
  { name: "read messages", method: "GET", path: () => `/sessions/${NO_SESSION}/messages`, schema: Message.array() },
  { name: "prompt with a bad body", method: "POST", path: () => `/sessions/${NO_SESSION}/prompt`, body: () => ({}) },
  {
    name: "raise a cost cap",
    method: "POST",
    path: () => `/sessions/${NO_SESSION}/cost-cap`,
    body: () => ({ cost_cap_usd: 5 }),
    schema: Session,
  },
  {
    name: "a cost cap of zero",
    method: "POST",
    path: () => `/sessions/${NO_SESSION}/cost-cap`,
    body: () => ({ cost_cap_usd: 0 }),
  },
  {
    name: "a cost cap as text",
    method: "POST",
    path: () => `/sessions/${NO_SESSION}/cost-cap`,
    body: () => ({ cost_cap_usd: "5" }),
  },
  {
    name: "open questions",
    method: "GET",
    path: () => `/questions?session=${NO_SESSION}&status=open`,
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
  { name: "the office connection's models", method: "GET", path: () => "/connections/office/models", schema: ModelList },
  { name: "end a chat", method: "POST", path: () => `/sessions/${NO_SESSION}/end`, schema: Ack },
  { name: "no such route", method: "GET", path: () => "/no/such/route" },
  { name: "a wrong method", method: "DELETE", path: () => "/people" },
]

/** Sends `step` to the office on `socket` and reduces its answer to what is compared. */
async function send(socket: string, step: Step, ctx: Ctx): Promise<Answer> {
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
const fakeCtx: Ctx = { cwd: "/tmp/proj", version: "" }
let realCtx: Ctx

beforeAll(async () => {
  fake = createFakeOffice()
  real = await startOffice()
  realCtx = { cwd: path.join(real.root, "proj"), version: "" }
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
    if (!want.keys || !got.keys) delete want.keys, delete got.keys
    expect({ step: step.name, ...got }).toEqual({ step: step.name, ...want })
  })
}
