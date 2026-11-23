/** Terminal tool group test helpers: permissions under a gate that decides each call as the office's does and records
 *  what it holds and checks, and a terminal over plain PTYs in a fresh folder. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { pending } from "@ngocbh/yian/tools"
import { now } from "@opencorp/protocol"
import { spawnPty } from "../../../src/platform.ts"
import { commandCard } from "../../../src/features/chat/gate.ts"
import { afterCheck, decideCommand } from "../../../src/runtime/permissions/gate.ts"
import {
  type Action, type ApprovalCard, type CheckInput, type Decided, judged, type Mode, type Permissions, type Rule,
  type Verdict, type Where,
} from "../../../src/runtime/permissions/policy.ts"
import type { Result } from "../../../src/runtime/sandbox/run.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { InstrumentRecord, readRecord, type RecordFile } from "../../../src/tools/terminal/record.ts"
import type { ShellState } from "../../../src/tools/terminal/shell.ts"
import {
  type CommandEnded, decidedFor, Terminal, type TerminalAudit, type TerminalHost, type TerminalShells,
} from "../../../src/tools/terminal/terminal.ts"
import { goldenPolicy, goldenSshPolicy } from "../../runtime/sandbox/helpers.ts"

/** What the host's own `where()` says: the workspace profile, writable everywhere. A terminal whose shells don't run
 *  in a workspace's sandbox must never take it. */
export const HOST_WHERE: Where = { profile: "workspace", cwd: "/w", writable: ["/"] }

export const rule = (effect: Rule["effect"], kind: Action["kind"], pattern: string): Rule => ({ effect, kind, pattern })

/** A terminal tool's call, as the gate saw it. */
interface GatedCallOf {
  readonly name: string
  readonly args: Record<string, unknown>
}

/** The office's gate as a test drives it: decides a terminal call before it acts, and lets a held one act on Yes. */
export interface TestGate {
  /** Decides call `callId` of terminal `terminal`'s tool `name` with `args`: null lets it act, anything else is what
   *  the call returns (a refusal, or `pending()` for a held call). */
  decide(terminal: Terminal, name: string, args: Record<string, unknown>, callId: string, signal?: AbortSignal): Promise<unknown>
  /** The owner's Yes to held call `callId`, credited as `credit`: the call it held, to make again under its id. */
  approve(callId: string, credit: string): GatedCallOf
}

/** Permissions under a gate that decides each terminal call as the office's does (`decideCommand` on the terminal's
 *  plan, then Auto's check in `auto`), with the mode, rules and block a test changes as it goes (`state`); it records
 *  each card it holds and each check it makes. `check`, when given, answers as the test says. */
export function permissions(
  o: { mode?: Mode; rules?: Rule[]; where?: Where; check?: (input: CheckInput, signal: AbortSignal) => Promise<Verdict> } = {},
) {
  const state: { mode: Mode; rules: Rule[]; blocked: string | null } = {
    mode: o.mode ?? "auto", rules: o.rules ?? [], blocked: null,
  }
  const held: { card: ApprovalCard; callId: string }[] = []
  const checked: CheckInput[] = []
  const ledger = new Map<string, Decided>()
  const plans = new Map<string, { plan: Parameters<typeof decidedFor>[0]; call: GatedCallOf }>()
  const check = o.check && ((input: CheckInput, signal: AbortSignal) => (checked.push(input), o.check!(input, signal)))
  const gate: TestGate = {
    async decide(terminal, name, args, callId, signal = new AbortController().signal) {
      const plan = terminal.plan(name, args)
      if (!plan.decide) return null
      const policy = () => ({ mode: state.mode, rules: state.rules, blocked: state.blocked })
      let decision = decideCommand(plan, policy())
      if (decision.verdict === "check") {
        const verdict = await judged(check, decision.input, signal)
        if (signal.aborted) return "Not run: the call closed while Auto's check ran."
        decision = afterCheck(verdict, decision.rules, state.mode)
      }
      switch (decision.verdict) {
        case "run":
          ledger.set(callId, decidedFor(plan, `by ${decision.note}`, false))
          return null
        case "refuse":
          terminal.audited(plan, "denied", decision.reason)
          return decision.reason
        case "ask":
          held.push({ card: commandCard(plan, decision), callId })
          plans.set(callId, { plan, call: { name, args } })
          terminal.audited(plan, "held", decision.reason)
          return pending()
      }
    },
    approve(callId, credit) {
      const found = plans.get(callId)
      if (found === undefined) throw new Error(`no held call ${callId}`)
      ledger.set(callId, decidedFor(found.plan, credit, true))
      return found.call
    },
  }
  const perms: Permissions & { readonly gate: TestGate } = {
    mode: () => state.mode,
    rules: () => state.rules,
    where: () => o.where ?? HOST_WHERE,
    decided: (callId) => {
      const decided = callId === undefined ? undefined : ledger.get(callId)
      if (callId !== undefined) ledger.delete(callId)
      return decided ?? null
    },
    gate,
  }
  return { perms, state, held, checked, ledger }
}

