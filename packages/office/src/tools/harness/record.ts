/** A harness instrument's record (a Codex or a Claude Code session's), in the host's folder for it: `meta.json` (who
 *  and what the session is, and its state), `conversation.log` (what each speaker said, each message labelled with its
 *  author) and `trace.log` (everything the harness did: the messages, each tool it ran with what came of it, each
 *  error).
 *
 *  Messages are written once they settle, at the end of the turn that holds them. In the files a label is yian's author
 *  wrapper (`authoredText`), and every text the harness or a command wrote is escaped, so nothing in them poses as
 *  another speaker's message. The instrument reads the newest part of both back as entries (`Said`), each with the
 *  author the office knows, never one read from a text. The record scrubs nothing. Its files are private to the owner,
 *  in a folder of mode 0700.
 *
 *  A session cut off by an office stop is marked interrupted at the next start (`markInterrupted`). */
import fs from "node:fs"
import path from "node:path"
import { authoredText, escapeAuthorTags } from "@ngocbh/yian"
import { type Message, now } from "@opencorp/protocol"
import { readRegular } from "../../util/files.ts"
import { checkFolder, makePrivateFolder, replaceFile } from "../../util/private_files.ts"
import type { Harness } from "./tools.ts"

/** Who and what a harness session is, as its instrument starts it: its session's id, its name, who drives it, and the
 *  chat it is the instrument of. */
export interface RecordMeta {
  id: string
  name: string
  kind: Harness["kind"]
  profile: "harness"
  driver: string
  chat: string
  started: string
}

/** A session's state in its record: running until it ends or fails, or until a start finds it cut off. */
export type RecordState = "running" | "ended" | "failed" | "interrupted"

/** What a record's meta.json holds; `error` says why the session failed, `writeError` why a log stopped short. */
export interface RecordFile extends RecordMeta {
  state: RecordState
  ended?: string
  error?: string
  writeError?: string
}

/** One entry of the conversation or the trace: who said or did it (the author the office knows: the employee, the
 *  owner, or the harness by its kind), its text as written, and where it starts, counted in UTF-16 code units of every
 *  entry's text from the session's start. */
export interface Said {
  readonly at: number
  readonly author: string
  readonly text: string
}

/** The most text of each of the conversation and the trace the record keeps in memory; the files keep all of it. */
export const KEEP_CHARS = 1024 * 1024

/** The newest entries of a log, at most `KEEP_CHARS` of their text, and where the log ends. */
export class Kept {
  readonly entries: Said[] = []
  /** Where the next entry starts: every entry's text so far. */
  end = 0
  private kept = 0

  constructor(private readonly keep = KEEP_CHARS) {}

  push(author: string, text: string): void {
    this.entries.push({ at: this.end, author, text })
    this.end += text.length
    this.kept += text.length
    // The newest entry stays, however long.
    while (this.kept > this.keep && this.entries.length > 1) this.kept -= this.entries.shift()!.text.length
  }

  /** Where the first entry kept starts. */
  get start(): number {
    return this.entries[0]?.at ?? this.end
  }
}

const META = "meta.json"
const CONVERSATION = "conversation.log"
const TRACE = "trace.log"
/** The largest meta.json read. */
const META_MAX = 1024 * 1024
const STATES = new Set<string>(["running", "ended", "failed", "interrupted"])

const metaText = (file: RecordFile): string => `${JSON.stringify(file, null, 2)}\n`

/** One harness session's record; its instrument is the folder's only writer. The newest part of the conversation and
 *  of the trace is kept in memory too, as entries, for the instrument's replies. */
export class HarnessRecord {
  /** What each speaker said: the employee's, the owner's and the harness's words. */
  readonly conversation: Kept
  /** Everything: each message's words, and each tool the harness ran, as the harness's. */
  readonly trace: Kept
  private readonly file: RecordFile
  private readonly logs: { conversation: number | null; trace: number | null }

