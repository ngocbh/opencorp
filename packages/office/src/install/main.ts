/**
 * `opencorp install <command>`: what `opencorp init`, `opencorp onboard`, `opencorp offboard`, `opencorp doctor`,
 * `opencorp start` and `opencorp restart` run.
 *
 * `opencorp`'s setup screen runs init and onboard with `--json-prompts`: each question is a JSON line on stdout,
 * each answer a JSON line on stdin. Flags are matched whole; a prefix (`--prov` for `--provider-stdin`) is
 * unknown.
 *
 * Exit codes: 0 done, 1 failed, 2 usage, 3 (`start`, `restart`) no office yet, 130 Ctrl-C.
 */
import { Console } from "node:console"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { parseArgs } from "node:util"
import { identityPath, readIdentity } from "../auth/identity.ts"
import { handleProblem } from "../company/naming.ts"
import { companyState } from "../company_template/index.ts"
import { OfficeStartError } from "../daemon/sockets.ts"
import { repr } from "../perm/redact.ts"
import { type CheckOptions, checks, exitCode, hqPortChecks, hqStatus, report } from "./doctor.ts"
import { init } from "./init.ts"
import { JsonPrompter, type TextOut } from "./json_prompts.ts"
import { defaultHost, type Env, type Host, type Launch, launch, ServiceError } from "./launch.ts"
import { Declined, OffboardError, offboard } from "./offboard.ts"
import {
  checkSocket,
  damageMessage,
  LISTERS,
  lexists,
  type Listers,
  type ModelCheck,
  modelProblem,
  onboard,
  SET_UP,
  WHO,
} from "./onboard.ts"
import { isTTY, KeyboardInterrupt, OnboardError, type Prompter, TtyPrompter } from "./prompts.ts"
import * as service from "./service.ts"

/** The exit code of `start` and `restart` when there's no company or no office yet. */
export const NOT_ONBOARDED = 3

/** What the commands read, write and run; tests pass stand-ins. */
export interface Setup {
  /** Where answers and a provider come from (`process.stdin`). */
  stdin: Readable
  /** Where questions, reports and what was started go (`process.stdout`). */
  stdout: Writable
  /** Where errors go (`process.stderr`). */
  stderr: Writable
  /** The setup's environment, handed to every command (`process.env`). */
  environ: Env
  /** This machine (`defaultHost()`). */
  host: Host
  /** Lists deployments and models to pick from (`LISTERS`). */
  listers: Listers
  /** Checks the model answers before the provider is saved (`modelProblem`). */
  checkModel: ModelCheck
  /** Runs `opencorp init`. */
  init: typeof init
  /** Runs `opencorp onboard`. */
  onboard: typeof onboard
  /** Runs `opencorp offboard`. */
  offboard: typeof offboard
  /** The doctor's checks' own options (none: their defaults). */
  doctor: Omit<CheckOptions, "host" | "environ">
  /** JSON mode: points every other stdout writer at stderr; returns the writer for prompts. */
  guardStdout(): TextOut
}

/** Rebinds the console and `process.stdout.write` to stderr; returns stdout's own writer, bound before. */
function guardStdout(): TextOut {
  const out = process.stdout.write.bind(process.stdout)
  // Python pointed fd 1 at stderr, so nothing else printed could land inside a prompt line. Here fd 1 stays, and
  // Bun's console writes natively rather than through process.stdout, so both writers are rebound.
  // Bun's global console type has members node:console's Console instance lacks.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr }) as typeof globalThis.console
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  return { write: out }
}

/** `given` with the production collaborators for what it leaves out, each made only when it's left out. */
function defaults(given: Partial<Setup>): Setup {
  return {
    stdin: given.stdin ?? process.stdin,
    stdout: given.stdout ?? process.stdout,
    stderr: given.stderr ?? process.stderr,
    environ: given.environ ?? process.env,
    host: given.host ?? defaultHost(),
    listers: given.listers ?? LISTERS,
    checkModel: given.checkModel ?? modelProblem,
    init: given.init ?? init,
    onboard: given.onboard ?? onboard,
    offboard: given.offboard ?? offboard,
    doctor: given.doctor ?? {},
    guardStdout: given.guardStdout ?? guardStdout,
  }
}

