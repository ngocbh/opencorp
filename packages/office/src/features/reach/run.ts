/** `opencorp hq` from a machine where no office answers, and the runs of its flows: approve the saved path (or learn
 *  one in a chat with OpenCorp, learn_hq's agent), replay it with reach_hq, connect to HQ's machine, sign the browser
 *  in or open HQ, and hold the connection until Ctrl-C, reconnecting after a drop. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { createTwoFilesPatch } from "diff"
import { loadFlow, runFlow } from "@ngocbh/yian"
import { type ModelCheck, modelProblem, providerSecrets } from "../../models/check.ts"
import type { Provider } from "../../models/provider.ts"
import { AUTH_FILE_ENV } from "../../models/connections.ts"
import { LISTERS, type Listers, signInRemedy, type SubscriptionAuth } from "../setup/onboard.ts"
import { clean, isTTY, KeyboardInterrupt, type Prompter, readLine, TtyPrompter } from "../setup/prompts.ts"
import { embedded } from "../../platform.ts"
import type { BuiltinChat, BuiltinSession, ChatEnd } from "../../runtime/sessions/builtin.ts"
import type { Terminal } from "../../tools/terminal/terminal.ts"
import { which } from "../../util/env.ts"
import { newId } from "../../util/ids.ts"
import { writePrivate } from "../../util/private_files.ts"
import { redact } from "../../util/redact.ts"
import { workerEnv } from "../../runtime/worker/spawn.ts"
import {
  classifyCheck,
  type Connection,
  connect,
  describe,
  ReachFailure,
  sameHealth,
  signIn,
  withProblems,
} from "./connect.ts"
import { ConnectionShell } from "./connection.ts"
import {
  portShared,
  present,
  removeCm,
  reservePort,
  type Saved,
  savedDestinations,
  socketId,
  sweepTemps,
  unknown,
} from "./destinations.ts"
import { Learning } from "./learning.ts"
import { isTemp, makeDirs, nameProblem, pathProblem, ReachPaths, tempName } from "./paths.ts"
import { learnProvider } from "./provider.ts"
import {
  cleanOutput,
  defaultIncludes,
  exitAll,
  findSsh,
  headChars,
  isSocket,
  LIMITS,
  mux,
  quietStdin,
  type ReachContext,
  readHosts,
  control,
  startWatcher,
  type Watcher,
  wellFormed,
  writeSshFiles,
} from "./ssh.ts"
import { beforeLearning, LEARN, LEARN_QUESTION, RELEARN_QUESTION } from "./risks.ts"
import { sshHome } from "./sandbox.ts"
import { type ConsentAsk, learningTerminal } from "./terminal.ts"
import { lineCount, numberedLines, shownCode } from "../../util/show.ts"
import { safePath, Spec } from "./spec.ts"
import {
  type Access,
  AccessError,
  cleanUp,
  DEFAULT_PORT,
  nextPort,
  readAccess,
  removeAtExpiry,
  sha256,
  sweepRedirects,
  takeLock,
  writeAccess,
  writeRedirect,
} from "./state.ts"
import { type Reached, readScript, Replaying, replayTool, ScriptError } from "./tools/replay.ts"
import { saveAccessTool } from "./tools/save_access.ts"
import learnYaml from "./flows/learn_hq.yaml" with { type: "file" }
import reachYaml from "./flows/reach_hq.yaml" with { type: "file" }

export { DEFAULT_PORT, describe, learnYaml, reachYaml }

/** How a visit was asked for: the destination named, `--sign-in`, `--port N`, whether it may open a browser, and
 *  `--relearn`. */
