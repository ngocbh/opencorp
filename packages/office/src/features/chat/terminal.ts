/** An employee's terminal: the pipes shell a main chat's commands run in, in its workspace's sandbox. Each shell is
 *  listed as the session's instrument, which the owner watches and stops, with its record in the session's
 *  `terminal/` folder (each command, who ran it, when, and its exit); every command goes through the office's gate of
 *  the run whose tools were last built (its mode, rules, Auto's check and cards), and acts on what that gate decided
 *  for it. Why a command ran or was refused is in that run's log. The note of a command the agent was told runs on,
 *  once it ends, goes to the session's actor (`onEnded`), and after a restart the actor holds a note of each one
 *  still owed (`restoreNotes`). */
import fs from "node:fs"
import path from "node:path"
import { now } from "@opencorp/protocol"
import type { Mode, Permissions, Where } from "../../runtime/permissions/policy.ts"
import type { Instruments } from "../../runtime/sessions/instruments.ts"
import { shellInstrument } from "../../tools/terminal/instrument.ts"
import { clearTold, InstrumentRecord, readRecord, RecordError } from "../../tools/terminal/record.ts"
import {
  type CommandEnded, type CommandPlan, restoredNote, Terminal, type TerminalProfile, type TerminalShells,
} from "../../tools/terminal/terminal.ts"
import { newId } from "../../util/ids.ts"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"

/** The base `where` the terminal reads a shell's over: none of it but its credentials (none) counts, since the
 *  terminal takes the profile, folder and writable paths from the shells' sandbox. Fixed, so a shell's start never
 *  reads back through the session's actor, whose own `where` is the terminal's. */
const BASE: Where = { profile: "workspace", cwd: null, writable: [] }

/** The notes a restart may have cost the session at `folder`: one (`restoredNote`) for each command of its terminal's
 *  records whose note the agent is still owed, oldest shell first, under that note's key, so a note the run already
 *  has is never sent twice, and signed by its shell's name. A record that can't be read gives none. */
export function restoreNotes(folder: string): { text: string; key: string; author: string }[] {
  const dir = path.join(folder, "terminal")
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files = names.flatMap((name) => {
    try {
      const file = readRecord(path.join(dir, name))
      return file === null ? [] : [file]
    } catch (error) {
      if (error instanceof RecordError) return []
      throw error
    }
  })
  files.sort((a, b) => a.started.localeCompare(b.started))
  return files.flatMap((file) =>
    file.commands.flatMap((command) =>
      command.told === undefined
        ? []
        : [{ text: restoredNote(file.name, command), key: command.told, author: file.name }],
    ),
  )
}

/** What an employee's terminal is made from; the agent sets none of it. */
export interface EmployeeTerminalOptions {
  /** The workspace's pipes (`WorkspaceTools.pipes`). */
  readonly shells: Extract<TerminalShells, { kind: "pipes" }>
  readonly sessionId: string
  /** The employee: who drives the shells. */
  readonly person: string
  /** The session's folder; the shells' records go to its `terminal/<shell id>/`. */
  readonly folder: string
  /** The office's live instruments, where each shell is listed. */
  readonly instruments: Pick<Instruments, "add" | "updated" | "output" | "remove">
  /** The session's mode, as stored now: what a reply reads before any run's permissions are bound. */
  mode(): Mode
}

/** A main chat's terminal, as its harness binds it (see the module). */
export class EmployeeTerminal {
  readonly #terminal: Terminal
  readonly #o: EmployeeTerminalOptions
  /** The shells listed now, by id. */
  readonly #listed = new Set<string>()
  /** The permissions of the run whose tools were last built: they gate the agent's commands. */
  #permissions: Permissions | null = null
  /** Who gets the notes of commands that ended: the session's actor. */
  #onEnded: ((note: CommandEnded) => void) | null = null
  /** The records of the shells it made, by shell id. */
  readonly #records = new Map<string, InstrumentRecord>()

  constructor(o: EmployeeTerminalOptions) {
    this.#o = o
    this.#terminal = new Terminal({
      shells: o.shells,
      driver: o.person,
      permissions: this.#forwarded(),
      shellHost: (name, profile) => this.#shellHost(name, profile),
      ended: (note) => this.#onEnded?.(note),
    })
  }

  /** Gives `listener` (the session's actor) the note of each command the agent was told runs on, once it ends; it
   *  replaces any listener before it. */
  onEnded(listener: (note: CommandEnded) => void): void {
    this.#onEnded = listener
  }

  /** The run has the note under `key` (`terminal:<shell id>:<n>`): the shell's record, this terminal's or one an
   *  earlier office left, owes it no more, so a restart never sends it again. */
  delivered(key: string): void {
    const shell = /^terminal:([^:/]+):\d+$/.exec(key)?.[1]
    if (shell === undefined) return
    const record = this.#records.get(shell)
    if (record?.running) record.untold(key)
    else clearTold(path.join(this.#o.folder, "terminal", shell), key)
  }

  /** The model-facing tools: the `terminal` group. */
  tools(): ReturnType<Terminal["tools"]> {
    return this.#terminal.tools()
  }

  /** Binds the permissions of the run whose tools are being built: they gate its commands from now. */
  bind(permissions: Permissions): void {
    this.#permissions = permissions
  }

  /** What the office's gate decides for the terminal's tool `tool` with `args`, read from its shells now
   *  (`Terminal.plan`). */
  plan(tool: string, args: Record<string, unknown>): CommandPlan {
    return this.#terminal.plan(tool, args)
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
      // The run's gate decides each command before it starts; with no run bound, nothing was decided.
      decided: (callId: string | undefined) => bound()?.decided(callId) ?? null,
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
    this.#records.set(id, record)
    const terminal = this.#terminal
    const shell = () => terminal.shell(id)
    const close = (by: string) => terminal.ownerClose(id, by)
    const listing = shellInstrument({ sessionId, id, name, driver: person, profile, interactive: false, shell, close })
    instruments.add(sessionId, listing)
    this.#listed.add(id)
    return {
      id,
      record,
      changed: () => instruments.updated(sessionId, id),
      output: (chunk: Uint8Array) => instruments.output(sessionId, id, chunk),
    }
  }
}
