/** `opencorp hq` from a machine where no office answers: approve the saved path (or learn one with the agent), replay
 *  it, connect to HQ's machine, sign the browser in or open HQ, and hold the connection until Ctrl-C, reconnecting
 *  after a drop. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import type { Readable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { createTwoFilesPatch } from "diff"
import { which } from "../install/launch.ts"
import { LISTERS, type Listers, type ModelCheck, modelProblem } from "../install/onboard.ts"
import { clean, isTTY, KeyboardInterrupt, type Prompter, readLine, TtyPrompter } from "../install/prompts.ts"
import { writePrivate } from "../secrets.ts"
import { classifyCheck, type Connection, connect, describe, ReachFailure, sameHealth, signIn } from "./connect.ts"
import { type Learned, Learning, learnProvider, runLearn } from "./learn.ts"
import { makeDirs, pathProblem, ReachPaths } from "./paths.ts"
import { readScript, runReach, ScriptError } from "./replay.ts"
import {
  cleanOutput,
  defaultIncludes,
  exitAll,
  findSsh,
  isSocket,
  LEARNING_PERSIST_S,
  LIMITS,
  mux,
  quietStdin,
  type ReachContext,
  control,
  startWatcher,
  type Watcher,
  writeSshFiles,
} from "./ssh.ts"
import { BEFORE_LEARNING, LEARN, LEARN_QUESTION, RELEARN_QUESTION } from "./risks.ts"
import { safePath, type Spec } from "./spec.ts"
import {
  type Access,
  cleanUp,
  DEFAULT_PORT,
  readAccess,
  removeAtExpiry,
  sha256,
  sweepRedirects,
  takeLock,
  writeAccess,
  writeRedirect,
} from "./state.ts"

export { DEFAULT_PORT, describe }

/** How a visit was asked for: `--sign-in`, `--port N`, whether it may open a browser, and `--relearn`. */
export interface VisitOptions {
  signIn: boolean
  port?: number
  open: boolean
  relearn?: boolean
}

/** What a visit reads from and does to the machine; tests pass their own. */
export interface VisitDeps {
  home: string
  env: Readonly<Record<string, string | undefined>>
  prompter: Prompter
  stdin: Readable
  print(line: string): void
  error(line: string): void
  /** Children's output for the owner, already cleaned, written as it comes. */
  echo(text: string): void
  /** Opens a file or URL without waiting; throws when the opener can't start. */
  open(target: string): void
  now(): Date
  /** Calls `fn` on each SIGINT until the returned function is called. */
  onSigint(fn: () => void): () => void
  exit(code: number): never
  limits?: ReachContext["limits"]
  /** The `Include`s of `hq/ssh/config`: `defaultIncludes(os.userInfo().homedir)` for real; tests pass their own. */
  sshIncludes: readonly string[]
  /** List deployments and models for the model picker of a first learning run. */
  listers: Listers
  /** Why a provider's model doesn't answer, or null; checked before `hq/provider.json` is saved. */
  checkModel: ModelCheck
}

export const USE = "Use it"
export const STOP = "Stop"
export const RUN_THIS = "Run this reach.sh on every visit?"
export const USE_CHANGED = "Use the changed reach.sh on every visit?"
/** No office answers here: this may be HQ's own machine with its office stopped, so this comes first. */
export const NO_OFFICE_HERE =
  "opencorp hq: no office answers here. If HQ runs on this machine, start it with `opencorp start` (`opencorp doctor` " +
  "says why it's down)."
/** No office answers here, there's no saved path and no terminal to learn one on. */
export const NO_PATH = (paths: ReachPaths) =>
  `${NO_OFFICE_HERE}\nTo reach HQ on another machine, run \`opencorp hq\` in a terminal to learn the way there with an ` +
  `agent, or write ${paths.script}, a sh script whose last line of output is the connection spec (see the README), ` +
  "then run `opencorp hq` again."
export const NOT_LEARNED = "opencorp hq: stopped; nothing was learned."
export const LEARN_NEEDS_TERMINAL = "opencorp hq: learning needs a terminal; run `opencorp hq --relearn` in one."
export const RELEARN_BUSY =
  "opencorp hq: another `opencorp hq` here holds the connection to HQ; end it with Ctrl-C there, then run `opencorp hq --relearn`."