export interface VisitOptions {
  /** The destination named on the command line. Without one, the visit goes to the one saved, asks which of several,
   *  or learns a first, named after the host it reaches. */
  name?: string
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
  /** The `Include`s of `hq/<name>/ssh/config`: `defaultIncludes` of `sshHome` for real; tests pass their own. */
  sshIncludes: readonly string[]
  /** ssh's home, where the agent's ssh reads `~/.ssh`: the passwd entry's (`sandbox.ts`'s `sshHome`). */
  sshHome: string
  /** List deployments and models for the model picker of a first learning run. */
  listers: Listers
  /** Why a provider's model doesn't answer, or null; checked before `hq/provider.json` is saved, and stopped once
   *  `signal` aborts (the owner's Ctrl-C). */
  checkModel(provider: Provider, signal: AbortSignal): Promise<string | null>
  /** Makes yian's `OpenAIAuth` for the picker's ChatGPT sign-in (the real one by default). */
  auth?: SubscriptionAuth
  /** Where there's a terminal the TUI can draw on: runs learning's session, a chat with OpenCorp, in this process on
   *  the no-office host, with the TUI on it, so the connection the session's save leaves open stays this visit's.
   *  Without it, learning is refused. */
  learnChat?: BuiltinChat<Terminal>
}

export const USE = "Use it"
export const STOP = "Stop"
/** The questions for a reach.sh of `lines` lines: the count shows when it's longer than it looks. */
export const runThis = (lines: number) => `Run this ${lines}-line reach.sh on every visit?`
export const useChanged = (lines: number) => `Use the changed ${lines}-line reach.sh on every visit?`
/** No office answers here: this may be HQ's own machine with its office stopped, so this comes first. */
export const NO_OFFICE_HERE =
  "opencorp hq: no office answers here. If HQ runs on this machine, start it with `opencorp start` (`opencorp doctor` " +
  "says why it's down)."
/** No office answers here, there's no saved destination and no terminal to learn one on; `root` is the hq folder. */
export const NO_PATH = (root: string) =>
  `${NO_OFFICE_HERE}\nTo reach HQ on another machine, run \`opencorp hq\` in a terminal to learn the way there with an ` +
  `agent, or write ${path.join(root, "NAME", "reach.sh")}, a sh script whose last line of output is the connection ` +
  "spec (see https://opencorp.readthedocs.io/hq/#hq-from-another-machine), then run `opencorp hq NAME`."
/** No office answers here, several destinations are saved, and there's no terminal to ask which. */
export const SEVERAL = (saved: readonly Saved[]) =>
  `opencorp hq: no office answers here, and several destinations are saved: ${saved.map((s) => s.paths.name).join(", ")}. ` +
  "Run `opencorp hq NAME` for one."
/** Asked when no office answers here and several destinations are saved. */
export const WHICH = "Which HQ do you want to open?"
/** Said for `dir`, a folder in hq under a destination's name that holds no reach.sh. */
export const NOT_A_DESTINATION = (dir: string) =>
  `opencorp hq: ${dir} holds no reach.sh, so it isn't a destination and no path can be saved under its name; move it ` +
  "aside, or write its reach.sh."
/** Said before offering to learn the path to `name`, which isn't saved. */
export const NOT_SAVED_YET = (name: string) => `opencorp hq: there's no saved path to ${name} yet.`
export const NOT_LEARNED = "opencorp hq: stopped; nothing was learned."
export const LEARN_NEEDS_TERMINAL = "opencorp hq: learning needs a terminal the TUI can draw on"
export const RELEARN_BUSY = (paths: ReachPaths) =>
  `opencorp hq: another \`opencorp hq\` here holds the connection to HQ; end it with Ctrl-C there, then run \`${paths.command} --relearn\`.`
export const NOT_SAVED = "opencorp hq: learning ended, and nothing was saved."
/** Learning's session failed: why, as its run said it. */
export const LEARNING_FAILED = (why: string) => `opencorp hq: learning failed: ${why}`
export const ASKED_FOR = "The commands the agent ran:"
/** The owner's first message in learning's chat: their choice to learn. */
export const LEARN_FIRST = "Learn how this machine reaches HQ"
/** Signed in longer than this, a visit hints at `--sign-in`: HQ's browser session lasts 30 days. */
export const SIGN_IN_HINT_DAYS = 30
export const SIGN_IN_HINT = (paths: ReachPaths) =>
  `Your browser's HQ sign-in lasts 30 days and is older; if HQ asks you to sign in, run \`${paths.command} --sign-in\`.`
