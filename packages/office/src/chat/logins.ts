/** Device sign-ins to the ChatGPT subscription, each adding a connection when it succeeds. */
import { AuthError, AuthStore, OpenAIAuth } from "@ngocbh/yian/llm_clients"
import type { ConnectionLogin } from "@opencorp/protocol"
import type { z } from "zod"
import { newId } from "../store/store.ts"
import { ConnectionFile, type Connections } from "./connections.ts"
import { type ModelCache, typeName } from "./models.ts"
import { ProviderError } from "./provider.ts"

/** How long `start` waits for OpenAI to give the sign-in's code, in ms. */
export const START_WAIT_MS = 20_000

/** How long a sign-in is kept after it ends, in ms. */
export const FORGET_MS = 600_000

/** How long `cancel` and `closeAll` wait for a sign-in to stop, in ms. */
export const STOP_WAIT_MS = 5_000

/** No sign-in with that id that the asking person started. */
export class LoginNotFound extends Error {
  override name = "LoginNotFound"
}

/** The office is stopping, so no sign-in starts. */
export class LoginsClosed extends Error {
  override name = "LoginsClosed"
}

/** The sign-in was cancelled: the reason its signal aborts with. */
class Stopped extends Error {
  override name = "Stopped"
}

/** A sign-in as clients see it. */
export type LoginView = z.output<typeof ConnectionLogin>

export interface LoginsOptions {
  /** Lists every connection's models again once a sign-in adds one. */
  models?: Pick<ModelCache, "warm"> | null
  /** Makes yian's `OpenAIAuth` for one sign-in, given the signal that aborts on its cancel. */
  auth?: (options: { signal: AbortSignal }) => OpenAIAuth
  /** Dates the ends, in ms (default `performance.now`). */
  clock?: () => number
  /** Where log lines go (default `console.error`). */
  log?: (line: string) => void
  /** How long `start` waits for the code, in ms (default `START_WAIT_MS`). */
  startWaitMs?: number
  /** How long `cancel` and `closeAll` wait for the sign-ins to stop, in ms (default `STOP_WAIT_MS`). */
  stopWaitMs?: number
}

/** One sign-in: its state as clients see it, and what its run and `start` wait on. */
class Login {
  view: LoginView = { id: newId(), state: "waiting", url: null, user_code: null, message: null, connection: null }
  readonly by: string
  ended: number | null = null
  readonly controller = new AbortController()
  /** Resolves once the code is shown, or the sign-in ends without one. */
  readonly shown: Promise<void>
  readonly setShown: () => void
  /** The run's promise; never rejects. */
  done: Promise<void> = Promise.resolve()

  constructor(by: string) {
    this.by = by
    let resolve!: () => void
    this.shown = new Promise<void>((r) => (resolve = r))
    this.setShown = resolve
  }

  /** Shows the URL and code the person approves the sign-in with. */
  show(url: string, userCode: string): void {
    this.view = { ...this.view, url, user_code: userCode }
    this.setShown()
  }
}

/** Resolves once `promise` settles or `ms` pass, whichever is first; the timer is cleared either way. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  try {
    await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Device sign-ins to the ChatGPT subscription; tokens go only to each connection's own auth file.
 *
 * A sign-in that succeeds adds a new connection, `chatgpt`, `chatgpt-2`, …, on the first model the subscription
 * lists. Only the person who started a sign-in sees or cancels it, and it is forgotten `FORGET_MS` after it ends.
 */
export class Logins {
  readonly connections: Connections
  readonly #models: Pick<ModelCache, "warm"> | null
  readonly #auth: (options: { signal: AbortSignal }) => OpenAIAuth
  readonly #clock: () => number
  readonly #log: (line: string) => void
  readonly #startWaitMs: number
  readonly #stopWaitMs: number
  readonly #logins = new Map<string, Login>()
  #closed = false // set by closeAll: no sign-in starts after it

  constructor(connections: Connections, options: LoginsOptions = {}) {
    this.connections = connections
    this.#models = options.models ?? null
    this.#auth = options.auth ?? (({ signal }) => new OpenAIAuth({ signal }))
    this.#clock = options.clock ?? (() => performance.now())
    this.#log = options.log ?? console.error
    this.#startWaitMs = options.startWaitMs ?? START_WAIT_MS
    this.#stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
  }