export const CAPPED =
  "opencorp hq: the model stopped after 30 turns without a working path, so nothing was saved. The commands it asked for:"
/** Signed in longer than this, a visit hints at `--sign-in`: HQ's browser session lasts 30 days. */
export const SIGN_IN_HINT_DAYS = 30
export const SIGN_IN_HINT =
  "Your browser's HQ sign-in lasts 30 days and is older; if HQ asks you to sign in, run `opencorp hq --sign-in`."
/** The terminal's Ctrl-C reaches the master too (one foreground group): let a concurrent SIGINT land first. */
export const DROP_SETTLE_MS = 100
export const LOST = "Connection lost; press Enter to reconnect (SSH may ask for Duo)"
export const RUNNING = "opencorp hq: another `opencorp hq` here holds the connection to HQ."
export const BUSY = "opencorp hq: another `opencorp hq` here is still approving or learning a path."
export const NOT_YET =
  "opencorp hq: the `opencorp hq` running here isn't connected yet; run `opencorp hq --sign-in` again in a moment."

/** What stays open until Ctrl-C, said once connected. */
export function visitLine(conn: Connection): string {
  const through = conn.spec.jump ? ` through ${conn.spec.jump.join(", ")}` : ""
  return `Connected. Until Ctrl-C these stay open: SSH to ${conn.spec.host}${through}, and HQ at http://127.0.0.1:${conn.port}/.`
}

/** The replay, then connect: a replay that isn't `ok` throws as the `ReachFailure` of its outcome. */
export async function reach(ctx: ReachContext, port: number): Promise<Connection> {
  const reached = await runReach(ctx)
  if (reached.outcome !== "ok") throw new ReachFailure(reached.outcome, reached.detail)
  return connect(reached.spec!, port, ctx)
}

/** A visit from a machine where no office answers; resolves to its exit code: 0 for a normal end (Ctrl-C while
 *  connected), 3 for no office there (or here, with no saved path), 130 for Ctrl-C before connecting, 1 for the
 *  rest. With no saved path it offers to learn one with the agent, and goes on with the connection that saved it. */
