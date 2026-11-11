/** Connecting to HQ's machine once reach.sh gave the spec: the node master, `opencorp hq --check` over it, the
 *  forward of HQ's socket to a local port, HQ's health through that port, and the sign-in code. */
import net from "node:net"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import {
  cleanOutput,
  control,
  endNode,
  forward,
  lastStderr,
  type Master,
  mux,
  type Ran,
  type ReachContext,
  startMaster,
  waitForSocket,
} from "./ssh.ts"
import { hqSocket, lastJson, type Spec } from "./spec.ts"
import { codeFrom, RemoteCode } from "./state.ts"

export type FailureKind = "unreachable" | "no_office" | "not_ready" | "broken" | "port_taken" | "no_forward"
/** A step of reaching HQ failed; `kind` is its row of the failure table. */
export class ReachFailure extends Error {
  override name = "ReachFailure"
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message)
  }
}

/** The failure table: what to say for `failure`, and the exit code. */
export function describe(failure: ReachFailure, port: number): { line: string; code: number } {
  // Where a sentence follows it, the message's own closing period goes.
  const said = failure.message.replace(/\.+$/, "")
  switch (failure.kind) {
    case "unreachable":
      return { line: `opencorp hq: couldn't connect: ${failure.message}`, code: 1 }
    case "no_office":
      return {
        line: `opencorp hq: no office answers there: ${said}. Start the job or the office there, or fix reach.sh if HQ moved.`,
        code: 3,
      }
    case "not_ready":
      return {
        line: `opencorp hq: HQ isn't ready there: ${said}. Run \`opencorp doctor\` there, or update that checkout.`,
        code: 1,
      }
    case "broken":
      return { line: `opencorp hq: the saved way to reach HQ is broken: ${failure.message}`, code: 1 }
    case "port_taken":
      return {
        line: `opencorp hq: port ${port} on 127.0.0.1 is taken by another program; pick a free one with \`opencorp hq --port N\` (you'll sign in again).`,
        code: 1,
      }
    case "no_forward":
      return {
        line: `opencorp hq: HQ didn't answer through the forward (${failure.message}); the node's sshd may refuse socket forwarding (AllowStreamLocalForwarding).`,
        code: 1,
      }
  }
}

/** Valid JSON from HQ's machine that lacks what a visit reads: that checkout and this one differ. */
export const SKEW = "HQ's machine runs a different opencorp; update one side"

/** What a visit reads of `opencorp hq --check --json`, whatever else that checkout's version prints: the socket,
 *  why it isn't listening (an older office leaves it out), and HQ's health, kept whole to compare. */
const RemoteStatus = z.looseObject({
  socket: z.string(),
  socket_error: z.string().nullable().optional(),
  health: z.looseObject({ app: z.unknown() }),
})

/** HQ's status as a visit uses it: its socket, and its health as HQ's machine printed it. */
export interface Checked {
  socket: string
  health: unknown
}

/** HQ's status from `opencorp hq --check --json` over the master, or the failure it shows. */
export function classifyCheck(ran: Ran): Checked {
  if (ran.timedOut || ran.code === 255)
    throw new ReachFailure(
      "unreachable",
      ran.timedOut ? "`opencorp hq --check` there didn't answer within 60 s" : lastStderr(ran) || "ssh exited 255",
    )
  if (ran.code === 3) throw new ReachFailure("no_office", lastStderr(ran) || "no office answers there")
  // The wrapper ends in `exec "${OPENCORP_BUN:-bun}"`: 127 is also a missing bun.
  if (ran.code === 127)
    throw new ReachFailure("broken", "no opencorp at the saved path, or no bun for it (exit 127; see env.OPENCORP_BUN)")
  if (ran.code === 2) throw new ReachFailure("not_ready", "`opencorp` there has no `hq --check`; update that checkout")
  if (ran.code === 1) throw new ReachFailure("not_ready", lastStderr(ran) || "`opencorp hq --check` failed there")
  if (ran.code !== 0) throw new ReachFailure("broken", `\`opencorp hq --check\` exited ${ran.code}`)
  const data = lastJson(ran.stdout)
  if (data === undefined) throw new ReachFailure("broken", "`opencorp hq --check --json` there printed no status JSON")
  const parsed = RemoteStatus.safeParse(data)
  if (!parsed.success) throw new ReachFailure("not_ready", SKEW)
  const status = parsed.data
  if (!hqSocket(status.socket)) throw new ReachFailure("broken", "HQ's socket path there can't be forwarded as is")
  if (typeof status.socket_error === "string")
    throw new ReachFailure("not_ready", `hq.sock isn't listening (${cleanOutput(status.socket_error)})`)
  if (status.health.app === null) throw new ReachFailure("not_ready", "HQ's web app isn't built")
  // As printed, not as parsed: compared whole with the health through the port, which the same office answers.
  return { socket: status.socket, health: (data as { health: unknown }).health }
}

