/** The install tests' helpers (Python's `tests/install/conftest.py` and `Script` from `test_provider_setup.py`), and
 *  chats for init's interview.
 *  Tests never run a real service tool: every install test passes a `makeHost` host, whose `run` is a `Runner`. */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import path from "node:path"
import { expect, onTestFinished } from "bun:test"
import { OAuthCredentials } from "@ngocbh/yian/llm_clients"
import type { Draft } from "../../../src/company/draft.ts"
import { dontAskRefusal } from "../../../src/runtime/permissions/policy.ts"
import type { BuiltinSession, CardAnswer, SessionBinding } from "../../../src/runtime/sessions/builtin.ts"
import { LocalHost } from "../../../src/server/local/host.ts"
import { type Completed, type Host, type Launch, launch, officeAnswers } from "../../../src/runtime/service/launch.ts"
import type { InterviewChat } from "../../../src/features/setup/interview.ts"
import type { Listers, SubscriptionAuth } from "../../../src/features/setup/onboard.ts"
import { CREATE } from "../../../src/features/setup/tools/propose_company.ts"
import { killGroup, sameProcess, startTime } from "../../../src/util/proc.ts"
import { type Prompter, stepLines } from "../../../src/features/setup/prompts.ts"
import { repr } from "../../../src/util/redact.ts"
import { startGroup, tempDir } from "../../helpers.ts"
import { testEnviron } from "../../runtime/worker/helpers.ts"

/** Records commands and answers each from a table of `[argv prefix, code, stderr, stdout?]`: the first matching
 *  prefix answers, else code 0 with empty output. */
export class Runner {
  readonly calls: string[][] = []
  /** Each call's `env` option, parallel to `calls`. */
  readonly envs: (Record<string, string> | undefined)[] = []

  constructor(private readonly answers: [prefix: string[], code: number, stderr: string, stdout?: string][] = []) {}