export async function visit(options: VisitOptions, deps: VisitDeps): Promise<number> {
  const paths = new ReachPaths(deps.home)
  // Before anything is made under hq/: with no saved path this is as likely HQ's own machine, its office stopped.
  const learnFirst = !present(paths.script)
  if (learnFirst) {
    if (!deps.prompter.interactive) {
      deps.error(NO_PATH(paths))
      return 3
    }
    deps.error(NO_OFFICE_HERE)
    // Stop by default: a stray Enter on HQ's own machine, its office stopped, must not start a model run.
    const asked = await askBeforeAnything(deps, () => askToLearn(deps, LEARN_QUESTION, STOP))
    if (asked !== true) {
      if (asked === false) deps.error(NOT_LEARNED)
      return asked === false ? 3 : 130
    }
  } else if (options.relearn && !deps.prompter.interactive) {
    deps.error(LEARN_NEEDS_TERMINAL)
    return 1
  }
  const problem = pathProblem(paths)
  if (problem !== null) {
    deps.error(problem)
    return 1
  }
  try {
    makeDirs(paths)
  } catch (error) {
    deps.error(`opencorp hq: ${messageOf(error)}`)
    return 1
  }
  const ssh = findSsh(deps.env.PATH, paths.bin)
  if (ssh === null) {
    deps.error("opencorp hq: there's no ssh on PATH")
    return 1
  }
  if (!safePath(ssh)) {
    deps.error(`opencorp hq: ssh at ${ssh} can't be used: its path must have only letters, digits and . _ + - /`)
    return 1
  }
  const lock = takeLock(paths)
  if (lock === null) return alreadyRunning(options, deps, paths, ssh)
  using _lock = lock
  const { ctx, off } = start(paths, ssh, deps)
  let watcher: Watcher | undefined
  let port = options.port ?? DEFAULT_PORT
  try {
    await writeSshFiles(paths, ssh, deps.sshIncludes)
    await cleanUp(ctx, deps.now().getTime())
    watcher = startWatcher(ctx)
    if (learnFirst) return await learnAndHold(ctx, deps, { notes: "", script: "", failure: "" }, port, options)
    const saved = await readAccess(paths)
    if (options.relearn) {
      port = options.port ?? saved?.port ?? DEFAULT_PORT
      if (!(await inVisit(ctx, () => askToLearn(deps, RELEARN_QUESTION, LEARN)))) {
        deps.error(NOT_LEARNED)
        return 1
      }
      return await learnAndHold(ctx, deps, { ...lastPath(paths), failure: "" }, port, options)
    }
    const approved = await approve(ctx, deps, saved, options.port)
    if (typeof approved === "number") return approved
    let access = approved
    if (options.port !== undefined && options.port !== access.port)
      access = { ...access, port: options.port, signed_in_at: null }
    port = access.port
    let conn: Connection
    try {
      conn = await reach(ctx, port)
    } catch (error) {
      // Only the first reach offers to relearn, defaulting to Stop: a drop's reconnect never does.
      if (!(error instanceof ReachFailure) || error.kind !== "broken" || ctx.signal?.aborted || !deps.prompter.interactive)
        throw error
      const { line, code } = describe(error, port)
      deps.error(line)
      if (!(await inVisit(ctx, () => askToLearn(deps, RELEARN_QUESTION, STOP)))) return code
      return await learnAndHold(ctx, deps, { ...lastPath(paths), failure: line }, port, options)
    }
    return await hold(ctx, conn, access, options, deps)
  } catch (error) {
    return failed(error, ctx, port, deps)
  } finally {
    off()
    await exitAll(ctx)
    await watcher?.release()
    fs.rmSync(paths.status(process.pid), { force: true })
  }
}

/** Once connected: sign the browser in or open HQ, record the visit, say what stays open, then wait until Ctrl-C. */
async function hold(ctx: ReachContext, conn: Connection, access: Access, options: VisitOptions, deps: VisitDeps): Promise<number> {
  access = await signInOrOpen(ctx, conn, access, options, deps)
  await writeAccess(ctx.paths, { ...access, last_used_at: deps.now().toISOString() })
  deps.print(visitLine(conn))
  return waitLoop(ctx, conn, deps)
}

/** Learns a path, then holds the connection that saved it; the exit code when nothing was saved. */
async function learnAndHold(
  ctx: ReachContext,
  deps: VisitDeps,
  inputs: { notes: string; script: string; failure: string },
  port: number,
  options: VisitOptions,
): Promise<number> {
  const learned = await learnPath(ctx, deps, inputs, port)
  return typeof learned === "number" ? learned : hold(ctx, learned.conn, learned.access, options, deps)
}

/** The most of the old notes.md or reach.sh a relearning run is given. */
export const MAX_OLD_CHARS = 64 * 1024

/** The old notes.md and reach.sh as text for a relearning run, each "" when missing or not a plain file of this
 *  user. */
function lastPath(paths: ReachPaths): { notes: string; script: string } {
  const text = (file: string) => {
    try {
      return (readScript(file) ?? Buffer.alloc(0)).toString("utf8").slice(0, MAX_OLD_CHARS)
    } catch (error) {
      if (error instanceof ScriptError) return ""
      throw error
    }
  }
  return { notes: text(paths.notes), script: text(paths.script) }
}

/** `ask` at a question inside the visit, stopped by its first Ctrl-C, which a numbered list gets as SIGINT rather
 *  than as a key. */
function inVisit<T>(ctx: ReachContext, ask: () => Promise<T>): Promise<T> {
  const signal = ctx.signal!
  return Promise.race([ask(), aborted(signal).then((): never => signal.throwIfAborted() as never)])
}

/** Shows what learning risks, then asks `question` with `fallback` as the default; resolves whether the owner chose
 *  to learn. */
