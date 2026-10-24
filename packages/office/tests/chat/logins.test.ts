/** Device sign-ins to the ChatGPT subscription, each adding a connection, on fake HTTP and a test scheduler
 *  (Python's `tests/chat/test_logins.py`). */
import fs from "node:fs"
import path from "node:path"
import { beforeEach, expect, test } from "bun:test"
import {
  type AuthRequest,
  type AuthRequestOptions,
  AuthStore,
  HttpResponse,
  OpenAIAuth,
} from "@ngocbh/yian/llm_clients"
import type { Scheduler } from "@ngocbh/yian/platform"
import { AUTH_FILE_ENV, Connections } from "../../src/chat/connections.ts"
import { FORGET_MS, LoginNotFound, Logins, type LoginsOptions, type LoginView } from "../../src/chat/logins.ts"
import { ProviderError } from "../../src/chat/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir, waitFor } from "../helpers.ts"

const SIGNATURE = "fake-signature-6e2a90d4"
const REFRESH = "fake-refresh-b81c5f37"

/** A token shaped like OpenAI's, naming `account`; its signature part is a fake secret. */
function jwt(account = "account-test"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SIGNATURE}`
}

const ACCESS = jwt()

const USERCODE = new HttpResponse(200, { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1n })
const PENDING = new HttpResponse(403, { error: "pending" })
const APPROVED = new HttpResponse(200, { authorization_code: "auth-code", code_verifier: "verifier" })
const TOKENS = new HttpResponse(200, {
  access_token: ACCESS,
  refresh_token: REFRESH,
  id_token: ACCESS,
  expires_in: 3600n,
})
const CATALOG = new HttpResponse(200, {
  models: [
    { slug: "gpt-5.5-codex", visibility: "list", priority: 2n },
    { slug: "gpt-5.5", visibility: "list", priority: 1n },
  ],
})
const FLOW = [USERCODE, PENDING, APPROVED, TOKENS, CATALOG]

type Reply = HttpResponse | ((url: string) => HttpResponse | Promise<HttpResponse>)

/** yian's `request` sender: answers each call with the next response, and with `rest` once they run out; a
 *  response that is a function is called (and awaited) with the URL. Records each call. */
class HTTP {
  readonly calls: [method: string, url: string, options: AuthRequestOptions][] = []
  readonly #responses: Reply[]
  readonly #rest: Reply | undefined

  constructor(responses: Reply[] = [], rest?: Reply) {
    this.#responses = [...responses]
    this.#rest = rest
  }

  readonly request: AuthRequest = async (method, url, options) => {
    this.calls.push([method, url, options])
    const response = this.#responses.length > 0 ? this.#responses.shift() : this.#rest
    if (response === undefined) throw new Error(`no response left for ${url}`)
    return typeof response === "function" ? await response(url) : response
  }
}

/** A promise and the function that resolves it. */
function release(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

/** `response`, given only once `released` resolves (at most 30 s). */
function held(response: HttpResponse, released: Promise<void>): Reply {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("never released")), 30_000)
    })
    try {
      await Promise.race([released, cap])
    } finally {
      clearTimeout(timer)
    }
    return response
  }
}

/** A sign-in that shows its code and then waits for the human forever. */
function waiting(url: string): HttpResponse {
  return url.endsWith("/usercode") ? USERCODE : PENDING
}

/** A scheduler that moves its clock by each sleep, giving way for ~5 real ms; `now` starts at real time, so a token's
 *  expiry stays real. A sleep of a minute or more (the login's deadline) only ends by its abort, so it never fires
 *  while a test holds a request. */
function testScheduler(): Scheduler {
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

/** Every log line of the current test, from both the `Connections` and the `Logins` (Python's caplog). */
let logs: string[] = []
const collect = (line: string) => void logs.push(line)

beforeEach(() => {
  logs = []
})

/** An office whose `office` connection is anthropic's, logging to `collect`. */
async function connections(): Promise<Connections> {
  const office = path.join(tempDir(), "office")
  fs.mkdirSync(office, { mode: 0o700 })
  const conns = new Connections(office, { log: collect })
  conns.ensureDir()
  await writePrivate(path.join(conns.dir, "office.json"), JSON.stringify({ llm_config: { provider: "anthropic" } }))
  return conns
}

function make(conns: Connections, http: HTTP, options: LoginsOptions = {}): Logins {
  return new Logins(conns, {
    auth: ({ signal }) => new OpenAIAuth({ request: http.request, scheduler: testScheduler(), signal }),
    log: collect,
    ...options,
  })
}

function until(logins: Logins, loginId: string, state: LoginView["state"], by = "ngocbh"): Promise<LoginView> {
  return waitFor(
    () => {
      const found = logins.get(loginId, { by })
      return found.state === state ? found : undefined
    },
    { timeout: 10_000, what: state },
  )
}

function noTokens(...texts: string[]): void {
  for (const text of texts) {
    expect(text).not.toContain(SIGNATURE)
    expect(text).not.toContain(REFRESH)
  }
}

test("start returns the url and code then signs in", async () => {
  const conns = await connections()
  const gate = release()
  const http = new HTTP([USERCODE, held(PENDING, gate.promise), APPROVED, TOKENS, CATALOG])
  const logins = make(conns, http)
  try {
    const login = await logins.start({ by: "ngocbh" })
    expect([login.state, login.url, login.user_code, login.connection]).toEqual([
      "waiting",
      "https://auth.openai.com/codex/device",
      "ABCD-EFGH",
      null,
    ])
    gate.open()
    const done = await until(logins, login.id, "signed_in")
    expect([done.connection, done.message]).toEqual(["chatgpt", null])
    const auth = conns.authFile("chatgpt")
    expect(fs.statSync(auth).mode & 0o777).toBe(0o600)
    expect(new AuthStore(auth).selection("openai")?.model).toBe("gpt-5.5")
    const conn = await conns.get("chatgpt")
    expect([conn.method, conn.llm_config]).toEqual(["subscription", { provider: "openai", model: "gpt-5.5" }])
    expect((await conns.resolve("chatgpt", null)).env).toEqual({ [AUTH_FILE_ENV]: auth })
    noTokens(
      JSON.stringify(login),
      JSON.stringify(done),
      fs.readFileSync(path.join(conns.dir, "chatgpt.json"), "utf8"),
      logs.join("\n"),
    )
    // the tokens are in the sign-in, and only there
    expect(fs.readFileSync(auth, "utf8")).toContain(ACCESS.split(".")[2]!)
  } finally {
    gate.open()
    await logins.closeAll()
  }
})

test("the sign in is saved before the connection", async () => {
  const conns = await connections()
  const seen: boolean[] = []
  const add = conns.add.bind(conns)
  // The connection file is written through add's private write, so the failed write comes right after the sign-in.
  conns.add = (base, conn, options) =>
    add(base, conn, {
      signIn: async (authFile) => {
        await options?.signIn?.(authFile)
        seen.push(fs.existsSync(authFile))
        throw new ProviderError(`can't write ${conns.dir}/chatgpt.json`)
      },
    })
  const logins = make(conns, new HTTP(FLOW))
  try {
    const login = await logins.start({ by: "ngocbh" })
    const failed = await until(logins, login.id, "failed")
    expect(seen).toEqual([true])
    // Its error names the office's files, which neither the person nor the log is shown.
    expect([failed.message, failed.connection]).toEqual(["the sign-in couldn't be saved as a connection", null])
    expect(logs.join("\n")).not.toContain(conns.dir)
    expect(logs.join("\n")).toContain("ProviderError")
    expect(fs.existsSync(conns.authFile("chatgpt"))).toBe(false)
    expect(await conns.names()).toEqual(["office"])
  } finally {
    await logins.closeAll()
  }
})