  readonly run = async (
    argv: readonly [string, ...string[]],
    options?: { env?: Record<string, string> },
  ): Promise<Completed> => {
    this.calls.push([...argv])
    this.envs.push(options?.env)
    for (const [prefix, code, stderr, stdout = ""] of this.answers) {
      if (prefix.every((part, i) => argv[i] === part)) return { code, stdout, stderr }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

/** A host whose home is `dir` and whose commands go to `runner` (a `Runner`, or any stand-in with its `run`);
 *  nothing real runs, and no office holds its lock unless `locked` says so. Its clock moves only when it sleeps, so
 *  waiting takes no real time. */
export function makeHost(
  dir: string,
  runner: Pick<Host, "run">,
  {
    platform = "darwin",
    which = () => null,
    spawn = () => {
      throw new Error("tests never spawn without a stand-in")
    },
    answers = async () => false,
    locked = () => false,
  }: {
    platform?: NodeJS.Platform
    which?: (name: string) => string | null
    spawn?: (argv: readonly [string, ...string[]], options: SpawnOptions) => ChildProcess
    answers?: (socket: string, timeoutMs?: number) => Promise<boolean>
    locked?: (lockPath: string) => boolean
  } = {},
): Host {
  let now = 0
  return {
    platform,
    userHome: dir,
    uid: 501,
    run: (argv, options) => runner.run(argv, options),
    spawn,
    which,
    sleep: async (ms) => {
      now += ms
    },
    clock: () => now,
    answers,
    locked,
  }
}

/** The owner's default office, with fixed paths so service files can be compared to goldens. */
export function ownerLaunch(): Launch {
  return launch("/Users/owner/.opencorp", {
    command: ["/opt/opencorp/bin/opencorp"],
    environ: { PATH: "/usr/bin:/bin", HOME: "/Users/owner" },
    userHome: "/Users/owner",
  })
}

/** A prompter that answers from a list and records everything it was asked or told. */
export class Script implements Prompter {
  readonly answers: string[]
  readonly interactive: boolean
  readonly seen: string[] = []
  /** The options of each `choose`, in order. */
  readonly offered: string[][] = []
  /** Whether each `choose` took a typed answer, in order. */
  readonly typed: boolean[] = []

  constructor(answers: string[] = [], { interactive = true }: { interactive?: boolean } = {}) {
    this.answers = [...answers]
    this.interactive = interactive
  }

  private next(): string {
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error("the script ran out of answers")
    return answer
  }

  async ask(question: string, defaultAnswer = ""): Promise<string> {
    this.seen.push(question)
    return this.next() || defaultAnswer
  }

  /** The default for an empty answer, an option given exactly, the option a number picks (from 1), or with
   *  `typed` any other text. */
  async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false): Promise<string> {
    this.seen.push(question)
    this.offered.push([...options])
    this.typed.push(typed)
    const answer = this.next()
    if (!answer) return defaultAnswer
    if (options.includes(answer)) return answer
    const number = /^[0-9]+$/.test(answer) ? Number(answer) : 0
    if (number >= 1 && number <= options.length) return options[number - 1]!
    if (typed) return answer
    throw new Error(`${repr(answer)} isn't an answer to ${repr(question)}; the options are [${options.map(repr).join(", ")}]`)
  }

  async secret(question: string): Promise<string> {
    this.seen.push(question)
    return this.next()
  }

  say(text: string): void {
    this.seen.push(text)
  }

  step(number: number, total: number, title: string, why: string): void {
    this.seen.push(...stepLines(number, total, title, why))
  }
}

/** What the no-office host binds for a session's tools, in `auto`: each card held through `ask` is answered at once
 *  with the next of `answers`; "dontAsk" refuses it, as a host in dontAsk does. */
export function cardBinding(answers: (CardAnswer | "dontAsk")[]): SessionBinding {
  return {
    sessionId: "01JDSESSION000000000000000",
    permissions: {
      mode: () => "auto",
      rules: () => [],
      where: () => ({ profile: "ssh", cwd: null, writable: [] }),
      hold: () => "Not run: no card here",
      check: async () => ({ verdict: "run", reason: "fine" }),
    },
    hold: () => "Not run: no card here",
    ask: (card, _callId, act) => {
      const answer = answers.shift()
      if (answer === undefined) throw new Error("no answer left for the card")
      return answer === "dontAsk" ? dontAskRefusal(card.reason) : act(answer, new AbortController().signal)
    },
    onShell: () => ({ changed: () => {}, output: () => {} }),
    instruments: { add: () => {}, updated: () => {}, output: () => {}, remove: () => {} },
  }
}

/** A chat for init's interview that proposes `draft` as the model would, and the owner says Yes on its card, with the
 *  tools bound as the host binds them; each session it is given goes to `sessions`. */
export function accepting(draft: Draft, sessions: BuiltinSession<never>[] = []): InterviewChat {
  return async (session) => {
    sessions.push(session)
    const tools = await session.tools(cardBinding([{ value: CREATE, typed: false }]))
    const { name, handle, title } = draft.owner
    const args = { company: draft.company, owner: { name, handle, title }, teammates: draft.team }
    await tools.groups.propose_company!.propose_company!.call(args, { callId: "r/init/1/0" })
    return { status: "ended", error: null }
  }
}

/** A chat that runs the interview's session on the no-office host, as the CLI's does with the TUI on it: `owner`
 *  plays the owner on the host, then the chat ends as the session does. */
export function hostChat(owner: (host: LocalHost) => Promise<void>): InterviewChat {
  return async (session) => {
    const host = await LocalHost.start(session, { log: () => {}, environ: testEnviron(tempDir()) })
    try {
      await owner(host)
      await host.ended
      return { status: host.failure === null ? "ended" : "failed", error: host.failure }
    } finally {
      await host.close()
    }
  }
}

/** Listers that list nothing, so no test reaches a provider: the model or deployment is typed. */
export const NO_LISTING: Listers = {
  azureDeployments: async () => [],
  providerModels: async () => [],
}

/** The fake ChatGPT sign-in's tokens and account, which nothing may show, and the device sign-in's URL and code. */
export const ACCESS_TOKEN = "fake-access-4f1c2a9e7b3d"
export const REFRESH_TOKEN = "fake-refresh-0d8e3b6a5c1f"
export const ACCOUNT = "account-7c2e9f"
export const DEVICE_URL = "https://auth.example.test/codex/device"
export const DEVICE_CODE = "WXYZ-1234"
/** The models the fake subscription lists, the first by priority. */
export const SUBSCRIPTION_MODELS = ["gpt-5.5-codex", "gpt-5.5"]

/**
 * A stand-in for yian's `OpenAIAuth` that reaches no server: each device sign-in shows `DEVICE_URL` and
 * `DEVICE_CODE`, then throws the next of `failures` if any is left, else resolves the fake credentials once
 * `approved` does (at once without it); it rejects with its signal's reason once that aborts. The subscription lists
 * `SUBSCRIPTION_MODELS`. A refresh resolves `refreshed`, or throws it when it's an error; without it, a refresh fails
 * the test. `signals` holds the signal each sign-in was made with, and `refreshes` counts the refreshes.
 */
export function fakeSubscription({
  failures = [],
  approved,
  refreshed,
}: { failures?: Error[]; approved?: Promise<void>; refreshed?: OAuthCredentials | Error } = {}) {
  const left = [...failures]
  const signals: AbortSignal[] = []
  const creds = new OAuthCredentials({
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: Date.now() / 1000 + 3600,
    accountId: ACCOUNT,
  })
  const auth: SubscriptionAuth = ({ signal }) => {
    signals.push(signal)
    return {
      deviceLogin: async (show) => {
        await show(DEVICE_URL, DEVICE_CODE)
        const failure = left.shift()
        if (failure !== undefined) throw failure
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          void (approved ?? Promise.resolve()).then(resolve)
        })
        return creds
      },
      subscriptionModels: async (given) => {
        expect(given).toBe(creds)
        return SUBSCRIPTION_MODELS
      },
      refresh: async () => {
        refreshes.count++
        if (refreshed === undefined) throw new Error("the fake wasn't meant to refresh")
        if (refreshed instanceof Error) throw refreshed
        return refreshed
      },
    }
  }
  const refreshes = { count: 0 }
  return { auth, creds, signals, refreshes }
}

