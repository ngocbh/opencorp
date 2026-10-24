/** The install tests' helpers (Python's `tests/install/conftest.py`). Tests never run a real service tool: every
 *  install test passes a `makeHost` host, whose `run` is a `Runner`. */
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { type Completed, type Host, type Launch, launch } from "../../src/install/launch.ts"

/** Records commands and answers each from a table of `[argv prefix, code, stderr, stdout?]`: the first matching
 *  prefix answers, else code 0 with empty output. */
export class Runner {
  readonly calls: string[][] = []

  constructor(private readonly answers: [prefix: string[], code: number, stderr: string, stdout?: string][] = []) {}

  readonly run = async (argv: readonly string[]): Promise<Completed> => {
    this.calls.push([...argv])
    for (const [prefix, code, stderr, stdout = ""] of this.answers) {
      if (prefix.every((part, i) => argv[i] === part)) return { code, stdout, stderr }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

/** A host whose home is `dir` and whose commands go to `runner`; nothing real runs. Its clock moves only when it
 *  sleeps, so waiting takes no real time. */
export function makeHost(
  dir: string,
  runner: Runner,
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
    run: runner.run,
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
