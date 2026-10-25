/**
 * The office's entry: the first argument picks the mode. `packages/cli/src/main.ts` hands its
 * internal modes (`__worker`, `__fs-helper`), `daemon` and `install` here before it loads anything
 * else.
 */

/** A mode's entry point: takes the arguments after the mode, resolves to an exit code. */
export type ModeMain = (argv: string[]) => Promise<number>

/** The office daemon, one per home. It exits as soon as `main` returns, so a live handle (a git child, a timer)
 *  can't keep an old daemon running after it released the lock, and at once on a crash. */
export const daemonMain: ModeMain = async (argv) => {
  // A shell's or a service manager's env and cwd never reach the daemon: it re-execs once into the office's
  // (same pid), or exits; design §6.5.
  const pinned = (await import("./install/launch.ts")).pinDaemon(argv)
  if (pinned !== undefined) process.exit(pinned)
  const daemon = await import("./daemon/main.ts")
  daemon.exitOnCrash()
  process.exit(await daemon.main(argv))
}
/** One yian run in its own process, talking to the daemon over fd 3. Its env is a frozen snapshot of this
 *  process's, taken before any worker module loads, so nothing those modules do to `process.env` reaches the run's
 *  settings. */
export const workerMain: ModeMain = async (argv) => {
  const env = Object.freeze({ ...process.env })
  return (await import("./worker/main.ts")).main(argv, env)
}
/** One file operation inside the sandbox. */
export const fsHelperMain: ModeMain = async () => (await import("./sandbox/fs_helper.ts")).fsHelperMain()
/** The setup commands (init, onboard, offboard, doctor, start, restart). It exits once stdout and stderr have
 *  drained, with 130 on Ctrl-C and 1 for an unexpected error, its stack on stderr. */
export const installMain: ModeMain = async (argv) => (await import("./install/main.ts")).run(argv)

const MODES: Record<string, ModeMain> = {
  daemon: daemonMain,
  __worker: workerMain,
  "__fs-helper": fsHelperMain,
  install: installMain,
}

/** Runs the mode `argv[0]` names with the rest; resolves to the exit code (2 for an unknown mode). */
export async function officeMain(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv
  const run = mode !== undefined && Object.hasOwn(MODES, mode) ? MODES[mode] : undefined
  if (!run) {
    console.error("opencorp: unknown office mode")
    return 2
  }
  return run(rest)
}