/** A fake ssh in a short folder of its own, removed when the test finishes. */
export function fakeSsh(behavior: FakeSshBehavior): FakeSsh {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return installFakeSsh(dir, behavior)
}

/** PTY shells as the SSH-only profile runs them, but plain: started in `<dir>/work`, its temp folder, with `dir` as
 *  the owner's home. */
export function sshShells(dir: string, fake?: FakeSsh): Extract<TerminalShells, { kind: "pty" }> {
  const work = path.join(dir, "work")
  fs.mkdirSync(work, { recursive: true })
  const hq = path.join(dir, ".opencorp", "hq")
  const shells = plainShells(dir, fake, work)
  const sandbox = goldenSshPolicy({ home: dir, hq, tmpdir: work, statusFile: "/s" })
  return { ...shells, env: { ...shells.env, TMPDIR: work }, sandbox }
}

/** Plain PTY shells (no sandbox) started in `cwd` (default `dir`), with only PATH (the fake ssh's folder first, when
 *  given), TERM and HOME, which is `dir`. */
export function plainShells(dir: string, fake?: FakeSsh, cwd = dir): Extract<TerminalShells, { kind: "pty" }> {
  return {
    kind: "pty",
    sandbox: null,
    start: (argv, io) => spawnPty(argv, { cwd, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData }),
    env: { PATH: `${fake ? `${fake.bin}:` : ""}/usr/bin:/bin`, TERM: "xterm-256color", HOME: dir },
  }
}

/** A terminal driven by `@minh` in a fresh folder, its shells' records in `<dir>/record-<id>`, over plain PTYs there
 *  unless `shells` says otherwise; with `audit`, its host keeps each audit row in `audits`; with `notes`, it keeps
 *  each note of a command that ended in `notes`. The test's end closes it, then removes the folder. */
