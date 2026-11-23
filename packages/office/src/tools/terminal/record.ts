/** A terminal's record, in the host's folder for it: `meta.json` (who and what the shell is, the commands it ran
 *  with their exits, and its state) and `output.log` (the model's view of it, as its text becomes final).
 *
 *  The record is the screen as it is: what the owner types and the terminal echoes is in it, as on screen; input the
 *  program doesn't echo, as at a password prompt, never reaches the view, so it is in neither file. The record takes
 *  no keystrokes and scrubs nothing. Both files are private to the owner, in a folder of mode 0700.
 *
 *  A shell cut off by its host's stop is marked interrupted at the host's next start (`recoverRecords`), and never
 *  run again. */
import fs from "node:fs"
import path from "node:path"
import { now } from "@opencorp/protocol"
import { readRegular } from "../../util/files.ts"
import { checkFolder, makePrivateFolder, replaceFile } from "../../util/private_files.ts"
import type { ModelView } from "./output.ts"

/** Who and what a shell is, as its host starts it. */
export interface RecordMeta {
  id: string
  name: string
  kind: "terminal"
  profile: string
  driver: string
  started: string
}

/** A shell's state in its record: running until its host ends it, or until a start finds it cut off. */
export type RecordState = "running" | "ended" | "failed" | "interrupted"

/** A command the shell ran: what, who ran it, when, the yian call that ran it and that call's run (when it has one),
 *  and its exit code once it ended (null for none, as when a signal ended it). No `exit` means it never ended in the
 *  record: still running, or cut off. `told` is the key of the note the agent is owed of its end, once its reply said
 *  it runs on, until something else told the agent of it. */
export interface RecordedCommand {
  command: string
  by: string
  at: string
  call?: string
  run?: string
  exit?: number | null
  told?: string
}

/** What a record's meta.json holds. `error` says why a shell failed or ended; `closedBy` names the person who closed
 *  it from their client, the owner; `outputError` says why output.log stopped short. */
export interface RecordFile extends RecordMeta {
  state: RecordState
  commands: RecordedCommand[]
  ended?: string
  error?: string
  closedBy?: string
  outputError?: string
}

/** A record's meta.json is there, but isn't a record's. */
export class RecordError extends Error {
  override name = "RecordError"
}

const META = "meta.json"
const OUTPUT = "output.log"

/** The largest meta.json a record is read from: a shell runs a few thousand commands of at most a few KiB. A larger
 *  one is an error, never read. */
export const META_MAX = 64 * 1024 * 1024

const STATES = new Set<string>(["running", "ended", "failed", "interrupted"])

/** `file` as meta.json's text. */
const metaText = (file: RecordFile): string => `${JSON.stringify(file, null, 2)}\n`

const isText = (value: unknown): value is string => typeof value === "string"

/** Whether `value` is a command as meta.json holds it. */
function isCommand(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const { command, by, at, call, run, exit, told } = value as Record<string, unknown>
  return (
    isText(command) &&
    isText(by) &&
    isText(at) &&
    (call === undefined || isText(call)) &&
    (run === undefined || isText(run)) &&
    (exit === undefined || exit === null || typeof exit === "number") &&
    (told === undefined || isText(told))
  )
}

/** Whether `value` is a terminal's record, as meta.json holds it. */
function isRecordFile(value: unknown): value is RecordFile {
  if (typeof value !== "object" || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file.kind === "terminal" &&
    ["id", "name", "profile", "driver", "started"].every((key) => isText(file[key])) &&
    ["ended", "error", "closedBy", "outputError"].every((key) => file[key] === undefined || isText(file[key])) &&
    STATES.has(file.state as string) &&
    Array.isArray(file.commands) &&
    file.commands.every(isCommand)
  )
}

/** One shell's record. Its host is the folder's only writer: it makes one record per shell, and `recoverRecords`
 *  runs at the host's start, before any shell. `command`, `exit` and `end` throw when meta.json can't be written;
 *  the view's output never throws into the shell. */