/** An open connection to HQ's machine. */
export interface Connection {
  readonly master: Master
  readonly spec: Spec
  readonly port: number
  readonly socket: string
}

/** Whether 127.0.0.1:`port` can be bound now. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** Connects to HQ's machine: (a) the node master logs in, (b) `opencorp hq --check --json` over it gives HQ's socket
 *  and health, (c) 127.0.0.1:`port` here is forwarded to that socket, and (d) HQ's health through the port must be
 *  the check's. On any failure it ends only the node master (a retry needs no new Duo for the login node) and throws
 *  `ReachFailure`. */
export async function connect(spec: Spec, port: number, ctx: ReachContext): Promise<Connection> {
  // Before logging in, so a port that's taken costs no Duo; checked again before the forward, minutes later.
  if (!(await portFree(port))) throw new ReachFailure("port_taken", `port ${port}`)
  const master = startMaster(ctx, spec, { quiet: ctx.batch })
  try {
    const up = await waitForSocket(master, ctx.limits.promptMs, ctx.signal)
    if (up === "exited")
      throw new ReachFailure("unreachable", `ssh couldn't log in to ${spec.host} (exit ${await master.exited})`)
    if (up === "timed_out")
      throw new ReachFailure("unreachable", `logging in to ${spec.host} didn't finish within 5 minutes`)
    const status = classifyCheck(await mux(ctx, spec, ["hq", "--check", "--json"]))
    if (!(await portFree(port))) throw new ReachFailure("port_taken", `port ${port}`)
    const added = await forward(ctx, spec, port, status.socket)
    if (added.code !== 0) {
      // A mux client ignores ExitOnForwardFailure, so the exit is all it says: a live master means the bind failed.
      const alive = (await control(ctx, ctx.paths.node, "check")).code === 0
      throw alive
        ? new ReachFailure("port_taken", `port ${port}`)
        : new ReachFailure("unreachable", lastStderr(added) || "the SSH connection ended")
    }
    await sameHealth(port, status, ctx.limits.stepMs)
    return { master, spec, port, socket: status.socket }
  } catch (error) {
    await endNode(ctx, master)
    throw error
  }
}

/** Step d: HQ's health through 127.0.0.1:`port` must be the check's; throws `ReachFailure` (no_forward) when it
 *  differs. */
export async function sameHealth(port: number, status: Checked, timeoutMs: number): Promise<void> {
  if (!isDeepStrictEqual(await healthThrough(port, timeoutMs), status.health))
    throw new ReachFailure("no_forward", "HQ's health through the port differs from the check's")
}

/** `GET /api/health` (open without a session) through the port, as JSON: a timeout is unreachable; a closed
 *  connection, a non-200 or a body that isn't JSON is no_forward (a node sshd refusing socket forwarding closes each
 *  one). */
async function healthThrough(port: number, timeoutMs: number): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    // Not kept alive: an idle pooled connection is an open channel that holds the master.
    res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" }, signal: timeout })
  } catch {
    if (timeout.aborted) throw new ReachFailure("unreachable", `HQ's health through port ${port} didn't answer within 60 s`)
    throw new ReachFailure("no_forward", `the connection through port ${port} closed before HQ answered`)
  }
  if (res.status !== 200) {
    await res.body?.cancel()
    throw new ReachFailure("no_forward", `GET /api/health through port ${port} answered HTTP ${res.status}`)
  }
  try {
    return await res.json()
  } catch {
    throw new ReachFailure("no_forward", `GET /api/health through port ${port} answered with no JSON`)
  }
}

/** A one-time pairing code from `opencorp hq --json` over the master. The code arrives on stdout, so it never enters
 *  argv, a run log (this isn't a flow) or a model. */
export async function signIn(ctx: ReachContext, spec: Spec): Promise<string> {
  const ran = await mux(ctx, spec, ["hq", "--json"])
  if (ran.timedOut || ran.code === 255)
    throw new ReachFailure(
      "unreachable",
      ran.timedOut ? "`opencorp hq --json` there didn't answer within 60 s" : lastStderr(ran) || "ssh exited 255",
    )
  if (ran.code === 3) throw new ReachFailure("no_office", lastStderr(ran) || "no office answers there")
  if (ran.code !== 0)
    throw new ReachFailure("not_ready", lastStderr(ran) || `\`opencorp hq --json\` exited ${ran.code} there`)
  const data = lastJson(ran.stdout)
  if (data !== undefined && !RemoteCode.safeParse(data).success) throw new ReachFailure("not_ready", SKEW)
  const code = codeFrom(data)
  if (code === null) throw new ReachFailure("broken", "`opencorp hq --json` there printed no pairing code")
  return code
}