test("a second sign in is a new connection", async () => {
  const conns = await connections()
  const logins = make(conns, new HTTP([...FLOW, ...FLOW, ...FLOW]))
  try {
    const first = await until(logins, (await logins.start({ by: "ngocbh" })).id, "signed_in")
    const second = await until(logins, (await logins.start({ by: "ngocbh" })).id, "signed_in")
    expect([first.connection, second.connection]).toEqual(["chatgpt", "chatgpt-2"])
    await conns.remove("chatgpt")
    const third = await until(logins, (await logins.start({ by: "ngocbh" })).id, "signed_in")
    expect(third.connection).toBe("chatgpt-3")
    expect(await conns.names()).toEqual(["office", "chatgpt-2", "chatgpt-3"])
  } finally {
    await logins.closeAll()
  }
})

test("cancel stops the poll and saves nothing", async () => {
  const conns = await connections()
  const http = new HTTP([], waiting)
  const logins = make(conns, http)
  try {
    const login = await logins.start({ by: "ngocbh" })
    await waitFor(() => http.calls.length > 2, { what: "the poll" })
    await logins.cancel(login.id, { by: "ngocbh" })
    expect(logins.get(login.id, { by: "ngocbh" }).state).toBe("cancelled")
    const calls = http.calls.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(http.calls.length).toBe(calls) // it polls no more
    expect(await conns.names()).toEqual(["office"])
    expect(fs.existsSync(conns.authFile("chatgpt"))).toBe(false)
    await logins.cancel(login.id, { by: "ngocbh" }) // cancelling an ended sign-in changes nothing
    expect(logins.get(login.id, { by: "ngocbh" }).state).toBe("cancelled")
  } finally {
    await logins.closeAll()
  }
})