export class InstrumentRecord {
  private readonly file: RecordFile
  /** output.log, open for appending until the record ends or a write to it fails. */
  private output: number | null
  /** The view whose text output.log holds (`follow`). */
  private view: ModelView | null = null
  /** How much of the view's text output.log holds, in its offsets: UTF-16 code units from the shell's start. */
  private written = 0

  /** Makes `dir` (mode 0700), an empty output.log and meta.json (both 0600). Throws when `dir` is a symlink, isn't
   *  private to this user, or already holds a record. */
  constructor(
    private readonly dir: string,
    meta: RecordMeta,
  ) {
    makePrivateFolder(dir)
    checkFolder(dir, "record folder")
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_APPEND } = fs.constants
    // O_EXCL: a record is never written over another's.
    this.output = fs.openSync(path.join(dir, OUTPUT), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_APPEND, 0o600)
    const { id, name, kind, profile, driver, started } = meta
    this.file = { id, name, kind, profile, driver, started, state: "running", commands: [] }
    try {
      fs.fchmodSync(this.output, 0o600) // the umask may have narrowed it
      this.save()
    } catch (error) {
      this.stopOutput()
      throw error
    }
  }

  /** Keeps `view`'s text in output.log: each line once it ends and a long line's head as the view drops it
   *  (`ModelView.onSettled`), then at `end` the unfinished last line, as it is. A redrawn line is in it once, as it
   *  ended, and output.log is the view's text at the view's offsets. Throws unless `view` is new and the record
   *  follows no other. */
  follow(view: ModelView): void {
    if (this.view !== null || view.length > 0) throw new Error("a record follows one view, from its start")
    this.view = view
    view.onSettled((text) => this.write(text))
  }

  /** Records that `by` ran `command`, for yian call `callId` (`<run>/...`) when it has one: a command line the agent
   *  runs, never the owner's keys, which no record takes. Throws, recording nothing, when meta.json can't be written. */
  command(command: string, by: string, callId?: string): void {
    if (this.file.state !== "running") return
    const slash = callId?.indexOf("/") ?? -1
    const call = callId === undefined ? {} : { call: callId, run: slash < 0 ? callId : callId.slice(0, slash) }
    this.file.commands.push({ command, by, at: now(), ...call })
    try {
      this.save()
    } catch (error) {
      this.file.commands.pop()
      throw error
    }
  }

  /** Records the exit code of the last command (null when it has none). Nothing changes when that command already
   *  has one, or there is none, as when the owner's own command ends. */
  exit(code: number | null): void {
    const last = this.file.commands.at(-1)
    if (this.file.state !== "running" || last === undefined || last.exit !== undefined) return
    last.exit = code
    this.save()
  }

  /** Records that the agent is owed a note, under `key`, of the last command's end: its reply said it runs on. */
  told(key: string): void {
    const last = this.file.commands.at(-1)
    if (this.file.state !== "running" || last === undefined) return
    last.told = key
    this.save()
  }

  /** Records that `by`, a person, closed the shell from their client; its end follows. */
  closedBy(by: string): void {
    if (this.file.state !== "running") return
    this.file.closedBy = by
    this.save()
  }

  /** Whether the record still takes writes: its shell hasn't ended. */
  get running(): boolean {
    return this.file.state === "running"
  }

  /** Records that the command owed the note under `key` needs none: something else told the agent of its end. */
  untold(key: string): void {
    const command = this.file.commands.find((c) => c.told === key)
    if (this.file.state !== "running" || command === undefined) return
    delete command.told
    this.save()
  }

  /** Ends the record as `state`, with `error` saying why when there is one. output.log gets the view's unfinished
   *  last line, and is complete and closed before meta.json says so. An ended record changes no more. */
  end(state: Exclude<RecordState, "running">, error?: string): void {
    if (this.file.state !== "running") return
    if (this.view !== null && this.view.length > this.written)
      this.write(this.view.page(this.written, this.view.length - this.written).output)
    if (this.output !== null) {
      try {
        fs.fsyncSync(this.output)
      } catch (failed) {
        this.file.outputError = (failed as Error).message
      }
    }
    this.stopOutput()
    this.file.state = state
    this.file.ended = now()
    if (error !== undefined) this.file.error = error
    this.save()
  }

  /** Appends `text`, the view's next final text, to output.log. Never throws, since it runs on the shell's output:
   *  a failed write stops output.log, and meta.json says why, now or at its next save. */
  private write(text: string): void {
    if (this.output === null || text === "") return
    try {
      const bytes = Buffer.from(text, "utf8")
      for (let at = 0; at < bytes.length; ) at += fs.writeSync(this.output, bytes, at)
      this.written += text.length
    } catch (error) {
      this.file.outputError = (error as Error).message
      this.stopOutput()
      try {
        this.save()
      } catch {
        // The disk may be full: the note stays in memory, and the next command, exit or end saves it.
      }
    }
  }

  /** Replaces meta.json with the record's state. */
  private save(): void {
    replaceFile(this.dir, META, metaText(this.file))
  }

  /** Closes output.log for good, if open; a failed close is noted as output.log's error. */
  private stopOutput(): void {
    if (this.output === null) return
    const fd = this.output
    this.output = null
    try {
      fs.closeSync(fd)
    } catch (error) {
      this.file.outputError ??= (error as Error).message
    }
  }
}

