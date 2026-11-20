/** An employee's terminal: the pipes shell a main chat's commands run in, in its workspace's sandbox. Each shell is
 *  listed as the session's instrument, which the owner watches and stops, with its record in the session's
 *  `terminal/` folder; every command goes through the permissions of the run whose tools were last built (its mode,
 *  rules, Auto's check and cards); and each command the gate holds or refuses, and each one that ran, once it ends, is
 *  an audit row of the session's. */
import path from "node:path"
import { now } from "@opencorp/protocol"
import type { ApprovalCard, CheckInput, Mode, Permissions, Where } from "../../runtime/permissions/policy.ts"
import type { Instruments } from "../../runtime/sessions/instruments.ts"
import type { Store } from "../../runtime/store/store.ts"
import { shellInstrument } from "../../tools/terminal/instrument.ts"
import { InstrumentRecord } from "../../tools/terminal/record.ts"
import {
  Terminal, type TerminalAudit, type TerminalProfile, type TerminalShells,
} from "../../tools/terminal/terminal.ts"
import { newId } from "../../util/ids.ts"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"
import { DETAIL_CHARS, repr } from "../../util/redact.ts"

/** The base `where` the terminal reads a shell's over: none of it but its credentials (none) counts, since the
 *  terminal takes the profile, folder and writable paths from the shells' sandbox. Fixed, so a shell's start never
 *  reads back through the session's actor, whose own `where` is the terminal's. */
const BASE: Where = { profile: "workspace", cwd: null, writable: [] }

/** What a command decides by before any run's permissions are bound: everything asks, and nothing can hold it. */
const UNBOUND = "no run of this session is bound to its terminal yet"

/** What an employee's terminal is made from; the agent sets none of it. */
export interface EmployeeTerminalOptions {
  /** The workspace's pipes (`WorkspaceTools.pipes`). */
  readonly shells: Extract<TerminalShells, { kind: "pipes" }>
  readonly sessionId: string
  /** The employee: who drives the shells, and whose audit rows they are. */
  readonly person: string
  /** The session's folder; the shells' records go to its `terminal/<shell id>/`. */
  readonly folder: string
  /** The office's live instruments, where each shell is listed. */
  readonly instruments: Pick<Instruments, "add" | "updated" | "output" | "remove">
  /** Where the audit rows go. */
  readonly store: Pick<Store, "recordAudit">
  /** The session's mode, as stored now: what a reply reads before any run's permissions are bound. */
  mode(): Mode
}

/** A main chat's terminal, as its harness binds it (see the module). */
export class EmployeeTerminal {
  readonly #terminal: Terminal
  readonly #o: EmployeeTerminalOptions
  /** The shells listed now, by id. */
  readonly #listed = new Set<string>()
  /** The run whose tools were last built: its permissions gate the agent's commands, and its id is the audit rows'. */
  #runId: string | null = null
  #permissions: Permissions | null = null

  constructor(o: EmployeeTerminalOptions) {
    this.#o = o
    this.#terminal = new Terminal({
      shells: o.shells,
      driver: o.person,
      permissions: this.#forwarded(),
      shellHost: (name, profile) => this.#shellHost(name, profile),
      audit: (row) => this.#audit(row),
    })
  }

  /** The model-facing tools: the `terminal` group. */
  tools(): ReturnType<Terminal["tools"]> {
    return this.#terminal.tools()
  }

  /** Binds run `runId` as the one whose tools are being built: `permissions` gate its commands from now, and its
   *  audit rows name it. */
  bind(runId: string, permissions: Permissions): void {
    this.#runId = runId
    this.#permissions = permissions
  }

  /** Runs held call `tool` of run `runId` once its card said Yes, approved as `credit` says (`approved by @<who>`, or
   *  what rule allows it): no gate, and only `signal` ends its wait, which then stops its command. */
  runApproved(
    tool: string,
    args: Record<string, unknown>,
    o: { runId: string; signal: AbortSignal; credit: string },
  ): Promise<string> {
    this.#runId = o.runId
    return this.#terminal.runApproved(tool, args, o.signal, o.credit)
  }

  /** Where a new shell's commands run, as the gate reads it: what the approvals decide a held card again by. */
  where(): Where {
    return this.#terminal.where()
  }

  /** Cuts off the agent's calls now (`Terminal.interruptWaits`): the commands they waited on stop. */
  interruptWaits(): void {
    this.#terminal.interruptWaits()
  }

  /** Ends every shell and its record, and removes each listing. */
  async close(): Promise<void> {
    try {
      await this.#terminal.close()
    } finally {
      for (const id of [...this.#listed]) this.#o.instruments.remove(this.#o.sessionId, id)
      this.#listed.clear()
    }
  }

  /** The shells, as the terminal lists them. */
  shells(): ReturnType<Terminal["shells"]> {
    return this.#terminal.shells()
  }

  /** The session's permissions, forwarded to the bound run's, but for `where`: the fixed base. */
  #forwarded(): Permissions {
    const bound = () => this.#permissions
    return {
      mode: () => bound()?.mode() ?? this.#o.mode(),
      rules: () => bound()?.rules() ?? [],
      where: () => ({ ...BASE }),
      hold: (card: ApprovalCard, callId: string) => bound()?.hold(card, callId) ?? `Not run: ${UNBOUND}.`,
      check: (input: CheckInput, signal: AbortSignal) => {
        const permissions = bound()
        return permissions?.check ? permissions.check(input, signal) : Promise.reject(new Error(UNBOUND))
      },
      blocked: () => {
        const permissions = bound()
        return permissions === null ? UNBOUND : (permissions.blocked?.() ?? null)
      },
    }
  }

  /** A new shell's record in `<folder>/terminal/<id>/`, and its listing as the session's instrument. */
  #shellHost(name: string, profile: TerminalProfile) {
    const { folder, sessionId, person, instruments } = this.#o
    const records = path.join(folder, "terminal")
    for (const dir of [folder, records]) {
      makePrivateFolder(dir)
      checkFolder(dir, "folder")
    }
    const id = newId()
    const record = new InstrumentRecord(path.join(records, id), {
      id, name, kind: "terminal", profile, driver: person, started: now(),
    })
    const terminal = this.#terminal
    const shell = () => terminal.shell(id)
    const listing = shellInstrument({ sessionId, id, name, driver: person, profile, interactive: false, shell })
    instruments.add(sessionId, listing)
    this.#listed.add(id)
    return {
      id,
      record,
      changed: () => instruments.updated(sessionId, id),
      output: (chunk: Uint8Array) => instruments.output(sessionId, id, chunk),
    }
  }

  /** Writes `row` as the session's audit row: `workspace` kind, the tool the model called, the command and shell,
   *  and why it was held or refused, or how it ended (`exit=<n> duration=<s>s <what let it run>`). */
  #audit(row: TerminalAudit): void {
    const detail = "reason" in row
      ? row.reason
      : `exit=${row.exit ?? "None"} duration=${row.duration.toFixed(3)}s ${row.why}`
    this.#o.store.recordAudit({
      person: this.#o.person,
      kind: "workspace",
      tool: row.tool,
      args: { summary: `command=${repr(row.text)}`, shell: row.shell },
      outcome: row.outcome,
      sessionId: this.#o.sessionId,
      runId: this.#runId,
      detail: detail.slice(0, DETAIL_CHARS),
    })
  }
}