test("a sign in lists the models of every connection again", async () => {
  const conns = await connections()
  const warmed = release()
  let names: string[] | undefined
  const models = {
    warm: async () => {
      names = await conns.names()
      warmed.open()
    },
  }
  const logins = make(conns, new HTTP(FLOW), { models })
  try {
    await until(logins, (await logins.start({ by: "ngocbh" })).id, "signed_in")
    await warmed.promise
    expect(names).toEqual(["office", "chatgpt"]) // after the new connection is saved
  } finally {
    await logins.closeAll()
  }
})

test("a failed sign in says why without tokens", async () => {
  const conns = await connections()
  const first = make(conns, new HTTP([new HttpResponse(400, { error: "bad request" })]))
  const leaky = new HttpResponse(401, { error: `bad token ${ACCESS} ${REFRESH}` })
  const second = make(conns, new HTTP([USERCODE, APPROVED, TOKENS, leaky])) // refused after the tokens came
  try {
    const failed = await first.start({ by: "ngocbh" }) // ended before a code was shown: start says so at once
    expect([failed.state, failed.url, failed.user_code]).toEqual(["failed", null, null])
    expect(failed.message).toBe("OpenAI authentication request failed (HTTP 400)")
    const refused = await until(second, (await second.start({ by: "ngocbh" })).id, "failed")
    expect(refused.message).toContain("HTTP 401")
    noTokens(JSON.stringify(refused), logs.join("\n"))
    expect(await conns.names()).toEqual(["office"])
    expect(fs.existsSync(conns.authFile("chatgpt"))).toBe(false)
  } finally {
    await first.closeAll()
    await second.closeAll()
  }
})

test("only the starter sees or cancels it", async () => {
  const conns = await connections()
  const logins = make(conns, new HTTP([], waiting))
  try {
    const login = await logins.start({ by: "ngocbh" })
    expect(() => logins.get(login.id, { by: "ava" })).toThrow(LoginNotFound)
    await expect(logins.cancel(login.id, { by: "ava" })).rejects.toBeInstanceOf(LoginNotFound)
    expect(() => logins.get("nope", { by: "ngocbh" })).toThrow(LoginNotFound)
    expect(logins.get(login.id, { by: "ngocbh" }).state).toBe("waiting")
  } finally {
    await logins.closeAll()
  }
})

test("a finished login is forgotten after ten minutes", async () => {
  const conns = await connections()
  let now = 1_000_000
  const logins = make(conns, new HTTP([new HttpResponse(400, {})], waiting), { clock: () => now })
  try {
    const failed = await logins.start({ by: "ngocbh" })
    const stillOpen = await logins.start({ by: "ngocbh" })
    now += FORGET_MS - 1
    expect(logins.get(failed.id, { by: "ngocbh" }).state).toBe("failed")
    now += 1
    expect(() => logins.get(failed.id, { by: "ngocbh" })).toThrow(LoginNotFound)
    now += 2 * FORGET_MS
    // an open sign-in is kept while it waits
    expect(logins.get(stillOpen.id, { by: "ngocbh" }).state).toBe("waiting")
  } finally {
    await logins.closeAll()
  }
})
