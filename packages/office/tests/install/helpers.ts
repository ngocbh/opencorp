/** The install tests' helpers (Python's `tests/install/conftest.py`, `Script` from `test_provider_setup.py`, and
 *  `flowReplies` from `test_interview.py`).
 *  Tests never run a real service tool: every install test passes a `makeHost` host, whose `run` is a `Runner`. */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { onTestFinished } from "bun:test"
import type { InitOutput } from "../../src/company/draft.ts"
import { type Completed, type Host, type Launch, launch, officeAnswers } from "../../src/install/launch.ts"
import type { Listers } from "../../src/install/onboard.ts"
import { killGroup, sameProcess, startTime } from "../../src/install/proc.ts"
import { type Prompter, stepLines } from "../../src/install/prompts.ts"
import { repr } from "../../src/perm/redact.ts"
import type { ScriptedReply } from "../../src/testing/fake_llm.ts"

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
 *  nothing real runs. Its clock moves only when it sleeps, so waiting takes no real time. */
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
  }: {
    platform?: NodeJS.Platform
    which?: (name: string) => string | null
    spawn?: (argv: readonly [string, ...string[]], options: SpawnOptions) => ChildProcess
    answers?: (socket: string, timeoutMs?: number) => Promise<boolean>
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

/** One interview round from the model: ask `question`, check `output`, then return it. */
export function flowReplies(
  question: string,
  output: InitOutput,
  options?: readonly string[],
): ScriptedReply[] {
  const args = { question, ...(options?.length ? { options } : {}) }
  const check = { company: output.company, owner: output.owner, teammates: output.teammates }
  return [
    { tool_calls: [{ name: "ask_user", arguments: args }] },
    { tool_calls: [{ name: "check_company", arguments: check }] },
    { content: "That's everything." }, // ends the tool loop
    { tool_calls: [{ name: "Record", arguments: output }] }, // forced structured output
  ]
}

/** Listers that list nothing, so no test reaches a provider: the model or deployment is typed. */
export const NO_LISTING: Listers = {
  azureDeployments: async () => [],
  providerModels: async () => [],
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

/** The office source folder. */
export const SRC = path.join(import.meta.dir, "../../src")

/** Every module `file` names: static and bare imports, re-exports, `import()` and `require()`, comments left out;
 *  `import type` and `export type` are kept unless `values` is set. */
export function specifiers(file: string, { values = false } = {}): string[] {
  const code = fs
    .readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(type\s+)?(?:(?!\b(?:import|export)\b)[^"'`;])*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*()["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*()["']([^"']+)["']/g,
  ]
  for (const pattern of patterns) {
    for (const [, type, name] of code.matchAll(pattern)) if (!(values && type)) found.push(name!)
  }
  return found
}
