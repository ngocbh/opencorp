/**
 * The office's entry: the first argument picks the mode. `packages/cli/src/main.ts` hands its
 * internal modes (`__worker`, `__fs-helper`), `daemon` and `install` here before it loads anything
 * else, with the hooks `install` takes.
 */

/** A mode's entry point: takes the arguments after the mode, resolves to an exit code. */
export type ModeMain = (argv: string[]) => Promise<number>

/** What the CLI's entry hands the office's modes; only `install` takes them. `chat` runs init's interview with the TUI
 *  on it, where this terminal can draw it. An `import()` type, as this file has no static imports. */
export type OfficeHooks = Pick<import("./server/commands/main.ts").Setup, "chat">

/** The office daemon, one per home. It exits as soon as `main` returns, so a live handle (a git child, a timer)
 *  can't keep an old daemon running after it released the lock, and at once on a crash. */
export const daemonMain: ModeMain = async (argv) => {
  // A shell's or a service manager's env and cwd never reach the daemon: it re-execs once into the office's
  // (same pid), or exits.
  const pinned = (await import("./runtime/service/launch.ts")).pinDaemon(argv)
  if (pinned !== undefined) process.exit(pinned)
  const daemon = await import("./server/daemon/main.ts")
  daemon.exitOnCrash()
  process.exit(await daemon.main(argv))
}
/** One yian run in its own process, talking to the daemon over fd 3. Its env is a frozen snapshot of this
 *  process's, taken before any worker module loads, so nothing those modules do to `process.env` reaches the run's
 *  settings. */
export const workerMain: ModeMain = async (argv) => {
  const env = Object.freeze({ ...process.env })
  // Each check's module loads only for its own job, so a chat worker loads neither.
  return (await import("./runtime/worker/main.ts")).main(argv, env, {
    check: async (job, jobEnv, signal) => (await import("./models/check.ts")).runCheck(job, jobEnv, signal),
    classify: async (job, jobEnv, signal) =>
      (await import("./runtime/permissions/classifier.ts")).runClassify(job, jobEnv, signal),
  })
}
/** One file operation inside the sandbox. */
export const fsHelperMain: ModeMain = async () => (await import("./runtime/sandbox/fs_helper.ts")).fsHelperMain()
/** The setup commands (init, onboard, offboard, doctor, start, restart), with the CLI's `hooks`. It exits once stdout
 *  and stderr have drained, with 130 on Ctrl-C and 1 for an unexpected error, its stack on stderr. */
export const installMain = async (argv: string[], hooks: OfficeHooks = {}): Promise<number> =>
  (await import("./server/commands/main.ts")).run(argv, { chat: hooks.chat })

const MODES: Record<string, (argv: string[], hooks: OfficeHooks) => Promise<number>> = {
  daemon: daemonMain,
  __worker: workerMain,
  "__fs-helper": fsHelperMain,
  install: installMain,
}

/** Runs the mode `argv[0]` names with the rest, and `hooks` for `install`; resolves to the exit code (2 for an unknown
 *  mode). */
export async function officeMain(argv: string[], hooks: OfficeHooks = {}): Promise<number> {
  const [mode, ...rest] = argv
  const run = mode !== undefined && Object.hasOwn(MODES, mode) ? MODES[mode] : undefined
  if (!run) {
    console.error("opencorp: unknown office mode")
    return 2
  }
  return run(rest, hooks)
}
