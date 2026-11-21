/** A Codex instrument's record, in the host's folder for it: `meta.json` (who and what the session is, and its state),
 *  `conversation.log` (what each speaker said, each message labelled with its author) and `trace.log` (everything
 *  Codex did: the messages, each command with its output, each file change with its diff, each error).
 *
 *  Messages are written once they settle, at the end of the turn that holds them. In the files a label is yian's author
 *  wrapper (`authoredText`), and every text Codex or a command wrote is escaped, so nothing in them poses as another
 *  speaker's message. The instrument reads the newest part of both back as entries (`Said`), each with the author the
 *  office knows, never one read from a text. The record scrubs nothing. Its files are private to the owner, in a folder
 *  of mode 0700.
 *
 *  A session cut off by an office stop is marked interrupted at the next start (`markInterrupted`). */
import fs from "node:fs"
import path from "node:path"
import { authoredText, escapeAuthorTags } from "@ngocbh/yian"
import { type Message, now, type ToolPart } from "@opencorp/protocol"
import { readRegular } from "../../util/files.ts"
import { checkFolder, makePrivateFolder, replaceFile } from "../../util/private_files.ts"
import { COMMAND, FILE_CHANGE, MCP_TOOL } from "./translate.ts"

/** Who and what a Codex session is, as its instrument starts it: its session's id, its name, who drives it, and the
 *  chat it is the instrument of. */
export interface CodexRecordMeta {
  id: string
  name: string
  kind: "codex"
  profile: "harness"
  driver: string
  chat: string
  started: string
}

/** A session's state in its record: running until it ends or fails, or until a start finds it cut off. */
export type CodexRecordState = "running" | "ended" | "failed" | "interrupted"

/** What a record's meta.json holds; `error` says why the session failed, `writeError` why a log stopped short. */
export interface CodexRecordFile extends CodexRecordMeta {
  state: CodexRecordState
  ended?: string
  error?: string
  writeError?: string
}

/** One entry of the conversation or the trace: who said or did it (the author the office knows: the employee, the
 *  owner, or `codex`), its text as written, and where it starts, counted in UTF-16 code units of every entry's text
 *  from the session's start. */
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
/** What Codex's messages are labelled with in the files, and who wrote them in the entries. */
export const CODEX_LABEL = "Codex"
export const CODEX_AUTHOR = "codex"

const metaText = (file: CodexRecordFile): string => `${JSON.stringify(file, null, 2)}\n`

/** One Codex session's record; its instrument is the folder's only writer. The newest part of the conversation and of
 *  the trace is kept in memory too, as entries, for the instrument's replies. */
export class CodexRecord {
  /** What each speaker said: the employee's, the owner's and Codex's words. */
  readonly conversation: Kept
  /** Everything: each message's words, and each tool Codex ran, as `codex`'s. */
  readonly trace: Kept
  private readonly file: CodexRecordFile
  private readonly logs: { conversation: number | null; trace: number | null }

  /** Makes `dir` (mode 0700), empty conversation.log and trace.log, and meta.json (all 0600). Throws when `dir` is a
   *  symlink, isn't private to this user, or already holds a record. */
  constructor(
    readonly dir: string,
    meta: Omit<CodexRecordMeta, "kind" | "profile">,
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
      this.file = { id, name, kind: "codex", profile: "harness", driver, chat, started, state: "running" }
      this.save()
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** The record's state. */
  get state(): CodexRecordState {
    return this.file.state
  }

  /** Appends the settled `messages`, in order: each one's words to the conversation, its author named by
   *  `label(author)` (Codex's as `codex`), and everything in it to the trace. Never throws: a failed write stops that
   *  log's file, and meta.json says why. */
  add(messages: readonly Message[], label: (author: string | null) => string): void {
    for (const message of messages) {
      const user = message.role === "user"
      const author = user ? label(message.author ?? null) : CODEX_AUTHOR
      const tag = user ? author : CODEX_LABEL
      const said = words(message)
      if (said !== "") {
        this.conversation.push(author, said)
        this.write("conversation", `${authoredText(tag, said)}\n\n`)
        this.trace.push(author, said)
        this.write("trace", `${authoredText(tag, said)}\n\n`)
      }
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const text = toolText(part)
        this.trace.push(CODEX_AUTHOR, text)
        this.write("trace", `${escapeAuthorTags(text)}\n\n`)
      }
    }
  }

  /** Ends the record as `state`, with `error` saying why when there is one. An ended record changes no more. */
  end(state: Exclude<CodexRecordState, "running">, error?: string | null): void {
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

/** A tool part as the trace shows it: what Codex ran and what came of it. */
function toolText(part: ToolPart): string {
  const input = part.input as Record<string, any>
  const state = part.state === "completed" ? "" : ` (${part.state}${part.error ? `: ${part.error}` : ""})`
  if (part.tool === COMMAND) {
    const exit = input.exit_code == null ? "" : ` (exit ${input.exit_code})`
    return `[command${state}] $ ${input.command}${exit}\n${textOf(part.output)}`.trimEnd()
  }
  if (part.tool === FILE_CHANGE) {
    const changes: Record<string, any>[] = Array.isArray(input.changes) ? input.changes : []
    return changes
      .map((c) => `[file change${state}] ${c.path}${c.move_path ? ` → ${c.move_path}` : ""} (${c.kind})\n${c.diff ?? ""}`)
      .join("\n")
      .trimEnd()
  }
  if (part.tool === MCP_TOOL) {
    return `[mcp${state}] ${input.server}/${input.tool} ${JSON.stringify(input.arguments ?? null)}\n${textOf(part.output)}`
      .trimEnd()
  }
  return `[${part.tool}${state}] ${JSON.stringify(input)}`
}

/** A part's output as text. */
function textOf(output: unknown): string {
  if (typeof output === "string") return output
  if (output === null || output === undefined) return ""
  if (typeof output === "object" && Object.keys(output).length === 0) return ""
  return JSON.stringify(output)
}

/** Whether `value` is a Codex record's meta.json. */
function isRecordFile(value: unknown): value is CodexRecordFile {
  if (typeof value !== "object" || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file.kind === "codex" &&
    ["id", "name", "profile", "driver", "chat", "started"].every((key) => typeof file[key] === "string") &&
    STATES.has(file.state as string)
  )
}

/** The record in `dir`, read from its meta.json; null when `dir` holds none (no private folder, no meta.json, or one
 *  that isn't a Codex record's). */
export function readCodexRecord(dir: string): CodexRecordFile | null {
  try {
    checkFolder(dir, "record folder")
    const bytes = readRegular(path.join(dir, META), META_MAX)
    if (bytes === null) return null
    const parsed: unknown = JSON.parse(bytes.toString("utf8"))
    return isRecordFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Marks the record in `dir` interrupted if it is still running: the office stopped while the session ran. Whether it
 *  marked it. */
export function markInterrupted(dir: string): boolean {
  const file = readCodexRecord(dir)
  if (file === null || file.state !== "running") return false
  file.state = "interrupted"
  file.ended = now()
  replaceFile(dir, META, metaText(file))
  return true
}
