/** `opencorp install …`: the parser, help and usage errors, and each command run in-process through `main` with
 *  stand-ins for the machine. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import readline from "node:readline"
import { Readable, Writable } from "node:stream"
import { type HqStatus, SetupPrompt } from "@opencorp/protocol"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { loadRepo } from "../../src/company/loader.ts"
import type { Unread } from "../../src/install/doctor.ts"
import * as fallback from "../../src/install/fallback.ts"
import type { InitOptions } from "../../src/install/init.ts"
import { launch, officeAnswers } from "../../src/install/launch.ts"
import { main, type Setup } from "../../src/install/main.ts"
import { type OnboardOptions, SET_UP, setupConnectionFile, WHO } from "../../src/install/onboard.ts"
import { KeyboardInterrupt, type Prompter, TtyPrompter } from "../../src/install/prompts.ts"
import { selfCommand, selfSpawnEnv } from "../../src/platform.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { shortDir, tempDir } from "../helpers.ts"
import { daemonHost, killedAtEnd, makeHost, NO_LISTING, Runner, SRC } from "./helpers.ts"

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
  expect(s.out()).toContain("VLLM_BASE_URL")
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

test.each(["start", "restart"])("a home too long for the socket is exit 1 [%s]", async (command) => {
  const dir = tempDir()
  const runner = new Runner()
  const s = { ...standIns(dir), host: makeHost(dir, runner) }
  const stderr = capture()
  expect(await main([command, "--home", path.join(dir, "h".repeat(120))], { ...s, stderr })).toBe(1)
  expect(stderr.text()).toContain("socket path too long")
  expect(runner.calls).toEqual([])
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

/** An HQ status whose web port is as `tcp` says, with `over` over its other fields. */
function hqAnswer(tcp: Partial<HqStatus["tcp"]> = {}, over: Partial<HqStatus> = {}): HqStatus {
  return {
    socket: "/h/office/hq.sock",
    tcp: { enabled: true, port: 49380, listening: true, error: null, next_retry_at: null, ...tcp },
    url: "http://127.0.0.1:49380/",
    health: { ok: true, office: { api: "0.0.1+aaa" }, app: null },
    socket_error: null,
    warnings: [],
    ...over,
  }
}

const TAKEN = { listening: false, error: "Address already in use" }