/** The terminal's Ctrl-C reaches the master too (one foreground group): let a concurrent SIGINT land first. */
export const DROP_SETTLE_MS = 100
export const LOST = "Connection lost; press Enter to reconnect (SSH may ask for Duo)"
export const RUNNING = "opencorp hq: another `opencorp hq` here holds the connection to HQ."
export const BUSY = "opencorp hq: another `opencorp hq` here is still approving or learning a path."
export const NOT_YET = (paths: ReachPaths) =>
  `opencorp hq: the \`opencorp hq\` running here isn't connected yet; run \`${paths.command} --sign-in\` again in a moment.`

/** What stays open until Ctrl-C, said once connected. */
export function visitLine(conn: Connection): string {
  const through = conn.spec.jump ? ` through ${conn.spec.jump.join(", ")}` : ""
  return `Connected. Until Ctrl-C these stay open: SSH to ${conn.spec.host}${through}, and HQ at http://127.0.0.1:${conn.port}/.`
}

/** The replay, then connect. */
export async function reach(ctx: ReachContext, port: number): Promise<Connection> {
  return connect(await replayed(ctx), port, ctx)
}

/** The spec a replay printed. A replay that isn't `ok` throws as the `ReachFailure` of its outcome, naming what the
 *  owner's ssh config sets, for the hosts reach.sh's ssh named, that a visit can't work with. */
async function replayed(ctx: ReachContext): Promise<Spec> {
  const reached = await runReach(ctx)
  if (reached.outcome === "ok") return reached.spec!
  const failure = new ReachFailure(reached.outcome, reached.detail)
  throw await withProblems(ctx, failure, readHosts(ctx))
}

/** Runs reach_hq with no `llmConfig` and no provider: one TOOL node, so yian resolves no model. */
export async function runReach(ctx: ReachContext): Promise<Reached> {
  const flow = await loadFlow(embedded(reachYaml).toString("utf8"), { sourceLabel: "features/reach/flows/reach_hq.yaml" })
  const vars = workerEnv(ctx.env)
  const result = await runFlow(
    flow,
    {},
    {
      tools: { replay_access: replayTool },
      numWorkers: 0,
      context: new Replaying(ctx),
      signal: ctx.signal,
      env: (name) => (Object.hasOwn(vars, name) ? vars[name] : undefined),
    },
  )
  if (result.status !== "succeeded") return { outcome: "broken", detail: result.failure?.message ?? "the replay failed" }
  const out = result.output as Reached
  return out.outcome === "ok" ? { ...out, spec: Spec.parse(numbers(out.spec)) } : out
}

/** `value` with yian's ints, which a run hands back as bigints, as numbers; `Spec` then checks their range. */
function numbers(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value)
  if (Array.isArray(value)) return value.map(numbers)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, numbers(v)]))
  return value
}

/** A visit to a destination's HQ over SSH; resolves to its exit code: 0 for a normal end (Ctrl-C while connected), 3
 *  for no office there (or here, with nothing saved), 2 for a name that isn't one or isn't saved where there's no
 *  terminal to learn it, 130 for Ctrl-C before connecting, 1 for the rest. The destination is the one named, else the
 *  one saved, else one asked for among several; with none, or a name that isn't saved, it offers to learn the path,
 *  and goes on with the connection that saved it. */
