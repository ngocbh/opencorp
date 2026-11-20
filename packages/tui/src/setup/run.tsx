import { createCliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import type { JSX } from "solid-js"
import { resolve as resolveConfig, TuiConfigProvider } from "../config"
import { KVProvider } from "../context/kv"
import { TuiPathsProvider } from "../context/runtime"
import { ThemeProvider } from "../context/theme"
import { Global } from "../core/global"
import { OpenCorpKeymapProvider, registerOpenCorpBaseKeymap, type OpenTuiKeymap } from "../keymap"
import { destroyRenderer } from "../util/renderer"
import { spawnSetup, type SetupChild } from "./child"
import { SetupScreen } from "./screen"

/** Somewhere to print the transcript and stderr once the screen is gone. */
export interface Writer {
  write(text: string): unknown
}

/** The header's name for the install `argv`: `opencorp <command>`, the command being the argument after `install`;
 *  empty without one. */
export function commandName(argv: string[]): string {
  const at = argv.indexOf("install")
  const name = at < 0 ? undefined : argv[at + 1]
  return name ? `opencorp ${name}` : ""
}

/**
 * Runs the install `argv` in `cwd` with exactly `env` behind the setup screen; resolves to its exit code once the
 * screen is gone and its transcript and stderr are printed.
 */
export async function runSetup(argv: string[], cwd: string, env: Record<string, string>): Promise<number> {
  const child = spawnSetup(argv, cwd, env)
  try {
    return await runSetupWith(child, process.stdout, process.stderr, commandName(argv))
  } catch (e) {
    // A renderer that fails to start must not leave the install waiting on stdin.
    child.close()
    await child.done
    throw e
  }
}

/** The same, for a child already running (tests pass a fake); the header reads `title` and names `command`, such as
 *  `opencorp init`. `exitSignals` are the signals that take the screen down (opentui's own list by default). */
export async function runSetupWith(
  child: SetupChild,
  out: Writer = process.stdout,
  err: Writer = process.stderr,
  command = "",
  { title, exitSignals }: { title?: string; exitSignals?: NodeJS.Signals[] } = {},
): Promise<number> {
  const renderer = await createCliRenderer({
    ...(exitSignals ? { exitSignals } : {}),
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: false,
  })
  let unregister: (() => void) | undefined
  /** Takes the keymap off, then gives the terminal back: the reverse of the order they were set up. Runs once. */
  const release = () => {
    unregister?.()
    unregister = undefined
    // Not once destroyed: destroyRenderer sets the title first, which would write to a terminal the renderer
    // has released.
    if (!renderer.isDestroyed) destroyRenderer(renderer)
  }
  // A process.exit while the screen is up still gives the terminal back.
  process.once("exit", release)
  // opentui logs an uncaught error where the screen hides it and then hangs on "Working…"; instead give the terminal
  // back, show the error and exit non-zero.
  const onFatal = (error: unknown) => {
    release()
    try {
      err.write(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    } catch {}
    process.exit(1)
  }
  process.on("uncaughtException", onFatal)
  process.on("unhandledRejection", onFatal)
  try {
    const keymap = createDefaultOpenTuiKeymap(renderer)
    unregister = registerOpenCorpBaseKeymap(keymap)
    // Emitted at the end of finalizeDestroy, which then releases stdin and stdout synchronously, so code awaiting
    // this runs once another renderer (the office's) can take them.
    const destroyed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()))
    // A signal (the terminal closing, SIGTERM) destroys the renderer without ending the child; without this it
    // would wait on stdin forever.
    renderer.once("destroy", () => child.close())
    const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
    const lines: string[] = []
    if (!renderer.isDestroyed)
      await render(
        () => (
          <Providers mode={mode} keymap={keymap}>
            <SetupScreen child={child} lines={lines} command={command} title={title} />
          </Providers>
        ),
        renderer,
      )
    const code = await child.done
    release()
    await destroyed
    // The terminal leaves the screen only once closed settles; it rejects when the terminal is already gone.
    await renderer.closed.catch(() => {})
    for (const line of lines) out.write(line + "\n")
    const stderr = child.stderr()
    if (stderr) err.write(stderr)
    return code
  } finally {
    process.off("exit", release)
    process.off("uncaughtException", onFatal)
    process.off("unhandledRejection", onFatal)
    // Gives the terminal back even when something above threw.
    release()
  }
}

/** What the theme, the spinner, the inputs and the question card need, with the same values the app gives them. */
function Providers(props: { mode: "dark" | "light"; keymap: OpenTuiKeymap; children: JSX.Element }) {
  return (
    <TuiPathsProvider
      value={{
        cwd: process.cwd(),
        home: Global.Path.home,
        state: Global.Path.state,
        worktree: Global.Path.data + "/worktree",
      }}
    >
      <KVProvider>
        <OpenCorpKeymapProvider keymap={props.keymap}>
          <TuiConfigProvider config={resolveConfig({}, { terminalSuspend: false })}>
            <ThemeProvider mode={props.mode}>{props.children}</ThemeProvider>
          </TuiConfigProvider>
        </OpenCorpKeymapProvider>
      </KVProvider>
    </TuiPathsProvider>
  )
}