async function askToLearn(deps: VisitDeps, question: string, fallback: string): Promise<boolean> {
  for (const line of BEFORE_LEARNING) deps.prompter.say(clean(line))
  const answer = await deps.prompter.choose(question, [LEARN, STOP], fallback)
  quietStdin(deps.stdin)
  return answer === LEARN
}

/** `ask` before the visit has its context: its own Ctrl-C, which a numbered list gets as SIGINT rather than as a key.
 *  Resolves to what `ask` resolved to, or null on Ctrl-C. */
async function askBeforeAnything<T>(deps: VisitDeps, ask: () => Promise<T>): Promise<T | null> {
  const stop = new AbortController()
  const off = deps.onSigint(() => (stop.signal.aborted ? deps.exit(130) : stop.abort()))
  try {
    return await Promise.race([ask(), aborted(stop.signal).then(() => null)])
  } catch (error) {
    if (error instanceof KeyboardInterrupt) return null
    throw error
  } finally {
    off()
  }
}

/** A learning run with the owner's consent already given: the model from `hq/provider.json` (asked for the first
 *  time), then learn_hq. Resolves to the saved path's record and the connection that tested it, or to the exit code
 *  once it says why nothing was saved. */
async function learnPath(
  ctx: ReachContext,
  deps: VisitDeps,
  inputs: { notes: string; script: string; failure: string },
  port: number,
): Promise<{ access: Access; conn: Connection } | number> {
  const signal = ctx.signal!
  // The second Ctrl-C exits at once; the first stops a model check that may take a minute.
  const checkModel: ModelCheck = async (provider) => {
    const problem = await Promise.race([deps.checkModel(provider), aborted(signal)])
    signal.throwIfAborted()
    return problem as string | null
  }
  const provider = await learnProvider(ctx.paths, deps.prompter, { listers: deps.listers, checkModel })
  quietStdin(deps.stdin)
  const key = provider.llm_config?.api_key
  const state = new Learning(ctx, deps.prompter, deps.stdin, typeof key === "string" && key ? [key] : [], port, deps.now)
  // Masters started while learning keep their ControlPersist; a reconnect's start from the visit's config again.
  await writeSshFiles(ctx.paths, ctx.ssh, deps.sshIncludes, { persist: LEARNING_PERSIST_S })
  let learned: Learned
  try {
    learned = await runLearn(provider, inputs, state)
  } finally {
    await writeSshFiles(ctx.paths, ctx.ssh, deps.sshIncludes)
  }
  // Saved and connected, whatever the model did after.
  if (state.connection !== null) {
    const access = await readAccess(ctx.paths)
    if (access === null) throw new Error(`${ctx.paths.access} went missing after it was saved`)
    return { access, conn: state.connection }
  }
  if (learned.capped) {
    deps.error(CAPPED)
    for (const { command, code } of state.commands) deps.error(`  (${code === null ? "not run" : `exit ${code}`}) ${clean(command)}`)
    return 1
  }
  deps.error(`opencorp hq: nothing was saved: ${clean(learned.message ?? learned.output ?? "the model stopped")}`)
  return 1
}

/** A visit's context, its Ctrl-C (a second one exits 130 at once; the watcher then ends the masters) and the
 *  function that stops listening for it. */
function start(paths: ReachPaths, ssh: string, deps: VisitDeps): { ctx: ReachContext; off: () => void } {
  const stop = new AbortController()
  const off = deps.onSigint(() => (stop.signal.aborted ? deps.exit(130) : stop.abort()))
  const ctx: ReachContext = {
    paths,
    ssh,
    env: deps.env,
    batch: false,
    echo: deps.echo,
    signal: stop.signal,
    limits: deps.limits ?? LIMITS,
  }
  return { ctx, off }
}

/** What a visit that threw `error` says, and its exit code: 130 for Ctrl-C (at a question, too), the failure
 *  table's row for a `ReachFailure`, else 1. */
function failed(error: unknown, ctx: ReachContext, port: number, deps: VisitDeps): number {
  if (ctx.signal?.aborted || error instanceof KeyboardInterrupt) return 130
  if (error instanceof ReachFailure) {
    const { line, code } = describe(error, port)
    deps.error(line)
    return code
  }
  deps.error(`opencorp hq: ${messageOf(error)}`)
  return 1
}