export async function visit(options: VisitOptions, deps: VisitDeps): Promise<number> {
  let saved: Saved[]
  try {
    saved = await savedDestinations(deps.home)
  } catch (error) {
    deps.error(`opencorp hq: ${messageOf(error)}`)
    return 1
  }
  let name = options.name
  if (name !== undefined) {
    const problem = nameProblem(name)
    if (problem !== null) {
      deps.error(`opencorp hq: ${problem}`)
      return 2
    }
  } else if (saved.length === 1) name = saved[0]!.paths.name
  else if (saved.length > 1) {
    const picked = await pickDestination(saved, deps)
    if (typeof picked === "number") return picked
    name = picked
  }
  const found = saved.find((s) => s.paths.name === name)
  // Before anything is made under hq/: with nothing saved this is as likely HQ's own machine, its office stopped.
  const learnFirst = found === undefined
  if (learnFirst) {
    // A folder there by that name would take the path's place when it's saved.
    const taken = name === undefined ? null : path.join(deps.home, "hq", name)
    if (taken !== null && present(taken)) {
      deps.error(NOT_A_DESTINATION(taken))
      return 1
    }
    if (!deps.prompter.interactive) {
      deps.error(name === undefined ? NO_PATH(path.join(deps.home, "hq")) : unknown(name, saved))
      return name === undefined ? 3 : 2
    }
    deps.error(name === undefined ? NO_OFFICE_HERE : NOT_SAVED_YET(name))
    // Before asking: there's nowhere to learn without the TUI.
    if (deps.learnChat === undefined) {
      deps.error(LEARN_NEEDS_TERMINAL)
      return 3
    }
    // Stop by default: a stray Enter on HQ's own machine, its office stopped, must not start a model run.
    const asked = await askBeforeAnything(deps, () => askToLearn(deps, LEARN_QUESTION, STOP))
    if (asked !== true) {
      if (asked === false) deps.error(NOT_LEARNED)
      return asked === false ? 3 : 130
    }
  } else if (options.relearn && (!deps.prompter.interactive || deps.learnChat === undefined)) {
    deps.error(LEARN_NEEDS_TERMINAL)
    return 1
  }
  // A first path is learned in a folder of its own, renamed to its name when it's saved.
  let paths = found?.paths ?? new ReachPaths(deps.home, tempName())
  while (learnFirst && present(paths.dir)) paths = new ReachPaths(deps.home, tempName())
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
  let access: Access | null = null
  if (!learnFirst) {
    try {
      access = await readAccess(paths)
    } catch (error) {
      if (!(error instanceof AccessError)) {
        deps.error(`opencorp hq: ${messageOf(error)}`)
        return 1
      }
      // A relearn writes a new one, as save_access does. Other destinations are unaffected.
      if (!options.relearn) {
        deps.error(`opencorp hq: ${error.message}; run \`${paths.command} --relearn\` to learn the path again.`)
        return 1
      }
      deps.error(`opencorp hq: ${error.message}; relearning as if there were none.`)
    }
  }
  paths = paths.withCm(await socketId(paths, access))
  if (access !== null && access.cm !== paths.cmId) {
    // Another folder records the same one (a copy of this one): this one moves to its own.
    access = { ...access, cm: paths.cmId! }
    await writeAccess(paths, access)
  }
  const others = saved.filter((s) => s.paths.name !== paths.name)
  const holder = others.find((s) => s.access !== null && s.access.port === options.port)
  if (holder !== undefined) {
    deps.error(`opencorp hq: port ${options.port} is ${holder.paths.name}'s; pick another with --port N`)
    return 1
  }
  let port: number
  if (learnFirst) {
    // Held for this run until it saves, so learning runs that overlap get ports of their own.
    const reserved = await reservePort(paths, options.port)
    if (typeof reserved === "string") {
      deps.error(`opencorp hq: ${reserved}`)
      await removeCm(paths)
      fs.rmSync(paths.dir, { recursive: true, force: true })
      return 1
    }
    port = reserved
  } else {
    port = options.port ?? access?.port ?? nextPort(others.flatMap((s) => (s.access === null ? [] : [s.access.port])))
    const shared = options.port === undefined && access !== null ? portShared(saved, paths.name, access.port) : null
    if (shared !== null) deps.error(shared)
  }
  const { ctx: started, off } = start(paths, ssh, deps)
  // The path a first learn saves is renamed: what follows uses the new folder.
  let ctx = started
  const moved = (to: ReachPaths) => void (ctx = { ...ctx, paths: to })
  let watcher: Watcher | undefined
  try {
    makeDirs(paths)
    await writeSshFiles(paths, ssh, deps.sshIncludes)
    await cleanUp(ctx, deps.now().getTime())
    await sweepTemps(ctx, deps.now().getTime())
    watcher = startWatcher(ctx)
    if (learnFirst) {
      const inputs = { name: name ?? null, notes: "", script: "", failure: "" }
      return await learnAndHold(ctx, deps, inputs, port, options, moved)
    }
    if (options.relearn) {
      if (!(await inVisit(ctx, deps.stdin, () => askToLearn(deps, RELEARN_QUESTION, LEARN)))) {
        deps.error(NOT_LEARNED)
        return 1
      }
      return await learnAndHold(ctx, deps, { name: paths.name, ...lastPath(paths), failure: "" }, port, options, moved)
    }
    const approved = await approve(ctx, deps, access, port)
    if (typeof approved === "number") return approved
    let record = approved
    if (options.port !== undefined && options.port !== record.port)
      record = { ...record, port: options.port, signed_in_at: null }
    port = record.port
    let conn: Connection
    try {
      conn = await reach(ctx, port)
    } catch (error) {
      // Only the first reach offers to relearn, defaulting to Stop: a drop's reconnect never does.
      const canLearn = deps.prompter.interactive && deps.learnChat !== undefined
      if (!(error instanceof ReachFailure) || error.kind !== "broken" || ctx.signal?.aborted || !canLearn) throw error
      const { line, code } = describe(error, port, paths.command)
      deps.error(line)
      if (!(await inVisit(ctx, deps.stdin, () => askToLearn(deps, RELEARN_QUESTION, STOP)))) return code
      return await learnAndHold(ctx, deps, { name: paths.name, ...lastPath(paths), failure: line }, port, options, moved)
    }
    return await hold(ctx, conn, record, options, deps)
  } catch (error) {
    return failed(error, ctx, port, deps)
  } finally {
    off()
    await exitAll(ctx)
    await watcher?.release()
    fs.rmSync(ctx.paths.status(process.pid), { force: true })
    // A first learn that saved nothing leaves nothing behind.
    if (isTemp(ctx.paths.name)) {
      await removeCm(ctx.paths)
      fs.rmSync(ctx.paths.dir, { recursive: true, force: true })
    }
  }
}