  /** Makes `dir` (mode 0700), empty conversation.log and trace.log, and meta.json (all 0600), for a session of
   *  `harness`. Throws when `dir` is a symlink, isn't private to this user, or already holds a record. */
  constructor(
    private readonly harness: Harness,
    readonly dir: string,
    meta: Omit<RecordMeta, "kind" | "profile">,
    { keep = KEEP_CHARS }: { keep?: number } = {},
  ) {
    this.conversation = new Kept(keep)
    this.trace = new Kept(keep)
    makePrivateFolder(dir)
    checkFolder(dir, "record folder")
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_APPEND } = fs.constants
    // O_EXCL: a record is never written over another's.
    const open = (name: string) => {
      const fd = fs.openSync(path.join(dir, name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_APPEND, 0o600)
      fs.fchmodSync(fd, 0o600) // the umask may have narrowed it
      return fd
    }
    this.logs = { conversation: open(CONVERSATION), trace: null }
    try {
      this.logs.trace = open(TRACE)
      const { id, name, driver, chat, started } = meta
      this.file = { id, name, kind: harness.kind, profile: "harness", driver, chat, started, state: "running" }
      this.save()
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** The record's state. */
  get state(): RecordState {
    return this.file.state
  }

  /** Appends the settled `messages`, in order: each one's words to the conversation, its author named by
   *  `label(author)` (the harness's by its kind), and everything in it to the trace. Never throws: a failed write
   *  stops that log's file, and meta.json says why. */
  add(messages: readonly Message[], label: (author: string | null) => string): void {
    const { kind, title } = this.harness
    for (const message of messages) {
      const user = message.role === "user"
      const author = user ? label(message.author ?? null) : kind
      const tag = user ? author : title
      const said = words(message)
      if (said !== "") {
        this.conversation.push(author, said)
        this.write("conversation", `${authoredText(tag, said)}\n\n`)
        this.trace.push(author, said)
        this.write("trace", `${authoredText(tag, said)}\n\n`)
      }
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const text = this.harness.toolText(part)
        this.trace.push(kind, text)
        this.write("trace", `${escapeAuthorTags(text)}\n\n`)
      }
    }
  }

  /** Ends the record as `state`, with `error` saying why when there is one. An ended record changes no more. */
  end(state: Exclude<RecordState, "running">, error?: string | null): void {
    if (this.file.state !== "running") return
    this.close()
    this.file.state = state
    this.file.ended = now()
    if (error) this.file.error = error
    try {
      this.save()
    } catch {
      // The disk may be full: the state stays in memory, and the next start marks a running record interrupted.
    }
  }

  /** Appends `text` to `log`'s file; a failed write stops the file. */
  private write(log: "conversation" | "trace", text: string): void {
    const fd = this.logs[log]
    if (fd === null) return
    try {
      const bytes = Buffer.from(text, "utf8")
      for (let at = 0; at < bytes.length; ) at += fs.writeSync(fd, bytes, at)
    } catch (error) {
      this.file.writeError ??= `${log === "conversation" ? CONVERSATION : TRACE}: ${(error as Error).message}`
      this.logs[log] = null
      try {
        fs.closeSync(fd)
      } catch {}
      try {
        this.save()
      } catch {}
    }
  }

  private save(): void {
    replaceFile(this.dir, META, metaText(this.file))
  }

  /** Closes both logs for good. */
  private close(): void {
    for (const log of ["conversation", "trace"] as const) {
      const fd = this.logs[log]
      this.logs[log] = null
      if (fd === null) continue
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

/** What a message says, as a person reads it: its texts, and why a turn failed. */
function words(message: Message): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : part.type === "error" ? [`[error] ${part.message}`] : []))
    .join("\n\n")
    .trim()
}

/** A part's output as text. */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output
  if (output === null || output === undefined) return ""
  if (typeof output === "object" && Object.keys(output).length === 0) return ""
  return JSON.stringify(output)
}

/** Whether `value` is the meta.json of a `kind` session's record. */
function isRecordFile(value: unknown, kind: Harness["kind"]): value is RecordFile {
  if (typeof value !== "object" || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file.kind === kind &&
    ["id", "name", "profile", "driver", "chat", "started"].every((key) => typeof file[key] === "string") &&
    STATES.has(file.state as string)
  )
}

/** The record of a `kind` session in `dir`, read from its meta.json; null when `dir` holds none (no private folder,
 *  no meta.json, or one that isn't such a record's). */
export function readRecord(dir: string, kind: Harness["kind"]): RecordFile | null {
  try {
    checkFolder(dir, "record folder")
    const bytes = readRegular(path.join(dir, META), META_MAX)
    if (bytes === null) return null
    const parsed: unknown = JSON.parse(bytes.toString("utf8"))
    return isRecordFile(parsed, kind) ? parsed : null
  } catch {
    return null
  }
}

/** Marks the record of a `kind` session in `dir` interrupted if it is still running: the office stopped while the
 *  session ran. Whether it marked it. */
export function markRecordInterrupted(dir: string, kind: Harness["kind"]): boolean {
  const file = readRecord(dir, kind)
  if (file === null || file.state !== "running") return false
  file.state = "interrupted"
  file.ended = now()
  replaceFile(dir, META, metaText(file))
  return true
}