/** The flags as parsed; each is there only for the commands that take it. */
interface Args {
  home?: string
  help?: boolean
  service?: service.Mode | "auto"
  "provider-stdin"?: boolean
  "json-prompts"?: boolean
  company?: string
  name?: string
  handle?: string
  title?: string
  agent?: string
  "agent-handle"?: string
  remote?: string
  "no-device"?: boolean
  from?: string
  yes?: boolean
  "delete-company"?: boolean
}

/** A flag: its type, short name, the placeholder for its value and its help; no help keeps it out of the help. */
interface Flag {
  type: "string" | "boolean"
  short?: string
  metavar?: string
  help?: string
  default?: string
}

const SERVICES: readonly string[] = ["auto", ...service.MODES]
/** Flags that can't be given together. */
const EXCLUSIVE = ["provider-stdin", "json-prompts"]

const COMMON: Record<string, Flag> = {
  help: { type: "boolean", short: "h", help: "show this help message and exit" },
  home: { type: "string", metavar: "HOME", help: "OpenCorp home (default: $OPENCORP_HOME or ~/.opencorp)" },
}
const SETUP: Record<string, Flag> = {
  service: {
    type: "string",
    default: "auto",
    metavar: `{${SERVICES.join(",")}}`,
    help: "how to run the office (default: the first that works)",
  },
  "provider-stdin": {
    type: "boolean",
    help:
      "read the office's setup connection from stdin as JSON, replacing it; ask nothing: " +
      '{"llm_config":{"provider":...,"api_key":...,"model":...},"env":{"VLLM_BASE_URL":...}}',
  },
  // Only for opencorp's setup screen, which reads the prompts; not something to type.
  "json-prompts": { type: "boolean" },
}

/** Each command: what it does, and its flags in help order. */
const COMMANDS: Record<string, { about: string; flags: Record<string, Flag>; run: Command }> = {
  init: {
    about: "create the company, then set up this office",
    flags: {
      ...COMMON,
      ...SETUP,
      company: { type: "string", metavar: "COMPANY", help: "use the company's name without asking" },
      name: { type: "string", metavar: "NAME", help: "use your name without asking" },
      handle: { type: "string", metavar: "HANDLE", help: "use your handle without asking" },
      title: { type: "string", metavar: "TITLE", help: "use your title without asking" },
      agent: { type: "string", metavar: "AGENT", help: "use the first teammate's name without asking" },
      "agent-handle": {
        type: "string",
        metavar: "AGENT_HANDLE",
        help: "use the first teammate's handle without asking",
      },
      remote: {
        type: "string",
        metavar: "URL",
        help: "push the company to this git remote without asking; the model never sees it",
      },
      "no-device": {
        type: "boolean",
        help:
          "don't register this device; the office stays open to requests without a token until someone runs" +
          " `opencorp login`",
      },
    },
    run: initCommand,
  },
  onboard: {
    about: "set up this office for an existing company",
    flags: {
      ...COMMON,
      ...SETUP,
      from: { type: "string", metavar: "URL", help: "clone the company from this git URL when there's none here yet" },
      handle: { type: "string", metavar: "HANDLE", help: "which of a cloned company's humans you are" },
    },
    run: onboardCommand,
  },
  offboard: {
    about: "remove this office from this machine",
    flags: {
      ...COMMON,
      yes: { type: "boolean", help: "remove without asking first" },
      "delete-company": {
        type: "boolean",
        help: "delete the company repo even if some of it isn't pushed anywhere",
      },
    },
    run: offboardCommand,
  },
  doctor: { about: "check the office", flags: COMMON, run: doctorCommand },
  start: { about: "start the office if it isn't running", flags: COMMON, run: startCommand },
  restart: { about: "stop the office and start it again", flags: COMMON, run: restartCommand },
}