/** Asks which of the `saved` destinations to open, the last used first; without a terminal, says which there are.
 *  Resolves to its name, or the exit code: 2 without a terminal, 130 on Ctrl-C. */
async function pickDestination(saved: readonly Saved[], deps: VisitDeps): Promise<string | number> {
  if (!deps.prompter.interactive) {
    deps.error(SEVERAL(saved))
    return 2
  }
  const used = (s: Saved) => s.access?.last_used_at ?? ""
  const names = [...saved].sort((a, b) => used(b).localeCompare(used(a))).map((s) => s.paths.name)
  const picked = await askBeforeAnything(deps, () => deps.prompter.choose(WHICH, names, names[0]))
  quietStdin(deps.stdin)
  return picked ?? 130
}

/** Once connected: sign the browser in or open HQ, record the visit, say what stays open, then wait until Ctrl-C. */
async function hold(ctx: ReachContext, conn: Connection, access: Access, options: VisitOptions, deps: VisitDeps): Promise<number> {
  access = await signInOrOpen(ctx, conn, access, options, deps)
  await writeAccess(ctx.paths, {
    ...access,
    last_used_at: deps.now().toISOString(),
    host: conn.spec.host,
    socket: conn.socket,
  })
  deps.print(visitLine(conn))
  return waitLoop(ctx, conn, deps)
}

/** What a learning run starts from: the destination's name (null for a first one named after its host), and the
 *  old path's notes, script and why it failed. */
export interface LearnInputs {
  name: string | null
  notes: string
  script: string
  failure: string
}

/** Learns a path, then holds the connection that saved it, in the folder it was saved in, which `moved` hears of;
 *  the exit code when nothing was saved. OpenCorp's connection shell, which holds the tunnel, closes at the end. */
async function learnAndHold(
  ctx: ReachContext,
  deps: VisitDeps,
  inputs: LearnInputs,
  port: number,
  options: VisitOptions,
  moved: (paths: ReachPaths) => void,
): Promise<number> {
  const learned = await learnPath(ctx, deps, inputs, port)
  if (typeof learned === "number") return learned
  moved(learned.paths)
  // Checked again as saved: another destination may have taken the port while this one learned.
  const shared = portShared(await savedDestinations(deps.home), learned.paths.name, learned.access.port)
  if (shared !== null) deps.error(shared)
  try {
    return await hold({ ...ctx, paths: learned.paths }, learned.conn, learned.access, options, deps)
  } finally {
    await learned.shell.close()
  }
}

/** The most of the old notes.md or reach.sh a relearning run is given. */
export const MAX_OLD_CHARS = 64 * 1024

/** The old notes.md and reach.sh as text for a relearning run, each "" when missing or not a plain file of this
 *  user. */
