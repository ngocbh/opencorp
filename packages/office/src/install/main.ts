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
import { repr } from "../perm/redact.ts"
import { type CheckOptions, checks, exitCode, report } from "./doctor.ts"
import { init } from "./init.ts"
import type { TextOut } from "./json_prompts.ts"
import { defaultHost, type Env, type Host } from "./launch.ts"
import { offboard } from "./offboard.ts"
import { LISTERS, type Listers, type ModelCheck, modelProblem, onboard } from "./onboard.ts"
import * as service from "./service.ts"

/** The exit code of `start` and `restart` when there's no office yet. */
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
  service?: string
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
    help: "read the office's setup connection from stdin, replacing it; ask nothing",
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

/** The help of `command`, or of `opencorp install` itself, laid out as argparse lays it out. */
function help(command?: string): string {
  const line = (names: string, text: string) =>
    names.length <= 20 ? `  ${names.padEnd(22)}${text}\n` : `  ${names}\n${" ".repeat(24)}${text}\n`
  if (command === undefined) {
    const lines = Object.entries(COMMANDS).map(([name, c]) => line(`  ${name}`, c.about))
    return `${usage()}\npositional arguments:\n  {${Object.keys(COMMANDS).join(",")}}\n${lines.join("")}`
  }
  const { about, flags } = COMMANDS[command]!
  const lines = Object.entries(flags).flatMap(([name, flag]) => (flag.help ? [line(shown(name, flag), flag.help)] : []))
  return `${usage(command)}\n${about}\n\noptions:\n${lines.join("")}`
}

/** Says on stderr how `command` (or `opencorp install`) is used and what was wrong; exit code 2. */
function usageError(s: Setup, message: string, command?: string): number {
  s.stderr.write(`${usage(command)}opencorp install${command ? ` ${command}` : ""}: error: ${message}\n`)
  return 2
}

/** The flags in `argv` for `command`, or a usage error's message. */
function parse(command: string, argv: string[]): Args | string {
  const options: Record<string, { type: "string" | "boolean"; short?: string; default?: string }> = {}
  for (const [name, { type, short, default: value }] of Object.entries(COMMANDS[command]!.flags)) {
    options[name] = { type, ...(short ? { short } : {}), ...(value !== undefined ? { default: value } : {}) }
  }
  let parsed
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true })
  } catch (error) {
    if (String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS_")) return (error as Error).message
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

async function initCommand(_args: Args, _s: Setup): Promise<number> {
  return 0
}

async function onboardCommand(_args: Args, _s: Setup): Promise<number> {
  return 0
}

async function offboardCommand(_args: Args, _s: Setup): Promise<number> {
  return 0
}

/** The home to use: `--home`, else `$OPENCORP_HOME` (empty is unset), else `~/.opencorp`; resolved by each
 *  command through `launch`. */
function home(value: string | undefined, s: Setup): string {
  return value || s.environ.OPENCORP_HOME || path.join(s.host.userHome, ".opencorp")
}

async function doctorCommand(args: Args, s: Setup): Promise<number> {
  const found = await checks(home(args.home, s), { ...s.doctor, host: s.host, environ: s.environ })
  s.stdout.write(report(found))
  return exitCode(found)
}

async function startCommand(_args: Args, _s: Setup): Promise<number> {
  return 0
}

async function restartCommand(_args: Args, _s: Setup): Promise<number> {
  return 0
}