type Command = (args: Args, s: Setup) => Promise<number>

/** A flag as help and usage show it: `--home HOME`, `-h, --help`. */
function shown(name: string, flag: Flag): string {
  const long = flag.metavar ? `--${name} ${flag.metavar}` : `--${name}`
  return flag.short ? `-${flag.short}, ${long}` : long
}

/** The usage line of `command`, or of `opencorp install` itself. */
function usage(command?: string): string {
  if (command === undefined) return `usage: opencorp install {${Object.keys(COMMANDS).join(",")}} ...\n`
  const flags = Object.entries(COMMANDS[command]!.flags).filter(([, flag]) => flag.help)
  const parts = flags.map(([name, flag]) => `[${flag.short ? `-${flag.short}` : shown(name, flag)}]`)
  return `usage: opencorp install ${command} ${parts.join(" ")}\n`
}

/** The column help text starts at: argparse's `max_help_position`. */
const HELP_COLUMN = 24

/** The help of `command`, or of `opencorp install` itself, argparse-like. */
function help(command?: string): string {
  // Names too wide to leave two spaces before the column go on their own line, as argparse puts them.
  const line = (names: string, text: string) =>
    names.length + 4 <= HELP_COLUMN
      ? `  ${names.padEnd(HELP_COLUMN - 2)}${text}\n`
      : `  ${names}\n${" ".repeat(HELP_COLUMN)}${text}\n`
  if (command === undefined) {
    const lines = Object.entries(COMMANDS).map(([name, c]) => line(`  ${name}`, c.about))
    return `${usage()}\npositional arguments:\n  {${Object.keys(COMMANDS).join(",")}}\n${lines.join("")}`
  }
  const lines = Object.entries(COMMANDS[command]!.flags).flatMap(([name, flag]) =>
    flag.help ? [line(shown(name, flag), flag.help)] : [],
  )
  return `${usage(command)}\noptions:\n${lines.join("")}`
}

/** Says on stderr how `command` (or `opencorp install`) is used and what was wrong; exit code 2. */
function usageError(s: Setup, message: string, command?: string): number {
  s.stderr.write(`${usage(command)}opencorp install${command ? ` ${command}` : ""}: error: ${message}\n`)
  return 2
}

/** The flags in `argv` for `command`, or a usage error's message. */
function parse(command: string, argv: string[]): Args | string {
  const options = Object.fromEntries(
    Object.entries(COMMANDS[command]!.flags).map(([name, { metavar, help, ...option }]) => [name, option]),
  )
  let parsed
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true })
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_")) {
      return error.message
    }
    throw error
  }
  const args = parsed.values as Args
  if (args.help) return args
  // In argv order, as argparse words it: the later flag is the one not allowed.
  const given = parsed.tokens.flatMap((t) => (t.kind === "option" && EXCLUSIVE.includes(t.name) ? [t.name] : []))
  const later = given.find((name) => name !== given[0])
  if (later) return `argument --${later}: not allowed with argument --${given[0]}`
  if (args.service !== undefined && !SERVICES.includes(args.service)) {
    return `argument --service: invalid choice: ${repr(args.service)} (choose from ${SERVICES.join(", ")})`
  }
  return args
}

/** Runs the command `argv[0]` names with the flags after it; resolves to the exit code. */
export async function main(argv: string[], setup: Partial<Setup> = {}): Promise<number> {
  const s = defaults(setup)
  const [command, ...rest] = argv
  if (command === "-h" || command === "--help") {
    s.stdout.write(help())
    return 0
  }
  if (command === undefined) return usageError(s, "the following arguments are required: command")
  if (!Object.hasOwn(COMMANDS, command)) {
    const choices = Object.keys(COMMANDS).join(", ")
    return usageError(s, `argument command: invalid choice: ${repr(command)} (choose from ${choices})`)
  }
  const args = parse(command, rest)
  if (typeof args === "string") return usageError(s, args, command)
  if (args.help) {
    s.stdout.write(help(command))
    return 0
  }
  return COMMANDS[command]!.run(args, s)
}