  /** Starts a sign-in for `by`; resolves with it as it is once OpenAI gives its URL and code, or `startWaitMs`
   *  pass. Rejects with `LoginsClosed` once `closeAll` has run. */
  async start(options: { by: string }): Promise<LoginView> {
    if (this.#closed) throw new LoginsClosed("the office is stopping")
    this.#forget()
    const login = new Login(options.by)
    this.#logins.set(login.view.id, login)
    login.done = this.#run(login)
    await within(login.shown, this.#startWaitMs)
    return { ...login.view }
  }

  /** Sign-in `loginId`; throws `LoginNotFound` unless `by` started it and it isn't forgotten. */
  get(loginId: string, options: { by: string }): LoginView {
    return { ...this.#find(loginId, options.by).view }
  }

  /**
   * Cancels sign-in `loginId` if it still waits, saving nothing; rejects with `LoginNotFound` as `get` throws.
   *
   * A cancel that comes while the sign-in is being saved is too late, and the sign-in still succeeds; `get` tells
   * how it ended.
   */
  async cancel(loginId: string, options: { by: string }): Promise<void> {
    await this.#stop([this.#find(loginId, options.by)])
  }

  /** Cancels every sign-in still waiting, and refuses any that would start after. */
  async closeAll(): Promise<void> {
    this.#closed = true
    await this.#stop([...this.#logins.values()].filter((login) => login.ended === null))
  }

  #find(loginId: string, by: string): Login {
    this.#forget()
    const login = this.#logins.get(loginId)
    // Another person's sign-in reads as no sign-in at all, so its id tells them nothing.
    if (login === undefined || login.by !== by) throw new LoginNotFound(`no sign-in ${loginId}`)
    return login
  }

  /** Drops sign-ins that ended `FORGET_MS` ago. */
  #forget(): void {
    const now = this.#clock()
    for (const [id, login] of this.#logins) {
      if (login.ended !== null && now - login.ended >= FORGET_MS) this.#logins.delete(id)
    }
  }

  /** Stops `logins`, waiting up to `stopWaitMs` for all of them together. */
  async #stop(logins: Login[]): Promise<void> {
    for (const login of logins) login.controller.abort(new Stopped("the sign-in was cancelled"))
    await within(Promise.all(logins.map((login) => login.done)), this.#stopWaitMs)
  }

  /** Runs `login` to its end, adding its connection if it succeeds; never rejects. */
  async #run(login: Login): Promise<void> {
    const signal = login.controller.signal
    let name: string
    try {
      const auth = this.#auth({ signal })
      const creds = await auth.deviceLogin((url, code) => login.show(url, code))
      const models = await auth.subscriptionModels(creds)
      const llm = { provider: "openai", model: models[0] }
      const conn = ConnectionFile.parse({ method: "subscription", llm_config: llm })
      name = await this.connections.add("chatgpt", conn, {
        // Quick, and calls no queued Connections method: it runs inside the queue of writes.
        signIn: async (authFile) => {
          signal.throwIfAborted() // a cancel that came while the models were listed saves nothing
          await new AuthStore(authFile).save("openai", creds, models[0]!)
        },
      })
    } catch (error) {
      if (error instanceof Stopped) {
        this.#end(login, { state: "cancelled" })
      } else if (error instanceof AuthError) {
        // yian's AuthError says only what failed and its HTTP status, never a token.
        this.#end(login, { state: "failed", message: error.message })
      } else if (error instanceof ProviderError) {
        // Its error may name the office's files; the log says which sign-in, the person gets no path.
        this.#log(`sign-in ${login.view.id} couldn't save its connection (${typeName(error)})`)
        this.#end(login, { state: "failed", message: "the sign-in couldn't be saved as a connection" })
      } else {
        this.#log(`sign-in ${login.view.id} failed (${typeName(error)})`) // by type: it may quote a reply
        this.#end(login, { state: "failed", message: "the sign-in failed" })
      }
      return
    }
    this.#end(login, { state: "signed_in", connection: name })
    void this.#models?.warm()
  }

  /** Merges `update` into the view (`id`, `url` and `user_code` stay) and dates the end. */
  #end(login: Login, update: Partial<LoginView>): void {
    login.view = { ...login.view, ...update }
    login.ended = this.#clock()
    login.setShown()
  }
}
