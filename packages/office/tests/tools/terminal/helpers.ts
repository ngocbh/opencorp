/** Terminal tool group test helpers: permissions that record what they are asked, and a terminal over plain PTYs in
 *  a fresh folder. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { pending } from "@ngocbh/yian/tools"
import { now } from "@opencorp/protocol"
import { spawnPty } from "../../../src/platform.ts"
import type {
  Action, ApprovalCard, CheckInput, Mode, Permissions, Rule, Verdict, Where,
} from "../../../src/runtime/permissions/policy.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { InstrumentRecord, readRecord, type RecordFile } from "../../../src/tools/terminal/record.ts"
import type { ShellState } from "../../../src/tools/terminal/shell.ts"
import { Terminal, type TerminalHost, type TerminalShells } from "../../../src/tools/terminal/terminal.ts"

/** What the host's own `where()` says: the workspace profile, writable everywhere. A terminal whose shells don't run
 *  in a workspace's sandbox must never take it. */
export const HOST_WHERE: Where = { profile: "workspace", cwd: "/w", writable: ["/"] }

export const rule = (effect: Rule["effect"], kind: Action["kind"], pattern: string): Rule => ({ effect, kind, pattern })

/** Permissions whose mode and rules a test changes as it goes (`state`), which record each card they hold and each
 *  check they make; `check`, when given, answers as the test says. */
export function permissions(
  o: { mode?: Mode; rules?: Rule[]; where?: Where; check?: (input: CheckInput, signal: AbortSignal) => Promise<Verdict> } = {},
) {
  const state = { mode: o.mode ?? "auto", rules: o.rules ?? [] }
  const held: { card: ApprovalCard; callId: string }[] = []
  const checked: CheckInput[] = []
  const perms: Permissions = {
    mode: () => state.mode,
    rules: () => state.rules,
    where: () => o.where ?? HOST_WHERE,
    hold: (card, callId) => (held.push({ card, callId }), pending()),
    ...(o.check ? { check: (input: CheckInput, signal: AbortSignal) => (checked.push(input), o.check!(input, signal)) } : {}),
  }
  return { perms, state, held, checked }
}

/** A fake ssh in a short folder of its own, removed when the test finishes. */
export function fakeSsh(behavior: FakeSshBehavior): FakeSsh {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return installFakeSsh(dir, behavior)
}

/** Plain PTY shells (no sandbox) in `dir`, with only PATH (the fake ssh's folder first, when given), TERM and HOME. */
export function plainShells(dir: string, fake?: FakeSsh): Extract<TerminalShells, { kind: "pty" }> {
  return {
    kind: "pty",
    sandbox: null,
    start: (argv, io) => spawnPty(argv, { cwd: dir, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData }),
    env: { PATH: `${fake ? `${fake.bin}:` : ""}/usr/bin:/bin`, TERM: "xterm-256color", HOME: dir },
  }
}

/** A terminal driven by `@minh` in a fresh folder, its shells' records in `<dir>/record-<id>`, over plain PTYs there
 *  unless `shells` says otherwise. The test's end closes it, then removes the folder. */
export function openTerminal(o: { perms: Permissions; fake?: FakeSsh; shells?: (dir: string) => TerminalShells }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-term-")))
  const live = new Map<string, Uint8Array[]>()
  const states = new Map<string, ShellState[]>()
  let made = 0
  let calls = 0
  const host: TerminalHost = {
    shells: o.shells?.(dir) ?? plainShells(dir, o.fake),
    driver: "@minh",
    permissions: o.perms,
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
  onTestFinished(async () => {
    await terminal.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const tools = terminal.tools()
  return {
    terminal,
    dir,
    /** Calls tool `name` with `args`, as yian would: with a fresh call id unless given. */
    call: (name: keyof typeof tools, args: Record<string, unknown>, options: { callId?: string; signal?: AbortSignal } = {}) =>
      tools[name].call(args, { callId: options.callId ?? `r/n/${++calls}/0`, ...(options.signal ? { signal: options.signal } : {}) }),
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
