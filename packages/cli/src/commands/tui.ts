import fs from "node:fs"
import { parseArgs } from "node:util"
import { createOfficeClient, UnknownDevice } from "@opencorp/client"
import { defaultSocket, type Env } from "@opencorp/client/node"
import { tuiAssetRoot } from "@opencorp/office/platform"
import { withTuiHome } from "../chat"
import type { CommandRun } from "../main"
import { localIdentity, officeDown, officeNotRunning } from "../office"
import { terminal } from "../setup"

/** What `opencorp tui --help` prints; `opencorp --help` repeats the option lines. */
export const TUI_USAGE = [
  "usage: opencorp [tui] [-s ID] [-c] [--person HANDLE] [--prompt TEXT]",
  "  -s, --session ID   resume a session",
  "  -c, --continue     continue the last session in this folder",
  "  --person HANDLE    talk to this person",
  "  --prompt TEXT      send TEXT as the first message",
].join("\n")

/** The TUI's args from `opencorp`'s flags: `-s/--session ID`, `-c/--continue`, `--person HANDLE`, `--prompt TEXT`;
 *  `help` when `-h/--help` asks for the usage instead. */
export function parseTuiArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string", short: "s" },
      continue: { type: "boolean", short: "c" },
      person: { type: "string" },
      prompt: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  return {
    ...(values.help && { help: true }),
    ...(values.session !== undefined && { sessionID: values.session }),
    ...(values.continue && { continue: true }),
    ...(values.person !== undefined && { person: values.person }),
    ...(values.prompt !== undefined && { prompt: values.prompt }),
  }
}

/** Whether `p` is a folder this process can list and enter; a missing path, a file, a symlink loop or a folder
 *  without read or search permission is not. */
function isFolder(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK)
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** What `tui` checks before it starts; tests pass fakes. */
export type TuiDeps = {
  /** Whether the TUI can draw here. */
  terminal(): boolean
  /** The compiled binary's folder OpenTUI loads its native library and assets from; null in a checkout. */
  assetRoot(): string | null
}

export const realTuiDeps: TuiDeps = {
  terminal,
  // The folder main.ts gives OpenTUI, worked out as the doctor does; never the caller's OTUI_ASSET_ROOT.
  assetRoot: tuiAssetRoot,
}

/**
 * `opencorp [tui]`: opens the TUI on this folder, for the office at `env`'s home. Refuses, in one line and before it
 * asks the office anything, when the assets folder is missing or there's no terminal to draw on, so `--prompt` without
 * a terminal sends nothing.
 */
export async function tui(argv: string[], env: Env, deps: TuiDeps = realTuiDeps): Promise<number> {
  let parsed
  try {
    parsed = parseTuiArgs(argv)
  } catch (e) {
    console.error(`opencorp: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const { help, ...args } = parsed
  if (help) {
    console.log(TUI_USAGE)
    return 0
  }
  // A binary copied without the assets beside it: OpenTUI would throw into Bun's crash printer.
  const assets = deps.assetRoot()
  if (assets !== null && !isFolder(assets)) {
    console.error(
      `opencorp: this binary's assets folder (${assets}) is missing or unreadable; reinstall opencorp, ` +
        "or keep bin/ and assets/ together",
    )
    return 1
  }
  // Without one, the TUI would draw into a pipe and never exit.
  if (!deps.terminal()) {
    console.error("opencorp: the TUI needs a terminal (stdin and stdout a TTY, TERM set and not dumb)")
    return 1
  }
  const socket = defaultSocket(env)
  // Asked before the TUI loads, so no office is one line, not a TUI waiting on the socket.
  const down = await officeDown(socket)
  if (down) return officeNotRunning(down, env)
  const token = localIdentity(env)?.token
  // Likewise a device the office refuses: one line, not a TUI that can't load anything. Who the office takes this
  // TUI as goes to it: only a session's approver is asked to type a shell's password.
  let person: string | undefined
  try {
    person = (await createOfficeClient({ socket, token }).whoami()).person
  } catch (e) {
    // Any other failure, the TUI shows as it would have without this check.
    if (e instanceof UnknownDevice) {
      console.error(`opencorp: ${e.message}`)
      return 1
    }
  }
  // The TUI is Solid JSX: from source the transform must be registered before its modules load, and a bunfig preload
  // would only apply when `opencorp` runs from this package's folder. The compiled binary's bundle (its URL has no
  // `.ts`) was transformed when it was built.
  if (import.meta.url.endsWith(".ts")) (await import("@opentui/solid/bun-plugin")).ensureSolidTransformPlugin()
  const [{ Effect }, { Global, run: runTui }] = await Promise.all([
    import("effect"),
    import("@opencorp/tui"),
  ])
  // The TUI keeps its state under `env`'s home: the office that opens after `opencorp init --home H` is H's.
  await withTuiHome(env.OPENCORP_HOME, () =>
    Effect.runPromise(runTui({ socket, token, person, cwd: process.cwd(), args }).pipe(Effect.provide(Global.layer))),
  )
  return typeof process.exitCode === "number" ? process.exitCode : 0
}

export const run: CommandRun = (argv, env) => tui(argv, env)