/** The record in `dir`, read from its meta.json and checked: the one way to read a record. Null when `dir` holds
 *  none: it isn't a folder private to this user, or has no meta.json. Throws `RecordError` when its meta.json isn't
 *  a record's: over `META_MAX` (left unread), not a regular file, unreadable, not JSON, or not a terminal's record. */
export function readRecord(dir: string): RecordFile | null {
  try {
    checkFolder(dir, "record folder")
  } catch {
    return null // a file, a symlink, a missing folder, or one that isn't private: no record's
  }
  const file = path.join(dir, META)
  let bytes: Buffer | null
  try {
    if (fs.lstatSync(file).size > META_MAX) throw new RecordError(`its meta.json is over ${META_MAX / 1024 / 1024} MiB`)
    // Null for a symlink, a FIFO, or a file grown past the cap since.
    bytes = readRegular(file, META_MAX)
  } catch (error) {
    if (error instanceof RecordError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new RecordError(`its meta.json can't be read: ${(error as Error).message}`)
  }
  if (bytes === null) throw new RecordError("its meta.json isn't a regular file within the cap")
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new RecordError("its meta.json isn't JSON")
  }
  if (!isRecordFile(parsed)) throw new RecordError("its meta.json isn't a terminal's record")
  return parsed
}

/** Records in the ended record in `dir` that the command owed the note under `key` needs none any more: the run has
 *  it. A record still running is its host's to write (`InstrumentRecord.untold`); one that isn't a record's, or owes no
 *  such note, is left as it is. */
export function clearTold(dir: string, key: string): void {
  let file: RecordFile | null
  try {
    file = readRecord(dir)
  } catch (error) {
    if (error instanceof RecordError) return
    throw error
  }
  const command = file?.commands.find((c) => c.told === key)
  if (file === null || file.state === "running" || command === undefined) return
  delete command.told
  replaceFile(dir, META, metaText(file))
}

/** Marks each record in `dir`'s folders that is still running as interrupted: its host stopped while the shell ran,
 *  and a command with no `exit` is one it cut off. A record is marked once. Run at the host's start, before any
 *  shell. Returns a line for
 *  each folder whose meta.json isn't a record's (`readRecord`'s `RecordError`, a meta.json over `META_MAX` among
 *  them), which it leaves as it is, for the host to log. Folders with no meta.json, and files, hold no record; a
 *  missing `dir` holds none. Throws when `dir` can't be read, or a record's meta.json can't be rewritten. */
export function recoverRecords(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const problems: string[] = []
  for (const name of names) {
    const folder = path.join(dir, name)
    let file: RecordFile | null
    try {
      file = readRecord(folder)
    } catch (error) {
      if (!(error instanceof RecordError)) throw error
      problems.push(`${folder}: ${error.message}`)
      continue
    }
    if (file === null || file.state !== "running") continue
    file.state = "interrupted"
    replaceFile(folder, META, metaText(file))
  }
  return problems
}
