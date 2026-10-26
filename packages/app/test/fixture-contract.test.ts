// The Playwright fixture (e2e/fixture.ts) against a real office's HQ: one script of HQ requests runs on both, and each
// step's status, error code and, for 2xx JSON, top-level keys and protocol schema must match. Values (names, ids,
// times) aren't compared: the fixture seeds its own company.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { createOfficeClient } from "@opencorp/client"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import {
  Ack,
  BrowserSession,
  CompanyFile,
  CompanyTree,
  CompanyView,
  CostReport,
  Health,
  HqStatus,
  Question,
  RunPage,
  Session,
} from "@opencorp/protocol"
import { apiId } from "@opencorp/protocol/version"

const APP = path.resolve(import.meta.dir, "..")
const PAIR_URL = /http:\/\/127\.0\.0\.1:(\d+)\/pair#([A-Za-z0-9_-]+)/

/** Polls `done` every 100 ms until it is true; fails after 20 s. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!(await done().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A port free on 127.0.0.1 a moment ago. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

type Reply = { status: number; type: string; text: string }

/** A same-origin client of one HQ, as the app in a browser: its Host, its Origin on writes, JSON bodies, and the
 *  cookies HQ sets kept. */
class Browser {
  readonly #jar = new Map<string, string>()

  constructor(readonly origin: string) {}

  get(target: string): Promise<Reply> {
    return this.#send("GET", target, {})
  }

  /** POST `body` as JSON, or as `type` when given. */
  post(target: string, body: unknown = {}, type = "application/json"): Promise<Reply> {
    return this.#send("POST", target, { origin: this.origin, "content-type": type }, JSON.stringify(body))
  }

  async #send(method: string, target: string, headers: Record<string, string>, body?: string): Promise<Reply> {
    const cookie = [...this.#jar].map(([name, value]) => `${name}=${value}`).join("; ")
    const res = await fetch(this.origin + target, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { ...headers, ...(cookie && { cookie }) },
    })
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";")
      const at = pair.indexOf("=")
      const name = pair.slice(0, at).trim()
      if (attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) this.#jar.delete(name)
      else this.#jar.set(name, pair.slice(at + 1).trim())
    }
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() }
  }
}

type Schema = { safeParse(data: unknown): { success: boolean } }

const ULID = "01JA1H0000000000000000000A"

/** `schema` parsing data whose `id` and `*_id` strings are first made ULIDs: the fixture's sessions, cards and runs
 *  have readable ids (`S-kai`), which its Playwright tests name, and ids are values, which aren't compared. */
const readableIds = (schema: Schema): Schema => ({
  safeParse: (data) => {
    const ulids = (key: string, value: unknown) => (/^(.+_)?id$/.test(key) && typeof value === "string" ? ULID : value)
    return schema.safeParse(JSON.parse(JSON.stringify(data), ulids))
  },
})

/** What a step is compared on. `keys` and `parses` are for 2xx JSON only; `parses` is null where no schema names
 *  the route's answer. */
type Seen = { step: string; status: number; error: string | null; keys: string[] | null; parses: boolean | null }

function seen(step: string, reply: Reply, schema?: Schema): Seen {
  const body = reply.type.startsWith("application/json") ? JSON.parse(reply.text) : undefined
  const ok = reply.status >= 200 && reply.status < 300 && body !== undefined
  const object = ok && typeof body === "object" && body !== null && !Array.isArray(body)
  return {
    step,
    status: reply.status,
    error: typeof body?.error === "string" ? body.error : null,
    keys: object ? Object.keys(body).sort() : null,
    parses: ok && schema ? schema.safeParse(body).success : null,
  }
}

/** The contract script against one HQ, signing in with the pairing code `code`. */
async function script(hq: Browser, code: string): Promise<Seen[]> {
  const out: Seen[] = []
  const step = async (name: string, reply: Promise<Reply>, schema?: Schema) => {
    const r = await reply
    out.push(seen(name, r, schema))
    return r
  }
  const day = new Date(Date.now() - 86_400_000).toISOString()
  const now = new Date().toISOString()
  await step("health", hq.get("/api/health"), Health)
  await step("whoami before sign-in", hq.get("/api/whoami"))
  await step("pair with a bad code", hq.post("/api/pair", { code: "not-a-code", label: "contract" }))
  await step("pair", hq.post("/api/pair", { code, label: "contract" }), BrowserSession)
  await step("whoami", hq.get("/api/whoami"))
  await step("company", hq.get("/api/company"), CompanyView)
  await step("sessions", hq.get("/api/sessions"), readableIds(Session.array()))
  await step("busy sessions", hq.get("/api/sessions?status=busy"), readableIds(Session.array()))
  await step("questions", hq.get("/api/questions"), readableIds(Question.array()))
  await step("costs", hq.get(`/api/costs?since=${encodeURIComponent(day)}`), CostReport)
  const tree = await step("tree", hq.get("/api/company/tree"), CompanyTree)
  const { commit, entries } = CompanyTree.parse(JSON.parse(tree.text))
  const file = entries.find((e) => e.type === "file")!.path
  const read = (at: string, p: string) => hq.get(`/api/company/file?${new URLSearchParams({ at, path: p })}`)
  await step("file with an absolute path", read(commit.id, "/abs"))
  await step("file at an unserved commit", read("0".repeat(40), file))
  await step("file not in the tree", read(commit.id, "no/such.md"))
  await step("file", read(commit.id, file), CompanyFile)
  await step("runs", hq.get("/api/runs"), readableIds(RunPage))
  await step("runs with an unknown status", hq.get("/api/runs?status=nope"))
  await step("runs recent with since", hq.get(`/api/runs?${new URLSearchParams({ recent: now, since: day })}`))
  await step("unknown run", hq.get("/api/runs/NOPE"))
  await step("unknown route", hq.get("/api/no-such-route"))
  await step("logout as text", hq.post("/api/logout", {}, "text/plain"))
  await step("logout", hq.post("/api/logout"), Ack)
  await step("whoami after logout", hq.get("/api/whoami"))
  return out
}