/** `error`'s stack, or the value itself when it isn't an `Error`. */
function stack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error)
}

/** Runs `main` as the `opencorp install` process and exits with its code once stdout and stderr have drained: 130
 *  on Ctrl-C, 1 with the stack on stderr for an error nothing expected or a rejection nothing handled. */
export async function run(argv: string[], setup: Partial<Setup> = {}): Promise<never> {
  let exiting = false
  let ending = false
  let failed = false
  let interrupted = false
  const exit = async (code: number): Promise<never> => {
    // The first exit is already on its way to process.exit; later callers wait for it.
    if (exiting) return new Promise<never>(() => {})
    exiting = true
    // Bun reports a rejection the last step left only after a macrotask; this lets `crashed` see it first.
    await new Promise((resolve) => setImmediate(resolve))
    ending = true
    try {
      // A zero-length write's callback can come before earlier writes have arrived; end's comes after all of them.
      for (const stream of [process.stdout, process.stderr]) await new Promise<void>((resolve) => stream.end(resolve))
    } finally {
      // A throw from `end` must not keep the process from exiting.
      process.exit(failed ? 1 : code)
    }
  }
  process.on("SIGINT", () => {
    // A repeat Ctrl-C exits at once, in case a flush never ends. A first one while an exit drains leaves that
    // exit's code alone.
    if (interrupted) process.exit(130)
    interrupted = true
    if (exiting) return
    // At a prompt Ctrl-C is a key in raw mode, not a signal, so this one came outside a prompt (a numbered list
    // reading a line, git running); raw mode goes off in case something left it on.
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false)
    process.stderr.write("\n")
    void exit(130)
  })
  const crashed = (error: unknown) => {
    // Writing after the streams end raises `write after end`, which would land here again.
    if (ending) return
    // readline re-emits the terminal's EIO after the prompt already failed on the closed input, and `main` ends
    // with 1 for that.
    if ((error as { code?: unknown } | null)?.code === "EIO") return
    // Bun only prints an unhandled rejection and carries on, so without this an exit would turn it into 0.
    failed = true
    process.stderr.write(`${stack(error)}\n`)
    void exit(1)
  }
  process.on("uncaughtException", crashed)
  process.on("unhandledRejection", crashed)
  let code: number
  try {
    code = await main(argv, setup)
  } catch (error) {
    process.stderr.write(`${stack(error)}\n`)
    code = 1
  }
  return exit(code)
}

/** The home to use: `--home`, else `$OPENCORP_HOME` (empty is unset), else `~/.opencorp`; resolved by each
 *  command through `launch`. */
function home(value: string | undefined, s: Setup): string {
  return value || s.environ.OPENCORP_HOME || path.join(s.host.userHome, ".opencorp")
}

/** The prompter for init and onboard: the setup screen's with `--json-prompts`, else the terminal's, which asks
 *  only when `asking` (no provider on stdin). */
function prompter(args: Args, asking: boolean, s: Setup, preset: Record<string, string> = {}): Prompter {
  if (args["json-prompts"]) return new JsonPrompter(s.guardStdout(), s.stdin, preset)
  return new TtyPrompter({ preset, interactive: asking, input: s.stdin, output: s.stdout, env: s.environ })
}

/** The exit code for `run` as `opencorp <command>`: 1 with the reason for an `OnboardError`, 130 for Ctrl-C. */
async function setupRun(command: string, s: Setup, run: () => Promise<void>): Promise<number> {
  try {
    await run()
  } catch (error) {
    if (error instanceof OnboardError) {
      s.stderr.write(`opencorp ${command}: ${error.message}\n`)
      return 1
    }
    if (error instanceof KeyboardInterrupt) {
      // Ctrl-C at a question leaves the cursor mid-line; end the line instead of showing a stack.
      s.stderr.write("\n")
      return 130
    }
    throw error
  }
  return 0
}

