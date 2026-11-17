/** A terminal's record, in the host's folder for it: `meta.json` (who and what the shell is, the commands it ran
 *  with their exits, and its state) and `output.log` (the model's view of it, appended).
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

/** A command the shell ran: what, who ran it, when, and its exit code once it ended (null for none, as when a signal
 *  ended it). No `exit` means it never ended in the record: still running, or cut off. */
export interface RecordedCommand {
  command: string
  by: string
  at: string
  exit?: number | null
}

/** What a record's meta.json holds. `error` says why a shell failed or ended; `outputError` says why output.log
 *  stopped short. */
export interface RecordFile extends RecordMeta {
  state: RecordState
  commands: RecordedCommand[]
  ended?: string
  error?: string
  outputError?: string
}

const META = "meta.json"
const OUTPUT = "output.log"

/** The largest meta.json `recoverRecords` reads: a shell runs a few thousand commands of at most a few KiB. */
const META_MAX = 64 * 1024 * 1024

/** `file` as meta.json's text. */
const metaText = (file: RecordFile): string => `${JSON.stringify(file, null, 2)}\n`

/** One shell's record. Its host is the folder's only writer: it makes one record per shell, and `recoverRecords`
 *  runs at the host's start, before any shell. Each call throws when meta.json can't be written; a failed write to
 *  output.log doesn't throw, and the shell goes on. */
export class InstrumentRecord {
  private readonly file: RecordFile
  /** output.log, open for appending until the record ends or a write to it fails. */
  private output: number | null

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
      this.closeOutput()
      throw error
    }
  }

  /** Records that `by` ran `command`. */
  command(command: string, by: string): void {
    if (this.file.state !== "running") return
    this.file.commands.push({ command, by, at: now() })
    this.save()
  }

  /** Records the exit code of the last command (null when it has none). Nothing changes when that command already
   *  has one, or there is none, as when the owner's own command ends. */
  exit(code: number | null): void {
    const last = this.file.commands.at(-1)
    if (this.file.state !== "running" || last === undefined || last.exit !== undefined) return
    last.exit = code
    this.save()
  }

  /** Appends `text` to output.log: the model's view's text (`ModelView`), in order, and nothing else. A write that
   *  fails stops output.log, and meta.json says why. */
  append(text: string): void {
    if (this.output === null || text === "") return
    try {
      const bytes = Buffer.from(text, "utf8")
      for (let at = 0; at < bytes.length; ) at += fs.writeSync(this.output, bytes, at)
    } catch (error) {
      this.closeOutput()
      this.file.outputError = (error as Error).message
      this.save()
    }
  }

  /** Ends the record as `state`, with `error` saying why when there is one. output.log is complete and closed before
   *  meta.json says so. An ended record changes no more. */
  end(state: Exclude<RecordState, "running">, error?: string): void {
    if (this.file.state !== "running") return
    if (this.output !== null) {
      try {
        fs.fsyncSync(this.output)
      } catch (failed) {
        this.file.outputError = (failed as Error).message
      }
    }
    this.closeOutput()
    this.file.state = state
    this.file.ended = now()
    if (error !== undefined) this.file.error = error
    this.save()
  }

  /** Replaces meta.json with the record's state. */
  private save(): void {
    replaceFile(this.dir, META, metaText(this.file))
  }

  /** Closes output.log, if open. */
  private closeOutput(): void {
    if (this.output === null) return
    const fd = this.output
    this.output = null
    fs.closeSync(fd)
  }
}

/** Marks each record in `dir`'s folders that is still running as interrupted: its host stopped while the shell ran.
 *  Run at the host's start, before any shell. Folders that aren't a record's, or whose meta.json doesn't read, are
 *  left alone; a missing `dir` holds none. */
export function recoverRecords(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  for (const name of names) {
    const folder = path.join(dir, name)
    try {
      checkFolder(folder, "record folder")
    } catch {
      continue // a file, a symlink, or a folder that isn't a record's
    }
    let file: RecordFile
    try {
      const bytes = readRegular(path.join(folder, META), META_MAX)
      if (bytes === null) continue
      file = JSON.parse(bytes.toString("utf8"))
    } catch {
      continue
    }
    // The kind keeps it off another folder's meta.json.
    if (typeof file !== "object" || file === null || file.kind !== "terminal" || file.state !== "running") continue
    file.state = "interrupted"
    replaceFile(folder, META, metaText(file))
  }
}