/** The saved path, approved: reach.sh's sha256 must be access.json's. A script the owner wrote or changed is shown
 *  (whole, or diffed against reach.approved.sh) and approved once; resolves to the record, or an exit code. */
async function approve(
  ctx: ReachContext,
  deps: VisitDeps,
  access: Access | null,
  port: number | undefined,
): Promise<Access | number> {
  const { paths } = ctx
  let now: Buffer | null
  try {
    now = readScript(paths.script)
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error
    deps.error(`opencorp hq: ${error.message}`)
    return 1
  }
  if (now === null) {
    deps.error(NO_PATH(paths))
    return 3
  }
  const digest = sha256(now)
  if (access !== null && access.sha256 === digest) return access
  const before = access === null ? null : approvedCopy(paths, access)
  const say = (line: string) => deps.prompter.say(clean(line))
  let question: string
  if (before === null) {
    if (access === null) say(`${paths.script} is new. It runs on this machine with your SSH keys on every visit:`)
    else
      say(
        `${paths.script} changed, and ${paths.approved} isn't the copy you approved, so here it is whole. ` +
          "It runs on this machine with your SSH keys on every visit:",
      )
    for (const line of now.toString("utf8").replace(/\n$/, "").split("\n")) say(`  ${line}`)
    question = RUN_THIS
  } else {
    say(`${paths.script} changed since you approved it:`)
    const patch = createTwoFilesPatch("reach.approved.sh", "reach.sh", before.toString("utf8"), now.toString("utf8"))
    for (const line of patch.replace(/\n$/, "").split("\n")) say(line)
    question = USE_CHANGED
  }
  if (!deps.prompter.interactive) {
    deps.error("opencorp hq: reach.sh isn't approved, and there's no terminal to ask; run `opencorp hq` in one.")
    return 1
  }
  // A numbered list reads a line, so Ctrl-C arrives as SIGINT, not as a key: stop at the first.
  const answer = await Promise.race([
    deps.prompter.choose(question, [USE, STOP], STOP),
    aborted(ctx.signal!).then(() => ctx.signal!.throwIfAborted()),
  ])
  quietStdin(deps.stdin)
  if (answer !== USE) {
    deps.error("opencorp hq: stopped; reach.sh isn't approved.")
    return 1
  }
  await writePrivate(paths.approved, now)
  const record: Access = {
    port: access?.port ?? port ?? DEFAULT_PORT,
    sha256: digest,
    learned_at: deps.now().toISOString(),
    last_used_at: access?.last_used_at ?? null,
    signed_in_at: access?.signed_in_at ?? null,
  }
  await writeAccess(paths, record)
  return record
}

/** reach.approved.sh when it's the copy `access` approved, else null: a diff against any other base could hide a
 *  line. */
function approvedCopy(paths: ReachPaths, access: Access): Buffer | null {
  try {
    const bytes = readScript(paths.approved)
    return bytes !== null && sha256(bytes) === access.sha256 ? bytes : null
  } catch (error) {
    if (error instanceof ScriptError) return null
    throw error
  }
}

/** Signs the browser in (the first time, or with `--sign-in`) through a redirect file, or opens HQ's URL; without
 *  opening, prints the link or the URL. Resolves to the record with `signed_in_at` set when it signed in. */
async function signInOrOpen(
  ctx: ReachContext,
  conn: Connection,
  access: Access,
  options: VisitOptions,
  deps: VisitDeps,
): Promise<Access> {
  if (options.signIn || access.signed_in_at === null) {
    await signBrowserIn(ctx, conn.spec, conn.port, options.open, deps, { removeAtExpiry: true })
    return { ...access, signed_in_at: deps.now().toISOString() }
  }
  openOrPrint(`http://127.0.0.1:${conn.port}/`, options.open, deps)
  const since = deps.now().getTime() - Date.parse(access.signed_in_at)
  if (since > SIGN_IN_HINT_DAYS * 24 * 60 * 60_000) deps.print(SIGN_IN_HINT)
  return access
}