async function initCommand(args: Args, s: Setup): Promise<number> {
  // Handles from flags are checked before anything is asked, so a bad one doesn't cost the owner an interview.
  for (const [flag, handle] of [
    ["--handle", args.handle],
    ["--agent-handle", args["agent-handle"]],
  ] as const) {
    const problem = handle ? handleProblem(handle) : null
    if (problem) {
      s.stderr.write(`opencorp init: ${flag} ${repr(handle!)}: ${problem}\n`)
      return 1
    }
  }
  if (args.handle && args["agent-handle"] === args.handle) {
    s.stderr.write(`opencorp init: --agent-handle ${repr(args.handle)} is the same as --handle\n`)
    return 1
  }
  const known = {
    company: args.company ?? "",
    name: args.name ?? "",
    handle: args.handle ?? "",
    title: args.title ?? "",
    agent: args.agent ?? "",
    agent_handle: args["agent-handle"] ?? "",
    remote: args.remote ?? "",
  }
  // With the provider on stdin nothing is asked, and questions without a flag take their defaults.
  const stdin = args["provider-stdin"] ? s.stdin : undefined
  const code = await setupRun("init", s, () =>
    s.init(home(args.home, s), prompter(args, stdin === undefined, s), {
      listers: s.listers,
      checkModel: s.checkModel,
      known,
      mode: args.service,
      stdin,
      device: !args["no-device"],
      host: s.host,
      environ: s.environ,
    }),
  )
  if (code === 0) await reportHq(home(args.home, s), s)
  return code
}

async function onboardCommand(args: Args, s: Setup): Promise<number> {
  const stdin = args["provider-stdin"] ? s.stdin : undefined
  const code = await setupRun("onboard", s, () =>
    s.onboard(home(args.home, s), prompter(args, stdin === undefined, s, { [WHO]: args.handle ?? "" }), {
      listers: s.listers,
      checkModel: s.checkModel,
      mode: args.service,
      stdin,
      source: args.from,
      host: s.host,
      environ: s.environ,
    }),
  )
  if (code === 0) await reportHq(home(args.home, s), s)
  return code
}

async function offboardCommand(args: Args, s: Setup): Promise<number> {
  // Without a terminal the confirmation takes its default, No, so only --yes removes anything.
  const asking = new TtyPrompter({
    interactive: isTTY(s.stdin),
    input: s.stdin,
    output: s.stdout,
    env: s.environ,
  })
  try {
    await s.offboard(home(args.home, s), asking, {
      yes: args.yes,
      deleteCompany: args["delete-company"],
      host: s.host,
      environ: s.environ,
    })
  } catch (error) {
    if (error instanceof OffboardError || error instanceof OnboardError) {
      const declined = error instanceof Declined && !asking.interactive
      const hint = declined ? "; there's no terminal to ask on, so pass --yes to remove it" : ""
      s.stderr.write(`opencorp offboard: ${error.message}${hint}\n`)
      return 1
    }
    if (error instanceof KeyboardInterrupt) {
      s.stderr.write("\n")
      return 130
    }
    throw error
  }
  return 0
}

async function doctorCommand(args: Args, s: Setup): Promise<number> {
  const found = await checks(home(args.home, s), { ...s.doctor, host: s.host, environ: s.environ })
  s.stdout.write(report(found))
  return exitCode(found)
}

/** Starts the office with `how` (`service.start` or `service.restart`) and waits for it to answer; says why on
 *  stderr when it didn't come up. */