/** Stand-ins for an onboarded home whose office already answers, its GET /hq answering `status`. */
function onboardedStandIns(dir: string, status: () => Promise<HqStatus | Unread>) {
  const company = path.join(dir, "home", "company")
  fs.mkdirSync(company, { recursive: true })
  git(company, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(company, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  git(company, "add", "-A")
  git(company, "commit", "-qm", "first")
  const s = standIns(dir)
  return {
    ...s,
    host: makeHost(dir, new Runner(), { answers: async () => true }),
    doctor: { ...s.doctor, hq: status },
  }
}

test("start says when the hq web port isnt listening and still exits 0", async () => {
  const dir = tempDir()
  const s = onboardedStandIns(dir, async () => hqAnswer(TAKEN))
  expect(await main(["start", "--home", path.join(dir, "home")], s)).toBe(0)
  expect(s.out()).toBe("The office is already running (pid ?).\n")
  expect(s.err()).toStartWith("opencorp: HQ: port 49380 isn't free (Address already in use)")
  expect(s.err()).toContain(path.join(dir, "home", "office", "hq.json"))
  expect(s.err().trimEnd().split("\n")).toHaveLength(1)
})

test.each([
  ["listening", async () => hqAnswer()],
  ["off", async () => hqAnswer({ enabled: false, listening: false })],
  ["refused", async () => "refused" as const],
  ["unreachable", async () => "unreachable" as const],
  ["unreadable", async () => "unreadable" as const],
  [
    "failing",
    async () => {
      throw new Error("boom")
    },
  ],
])("start says nothing of hq when there is nothing to fix [%s]", async (_name, status) => {
  const dir = tempDir()
  const s = onboardedStandIns(dir, status)
  expect(await main(["start", "--home", path.join(dir, "home")], s)).toBe(0)
  expect(s.out()).toBe("The office is already running (pid ?).\n")
  expect(s.err()).toBe("")
})

test("start passes on hqs warnings and every web port line that needs a look", async () => {
  const others = "the web port is on and this host has other users (ann): any of them could take the port"
  const answers: [HqStatus, string[]][] = [
    [hqAnswer({}, { warnings: [others] }), [`opencorp: HQ: ${others}`]],
    [
      hqAnswer(TAKEN, { socket_error: "Permission denied" }),
      ["opencorp: HQ: not listening on /h/office/hq.sock: Permission denied", "opencorp: HQ: port 49380 isn't free"],
    ],
    [hqAnswer({ listening: false }), ["opencorp: HQ: port 49380 isn't listening yet (HQ is binding it)"]],
  ]
  for (const [answer, lines] of answers) {
    const dir = tempDir()
    const s = onboardedStandIns(dir, async () => answer)
    expect(await main(["start", "--home", path.join(dir, "home")], s)).toBe(0)
    const got = s.err().trimEnd().split("\n")
    expect(got).toHaveLength(lines.length)
    lines.forEach((line, i) => expect(got[i]).toStartWith(line))
  }
})

test.each(["init", "onboard"])("%s says when hqs web port isnt listening", async (command) => {
  const dir = tempDir()
  const s = { ...onboardedStandIns(dir, async () => hqAnswer(TAKEN)), init: async () => {}, onboard: async () => {} }
  expect(await main([command, "--home", path.join(dir, "home")], s)).toBe(0)
  expect(s.err()).toStartWith("opencorp: HQ: port 49380 isn't free")
})

test("a failed init says nothing of hq", async () => {
  const dir = tempDir()
  const s = { ...onboardedStandIns(dir, async () => hqAnswer(TAKEN)), init: interrupted }
  expect(await main(["init", "--home", path.join(dir, "home")], s)).toBe(130)
  expect(s.err()).toBe("\n")
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
      expect(running.err).toBe("") // HQ's web port is off, so there's nothing to say about it
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

test(
  "restart and start say hqs web port is taken once the office answers",
  async () => {
    const office = realOffice(killedAtEnd())
    const holder = net.createServer()
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject)
      holder.listen(0, "127.0.0.1", resolve)
    })
    onTestFinished(() => new Promise<void>((resolve) => holder.close(() => resolve())))
    const port = (holder.address() as net.AddressInfo).port
    const taken = `opencorp: HQ: port ${port} isn't free`
    try {
      const made = await office.init()
      expect(made.code, made.err).toBe(0)
      fs.writeFileSync(path.join(office.dir, "office", "hq.json"), JSON.stringify({ tcp: true, port }))
      // Each command reports HQ only once office.sock answers, and HQ binds its web port before that socket listens.
      const restart = () => office.install(["restart"])
      const start = () => office.stop().then(() => office.install(["start"]))
      for (const run of [restart, start]) {
        const { code, err } = await run()
        expect(code, err).toBe(0)
        expect(err.split("\n").filter((line) => line.startsWith(taken))).toHaveLength(1)
        expect(err).not.toContain("isn't listening yet (HQ is binding it)")
      }
    } finally {
      await office.stop()
    }
  },
  120_000,
)

// Python's conftest refused the service tools on PATH; these record any call, so a test can show none ran.
const REFUSED = ["launchctl", "systemctl", "loginctl", "tmux"]

/** A child's env under `dir`: HOME and the office home inside it, and `dir/bin` first on PATH, holding refusing
 *  service tools that append their argv to `dir/calls.log` and exit 1. */
function childEnv(dir: string): Record<string, string> {
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(dir, "user"), { recursive: true })
  for (const name of REFUSED) {
    const log = JSON.stringify(path.join(dir, "calls.log"))
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\nexit 1\n`, { mode: 0o755 })
  }
  return {
    ...gitEnv(selfSpawnEnv(process.env)),
    HOME: path.join(dir, "user"),
    OPENCORP_HOME: path.join(dir, "user", ".opencorp"),
    PATH: `${bin}:${process.env.PATH}`,
  }
}

/** Writes a driver to `dir/driver.ts` that runs `run` with the setup `overrides` (TS source of an object) on the
 *  driver's own argv, after the `imports` lines; returns the command that runs it with this Bun and the
 *  no-autoload flags. */
function driver(dir: string, overrides: string, imports = ""): string[] {
  const file = path.join(dir, "driver.ts")
  const main = JSON.stringify(path.join(SRC, "install/main.ts"))
  fs.writeFileSync(file, `${imports}import { run } from ${main}\nawait run(process.argv.slice(2), ${overrides})\n`)
  // The same flags as CHECKOUT_FLAGS in src/platform.ts, which doesn't export them; keep the two in sync.
  return [process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", file]
}

/** A short home for a child's office, kept off HQ's TCP port, and `stop`, which stops the daemon a child left
 *  there; it also runs when the test ends, before the home is removed. */
function childHome(env: Record<string, string>): { home: string; stop: () => Promise<unknown> } {
  let home = ""
  const stop = async () => {
    if (home) await fallback.stopProcess(launch(home, { environ: env }))
  }
  // Registered before shortDir registers the removal, so it runs first.
  onTestFinished(stop)
  home = shortDir()
  fs.mkdirSync(path.join(home, "office"), { mode: 0o700 })
  fs.writeFileSync(path.join(home, "office", "hq.json"), '{"tcp": false}')
  return { home, stop }
}

/** Runs `argv` in `cwd` with `env`, `input` on stdin; killed after `bound` ms. With `readAfter`, stdout is read
 *  only after that many ms. With `talk`, stdin stays open and `talk` gets the child to drive it instead. */
function spawnChild(
  argv: string[],
  env: Record<string, string>,
  {
    input = "",
    bound,
    cwd,
    readAfter,
    talk,
  }: {
    input?: string
    bound: number
    cwd: string
    readAfter?: number
    talk?: (child: ChildProcessWithoutNullStreams) => void
  },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  const kill = setTimeout(() => child.kill("SIGKILL"), bound)
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
  // A child that exits before reading all its input closes the pipe under a write.
  child.stdin.on("error", () => {})
  if (readAfter !== undefined) {
    child.stdout.pause()
    setTimeout(() => child.stdout.resume(), readAfter)
  }
  if (talk) talk(child)
  else child.stdin.end(input)
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(kill)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(kill)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
    })
  })
}

test("all of stdout reaches the reader before setup exits", async () => {
  const dir = tempDir()
  const script = driver(
    dir,
    `{ offboard: async () => { for (let i = 0; i < 1024; i++) process.stdout.write("x".repeat(1024) + "\\n") } }`,
  )
  const home = path.join(dir, "user", ".opencorp")
  const result = await spawnChild([...script, "offboard", "--home", home], childEnv(dir), {
    bound: 20_000,
    cwd: dir,
    readAfter: 500,
  })
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout.length).toBe(1024 * 1025)
  expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
}, 30_000)

test("an unexpected error is exit 1 with its stack on stderr", async () => {
  const dir = tempDir()
  const home = path.join(dir, "user", ".opencorp")
  const env = childEnv(dir)
  const boom = driver(
    dir,
    `{ doctor: { probe: async () => { throw new Error("boom") }, ` +
      `codex: async () => ({ name: "codex", status: "ok", detail: "stand-in" }) } }`,
  )
  const crashed = await spawnChild([...boom, "doctor", "--home", home], env, { bound: 20_000, cwd: dir })
  expect(crashed.code, crashed.stderr).toBe(1)
  expect(crashed.stderr).toContain("boom")
  expect(crashed.stderr).toMatch(/^\s+at /m)
  expect(crashed.stdout.toString()).not.toContain("boom")
  // A rejection nothing handles, left by a step that then returns: Bun would only print it and exit 0.
  const dangling = driver(dir, `{ offboard: async () => { Promise.reject(new Error("dangling")) } }`)
  const left = await spawnChild([...dangling, "offboard", "--home", home], env, { bound: 20_000, cwd: dir })
  expect(left.code, left.stderr).toBe(1)
  expect(left.stderr).toContain("dangling")
  expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
}, 60_000)

const KEY = "sk-ant-sentinel-a7d93c10e5b2"

/** Runs `opencorp install init` in a real process on `home` with the key and the fake model's env on stdin. */
function realInit(home: string, env: Record<string, string>, fakeEnv: Record<string, string>, cwd: string) {
  const argv = [...selfCommand(), "install", "init", "--home", home, "--provider-stdin", "--company", "Acme"]
  argv.push("--name", "Ngoc", "--handle", "ngocbh", "--service", "background")
  const input = JSON.stringify({ llm_config: { ...LLM_CONFIG, api_key: KEY }, env: fakeEnv })
  return spawnChild(argv, env, { input, bound: 60_000, cwd })
}

test(
  "init in a real process keeps the key off the terminal",
  async () => {
    const fake = await fakeLlm()
    fake.script({ content: "OK" })
    const dir = tempDir()
    const env = childEnv(dir)
    const { home } = childHome(env)
    const done = await realInit(home, env, fake.env(), dir)
    expect(done.code, done.stderr).toBe(0)
    expect(done.stdout.toString()).not.toContain(KEY)
    expect(done.stderr).not.toContain(KEY)
    expect(done.stdout.toString()).toContain("Done.")
    expect(fake.requests()).toHaveLength(1)
    const kinds = [...loadRepo(path.join(home, "company")).people.values()].map((p) => p.kind)
    expect(kinds.sort()).toEqual(["agent", "human"])
    const file = setupConnectionFile(path.join(home, "office"))
    expect(JSON.parse(fs.readFileSync(file, "utf8")).llm_config.api_key).toBe(KEY)
    expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
  },
  150_000,
)

/** What the test answers `prompt` with, as the setup screen would; null when it needs no answer. */
function answer(prompt: ReturnType<typeof SetupPrompt.parse>): string | null {
  if (prompt.type === "choose") return prompt.question === "Model provider" ? "anthropic" : prompt.default
  if (prompt.type === "secret") return KEY
  if (prompt.type === "ask") return ""
  return null
}

test(
  "onboard with json prompts in a real process keeps the channel clean",
  async () => {
    const fake = await fakeLlm()
    fake.script({ content: "OK" })
    const dir = tempDir()
    const env = childEnv(dir)
    const { home, stop } = childHome(env)
    const done = await realInit(home, env, fake.env(), dir)
    expect(done.code, done.stderr).toBe(0)
    await stop()
    const file = setupConnectionFile(path.join(home, "office"))
    fs.unlinkSync(file) // so onboard asks for the provider
    // The stray output comes after stdout is guarded, so it must land on stderr, not between prompts.
    const script = driver(
      dir,
      "{ listers: { azureDeployments: async () => [], providerModels: async () => [] }, checkModel: async () => " +
        '{ console.log("a stray print"); process.stdout.write("a stray write\\n"); return null } }',
    )
    const lines: string[] = []
    const kinds = new Set<string>()
    const bad: string[] = []
    const argv = [...script, "onboard", "--home", home, "--json-prompts", "--service", "background"]
    const result = await spawnChild(argv, env, {
      bound: 60_000,
      cwd: dir,
      talk: (child) => {
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          lines.push(line)
          let prompt
          try {
            prompt = SetupPrompt.parse(JSON.parse(line))
          } catch {
            bad.push(line)
            return
          }
          kinds.add(prompt.type)
          const reply = answer(prompt)
          if (reply !== null) child.stdin.write(`${JSON.stringify({ answer: reply })}\n`)
        })
      },
    })
    const out = result.stdout.toString()
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain("a stray print")
    expect(result.stderr).toContain("a stray write")
    expect(out).not.toContain("a stray print")
    expect(out).not.toContain("a stray write")
    expect(bad).toEqual([])
    expect(lines.length).toBeGreaterThan(0)
    expect(out).not.toContain(KEY)
    expect(result.stderr).not.toContain(KEY)
    expect([...kinds]).toEqual(expect.arrayContaining(["step", "say"]))
    expect(JSON.parse(fs.readFileSync(file, "utf8")).llm_config.api_key).toBe(KEY)
    expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
  },
  220_000,
)

test(
  "init without git says so instead of a traceback",
  async () => {
    const dir = tempDir()
    const env = childEnv(dir)
    const { home } = childHome(env)
    const empty = path.join(dir, "empty")
    fs.mkdirSync(empty)
    const script = driver(
      dir,
      "{ listers: { azureDeployments: async () => [], providerModels: async () => [] }, checkModel: async () => null }",
    )
    const argv = [...script, "init", "--home", home, "--provider-stdin", "--company", "Acme", "--name", "Ngoc"]
    argv.push("--handle", "ngocbh", "--service", "background")
    // The driver runs with Bun's absolute path, so a PATH with nothing on it is fine.
    const input = JSON.stringify({ llm_config: { provider: "openai" } })
    const result = await spawnChild(argv, { ...env, PATH: empty }, { input, bound: 60_000, cwd: dir })
    expect(result.code, result.stderr).toBe(1)
    expect(result.stderr).toStartWith("opencorp init: ")
    expect(result.stderr).toContain("git")
    expect(result.stderr).not.toMatch(/^\s+at /m)
    expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
  },
  100_000,
)

test(
  "ctrl c at a numbered question is exit 130 with only a newline",
  async () => {
    const dir = tempDir()
    const env = childEnv(dir)
    const { home } = childHome(env)
    // No provider on stdin, so the terminal prompter asks its numbered list on the pipe left open.
    const argv = [...selfCommand(), "install", "init", "--home", home, "--service", "background"]
    const result = await spawnChild(argv, env, {
      bound: 30_000,
      cwd: dir,
      talk: (child) => {
        let seen = ""
        let sent = false
        child.stdout.on("data", (chunk: Buffer) => {
          seen += chunk.toString()
          if (!sent && seen.includes("Model provider")) {
            sent = true
            child.kill("SIGINT")
          }
        })
      },
    })
    expect(result.code, result.stderr).toBe(130)
    expect(result.stderr).toBe("\n")
    expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
  },
  60_000,
)

test("an input error after a prompt failed is not a crash", async () => {
  const dir = tempDir()
  const prompts = JSON.stringify(path.join(SRC, "install/prompts.ts"))
  // The queued EIO comes in exit's one-macrotask yield, before the streams end: where it could count as a crash.
  const script = driver(
    dir,
    "{ offboard: async () => { " +
      'setImmediate(() => { throw Object.assign(new Error("read EIO"), { code: "EIO" }) }); ' +
      "throw new OnboardError(\"no answer to 'x' (stdin closed)\") } }",
    `import { OnboardError } from ${prompts}\n`,
  )
  const home = path.join(dir, "user", ".opencorp")
  const result = await spawnChild([...script, "offboard", "--home", home], childEnv(dir), { bound: 20_000, cwd: dir })
  expect(result.code, result.stderr).toBe(1)
  expect(result.stderr).toBe("opencorp offboard: no answer to 'x' (stdin closed)\n")
  expect(fs.existsSync(path.join(dir, "calls.log"))).toBe(false)
}, 30_000)