export function lastPath(paths: ReachPaths): { notes: string; script: string } {
  const text = (file: string) => {
    try {
      return headChars((readScript(file) ?? Buffer.alloc(0)).toString("utf8"), MAX_OLD_CHARS)
    } catch (error) {
      if (error instanceof ScriptError) return ""
      throw error
    }
  }
  return { notes: text(paths.notes), script: text(paths.script) }
}

/** `ask` at a question inside the visit, stopped by its first Ctrl-C, which a numbered list gets as SIGINT rather
 *  than as a key; then `stdin` is paused, so the line read the question left pending can't keep the process alive. */
function inVisit<T>(ctx: ReachContext, stdin: Readable, ask: () => Promise<T>): Promise<T> {
  const signal = ctx.signal!
  return Promise.race([
    ask(),
    aborted(signal).then((): never => {
      quietStdin(stdin)
      return signal.throwIfAborted() as never
    }),
  ])
}

/** Shows what learning risks, then asks `question` with `fallback` as the default; resolves whether the owner chose
 *  to learn. */
async function askToLearn(deps: VisitDeps, question: string, fallback: string): Promise<boolean> {
  for (const line of beforeLearning(path.join(deps.home, "hq"))) deps.prompter.say(clean(line))
  const answer = await deps.prompter.choose(question, [LEARN, STOP], fallback)
  quietStdin(deps.stdin)
  return answer === LEARN
}

/** `ask` before the visit has its context: its own Ctrl-C, which a numbered list gets as SIGINT rather than as a key.
 *  Resolves to what `ask` resolved to, or null on Ctrl-C, after which stdin is paused so the line read the question
 *  left pending can't keep the process alive. */
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
    if (stop.signal.aborted) quietStdin(deps.stdin)
  }
}

/** A learning run with the owner's consent already given: the model from `hq/provider.json` (asked for on the
 *  plain terminal the first time), then learn_hq as a chat with OpenCorp, through `deps.learnChat`. Resolves to the
 *  saved path's record, the connection that tested it and OpenCorp's connection shell it runs in, or to the exit code
 *  once it says why nothing was saved: 1, or 130 when the owner left the chat (or stopped the visit) first. */
async function learnPath(
  ctx: ReachContext,
  deps: VisitDeps,
  inputs: LearnInputs,
  port: number,
): Promise<{ access: Access; conn: Connection; shell: ConnectionShell; paths: ReachPaths } | number> {
  const signal = ctx.signal!
  // The first Ctrl-C stops a model check that may take a minute, its request included.
  const checkModel: ModelCheck = async (provider) => {
    const problem = await Promise.race([deps.checkModel(provider, signal), aborted(signal)])
    signal.throwIfAborted()
    return problem as string | null
  }
  // The first Ctrl-C stops a device sign-in too.
  const provider = await inVisit(ctx, deps.stdin, () =>
    learnProvider(ctx.paths, deps.prompter, { listers: deps.listers, checkModel, auth: deps.auth, signal }),
  )
  quietStdin(deps.stdin)
  // Read again at each use: the run's first model call may refresh a subscription's tokens.
  const secrets = () => providerSecrets(provider, workerEnv(ctx.env))
  const id = newId()
  const state = new Learning(ctx, secrets, port, ctx.paths.session(id), deps.now, inputs.name)
  let end: ChatEnd
  try {
    end = await deps.learnChat!(learningSession(ctx, deps, provider, inputs, id, state))
  } catch (error) {
    await state.shell?.close()
    throw error
  }
  // Saved and connected, whatever the agent did after.
  if (state.connection !== null && state.shell !== null) {
    const paths = state.saved ?? ctx.paths
    const access = await readAccess(paths)
    if (access === null) throw new Error(`${paths.access} went missing after it was saved`)
    return { access, conn: state.connection, shell: state.shell, paths }
  }
  await state.shell?.close()
  if (end.status === "failed") {
    // The model's key or sign-in never goes to the terminal, though a server may quote it.
    const why = redact(end.error ?? "the session failed", [], state.secrets())
    deps.error(LEARNING_FAILED(clean(learnedMessage(why, provider, ctx.paths))))
  } else deps.error(NOT_SAVED)
  listCommands(deps, state)
  return end.status === "left" || signal.aborted ? 130 : 1
}