/** Mints a code over the master and opens it through a 0600 redirect file, or prints the link. */
async function signBrowserIn(
  ctx: ReachContext,
  spec: Spec,
  port: number,
  open: boolean,
  deps: VisitDeps,
  o: { removeAtExpiry: boolean },
): Promise<void> {
  const code = await signIn(ctx, spec)
  const link = `http://127.0.0.1:${port}/pair#${code}`
  if (!open) {
    deps.print(link)
    return
  }
  const file = await writeRedirect(ctx.paths, port, code)
  if (o.removeAtExpiry) removeAtExpiry(file)
  try {
    // argv holds only the file's path; the file (0600, in the hq folder) holds the code.
    deps.open(file)
  } catch (error) {
    deps.error(`opencorp hq: couldn't open a browser (${messageOf(error)}); open this link:`)
    deps.print(link)
  }
}

/** Opens `url`, or prints it without opening or when the opener can't start. */
function openOrPrint(url: string, open: boolean, deps: VisitDeps): void {
  if (!open) {
    deps.print(url)
    return
  }
  try {
    deps.open(url)
  } catch (error) {
    deps.error(`opencorp hq: couldn't open a browser (${messageOf(error)}); open:`)
    deps.print(url)
  }
}

/** Another `opencorp hq` holds the lock: open HQ's URL. With `--sign-in` and its master up, replay reach.sh for the
 *  spec (it rides the login master, so no Duo), check HQ over that master and through the recorded port, and only
 *  then mint over the master. No ssh files, clean-up or watcher: they're the running visit's. */
async function alreadyRunning(options: VisitOptions, deps: VisitDeps, paths: ReachPaths, ssh: string): Promise<number> {
  if (options.relearn) {
    deps.error(RELEARN_BUSY)
    return 1
  }
  let access: Access | null
  try {
    access = await readAccess(paths)
  } catch (error) {
    deps.error(`opencorp hq: ${messageOf(error)}`)
    return 1
  }
  if (access === null) {
    deps.error(BUSY)
    return 1
  }
  if (!options.signIn) {
    deps.error(RUNNING)
    openOrPrint(`http://127.0.0.1:${access.port}/`, options.open, deps)
    return 0
  }
  const { ctx, off } = start(paths, ssh, deps)
  try {
    if (!isSocket(paths.node) || (await control(ctx, paths.node, "check")).code !== 0) {
      deps.error(NOT_YET)
      return 1
    }
    const reached = await runReach(ctx)
    if (reached.outcome !== "ok") throw new ReachFailure(reached.outcome, reached.detail)
    const spec = reached.spec!
    // The running visit may not have forwarded the port yet, or may be moving it (`--port`): a code goes only to a
    // port where HQ answers as its check says, steps b and d.
    const status = classifyCheck(await mux(ctx, spec, ["hq", "--check", "--json"]))
    try {
      await sameHealth(access.port, status, ctx.limits.stepMs)
    } catch (error) {
      if (!(error instanceof ReachFailure) || ctx.signal?.aborted) throw error
      deps.error(NOT_YET)
      return 1
    }
    // The running visit's sweep deletes the file once it expires: this process ends first.
    await signBrowserIn(ctx, spec, access.port, options.open, deps, { removeAtExpiry: false })
    const now = (await readAccess(paths)) ?? access
    await writeAccess(paths, { ...now, signed_in_at: deps.now().toISOString() })
    return 0
  } catch (error) {
    return failed(error, ctx, access.port, deps)
  } finally {
    off()
    fs.rmSync(paths.status(process.pid), { force: true })
  }
}

/** Waits until Ctrl-C, reconnecting after each drop; sweeps expired redirect files once a minute. */
async function waitLoop(ctx: ReachContext, conn: Connection, deps: VisitDeps): Promise<number> {
  const signal = ctx.signal!
  const sweep = setInterval(() => sweepRedirects(ctx.paths, deps.now().getTime()), 60_000)
  sweep.unref()
  try {
    for (;;) {
      const why = await Promise.race([conn.master.exited.then(() => "drop" as const), aborted(signal)])
      if (why === "drop") await sleep(DROP_SETTLE_MS)
      if (signal.aborted) return 0
      const again = await reconnect(ctx, conn.port, deps)
      if (again === null) return signal.aborted ? 0 : 1
      conn = again
      deps.print(visitLine(conn))
    }
  } finally {
    clearInterval(sweep)
  }
}