/** A process the test host started: its pid and the start time read right after the spawn. */
export interface Spawned {
  pid: number
  started: number
}

/**
 * The list a `daemonHost` records its processes in; when the test finishes, each one's group is SIGKILLed if it
 * still has its start time, never by name or pattern. Call before making the test's temp dirs: onTestFinished
 * runs callbacks in registration order, so the daemons go before their homes are removed.
 */
export function killedAtEnd(): Spawned[] {
  const spawned: Spawned[] = []
  onTestFinished(() => {
    for (const d of spawned) if (sameProcess(d.pid, d.started)) killGroup(d.pid)
  })
  return spawned
}

/** A host that really starts processes, recording each in `spawned` at once, waits in real time and asks the
 *  real socket. Its commands still go to a `Runner` and it finds no program, so no service tool runs. */
export function daemonHost(dir: string, spawned: Spawned[]): Host {
  return {
    ...makeHost(dir, new Runner()),
    clock: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    answers: officeAnswers,
    which: () => null,
    spawn: (argv, options) => {
      const child = spawn(argv[0], argv.slice(1), options)
      if (child.pid !== undefined) {
        const started = startTime(child.pid)
        if (started === null) {
          // Without a start time the cleanup could not tell it from a reused pid, so it must not run on.
          child.kill("SIGKILL")
          throw new Error(`can't read the start time of ${argv[0]} (pid ${child.pid})`)
        }
        spawned.push({ pid: child.pid, started })
      }
      return child
    },
  }
}

/** A stand-in daemon: `sh` whose args end with `tail`; a SIGTERM also ends its `sleep`. Resolves once it runs; it
 *  is killed when the test finishes. */
export async function standIn(tail: string): Promise<{ pid: number; started: number | null }> {
  const group = startGroup(`trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 60 & echo ready; wait; : ${tail}`)
  expect(await group.line()).toBe("ready")
  return { pid: group.pid, started: group.started }
}

/** The office source folder. */
export const SRC = path.join(import.meta.dir, "../../../src")
