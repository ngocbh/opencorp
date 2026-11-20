/** The no-office host's test helpers: a built-in agent's session on the fake model, with a terminal over plain PTYs
 *  in a fresh folder, and a host the test's end stops. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { type Event, type LiveEvent, now } from "@opencorp/protocol"
import { PING } from "../../../src/runtime/bus.ts"
import type { BuiltinSession, SessionBinding } from "../../../src/runtime/sessions/builtin.ts"
import { spawnProcess } from "../../../src/runtime/worker/spawn.ts"
import { LocalHost, type LocalHostOptions } from "../../../src/server/local/host.ts"
import { type FakeLLM, LLM_CONFIG } from "../../../src/testing/fake_llm.ts"
import { InstrumentRecord } from "../../../src/tools/terminal/record.ts"
import { Terminal } from "../../../src/tools/terminal/terminal.ts"
import { newId } from "../../../src/util/ids.ts"
import { waitFor } from "../../helpers.ts"
import { plainShells } from "../../tools/terminal/helpers.ts"

/** The built-in agent's flow, in the chat flow's shape. */
export const FLOW = fs.readFileSync(new URL("../../fixtures/local_chat.yaml", import.meta.url), "utf8")
/** What every request of the agent holds, for the fake model's `match`. */
export const AGENT = "OpenCorp's built-in agent"
/** What every request of Auto's check holds. */
export const CHECK = "<input>"

/** The model's call of terminal tool `name` with `args`. */
export function terminalCall(name: string, args: Record<string, unknown>, id?: string) {
  return { name: `terminal_${name}`, arguments: args, ...(id === undefined ? {} : { id }) }
}

/** A started host, and what the test reads of it. */
export interface Started {
  host: LocalHost
  /** The session's folder. */
  folder: string
  /** The folder the shells start in, which is their home. */
  work: string
  /** Each worker the host spawned: its folder and pid. */
  spawned: { dir: string; pid: number }[]
  /** What the host bound for the session's tools. */
  binding: SessionBinding
  /** The terminal the session's tools drive. */
  terminal: Terminal
}

/** Starts a host for the built-in agent on `fake`, its folder `<temp>/sessions/<id>`, its terminal's shells on plain
 *  PTYs in a fresh folder with their records in the session's `terminal/`. `o.sessions` gives the sessions folder. The
 *  test's end stops the host, then removes the folders. */
export async function startHost(
  fake: FakeLLM,
  o: Partial<LocalHostOptions> & { sessions?: string } = {},
): Promise<Started> {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-local-")))
  let host: LocalHost | undefined
  onTestFinished(async () => {
    await host?.close()
    fs.rmSync(top, { recursive: true, force: true })
  })
  const sessions = o.sessions ?? path.join(top, "sessions")
  const folder = path.join(sessions, newId())
  const work = path.join(top, "work")
  fs.mkdirSync(work)
  const spawned: Started["spawned"] = []
  let bound: SessionBinding | undefined
  let made: Terminal | undefined
  const spec: BuiltinSession<Terminal> = {
    agent: { handle: "opencorp", name: "OpenCorp" },
    flow: { name: "local_chat", text: FLOW },
    inputs: {},
    model: { llm_config: { ...LLM_CONFIG }, env: fake.env() },
    folder,
    tools: (binding) => {
      bound = binding
      const records = path.join(folder, "terminal")
      const terminal = new Terminal({
        shells: plainShells(work),
        driver: "opencorp",
        permissions: binding.permissions,
        shellHost: (name, profile) => {
          const id = newId()
          const meta = { id, name, kind: "terminal" as const, profile, driver: "opencorp", started: now() }
          const record = new InstrumentRecord(path.join(records, id), meta)
          const listener = binding.onShell(id, name)
          return { id, record, changed: (state) => listener.changed(state), output: (chunk) => listener.output(chunk) }
        },
      })
      made = terminal
      return { groups: { terminal: terminal.tools() }, terminal }
    },
  }
  host = await LocalHost.start(spec, {
    log: () => {},
    ...o,
    spawn: (dir, env, options) => {
      const out = (o.spawn ?? spawnProcess)(dir, env, options)
      if (out.child.pid !== undefined) spawned.push({ dir, pid: out.child.pid })
      return out
    },
  })
  return { host, folder, work, spawned, binding: bound!, terminal: made! }
}

/** What the host's bus publishes from now until the test finishes. */
export function follow(host: LocalHost): { meta: Event[]; live: LiveEvent[] } {
  const seen: { meta: Event[]; live: LiveEvent[] } = { meta: [], live: [] }
  const sub = host.bus.subscribe()
  let done = false
  onTestFinished(() => {
    done = true
    sub.end()
  })
  void (async () => {
    while (!done) {
      const item = await sub.next(1000)
      if (item === null) return
      if (item === PING) continue
      if (item[0] === "meta") seen.meta.push(item[1])
      else seen.live.push(item[1])
    }
  })()
  return seen
}

/** Waits until the session is `status`. */
export function until(host: LocalHost, status: string, what = `the session to be ${status}`): Promise<unknown> {
  return waitFor(() => host.session()?.status === status, { what, timeout: 30_000 })
}

/** The session's messages as `[role, texts]`, empty texts left out. */
export async function said(host: LocalHost): Promise<[string, string[]][]> {
  return (await host.messages()).map((m) => [
    m.role,
    m.parts.flatMap((p) => (p.type === "text" && p.text !== "" ? [p.text] : [])),
  ])
}

/** The open questions of the session. */
export function open(host: LocalHost) {
  return host.questions({ status: ["open"] })
}

/** Waits until the session has `n` open questions, and returns them. */
export function cards(host: LocalHost, n: number) {
  return waitFor(
    () => {
      const found = open(host)
      return found.length === n ? found : null
    },
    { what: `${n} open cards` },
  )
}

/** Whether process `pid` is gone (or a zombie nobody reaped yet). */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  try {
    return /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
  } catch {
    return true
  }
}
