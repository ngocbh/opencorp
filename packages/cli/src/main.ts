// `opencorp`: the OpenCorp command line. Each command lives in its own file under commands/ and
// is loaded only when it runs, so `opencorp doctor` never loads the TUI.
//
// The internal modes come first and load only the office: a sandboxed __fs-helper or a __worker
// never loads a command or the TUI. ESM runs static imports before any statement, so this file
// has none (test/entry.test.ts checks).
const internal = import.meta.main && (process.argv[2] === "__fs-helper" || process.argv[2] === "__worker")
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

/** Every command, by name. The first is the default when `opencorp` gets no command name. */
export const commands: Record<string, { summary: string; load: () => Promise<{ run: CommandRun }> }> = {
  tui: { summary: "Talk to a person in this folder (the default)", load: () => import("./commands/tui") },
  end: { summary: "End a session and start its debrief", load: () => import("./commands/end") },
  feedback: { summary: "Give feedback on a person's work", load: () => import("./commands/feedback") },
  profile: { summary: "Edit a person's profile in $EDITOR", load: () => import("./commands/profile") },
  login: { summary: "Log this device in, with your password if you have one", load: () => import("./commands/login") },
  password: {
    summary: "Set your password, which logging in a new device asks for",
    load: () => import("./commands/password"),
  },
  logout: { summary: "Remove this device from the office and forget it", load: () => import("./commands/logout") },
  devices: { summary: "List, add or remove a person's devices", load: () => import("./commands/devices") },
  whoami: { summary: "Show who this device acts as", load: () => import("./commands/whoami") },
  pair: {
    summary: "Print or open a one-time link that signs a browser in to HQ",
    load: () => import("./commands/pair"),
  },
  init: { summary: "Create the company, then set up this office", load: () => import("./commands/init") },
  onboard: { summary: "Set up this office for an existing company", load: () => import("./commands/onboard") },
  offboard: { summary: "Remove this office from this machine", load: () => import("./commands/offboard") },
  start: { summary: "Start the office if it isn't running", load: () => import("./commands/start") },
  restart: { summary: "Stop the office and start it again", load: () => import("./commands/restart") },
  doctor: { summary: "Check the office, its socket, the sandbox and Codex", load: () => import("./commands/doctor") },
}

const DEFAULT = "tui"

function help() {
  const width = Math.max(...Object.keys(commands).map((n) => n.length))
  return [
    "Usage: opencorp [command] [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    "",
    "With no command, or only options, opencorp runs `tui`.",
  ].join("\n")
}

/** Runs the command `argv` names (or the default); resolves to the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (first === "-h" || first === "--help" || first === "help") {
    console.log(help())
    return 0
  }
  if (first === undefined || first.startsWith("-")) return (await commands[DEFAULT].load()).run(argv)
  const command = commands[first]
  if (!command) {
    console.error(`opencorp: unknown command: ${first}\n\n${help()}`)
    return 2
  }
  return (await command.load()).run(rest)
}

if (import.meta.main && !internal) process.exitCode = await main(process.argv.slice(2))
