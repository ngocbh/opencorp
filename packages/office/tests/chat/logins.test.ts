/** Device sign-ins to the ChatGPT subscription, each adding a connection, on fake HTTP and a test scheduler
 *  (Python's `tests/chat/test_logins.py`). */
import fs from "node:fs"
import path from "node:path"
import { beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import {
  type AuthRequest,
  type AuthRequestOptions,
  AuthStore,
  HttpResponse,
  OpenAIAuth,
} from "@ngocbh/yian/llm_clients"
import { AUTH_FILE_ENV, ConnectionFile, Connections } from "../../src/chat/connections.ts"
import {
  FORGET_MS,
  LoginNotFound,
  Logins,
  LoginsClosed,
  type LoginsOptions,
  type LoginView,
} from "../../src/chat/logins.ts"
import { ProviderError } from "../../src/chat/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { ACCESS, APPROVED, CATALOG, PENDING, REFRESH, SIGNATURE, TOKENS, USERCODE, testScheduler } from "./helpers.ts"

setDefaultTimeout(30_000)

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
    expect(await conns.get("chatgpt")).toEqual(
      ConnectionFile.parse({ method: "subscription", llm_config: { provider: "openai", model: "gpt-5.5" } }),
    )
    expect((await conns.resolve("chatgpt", null)).env).toEqual({ [AUTH_FILE_ENV]: auth })
    noTokens(
      JSON.stringify(login),
      JSON.stringify(done),
      fs.readFileSync(path.join(conns.dir, "chatgpt.json"), "utf8"),
      logs.join("\n"),
    )
    // the tokens are in the sign-in, and only there
    expect(fs.readFileSync(auth, "utf8")).toContain(SIGNATURE)
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

test.each(["the listing", "the save"])("a cancel after the code is approved saves nothing [%s]", async (heldAt) => {
  const conns = await connections()
  const gate = release()
  let reached = false
  const hold = async () => {
    reached = true
    await gate.promise
  }
  if (heldAt === "the save") {
    const add = conns.add.bind(conns)
    conns.add = async (...args) => {
      await hold()
      return add(...args)
    }
  }
  const catalog = async () => {
    await hold()
    return CATALOG
  }
  // stopWaitMs is short so cancel returns while the sign-in is held.
  const http = new HTTP([USERCODE, APPROVED, TOKENS, heldAt === "the listing" ? catalog : CATALOG])
  const logins = make(conns, http, { stopWaitMs: 50 })
  try {
    const login = await logins.start({ by: "ngocbh" })
    await waitFor(() => reached, { what: heldAt })
    await logins.cancel(login.id, { by: "ngocbh" })
    gate.open()
    await until(logins, login.id, "cancelled")
    expect(await conns.names()).toEqual(["office"])
    expect(fs.existsSync(conns.authFile("chatgpt"))).toBe(false)
  } finally {
    gate.open()
    await logins.closeAll()
  }
})

test("a sign in lists the models of every connection again", async () => {
  const conns = await connections()
  let names: string[] | undefined
  const models = {
    warm: async () => {
      names = await conns.names()
    },
  }
  const logins = make(conns, new HTTP(FLOW), { models })
  try {
    await until(logins, (await logins.start({ by: "ngocbh" })).id, "signed_in")
    // after the new connection is saved
    expect(await waitFor(() => names, { what: "the warm-up" })).toEqual(["office", "chatgpt"])
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

test("close all cancels every open sign in", async () => {
  const conns = await connections()
  const logins = make(conns, new HTTP([], waiting))
  try {
    const ids = [(await logins.start({ by: "ngocbh" })).id, (await logins.start({ by: "ava" })).id]
    await logins.closeAll()
    expect([logins.get(ids[0]!, { by: "ngocbh" }).state, logins.get(ids[1]!, { by: "ava" }).state]).toEqual([
      "cancelled",
      "cancelled",
    ])
    expect(await conns.names()).toEqual(["office"])
  } finally {
    await logins.closeAll()
  }
})

test("close all waits for every sign in at once and refuses new ones", async () => {
  const conns = await connections()
  const gate = release()
  let reached = 0
  // A request rejects at once on a cancel, so each run is held in add instead, where it is deaf to one.
  const add = conns.add.bind(conns)
  conns.add = async (...args) => {
    reached += 1
    await gate.promise
    return add(...args)
  }
  // Each sign-in gets its own replies: one shared queue would hand the concurrent sign-ins each other's.
  const logins = new Logins(conns, {
    auth: ({ signal }) => new OpenAIAuth({ request: new HTTP(FLOW).request, scheduler: testScheduler(), signal }),
    log: collect,
    startWaitMs: 50,
    stopWaitMs: 500,
  })
  try {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await logins.start({ by: "ngocbh" })).id)
    await waitFor(() => reached === 3, { what: "every sign-in in add" })
    const began = performance.now()
    await logins.closeAll()
    expect(performance.now() - began).toBeLessThan(1_000) // one wait for them all, not one each
    await expect(logins.start({ by: "ngocbh" })).rejects.toBeInstanceOf(LoginsClosed)
    gate.open()
    for (const id of ids) await until(logins, id, "cancelled")
    expect(await conns.names()).toEqual(["office"])
  } finally {
    gate.open()
    await logins.closeAll()
  }
})

test("a sign in that shows no code in time still returns waiting", async () => {
  const conns = await connections()
  const gate = release()
  const logins = make(conns, new HTTP([held(USERCODE, gate.promise)], waiting), { startWaitMs: 100 })
  try {
    const login = await logins.start({ by: "ngocbh" })
    expect([login.state, login.url, login.user_code]).toEqual(["waiting", null, null])
    gate.open()
    await waitFor(() => logins.get(login.id, { by: "ngocbh" }).user_code === "ABCD-EFGH", { what: "the code" })
  } finally {
    gate.open()
    await logins.closeAll()
  }
})
