// `opencorp`: the OpenCorp command line. Each command lives in its own file under commands/ and
// is loaded only when it runs, so `opencorp doctor` never loads the TUI.
//
// The internal modes come first and load only the office: a sandboxed __fs-helper, a __worker,
// the daemon or the setup commands (`install`) never load a command or the TUI. ESM runs static
// imports before any statement, so this file has none (test/entry.test.ts checks).
const internal = import.meta.main && (process.argv[2] === "__fs-helper" || process.argv[2] === "__worker" || process.argv[2] === "daemon" || process.argv[2] === "install")
if (internal) process.exitCode = await (await import("@opencorp/office")).officeMain(process.argv.slice(2))

// In the compiled binary (its bundle's URL has no `.ts`), OpenTUI loads its native library and
// assets from the install, never from a copy Bun would extract to a predictable $TMPDIR path that
// any same-user process could swap before it is loaded.
if (!internal && !import.meta.url.endsWith(".ts")) {
  const { dirname, join } = await import("node:path")
  process.env.OTUI_ASSET_ROOT = join(dirname(process.execPath), "..", "assets")
}

/** A command's entry point: takes the arguments after its name, resolves to an exit code. */
export type CommandRun = (argv: string[]) => Promise<number>

/** Every command, by name, with the arguments the help shows after it. The first is the default when `opencorp` gets
 *  no command name. */
export const commands: Record<string, { args?: string; summary: string; load: () => Promise<{ run: CommandRun }> }> = {
  tui: {
    args: "[options]",
    summary: "Talk to a person in this folder (the default)",
    load: () => import("./commands/tui"),
  },
  end: { args: "[SESSION_ID]", summary: "End a session", load: () => import("./commands/end") },
  profile: {
    args: "edit PERSON",
    summary: "Edit a person's profile in $EDITOR",
    load: () => import("./commands/profile"),
  },
  login: { summary: "Log this device in, with your password if you have one", load: () => import("./commands/login") },
  password: {
    summary: "Set your password, which logging in a new device asks for",
    load: () => import("./commands/password"),
  },
  logout: { summary: "Remove this device from the office and forget it", load: () => import("./commands/logout") },
  devices: { summary: "List, add or remove a person's devices", load: () => import("./commands/devices") },
  whoami: { summary: "Show who this device acts as", load: () => import("./commands/whoami") },
  hq: { summary: "Open HQ in a browser, here or from another machine over SSH", load: () => import("./commands/hq") },
  init: { summary: "Create the company, then set up this office", load: () => import("./commands/init") },
  onboard: { summary: "Set up this office for an existing company", load: () => import("./commands/onboard") },
  offboard: { summary: "Remove this office from this machine", load: () => import("./commands/offboard") },
  start: { summary: "Start the office if it isn't running", load: () => import("./commands/start") },
  stop: { summary: "Stop the office (its service stays installed)", load: () => import("./commands/stop") },
  restart: { summary: "Stop the office and start it again", load: () => import("./commands/restart") },
  doctor: { summary: "Check the office, its socket, the sandbox and Codex", load: () => import("./commands/doctor") },
}

const DEFAULT = "tui"

/** `opencorp --help`: every command with its arguments, the TUI's options and the environment they read. */
function help() {
  const named = Object.entries(commands).map(([name, c]) => [c.args ? `${name} ${c.args}` : name, c.summary])
  const width = Math.max(...named.map(([n]) => n.length))
  return [
    "Usage: opencorp [command] [options]",
    "",
    "Commands:",
    ...named.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    "",
    "With no command, or only options, opencorp runs `tui`.",
    "",
    // The same lines as tui's own usage (commands/tui.ts), which this file can't import before it runs.
    "tui options:",
    "  -s, --session ID   resume a session",
    "  -c, --continue     continue the last session in this folder",
    "  --person HANDLE    talk to this person",
    "  --prompt TEXT      send TEXT as the first message",
    "",
    "  -h, --help         show this help",
    "  --version          print opencorp's version",
    "Run `opencorp help COMMAND` for a command's options.",
    "",
    "Environment:",
    "  OPENCORP_HOME  the office home every command uses (default ~/.opencorp); init, onboard, offboard, start,",
    "                 stop, restart and doctor also take --home",
  ].join("\n")
}

/** The command named `name`, or undefined; names `commands` inherits from Object (`constructor`, ...) are none. */
const command = (name: string) => (Object.hasOwn(commands, name) ? commands[name] : undefined)

/** Says `name` is no command and prints the help; returns the usage error's exit code. */
function unknown(name: string): number {
  console.error(`opencorp: unknown command: ${name}\n\n${help()}`)
  return 2
}

/** Runs the command `argv` names (or the default); resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  // `help help` and `help -h` ask for this help, which the checks below print.
  if (first === "help" && rest.length > 0 && !["help", "-h", "--help"].includes(rest[0]!)) {
    const named = command(rest[0]!)
    return named ? (await named.load()).run(["--help"]) : unknown(rest[0]!)
  }
  if (first === "-h" || first === "--help" || first === "help") {
    console.log(help())
    return 0
  }
  if (first === "--version") {
    console.log((await import("../package.json", { with: { type: "json" } })).default.version)
    return 0
  }
  if (first === undefined || first.startsWith("-")) return (await commands[DEFAULT].load()).run(argv)
  const named = command(first)
  if (!named) return unknown(first)
  return (await named.load()).run(rest)
}

if (import.meta.main && !internal) process.exitCode = await main(process.argv.slice(2))
