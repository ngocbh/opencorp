/** The replay on every visit: `reach_hq`, which runs the approved reach.sh, then reads what it printed and how it
 *  exited. */
import { type FunctionTool, loadFlow, runFlow, type ToolContext, tool } from "@ngocbh/yian"
import { embedded } from "../platform.ts"
import { replaceFile } from "../secrets.ts"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { workerEnv } from "../worker/spawn.ts"
import reachYaml from "./flows/reach_hq.yaml" with { type: "file" }
import { lastStderr, type Ran, type ReachContext, readStatuses, resetStatus, runChild, sshEnv } from "./ssh.ts"
import { parseSpec, Spec } from "./spec.ts"
import { readAccess, sha256 } from "./state.ts"

export { reachYaml }

export type Outcome = "ok" | "no_office" | "unreachable" | "broken"
/** What a replay found: the checked spec when `ok` (the key is left out otherwise), else why not. */
export interface Reached {
  outcome: Outcome
  spec?: Spec
  detail: string
}

/** What a run of reach.sh means. Any ssh that exited 255 (the wrapper records each), or running out of time, is
 *  "couldn't connect", whatever the script returned; then 3 is no office, 0 with a valid spec ok, the rest broken. */
export function classify(ran: Ran, statuses: readonly number[]): Reached {
  if (ran.timedOut) return { outcome: "unreachable", detail: "reach.sh didn't finish within 5 minutes" }
  if (ran.code === 255 || statuses.includes(255))
    return { outcome: "unreachable", detail: lastStderr(ran) || "ssh exited 255" }
  if (ran.code === 3) return { outcome: "no_office", detail: lastStderr(ran) || "reach.sh found no office (exit 3)" }
  if (ran.code !== 0)
    return { outcome: "broken", detail: `reach.sh exited ${ran.code}${lastStderr(ran) ? `: ${lastStderr(ran)}` : ""}` }
  const parsed = parseSpec(ran.stdout)
  if ("problem" in parsed)
    return { outcome: "broken", detail: `reach.sh printed a spec that isn't valid: ${parsed.problem}` }
  return { outcome: "ok", spec: parsed.spec, detail: "" }
}

/** Runs `file` with `/bin/sh` in the hq folder, with only `sshEnv` (our wrapper first on PATH), stdin from /dev/null
 *  and its stderr echoed to the owner, for up to `promptMs` (its ssh may ask for Duo); then classifies the run with
 *  the exits the wrapper recorded. */
export async function runScript(file: string, ctx: ReachContext): Promise<Reached> {
  resetStatus(ctx)
  const ran = await runChild(["/bin/sh", file], {
    env: sshEnv(ctx),
    cwd: ctx.paths.dir,
    timeoutMs: ctx.limits.promptMs,
    signal: ctx.signal,
    echo: ctx.echo,
  })
  return classify(ran, readStatuses(ctx))
}

/** The most a reach.sh may hold. */
export const MAX_SCRIPT_BYTES = 1024 * 1024

/** A script a visit would show or run isn't one it will use; the message says why. */
export class ScriptError extends Error {
  override name = "ScriptError"
}

/** `file`'s bytes, or null when nothing is there. Throws `ScriptError` unless it's a regular file of this user with
 *  one link and at most `MAX_SCRIPT_BYTES`, so what was approved can't change behind another name. The owner may
 *  write reach.sh with any mode: the hq folder is 0700. */
export function readScript(file: string): Buffer | null {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NONBLOCK so a FIFO there can't hang the open; fstat then refuses it.
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    // A symlink's last component under O_NOFOLLOW: ELOOP (EMLINK on some BSDs).
    if (code === "ELOOP" || code === "EMLINK") throw new ScriptError(`${file} is a symbolic link; it must be a regular file`)
    throw new ScriptError(`${file} can't be read (${code})`)
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new ScriptError(`${file} must be a regular file`)
    if (st.uid !== process.geteuid!()) throw new ScriptError(`${file} must be your own file`)
    if (st.nlink !== 1) throw new ScriptError(`${file} has another hard link; it must be a regular file with one`)
    if (st.size > MAX_SCRIPT_BYTES) throw new ScriptError(`${file} is over 1 MiB`)
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Runs reach.sh only when its sha256 is the approved one in access.json, and runs the bytes it checked; else
 *  broken, and nothing runs. */
export async function replay(ctx: ReachContext): Promise<Reached> {
  const access = await readAccess(ctx.paths)
  if (access === null) return { outcome: "broken", detail: "there's no approved reach.sh yet" }
  let bytes: Buffer | null
  try {
    bytes = readScript(ctx.paths.script)
  } catch (error) {
    if (error instanceof ScriptError) return { outcome: "broken", detail: error.message }
    throw error
  }
  if (bytes === null) return { outcome: "broken", detail: `there's no ${ctx.paths.script}` }
  if (sha256(bytes) !== access.sha256) return { outcome: "broken", detail: "reach.sh isn't the approved one" }
  return runBytes(bytes, ctx)
}

/** Runs `bytes`, a script whose sha256 was checked, from a private copy in the hq folder (0600, unique to this run,
 *  removed after), so a reach.sh changed after the check never runs. */
export async function runBytes(bytes: Uint8Array, ctx: ReachContext): Promise<Reached> {
  const name = `.reach-${process.pid}-${randomBytes(4).toString("hex")}.sh`
  replaceFile(ctx.paths.dir, name, bytes)
  const file = path.join(ctx.paths.dir, name)
  try {
    return await runScript(file, ctx)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

/** The host object a `reach_hq` run gives its tool: the visit's context. */
export class Replaying {
  constructor(readonly ctx: ReachContext) {}
}

function replaying(c: ToolContext): ReachContext {
  if (!(c.context instanceof Replaying)) throw new Error("replay_access runs only in opencorp hq's replay")
  return c.context.ctx
}

/** `reach_hq`'s one tool: the replay, with the visit's context. */
export const replayTool: FunctionTool = tool({
  name: "replay_access",
  description: "Run the approved reach.sh and return the connection spec it printed, or why it couldn't.",
  parameters: { type: "object", properties: {} },
  execute: (_args, c) => replay(replaying(c)),
})

/** Runs reach_hq with no `llmConfig` and no provider: one TOOL node, so yian resolves no model. */
export async function runReach(ctx: ReachContext): Promise<Reached> {
  const flow = await loadFlow(embedded(reachYaml).toString("utf8"), { sourceLabel: "reach/flows/reach_hq.yaml" })
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