/** Why a learning run on `provider` failed, `message`, with yian's hint to run `yian auth openai` replaced, on the
 *  sign-in in `paths.auth`, by how to sign in again here: that command writes another file. */
export function learnedMessage(message: string, provider: Provider, paths: ReachPaths): string {
  if (provider.env[AUTH_FILE_ENV] !== paths.auth) return message
  return signInRemedy(message, {
    refused: `delete ${paths.auth} and run \`opencorp hq\` again`,
    retry: "run `opencorp hq` again later",
  })
}

/** The commands the agent's shells ran, each with its exit, or none; its first line as the record holds it. */
function listCommands(deps: VisitDeps, state: Learning): void {
  const tried = state.tried()
  if (tried.length === 0) return
  deps.error(ASKED_FOR)
  for (const { command, code } of tried) {
    const lines = command.split("\n")
    const more = lines.length > 1 ? ` (and ${lines.length - 1} more line${lines.length > 2 ? "s" : ""})` : ""
    deps.error(`  (${code === null ? "no exit" : `exit ${code}`}) ${shownCode(lines[0]!)}${more}`)
  }
}

/** Learning's session for the no-office host: learn_hq with the old path's `inputs`, from the owner's choice to
 *  learn, on `provider`'s model, in `hq/sessions/<id>`. Its tools are learning's terminal, its shells in the agent's
 *  SSH-only sandbox under the session's permissions (where there's no sandbox, the owner is asked here first), and
 *  `save_access`, whose card the session holds and whose chain test runs in OpenCorp's connection shell. */
function learningSession(
  ctx: ReachContext,
  deps: VisitDeps,
  provider: Provider,
  inputs: LearnInputs,
  id: string,
  state: Learning,
): BuiltinSession<Terminal> {
  return {
    agent: { handle: "opencorp", name: "OpenCorp" },
    flow: { name: "learn_hq", text: embedded(learnYaml).toString("utf8") },
    inputs: {
      name: inputs.name ?? "",
      notes: wellFormed(inputs.notes),
      script: wellFormed(inputs.script),
      failure: wellFormed(inputs.failure),
    },
    first: LEARN_FIRST,
    model: { llm_config: { ...(provider.llm_config ?? {}) }, env: { ...provider.env } },
    folder: state.folder,
    tools: async (binding) => {
      const terminal = await learningTerminal({
        paths: ctx.paths,
        session: id,
        home: deps.sshHome,
        ssh: ctx.ssh,
        env: ctx.env,
        permissions: binding.permissions,
        consent: (ask) => consentHere(deps, ask),
        onShell: (shell, name) => binding.onShell(shell, name),
      })
      const connection = () =>
        (state.shell ??= new ConnectionShell({
          ctx,
          folder: state.folder,
          sessionId: binding.sessionId,
          instruments: binding.instruments,
        }))
      const save = saveAccessTool({ state, binding, connection })
      return { groups: { terminal: terminal.tools(), save_access: { save_access: save } }, terminal }
    },
  }
}

/** Asks the owner on the plain terminal whether learning's shells may run with no sandbox, before the chat opens. */
async function consentHere(deps: VisitDeps, ask: ConsentAsk): Promise<string> {
  for (const line of ask.lines) deps.prompter.say(clean(line))
  const answer = await deps.prompter.choose(ask.question, [...ask.choices], ask.default)
  quietStdin(deps.stdin)
  return answer
}

/** A visit's context, its Ctrl-C (a second one exits 130 at once; the watcher then ends the masters), and the
 *  function that stops listening for it. */