async function cameUp(
  run: Launch,
  s: Setup,
  how: (run: Launch, host: Host) => Promise<service.Installed>,
): Promise<boolean> {
  try {
    const started = await how(run, s.host)
    for (const note of started.notes) {
      s.stderr.write(`opencorp: ${note}; started the office in the background instead\n`)
    }
    await service.wait(run, s.host)
  } catch (error) {
    if (!(error instanceof ServiceError || error instanceof OfficeStartError)) throw error
    s.stderr.write(`opencorp: ${error.message}\n`)
    return false
  }
  return true
}

/**
 * Says on stderr what needs a look about HQ on the office at `officeHome`: its socket or web port not listening (a
 * taken port never stops the office, so nothing else would say so), and HQ's own warnings. Says nothing when GET /hq
 * can't be read, as without this device's identity; doctor says more.
 */
async function reportHq(officeHome: string, s: Setup): Promise<void> {
  try {
    const run = launch(officeHome, { environ: s.environ, userHome: s.host.userHome })
    const status = await (s.doctor.hq ?? hqStatus)(run.socket, await readIdentity(identityPath(run.home)))
    if (typeof status === "string") return
    const port = hqPortChecks(status, path.join(run.home, "office")).filter((c) => c.status === "warn")
    for (const detail of [...port.map((c) => c.detail), ...(status.warnings ?? [])])
      s.stderr.write(`opencorp: HQ: ${detail}\n`)
  } catch {
    // Only a report: the office is up, which is what the command did.
  }
}

/** Whether the office's socket at `run`'s home is too long to bind; says so on stderr. */
function socketTooLong(run: Launch, s: Setup): boolean {
  try {
    checkSocket(run.socket)
  } catch (error) {
    if (!(error instanceof OnboardError)) throw error
    s.stderr.write(`opencorp: ${error.message}\n`)
    return true
  }
  return false
}

/** The exit code when the office at `run`'s home can't start yet, saying why on stderr, or null when it can. */
async function notOnboarded(run: Launch, s: Setup): Promise<number | null> {
  const company = path.join(run.home, "company")
  const state = await companyState(company)
  if (state.kind === "damaged") {
    s.stderr.write(`opencorp: ${damageMessage(company, state)}\n`)
    return 1
  }
  if (state.kind !== "ok") {
    s.stderr.write(`opencorp: no office at ${run.home} yet; ${SET_UP}\n`)
    return NOT_ONBOARDED
  }
  // init and onboard always make the office dir and offboard removes it, while an identity is legitimately
  // missing (no device, or onboarded without a terminal), so the dir is what says this home is onboarded.
  if (!lexists(run.office)) {
    s.stderr.write(`opencorp: ${run.home} has a company but no office yet; run \`opencorp onboard\` to set it up\n`)
    return NOT_ONBOARDED
  }
  return null
}

async function startCommand(args: Args, s: Setup): Promise<number> {
  const run = launch(home(args.home, s), { environ: s.environ, userHome: s.host.userHome })
  if (socketTooLong(run, s)) return 1
  if (await s.host.answers(run.socket)) {
    s.stdout.write(`The office is already running (pid ${service.pid(run)}).\n`)
    await reportHq(run.home, s)
    return 0
  }
  const refused = await notOnboarded(run, s)
  if (refused !== null) return refused
  if (!(await cameUp(run, s, service.start))) return 1
  s.stdout.write(`Started the office (pid ${service.pid(run)}).\n`)
  await reportHq(run.home, s)
  return 0
}

async function restartCommand(args: Args, s: Setup): Promise<number> {
  const run = launch(home(args.home, s), { environ: s.environ, userHome: s.host.userHome })
  if (socketTooLong(run, s)) return 1
  const refused = await notOnboarded(run, s)
  if (refused !== null) return refused
  const was = (await s.host.answers(run.socket)) ? service.pid(run) : null
  if (!(await cameUp(run, s, service.restart))) return 1
  if (was === null) s.stdout.write(`The office wasn't running; started it (pid ${service.pid(run)}).\n`)
  else s.stdout.write(`Restarted the office (pid ${service.pid(run)}; was ${was}).\n`)
  await reportHq(run.home, s)
  return 0
}
