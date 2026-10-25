/** `opencorp install …`: the parser, help and usage errors, and each command run in-process through `main` with
 *  stand-ins for the machine. */
import fs from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, setDefaultTimeout, test } from "bun:test"
import * as fallback from "../../src/install/fallback.ts"
import type { InitOptions } from "../../src/install/init.ts"
import { launch, officeAnswers } from "../../src/install/launch.ts"
import { main, type Setup } from "../../src/install/main.ts"
import { type OnboardOptions, SET_UP, WHO } from "../../src/install/onboard.ts"
import { KeyboardInterrupt, type Prompter, TtyPrompter } from "../../src/install/prompts.ts"
import { selfSpawnEnv } from "../../src/platform.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { daemonHost, killedAtEnd, makeHost, NO_LISTING, Runner } from "./helpers.ts"

// onTestFinished hooks inherit it, and a daemon's stop can take 25 s plus a SIGKILL.
setDefaultTimeout(30_000)

/** A Writable that keeps what is written. */
function capture(): Writable & { text: () => string } {
  let text = ""
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  return Object.assign(stream, { text: () => text })
}

/** A setup that never reaches the machine: a host whose spawns and service tools are refused, an empty env and
 *  stdin, captured output; `out()` and `err()` give the text written. */
function standIns(dir: string) {
  const stdout = capture()
  const stderr = capture()
  const setup = {
    host: makeHost(dir, new Runner()),
    environ: {},
    stdin: Readable.from([]),
    stdout,
    stderr,
    doctor: {
      probe: async () => null,
      codex: async () => ({ name: "codex", status: "ok" as const, detail: "stand-in" }),
    },
    listers: NO_LISTING,
    checkModel: async () => null,
    guardStdout: () => {
      throw new Error("in-process tests never guard stdout")
    },
  } satisfies Partial<Setup>
  return { ...setup, out: () => stdout.text(), err: () => stderr.text() }
}

test.each(["init", "onboard"])("json prompts and provider stdin together are refused [%s]", async (command) => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main([command, "--home", dir, "--json-prompts", "--provider-stdin"], s)).toBe(2)
  expect(s.err()).toContain("not allowed with argument --json-prompts")
})

test("json prompts is not in the help", async () => {
  const s = standIns(tempDir())
  expect(await main(["init", "--help"], s)).toBe(0)
  expect(s.out()).not.toContain("--json-prompts")
  expect(s.out()).toContain("--provider-stdin")
})

test("a service mode that isnt one is a usage error", async () => {
  const s = standIns(tempDir())
  expect(await main(["init", "--service", "nope"], s)).toBe(2)
  expect(s.err()).toContain(
    "argument --service: invalid choice: 'nope' (choose from auto, launchd, systemd, tmux, background)",
  )
})

test("a missing or unknown command or flag is a usage error", async () => {
  const dir = tempDir()
  let s = standIns(dir)
  expect(await main(["nope"], s)).toBe(2)
  expect(s.err()).toContain("invalid choice: 'nope'")
  s = standIns(dir)
  expect(await main([], s)).toBe(2)
  expect(s.err()).toContain("the following arguments are required: command")
  s = standIns(dir)
  expect(await main(["start", "--bogus"], s)).toBe(2)
  expect(s.err()).toStartWith("usage: opencorp install start")
  expect(s.err()).toContain("--bogus")
})

test("doctor runs the codex check doctor has when it runs", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  await main(["doctor", "--home", path.join(dir, "home")], s)
  expect(s.out()).toContain("ok    codex        stand-in")
})

test("doctor on a fresh machine fails and says to onboard", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main(["doctor", "--home", path.join(dir, "home")], s)).toBe(1)
  expect(s.out()).toContain("fail  company      no company repo")
})

test("the home defaults to opencorp home", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), environ: { OPENCORP_HOME: path.join(dir, "elsewhere") } }
  await main(["doctor"], s)
  expect(s.out()).toContain(`no company repo at ${dir}/elsewhere/company`)
})

test("an empty opencorp home means the default", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), environ: { OPENCORP_HOME: "" } }
  await main(["doctor"], s)
  expect(s.out()).toContain(`no company repo at ${dir}/.opencorp/company`)
})

/** What a stand-in for init, onboard or offboard was called with. */
interface Call<O> {
  home: string
  prompter: Prompter
  options: O
}

/** A stand-in for a command that throws `KeyboardInterrupt`, as a Ctrl-C at a question does. */
async function interrupted(): Promise<void> {
  throw new KeyboardInterrupt()
}

/** A stand-in for init that must not run. */
async function mustNotRun(): Promise<void> {
  throw new Error("init ran")
}