/** After a drop: close our masters, try once quietly in BatchMode (it fails at once where a login needs Duo), then
 *  reconnect each time the owner presses Enter; Enters typed before the prompt don't count. A failed retry has
 *  ended only the node master (`connect` does that), so the next rides the login master without a new Duo. Never
 *  offers relearning. Null when stdin ends or on Ctrl-C. */
async function reconnect(ctx: ReachContext, port: number, deps: VisitDeps): Promise<Connection | null> {
  await exitAll(ctx)
  try {
    return await reach({ ...ctx, batch: true, echo: () => {} }, port)
  } catch {
    await exitAll(ctx)
  }
  const signal = ctx.signal!
  for (;;) {
    if (signal.aborted) return null
    await drain(deps.stdin)
    deps.error(LOST)
    if ((await lineOrStop(deps.stdin, signal)) === undefined) return null
    quietStdin(deps.stdin)
    try {
      return await reach(ctx, port)
    } catch (error) {
      if (signal.aborted) return null
      deps.error(error instanceof ReachFailure ? describe(error, port).line : `opencorp hq: ${messageOf(error)}`)
    }
  }
}

/** How long `drain` reads what's waiting on stdin. */
export const DRAIN_INPUT_MS = 50

/** Discards what's waiting on `stdin` (buffered here, or typed into the terminal while nothing read it), then pauses
 *  it again. */
async function drain(stdin: Readable): Promise<void> {
  if (stdin.readableEnded || stdin.destroyed) return
  const discard = () => {}
  stdin.on("data", discard)
  stdin.resume()
  await sleep(DRAIN_INPUT_MS)
  stdin.off("data", discard)
  stdin.pause()
}

/** A line from `stdin`, or undefined once it ends or `signal` aborts (then stdin is paused). */
async function lineOrStop(stdin: Readable, signal: AbortSignal): Promise<string | undefined> {
  const line = await Promise.race([readLine(stdin).catch(() => undefined), aborted(signal).then(() => undefined)])
  if (signal.aborted) stdin.pause()
  return line
}

/** Whether anything, a dangling link included, is at `file`. */
function present(file: string): boolean {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch {
    // A file where a folder on its path should be.
    return false
  }
}

/** Resolves "stop" once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<"stop"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("stop")
    else signal.addEventListener("abort", () => resolve("stop"), { once: true })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The program that opens a file or URL in the browser here. */
export const opener = (platform: string) => (platform === "darwin" ? "open" : "xdg-open")

/** This process's terminal, signals and clock. Questions and children's output go to stderr, so stdout holds only
 *  links and the visit line; the ssh config includes the passwd entry's `~/.ssh/config`, where ssh's own `~` points. */
export function realVisitDeps(home: string): VisitDeps {
  return {
    home,
    env: process.env,
    prompter: new TtyPrompter({
      interactive: isTTY(process.stdin),
      input: process.stdin,
      output: process.stderr,
      env: process.env,
    }),
    stdin: process.stdin,
    print: (line) => void process.stdout.write(`${line}\n`),
    error: (line) => void process.stderr.write(`${line}\n`),
    echo: (text) => void process.stderr.write(cleanOutput(text)),
    open: (target) => {
      const program = opener(process.platform)
      const file = which(program, process.env.PATH)
      if (file === null) throw new Error(`there's no ${program} on PATH`)
      // Detached, its output discarded: xdg-open may block without a display.
      const child = spawn(file, [target], { stdio: "ignore", detached: true })
      child.on("error", () => {})
      child.unref()
    },
    now: () => new Date(),
    onSigint: (fn) => {
      process.on("SIGINT", fn)
      return () => void process.off("SIGINT", fn)
    },
    exit: (code) => process.exit(code),
    sshIncludes: defaultIncludes(os.userInfo().homedir),
    listers: LISTERS,
    checkModel: (provider) => modelProblem(provider),
  }
}