function start(paths: ReachPaths, ssh: string, deps: VisitDeps): { ctx: ReachContext; off: () => void } {
  const stop = new AbortController()
  const interrupt = () => (stop.signal.aborted ? deps.exit(130) : stop.abort())
  const off = deps.onSigint(interrupt)
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
    const { line, code } = describe(error, port, ctx.paths.command)
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
  port: number,
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
    deps.error(NO_PATH(paths.root))
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
    // Numbered, anything but printable ASCII escaped and padding collapsed: what's approved is what runs.
    for (const line of numberedLines(now.toString("utf8"))) deps.prompter.say(line)
    question = runThis(lineCount(now.toString("utf8")))
  } else {
    say(`${paths.script} changed since you approved it:`)
    const patch = createTwoFilesPatch("reach.approved.sh", "reach.sh", before.toString("utf8"), now.toString("utf8"))
    // A diff line's +, - or space comes first, so the script's own indentation follows it and is shown as written.
    for (const line of patch.replace(/\n$/, "").split("\n"))
      deps.prompter.say(/^[ +-]/.test(line) ? line[0] + shownCode(line.slice(1)) : shownCode(line))
    question = useChanged(lineCount(now.toString("utf8")))
  }
  if (!deps.prompter.interactive) {
    deps.error("opencorp hq: reach.sh isn't approved, and there's no terminal to ask; run `opencorp hq` in one.")
    return 1
  }
  const answer = await inVisit(ctx, deps.stdin, () => deps.prompter.choose(question, [USE, STOP], STOP))
  quietStdin(deps.stdin)
  if (answer !== USE) {
    deps.error("opencorp hq: stopped; reach.sh isn't approved.")
    return 1
  }
  await writePrivate(paths.approved, now)
  const record: Access = {
    port: access?.port ?? port,
    sha256: digest,
    learned_at: deps.now().toISOString(),
    last_used_at: access?.last_used_at ?? null,
    signed_in_at: access?.signed_in_at ?? null,
    cm: paths.cmId!,
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
  if (since > SIGN_IN_HINT_DAYS * 24 * 60 * 60_000) deps.print(SIGN_IN_HINT(ctx.paths))
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
async function alreadyRunning(options: VisitOptions, deps: VisitDeps, found: ReachPaths, ssh: string): Promise<number> {
  if (options.relearn) {
    deps.error(RELEARN_BUSY(found))
    return 1
  }
  let paths = found
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
  paths = paths.withCm(access.cm)
  const { ctx, off } = start(paths, ssh, deps)
  try {
    if (!isSocket(paths.node) || (await control(ctx, paths.node, "check")).code !== 0) {
      deps.error(NOT_YET(paths))
      return 1
    }
    const spec = await replayed(ctx)
    // The running visit may not have forwarded the port yet, or may be moving it (`--port`): a code goes only to a
    // port where HQ answers as its check says, steps b and d.
    const status = classifyCheck(await mux(ctx, spec, ["hq", "--check", "--json"]))
    try {
      await sameHealth(access.port, status, ctx.limits.stepMs)
    } catch (error) {
      if (!(error instanceof ReachFailure) || ctx.signal?.aborted) throw error
      deps.error(NOT_YET(paths))
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

/** After a drop: close our masters, try once quietly in BatchMode (it fails at once where a login needs Duo, and
 *  each of its steps within `quietMs`, as over a stale connection of the owner's that we don't close), then
 *  reconnect each time the owner presses Enter; Enters typed before the prompt don't count. A failed retry has
 *  ended only the node master (`connect` does that), so the next rides the login master without a new Duo. Never
 *  offers relearning. Null when stdin ends or on Ctrl-C. */
async function reconnect(ctx: ReachContext, port: number, deps: VisitDeps): Promise<Connection | null> {
  await exitAll(ctx)
  const { quietMs } = ctx.limits
  const quiet = { ...ctx.limits, promptMs: quietMs, stepMs: Math.min(ctx.limits.stepMs, quietMs) }
  try {
    return await reach({ ...ctx, batch: true, echo: () => {}, limits: quiet }, port)
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
      deps.error(error instanceof ReachFailure ? describe(error, port, ctx.paths.command).line : `opencorp hq: ${messageOf(error)}`)
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
 *  links and the visit line; the ssh config includes the passwd entry's `~/.ssh/config`, where ssh's own `~` points
 *  (`$HOME`'s in a test that names its fake ssh's folder; see `sandbox.ts`). */
export function realVisitDeps(home: string): VisitDeps {
  const ssh = sshHome(os.userInfo().homedir, process.env)
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
    sshIncludes: defaultIncludes(ssh),
    sshHome: ssh,
    listers: LISTERS,
    checkModel: (provider, signal) => modelProblem(provider, { signal }),
  }
}