test("init flags are known answers for the interview", async () => {
  const dir = tempDir()
  let seen: Call<InitOptions> | undefined
  const s = {
    ...standIns(dir),
    init: async (home: string, prompter: Prompter, options: InitOptions) => {
      seen = { home, prompter, options }
    },
  }
  const argv = ["init", "--home", path.join(dir, "home"), "--company", "Acme", "--name", "Me", "--handle", "me"]
  argv.push("--agent", "Bo", "--agent-handle", "bo", "--title", "CTO", "--remote", "u", "--no-device")
  expect(await main(argv, s)).toBe(0)
  expect(seen!.options.known).toEqual({
    company: "Acme",
    name: "Me",
    handle: "me",
    title: "CTO",
    agent: "Bo",
    agent_handle: "bo",
    remote: "u",
  })
  expect(seen!.prompter).toBeInstanceOf(TtyPrompter)
  expect(seen!.prompter.interactive).toBe(true)
  expect(seen!.options.device).toBe(false)
  expect(seen!.options.stdin).toBeUndefined()
  expect(seen!.options.listers).toBe(s.listers)
  expect(seen!.options.checkModel).toBe(s.checkModel)
  expect(seen!.options.host).toBe(s.host)
  expect(seen!.options.environ).toBe(s.environ)
})

test("ctrl c during init is exit 130 with only a newline", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), init: interrupted }
  expect(await main(["init", "--home", path.join(dir, "home")], s)).toBe(130)
  expect(s.err()).toBe("\n")
})

test.each(["onboard", "offboard"])(
  "ctrl c during onboard or offboard is exit 130 with only a newline [%s]",
  async (command) => {
    const dir = tempDir()
    const s = { ...standIns(dir), onboard: interrupted, offboard: interrupted }
    expect(await main([command, "--home", path.join(dir, "home")], s)).toBe(130)
    expect(s.err()).toBe("\n")
  },
)

test("the same handle for you and the first teammate stops init before it starts", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), init: mustNotRun }
  expect(await main(["init", "--home", path.join(dir, "home"), "--handle", "x", "--agent-handle", "x"], s)).toBe(1)
  expect(s.err()).toBe("opencorp init: --agent-handle 'x' is the same as --handle\n")
})

// Checked before anything is asked, so a bad flag costs the owner no questions.
test.each(["--handle", "--agent-handle"])("a bad handle flag stops init before it starts [%s]", async (flag) => {
  const dir = tempDir()
  const s = { ...standIns(dir), init: mustNotRun }
  expect(await main(["init", "--home", path.join(dir, "home"), flag, "Bad_Handle"], s)).toBe(1)
  expect(s.err()).toStartWith(`opencorp init: ${flag} 'Bad_Handle': `)
  expect(s.err()).toContain("should match pattern")
})

test("an init error is exit 1 with the reason", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), stdin: Readable.from(["not json"]) }
  const argv = ["init", "--home", path.join(dir, "home"), "--provider-stdin", "--company", "Acme"]
  argv.push("--name", "Ngoc", "--handle", "ngocbh", "--service", "background")
  expect(await main(argv, s)).toBe(1)
  expect(s.err()).toContain("opencorp init: the provider on stdin is not valid JSON")
})

test("onboard flags give the repo to clone and say which human you are", async () => {
  const dir = tempDir()
  let seen: Call<OnboardOptions> | undefined
  const s = {
    ...standIns(dir),
    onboard: async (home: string, prompter: Prompter, options: OnboardOptions) => {
      seen = { home, prompter, options }
    },
  }
  const argv = ["onboard", "--home", path.join(dir, "home"), "--from", "git@example.com:acme.git", "--handle", "lan"]
  expect(await main(argv, s)).toBe(0)
  expect(seen!.options.source).toBe("git@example.com:acme.git")
  expect(await seen!.prompter.choose(WHO, ["ceo", "lan"], "ceo")).toBe("lan")
})

test("onboard without a company or a repo is exit 1 with the ways to get one", async () => {
  const dir = tempDir()
  const s = { ...standIns(dir), stdin: Readable.from(["{}"]) }
  expect(await main(["onboard", "--home", path.join(dir, "home"), "--provider-stdin"], s)).toBe(1)
  expect(s.err()).toContain(SET_UP)
})

test("offboard flags reach offboard", async () => {
  const dir = tempDir()
  let seen: Call<Parameters<Setup["offboard"]>[2]> | undefined
  const s = {
    ...standIns(dir),
    offboard: async (home: string, prompter: Prompter, options: Parameters<Setup["offboard"]>[2]) => {
      seen = { home, prompter, options }
    },
  }
  expect(await main(["offboard", "--home", path.join(dir, "home"), "--yes", "--delete-company"], s)).toBe(0)
  expect(seen!.home).toBe(path.join(dir, "home"))
  expect(seen!.options).toMatchObject({ yes: true, deleteCompany: true })
  expect(seen!.options?.host).toBe(s.host)
  expect(seen!.options?.environ).toBe(s.environ)
})