export function openTerminal(o: {
  perms: Permissions
  fake?: FakeSsh
  shells?: (dir: string) => TerminalShells
  audit?: boolean
  notes?: boolean
}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-term-")))
  const live = new Map<string, Uint8Array[]>()
  const states = new Map<string, ShellState[]>()
  const audits: TerminalAudit[] = []
  const notes: CommandEnded[] = []
  let made = 0
  let calls = 0
  const host: TerminalHost = {
    shells: o.shells?.(dir) ?? plainShells(dir, o.fake),
    driver: "@minh",
    permissions: o.perms,
    ...(o.audit ? { audit: (row: TerminalAudit) => void audits.push(row) } : {}),
    ...(o.notes ? { ended: (note: CommandEnded) => void notes.push(note) } : {}),
    shellHost: (name, profile) => {
      const id = `sh_${++made}`
      const record = new InstrumentRecord(path.join(dir, `record-${id}`), {
        id, name, kind: "terminal", profile, driver: "@minh", started: now(),
      })
      live.set(id, [])
      states.set(id, [])
      return { id, record, changed: (state) => states.get(id)!.push(state), output: (chunk) => live.get(id)!.push(chunk) }
    },
  }
  const terminal = new Terminal(host)
  const gate = (o.perms as Partial<{ gate: TestGate }>).gate
  onTestFinished(async () => {
    await terminal.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const tools = terminal.tools()
  return {
    terminal,
    dir,
    /** The rows the host's audit got, in order. */
    audits,
    /** The notes the host got of commands that ended, in order. */
    notes,
    /** Calls tool `name` with `args`, as yian would: with a fresh call id unless given, its signal and the agent's
     *  interrupt, through the permissions' gate, when they have one, first. */
    call: async (
      name: keyof typeof tools,
      args: Record<string, unknown>,
      options: { callId?: string; signal?: AbortSignal; interrupted?: AbortSignal } = {},
    ) => {
      const callId = options.callId ?? `r/n/${++calls}/0`
      const signal = options.signal ? { signal: options.signal } : {}
      const interrupted = options.interrupted ? { interrupted: options.interrupted } : {}
      const out = gate === undefined ? null : await gate.decide(terminal, name, args, callId, options.signal)
      return out !== null ? out : tools[name].call(args, { callId, ...signal, ...interrupted })
    },
    /** The owner's Yes to held call `callId` (credited as `credit`, by default "approved"): yian releases it, and the
     *  call is made again under its id. */
    approve: (callId: string, o: { credit?: string; signal?: AbortSignal } = {}) => {
      if (gate === undefined) throw new Error("these permissions have no gate")
      const call = gate.approve(callId, o.credit ?? "approved")
      return tools[call.name as keyof typeof tools].call(call.args, { callId, ...(o.signal ? { signal: o.signal } : {}) })
    },
    /** The owner's live view of shell `id` so far, decoded. */
    live: (id: string) => new TextDecoder().decode(Buffer.concat(live.get(id) ?? [])),
    /** Shell `id`'s states as its host was told them. */
    states: (id: string) => states.get(id) ?? [],
    /** Shell `id`'s record. */
    record: (id: string): RecordFile => readRecord(path.join(dir, `record-${id}`))!,
  }
}

/** A reply as the model reads it. */
export const json = (result: unknown): Record<string, unknown> => JSON.parse(result as string)

/** A pipes runner over a workspace's sandbox in `dir` that runs nothing: `echo <text>` prints its text and exits 0 at
 *  once; any other command runs until `end(command, exit, output)`, which prints `output` first, or until its call is
 *  stopped, when it ends with no exit, as a killed call does. `commands` are the commands it was given, in order;
 *  `running()` those still running. */
export function fakePipes(dir: string) {
  const sandbox = goldenPolicy({ workspace: dir, writable: true, network: false, tmpdir: "/tmp" })
  const ends = new Map<string, (exit: number, output?: string) => void>()
  const commands: string[] = []
  const shells: Extract<TerminalShells, { kind: "pipes" }> = {
    kind: "pipes",
    sandbox,
    run: (argv, options) =>
      new Promise((resolve) => {
        const command = argv[2]!.replace(/^exec 2>&1; /, "")
        commands.push(command)
        const started = performance.now()
        const done = (exit: number | null) => {
          options.signal?.removeEventListener("abort", stop)
          ends.delete(command)
          resolve(pipesResult(exit, exit === null, (performance.now() - started) / 1000))
        }
        const stop = () => done(null)
        if (options.signal?.aborted) return stop()
        if (command.startsWith("echo ")) {
          options.onOutput?.("stdout", Buffer.from(`${command.slice(5)}\n`))
          return done(0)
        }
        options.signal?.addEventListener("abort", stop, { once: true })
        ends.set(command, (exit, output = "") => {
          if (output !== "") options.onOutput?.("stdout", Buffer.from(output))
          done(exit)
        })
      }),
  }
  return {
    shells,
    commands,
    running: () => [...ends.keys()],
    end: (command: string, exit: number, output?: string) => ends.get(command)?.(exit, output),
  }
}

/** A pipes call's result, as `run` gives it. */
export function pipesResult(exit: number | null, interrupted = false, duration = 0): Result {
  const empty = Buffer.alloc(0)
  return {
    exit, stdout: empty, stderr: empty, stdoutTail: empty, stderrTail: empty, stdoutBytes: 0, stderrBytes: 0,
    timedOut: false, interrupted, truncated: false, duration, refused: false,
  }
}