/** Each step's status and error code, as the real HQ answers them. */
const EXPECTED: [string, number, string | null][] = [
  ["health", 200, null],
  ["whoami before sign-in", 401, "sign_in_required"],
  ["pair with a bad code", 400, "pair_code_invalid"],
  ["pair", 200, null],
  ["whoami", 200, null],
  ["company", 200, null],
  ["sessions", 200, null],
  ["busy sessions", 200, null],
  ["questions", 200, null],
  ["costs", 200, null],
  ["tree", 200, null],
  ["file with an absolute path", 400, "bad_path"],
  ["file at an unserved commit", 409, "stale_commit"],
  ["file not in the tree", 404, "no_file"],
  ["file", 200, null],
  ["runs", 200, null],
  ["runs with an unknown status", 422, "invalid_body"],
  ["runs recent with since", 422, "invalid_body"],
  ["unknown run", 404, "not_found"],
  ["unknown route", 404, "no_route"],
  ["logout as text", 415, "json_required"],
  ["logout", 200, null],
  ["whoami after logout", 401, "sign_in_required"],
]

let office: TestOffice
let real: Browser
let realCode: string
beforeAll(async () => {
  office = await startOffice({ hq: { tcp: true, port: 0 } })
  const client = createOfficeClient({ socket: office.socket })
  let port = 0
  await until("HQ to listen on TCP", async () => {
    const { tcp } = HqStatus.parse(await client.hq.status())
    port = tcp.port
    return tcp.listening
  })
  real = new Browser(`http://127.0.0.1:${port}`)
  const cwd = path.join(office.root, "pair")
  fs.mkdirSync(cwd)
  const paired = await office.opencorp(["pair", "--no-open"], { cwd })
  const link = PAIR_URL.exec(paired.stdout)
  if (paired.code !== 0 || !link)
    throw new Error(`opencorp pair exited ${paired.code}:\n${paired.stdout}${paired.stderr}`)
  expect(Number(link[1])).toBe(port)
  realCode = link[2]!
}, 60_000)
afterAll(() => office?.stop())

let fixture: ChildProcess
let fake: Browser
let dist: string
beforeAll(async () => {
  dist = fs.mkdtempSync("/tmp/oc-dist-")
  fs.writeFileSync(path.join(dist, "build.json"), `${JSON.stringify({ build: "contract", api: apiId() })}\n`)
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>HQ</title>\n")
  const port = await freePort()
  // Bun's and Node's options from this process would change how the fixture runs.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("BUN_") && key !== "NODE_OPTIONS"),
  )
  const argv = ["--no-install", "--no-env-file", "--config=/dev/null", "e2e/fixture.ts", "--port", String(port)]
  fixture = spawn(process.execPath, [...argv, "--dist", dist], { cwd: APP, env, stdio: "ignore" })
  fake = new Browser(`http://127.0.0.1:${port}`)
  await until("the fixture to answer", async () => {
    if (fixture.exitCode !== null) throw new Error(`the fixture exited ${fixture.exitCode}`)
    return (await fake.get("/api/health")).status === 200
  })
  expect((await fake.post("/__fixture/code", { code: "c0de" })).status).toBe(200)
}, 30_000)
afterAll(async () => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    const exited = new Promise((resolve) => fixture.once("exit", resolve))
    fixture.kill("SIGKILL")
    await exited
  }
  if (dist) fs.rmSync(dist, { recursive: true, force: true })
})

test("the fixture answers the hq script as the real hq does", async () => {
  const want = await script(real, realCode)
  const got = await script(fake, "c0de")
  expect(want.map((s) => [s.step, s.status, s.error])).toEqual(EXPECTED)
  expect(want.filter((s) => s.parses === false).map((s) => s.step)).toEqual([])
  expect(got).toEqual(want)
}, 30_000)