test("offboard without a terminal or yes removes nothing", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(path.join(home, "office"), { recursive: true })
  const s = { ...standIns(dir), stdin: Readable.from([""]) }
  expect(await main(["offboard", "--home", home], s)).toBe(1)
  expect(s.err()).toContain("opencorp offboard: nothing was removed; there's no terminal to ask on, so pass --yes")
  expect(fs.statSync(path.join(home, "office")).isDirectory()).toBe(true)
})

test("offboard on an empty home is exit 0", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main(["offboard", "--home", path.join(dir, "home")], s)).toBe(0)
  expect(s.out()).toContain("Nothing of this office to remove at")
})

test("start before onboarding is exit 3 with a hint", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main(["start", "--home", path.join(dir, "home")], s)).toBe(3)
  expect(s.err()).toContain(SET_UP)
})

test("restart before onboarding is exit 3 with a hint", async () => {
  const dir = tempDir()
  const s = standIns(dir)
  expect(await main(["restart", "--home", path.join(dir, "home")], s)).toBe(3)
  expect(s.err()).toContain(SET_UP)
})

test("start with a company that has no first commit is exit 3 with a hint", async () => {
  const dir = tempDir()
  const company = path.join(dir, "home", "company")
  fs.mkdirSync(company, { recursive: true })
  git(company, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(company, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  const s = standIns(dir)
  expect(await main(["start", "--home", path.join(dir, "home")], s)).toBe(3)
  expect(s.err()).toContain(SET_UP)
})

/** A home for a real office, kept off HQ's TCP port, which the owner's own office holds: `install(argv)` runs
 *  `main` with a host that really starts the daemon, each call with its own output; `pid()` reads the pidfile. */
function realOffice(spawned: ReturnType<typeof killedAtEnd>) {
  const dir = shortDir()
  fs.mkdirSync(path.join(dir, "office"), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "office", "hq.json"), '{"tcp": false}')
  const environ = { ...gitEnv(selfSpawnEnv(process.env)), HOME: tempDir() }
  const host = daemonHost(dir, spawned)
  const install = async (argv: string[], stdin: Readable = Readable.from([])) => {
    const s = { ...standIns(dir), host, environ, stdin }
    const code = await main([argv[0]!, "--home", dir, ...argv.slice(1)], s)
    return { code, out: s.out(), err: s.err() }
  }
  const initArgs = ["init", "--provider-stdin", "--company", "Acme", "--name", "Hong Ngoc Bui", "--handle", "ngocbh"]
  const provider = JSON.stringify({ llm_config: { provider: "openai" } })
  return {
    dir,
    socket: path.join(dir, "office", "office.sock"),
    init: () => install([...initArgs, "--service", "background"], Readable.from([provider])),
    install,
    pid: () => fs.readFileSync(path.join(dir, "office", "office.pid"), "utf8").trim(),
    stop: () => fallback.stopProcess(launch(dir, { environ, userHome: dir })),
  }
}

test(
  "scripted init then start brings a stopped office back",
  async () => {
    const office = realOffice(killedAtEnd())
    try {
      const made = await office.init()
      expect(made.code, made.err).toBe(0)
      expect(made.out).toContain("with you as CEO and Minh (@minh)")
      const running = await office.install(["start"]) // already running: nothing to do
      expect(running.code).toBe(0)
      expect(running.out).toBe(`The office is already running (pid ${office.pid()}).\n`)
      await office.stop()
      expect(await officeAnswers(office.socket)).toBe(false)
      const started = await office.install(["start"])
      expect(started.code, started.err).toBe(0)
      expect(await officeAnswers(office.socket)).toBe(true)
      expect(started.out).toBe(`Started the office (pid ${office.pid()}).\n`)
    } finally {
      await office.stop()
    }
  },
  120_000,
)

test(
  "restart replaces a running office and starts a stopped one",
  async () => {
    const office = realOffice(killedAtEnd())
    try {
      const made = await office.init()
      expect(made.code, made.err).toBe(0)
      const old = office.pid()
      const restarted = await office.install(["restart"])
      expect(restarted.code, restarted.err).toBe(0)
      const now = office.pid()
      expect(now).not.toBe(old)
      expect(await officeAnswers(office.socket)).toBe(true)
      expect(restarted.out).toBe(`Restarted the office (pid ${now}; was ${old}).\n`)
      await office.stop()
      const started = await office.install(["restart"])
      expect(started.code, started.err).toBe(0)
      expect(await officeAnswers(office.socket)).toBe(true)
      expect(started.out).toBe(`The office wasn't running; started it (pid ${office.pid()}).\n`)
    } finally {
      await office.stop()
    }
  },
  120_000,
)
