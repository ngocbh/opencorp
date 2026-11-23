/** A harness instrument's record (a Codex or a Claude Code session's), in the host's folder for it: `meta.json` (who
 *  and what the session is, the harness's own id for it, the turn under way and where the driver last read, and its
 *  state), `conversation.log` (what each speaker said, each message labelled with its author) and `trace.log`
 *  (everything the harness did: the messages, each tool it ran with what came of it, each error). `conversation.jsonl`
 *  and `trace.jsonl` hold the same entries as JSON lines, each with where it starts, for a later office to load back
 *  (`loadRecord`). Beside the records, the folder's `instrument.json` keeps the number the next session's name takes.
 *
 *  Messages are written once they settle, at the end of the turn that holds them. In the `.log` files a label is yian's
 *  author wrapper (`authoredText`), and every text the harness or a command wrote is escaped, so nothing in them poses
 *  as another speaker's message. The instrument reads the newest part of both back as entries (`Said`), each with the
 *  author the office knows, never one read from a text. Memory, and the JSON lines a later office loads it from, keep a
 *  huge entry's head and tail; the `.log` files keep all of it. The record scrubs nothing. Its files are private to the
 *  owner, in a folder of mode 0700.
 *
 *  An office stop leaves a live session's record interrupted (`suspend`), and the next start marks one a crash left
 *  running so (`markRecordInterrupted`); the turn it cut off stays in meta.json. A later office goes on writing it once
 *  it continues the session (`resume`). meta.json also counts the session's turns, and keeps the key of the note the
 *  driver is owed of a turn's end (`told`), so a later office can send it after a restart. */
import fs from "node:fs"
import path from "node:path"
import { authoredText, escapeAuthorTags } from "@ngocbh/yian"
import { type Message, now } from "@opencorp/protocol"
import { strerror } from "../../util/errors.ts"
import { readRegular, tailRegular } from "../../util/files.ts"
import { PrivateFileError, checkFolder, makePrivateFolder, replaceFile } from "../../util/private_files.ts"
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

/** A session's state in its record: running until it ends or fails, or until an office stop or crash cuts it off
 *  (interrupted), from which a later office may run it again. */
export type RecordState = "running" | "ended" | "failed" | "interrupted"

/** The turn under way: who started it, as the author of the message that started it. */
export interface RecordTurn {
  by: string | null
}

/** What a record's meta.json holds; `error` says why the session failed, `writeError` why a log stopped short. */
export interface RecordFile extends RecordMeta {
  state: RecordState
  /** The harness's own id for the session, which a resume names: the Codex thread's, or the Claude Code session's. */
  harnessSessionId?: string
  /** The turn under way, while one runs: what an office stop or a crash cuts off. */
  turn?: RecordTurn
  /** How many turns the session has started: each turn's number, for its note's key. */
  turns?: number
  /** The key of the note the driver is owed of a turn's end, once a reply said the turn runs on, until the run has
   *  the note or something else told the driver of the end. */
  told?: string
  /** Where the driver last read the conversation. */
  read?: number
  ended?: string
  error?: string
  writeError?: string
}

/** One entry of the conversation or the trace: who said or did it (the author the office knows: the employee, the
 *  owner, or the harness by its kind), its text as memory keeps it (`Kept`), and where it starts, counted in UTF-16
 *  code units of every earlier entry's text as kept, from the session's start. */
export interface Said {
  readonly at: number
  readonly author: string
  readonly text: string
}

/** The most text of each of the conversation and the trace the record keeps in memory; the files keep all of it. */
export const KEEP_CHARS = 1024 * 1024
/** The most of one entry's text memory keeps: its head and its tail, each half of it. */
export const ENTRY_CHARS = 256 * 1024

/** The newest entries of a log, at most `KEEP_CHARS` of their text, and where the log ends. An entry over
 *  `ENTRY_CHARS` keeps only its head and tail, with a marker saying how much is left out between them. */
export class Kept {
  readonly entries: Said[] = []
  /** Where the next entry starts: every entry's text so far, as kept. */
  end = 0
  private kept = 0

  constructor(
    private readonly keep = KEEP_CHARS,
    private readonly entryMax = ENTRY_CHARS,
  ) {}

  /** The newest of `entries`, each starting where the one before ends, as a later office loads them back. */
  static restored(entries: readonly Said[], keep = KEEP_CHARS): Kept {
    const kept = new Kept(keep)
    const last = entries.at(-1)
    if (last === undefined) return kept
    for (const entry of entries) {
      kept.entries.push(entry)
      kept.kept += entry.text.length
    }
    kept.end = last.at + last.text.length
    kept.trim()
    return kept
  }

  /** Keeps `text`, by `author`, as the newest entry (its head and tail when it is huge), and returns it as kept. */
  push(author: string, text: string): string {
    const kept = headAndTail(text, this.entryMax)
    this.entries.push({ at: this.end, author, text: kept })
    this.end += kept.length
    this.kept += kept.length
    this.trim()
    return kept
  }

  /** Where the first entry kept starts. */
  get start(): number {
    return this.entries[0]?.at ?? this.end
  }

  private trim(): void {
    // The newest entry stays, at its kept length.
    while (this.kept > this.keep && this.entries.length > 1) this.kept -= this.entries.shift()!.text.length
  }
}

/** `text`, or when it is over `max` its first and last `max / 2` code units with a marker between saying how many are
 *  left out and how to get them; a cut never splits a surrogate pair. */
function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  let head = half
  let tail = text.length - half
  if (isHigh(text.charCodeAt(head - 1))) head -= 1
  if (isLow(text.charCodeAt(tail))) tail += 1
  // The record's files keep them, but the employee can't read those: the harness can still give them.
  const marker =
    `[… ${tail - head} characters left out here: ask the session for the part you need, or to save it to a file in ` +
    "the folder]"
  return `${text.slice(0, head)}\n\n${marker}\n\n${text.slice(tail)}`
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

const META = "meta.json"
/** A record's logs, and their entries as JSON lines. */
const FILES = {
  conversation: "conversation.log",
  trace: "trace.log",
  conversationEntries: "conversation.jsonl",
  traceEntries: "trace.jsonl",
} as const
type FileKey = keyof typeof FILES
type Log = "conversation" | "trace"
const ENTRIES = { conversation: "conversationEntries", trace: "traceEntries" } as const
/** The file beside the records that keeps the number the next session's name takes. */
const NAMES = "instrument.json"
/** The largest meta.json or instrument.json read. */
const META_MAX = 1024 * 1024
/** How much of a log's entries file a load reads, from its end, for each code unit kept: room for UTF-8 and JSON. */
const TAIL_PER_CHAR = 8
const STATES = new Set<string>(["running", "ended", "failed", "interrupted"])

const metaText = (file: RecordFile): string => `${JSON.stringify(file, null, 2)}\n`
const finishedState = (state: RecordState): boolean => state === "ended" || state === "failed"

/** One harness session's record; its instrument is the folder's only writer. The newest part of the conversation and
 *  of the trace is kept in memory too, as entries, for the instrument's replies. */
export class HarnessRecord {
  readonly #harness: Harness
  readonly #keep: number
  readonly #file: RecordFile
  /** Each log's entries in memory; a loaded record reads them from their file when first asked. */
  readonly #kept: Partial<Record<Log, Kept>> = {}
  /** The files open for appending; a loaded record opens each at its first write. */
  readonly #fds: Partial<Record<FileKey, number>> = {}
  /** The files a failed write stopped. */
  readonly #stopped = new Set<FileKey>()

  /** Makes `dir` (mode 0700), its empty logs and meta.json (all 0600), for a new session of `harness`. Throws when
   *  `dir` is a symlink, isn't private to this user, or already holds a record. `loaded` takes the record an earlier
   *  office left in `dir` instead, with that meta.json (`loadRecord`), and writes nothing. */
  constructor(
    harness: Harness,
    readonly dir: string,
    meta: Omit<RecordMeta, "kind" | "profile">,
    { keep = KEEP_CHARS, loaded }: { keep?: number; loaded?: RecordFile } = {},
  ) {
    this.#harness = harness
    this.#keep = keep
    if (loaded !== undefined) {
      this.#file = loaded
      return
    }
    makePrivateFolder(dir)
    checkFolder(dir, "record folder")
    try {
      // O_EXCL: a record is never written over another's.
      for (const key of Object.keys(FILES) as FileKey[]) this.#fds[key] = open(dir, FILES[key], fs.constants.O_EXCL)
      const { id, name, driver, chat, started } = meta
      this.#file = { id, name, kind: harness.kind, profile: "harness", driver, chat, started, state: "running" }
      this.#kept.conversation = new Kept(keep)
      this.#kept.trace = new Kept(keep)
      this.#save()
    } catch (error) {
      this.#close()
      throw error
    }
  }

  /** The record's state. */
  get state(): RecordState {
    return this.#file.state
  }

  /** What its meta.json holds. */
  get meta(): Readonly<RecordFile> {
    return this.#file
  }

  /** What each speaker said: the employee's, the owner's and the harness's words. */
  get conversation(): Kept {
    return this.#log("conversation")
  }

  /** Everything: each message's words, and each tool the harness ran, as the harness's. */
  get trace(): Kept {
    return this.#log("trace")
  }

  /** Appends the settled `messages`, in order: each one's words to the conversation, its author named by
   *  `label(author)` (the harness's by its kind), and everything in it to the trace. Never throws: a failed write
   *  stops that file, and meta.json says why. */
  add(messages: readonly Message[], label: (author: string | null) => string): void {
    const { kind, title } = this.#harness
    for (const message of messages) {
      const user = message.role === "user"
      const author = user ? label(message.author ?? null) : kind
      const said = words(message)
      if (said !== "") this.#said(author, user ? author : title, said)
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const text = this.#harness.toolText(part)
        this.#push("trace", kind, text, escapeAuthorTags(text))
      }
    }
  }

  /** Appends `text`, what the office says of the session, as the harness's entry. Never throws, as `add`. */
  note(text: string): void {
    this.#said(this.#harness.kind, this.#harness.title, text)
  }

  /** Keeps the harness's own id for the session, which a later office resumes it by. */
  setHarnessSession(id: string): void {
    if (this.#file.harnessSessionId === id) return
    this.#file.harnessSessionId = id
    this.#trySave()
  }

  /** Keeps the turn under way, or that none is (`null`); a turn that starts when none was under way is counted. */
  setTurn(turn: RecordTurn | null): void {
    const was = this.#file.turn
    if (turn === null ? was === undefined : was !== undefined && was.by === turn.by) return
    if (turn === null) delete this.#file.turn
    else {
      if (was === undefined) this.#file.turns = (this.#file.turns ?? 0) + 1
      this.#file.turn = { by: turn.by }
    }
    this.#trySave()
  }

  /** Keeps `key`, the note's the driver is owed of the turn under way, once a reply said it runs on. */
  told(key: string): void {
    if (this.#file.told === key) return
    this.#file.told = key
    this.#trySave()
  }

  /** The note under `key` is owed no more: the run has it, or something else told the driver of the turn's end. */
  untold(key: string): void {
    if (this.#file.told !== key) return
    delete this.#file.told
    this.#trySave()
  }

  /** Keeps where the driver last read the conversation. */
  setRead(at: number): void {
    if (this.#file.read === at) return
    this.#file.read = at
    this.#trySave()
  }

  /** The office stops, or a later one finds the record as a crash left it: the logs close, and a running record is
   *  interrupted until a later office continues it (`resume`), keeping the turn under way. A finished one is left as
   *  it is. Never throws. */
  suspend(): void {
    this.#close()
    if (this.#file.state !== "running") return
    this.#file.state = "interrupted"
    this.#file.ended = now()
    this.#trySave()
  }

  /** A later office continues the session: an interrupted record runs again, and its logs go on where they ended. A
   *  finished one is left as it is. Never throws. */
  resume(): void {
    if (this.#file.state !== "interrupted") return
    this.#file.state = "running"
    delete this.#file.ended
    this.#trySave()
  }

  /** Ends the record as `state`, with `error` saying why when there is one. An ended or failed record changes no more. */
  end(state: Exclude<RecordState, "running">, error?: string | null): void {
    if (finishedState(this.#file.state)) return
    this.#close()
    this.#file.state = state
    this.#file.ended = now()
    if (error) this.#file.error = error
    // The disk may be full: the state stays in memory, and the next start marks a running record interrupted.
    this.#trySave()
  }

  /** Each log's entries, read from its file the first time. */
  #log(log: Log): Kept {
    let kept = this.#kept[log]
    if (kept === undefined) {
      kept = readKept(path.join(this.dir, FILES[ENTRIES[log]]), this.#keep)
      this.#kept[log] = kept
    }
    return kept
  }

  /** Appends `text`, said by `author` and labelled `tag` in the files, to the conversation and the trace. */
  #said(author: string, tag: string, text: string): void {
    const shown = authoredText(tag, text)
    this.#push("conversation", author, text, shown)
    this.#push("trace", author, text, shown)
  }

  /** Appends an entry to `log`: in memory, `shown` to its file, and the entry as memory keeps it, with where it
   *  starts, to its JSON lines, so a later office loads back what this one kept. */
  #push(log: Log, author: string, text: string, shown: string): void {
    const kept = this.#log(log)
    const at = kept.end
    const said = kept.push(author, text)
    this.#write(log, `${shown}\n\n`)
    this.#write(ENTRIES[log], `${JSON.stringify({ at, author, text: said })}\n`)
  }

  /** Appends `text` to `key`'s file, opening it first if it isn't (an entries file a crash cut short goes on from a
   *  line of its own); a failed write stops the file, and a finished record writes nothing. */
  #write(key: FileKey, text: string): void {
    if (finishedState(this.#file.state) || this.#stopped.has(key)) return
    try {
      let fd = this.#fds[key]
      if (fd === undefined) {
        const cut = (key === ENTRIES.conversation || key === ENTRIES.trace) && cutShort(path.join(this.dir, FILES[key]))
        fd = open(this.dir, FILES[key], fs.constants.O_CREAT)
        this.#fds[key] = fd
        if (cut) text = `\n${text}`
      }
      const bytes = Buffer.from(text, "utf8")
      for (let at = 0; at < bytes.length; ) at += fs.writeSync(fd, bytes, at)
    } catch (error) {
      this.#file.writeError ??= `${FILES[key]}: ${strerror(error) ?? (error as Error).name}`
      this.#stopped.add(key)
      this.#closeFile(key)
      this.#trySave()
    }
  }

  #save(): void {
    replaceFile(this.dir, META, metaText(this.#file))
  }

  #trySave(): void {
    try {
      this.#save()
    } catch {
      // The disk may be full: what changed stays in memory, for the next save.
    }
  }

  /** Closes every file open. */
  #close(): void {
    for (const key of Object.keys(FILES) as FileKey[]) this.#closeFile(key)
  }

  #closeFile(key: FileKey): void {
    const fd = this.#fds[key]
    delete this.#fds[key]
    if (fd === undefined) return
    try {
      fs.closeSync(fd)
    } catch {}
  }
}

/** Opens `name` in `dir` to append to, never through a link, with `flags` (`O_EXCL` for a new file, `O_CREAT` to make
 *  a missing one), mode 0600. */
function open(dir: string, name: string, flags: number): number {
  const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_APPEND } = fs.constants
  const fd = fs.openSync(path.join(dir, name), O_WRONLY | O_CREAT | O_NOFOLLOW | O_APPEND | flags, 0o600)
  fs.fchmodSync(fd, 0o600) // the umask may have narrowed it
  return fd
}

/** Whether `file` holds text that doesn't end its last line: an append a crash cut off. */
function cutShort(file: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return false
  }
  try {
    const { size } = fs.fstatSync(fd)
    if (size === 0) return false
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    fs.closeSync(fd)
  }
}

/** The newest entries of a log, as its JSON lines keep them: read from the file's end, each starting where the one
 *  before ends. A line that doesn't parse (the last, when a crash cut it off) is skipped, and an entry that doesn't
 *  follow the one before starts the run again; an unreadable file keeps nothing. */
function readKept(file: string, keep: number): Kept {
  let text: string | null = null
  try {
    text = tailRegular(file, keep * TAIL_PER_CHAR)
  } catch {
    // Unreadable: the log starts over, empty.
  }
  const entries: Said[] = []
  for (const line of (text ?? "").split("\n")) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isSaid(entry)) continue
    const last = entries.at(-1)
    if (last !== undefined && last.at + last.text.length !== entry.at) entries.length = 0
    entries.push({ at: entry.at, author: entry.author, text: entry.text })
  }
  return Kept.restored(entries, keep)
}

/** Whether `value` is an entry as a log's JSON lines hold it. */
function isSaid(value: unknown): value is Said {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return isOffset(entry.at) && typeof entry.author === "string" && typeof entry.text === "string"
}

const isOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

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
  const turn = file.turn as Record<string, unknown> | null | undefined
  return (
    file.kind === kind &&
    ["id", "name", "profile", "driver", "chat", "started"].every((key) => typeof file[key] === "string") &&
    STATES.has(file.state as string) &&
    (file.harnessSessionId === undefined || (typeof file.harnessSessionId === "string" && file.harnessSessionId !== "")) &&
    (turn === undefined || (typeof turn === "object" && turn !== null && (turn.by === null || typeof turn.by === "string"))) &&
    (file.read === undefined || isOffset(file.read)) &&
    (file.turns === undefined || isOffset(file.turns)) &&
    (file.told === undefined || typeof file.told === "string")
  )
}

/** The meta.json of the `kind` session's record in `dir`. Throws, saying why, when there is none, or it isn't such a
 *  record's. */
function readMeta(dir: string, kind: Harness["kind"]): RecordFile {
  checkFolder(dir, "record folder")
  const bytes = readRegular(path.join(dir, META), META_MAX)
  if (bytes === null) throw new RecordRefused(`it has no ${META}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new RecordRefused(`its ${META} doesn't parse`)
  }
  if (!isRecordFile(parsed, kind)) throw new RecordRefused(`its ${META} isn't a ${kind} session's record`)
  return parsed
}

/** Why a folder's record isn't loaded, in words that name no path. */
export class RecordRefused extends Error {
  override name = "RecordRefused"
}

/** The record of a `kind` session in `dir`, read from its meta.json; null when `dir` holds none (no private folder,
 *  no meta.json, or one that isn't such a record's). */
export function readRecord(dir: string, kind: Harness["kind"]): RecordFile | null {
  try {
    return readMeta(dir, kind)
  } catch {
    return null
  }
}

/** The record of a `harness` session an earlier office left in `dir`, to read and to go on writing. Throws, saying
 *  why, when `dir` holds none: no private folder, or no meta.json that is such a record's. */
export function loadRecord(harness: Harness, dir: string, { keep = KEEP_CHARS }: { keep?: number } = {}): HarnessRecord {
  const file = readMeta(dir, harness.kind)
  return new HarnessRecord(harness, dir, file, { keep, loaded: file })
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

/** Keeps, in the records' folder `dir`, `next`: the number the next session of chat `chat`'s `kind` instrument takes
 *  in its name. Throws as the write does. */
export function saveNextName(dir: string, kind: Harness["kind"], chat: string, next: number): void {
  replaceFile(dir, NAMES, `${JSON.stringify({ kind, chat, next }, null, 2)}\n`)
}

/** The number the next session takes in its name, as the records' folder `dir` keeps it (`saveNextName`); null when
 *  it keeps none. Throws `RecordRefused` when its file isn't chat `chat`'s `kind` sessions'. */
function readNextName(dir: string, kind: Harness["kind"], chat: string): number | null {
  const bytes = readRegular(path.join(dir, NAMES), META_MAX)
  if (bytes === null) return null
  let file: unknown = null
  try {
    file = JSON.parse(bytes.toString("utf8"))
  } catch {}
  const names = file as Record<string, unknown> | null
  if (typeof names !== "object" || names === null || names.kind !== kind || names.chat !== chat) {
    throw new RecordRefused(`${NAMES} isn't this chat's ${kind} sessions'`)
  }
  if (!Number.isSafeInteger(names.next) || (names.next as number) < 1) {
    throw new RecordRefused(`${NAMES} names no next number`)
  }
  return names.next as number
}

/** Why `error` refused a record or `instrument.json`, naming no path: a `RecordRefused`'s words, or the system's
 *  error's. */
function refusal(error: unknown): string {
  if (error instanceof RecordRefused) return error.message
  if (error instanceof PrivateFileError) return "its folder isn't a private folder of this user"
  return strerror(error) ?? (error instanceof Error ? error.name : "it can't be read")
}

/** The records an earlier office left in `dir` of chat `chat`'s `harness` sessions, driven by `driver`, in the order
 *  of their names, and the number the next session's name takes: past `instrument.json`'s and every record's. A
 *  record that doesn't load, or whose meta.json isn't of that chat, driver and folder, or names a session as no
 *  instrument does or as another record does, is refused: left as it is, and `log` says why. */
export function loadRecords(
  harness: Harness,
  dir: string,
  { chat, driver, log, keep = KEEP_CHARS }: { chat: string; driver: string; log: (line: string) => void; keep?: number },
): { records: HarnessRecord[]; next: number } {
  const { kind } = harness
  let next = 1
  try {
    next = readNextName(dir, kind, chat) ?? 1
  } catch (error) {
    log(`${kind} sessions of chat ${chat}: ${refusal(error)}, so their names go on from the records`)
  }
  const named = new RegExp(`^${kind} ([1-9][0-9]{0,8})$`)
  const found: { record: HarnessRecord; n: number }[] = []
  const taken = new Set<string>()
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue
    const refused = (why: string) => log(`${kind} record ${item.name} of chat ${chat} is refused: ${why}`)
    let record: HarnessRecord
    try {
      record = loadRecord(harness, path.join(dir, item.name), { keep })
    } catch (error) {
      refused(refusal(error))
      continue
    }
    const meta = record.meta
    const n = Number(named.exec(meta.name)?.[1] ?? Number.NaN)
    if (meta.id !== item.name) refused(`its ${META} is another session's`)
    else if (meta.chat !== chat) refused(`its ${META} is another chat's`)
    else if (meta.driver !== driver) refused(`its ${META} is another driver's`)
    else if (Number.isNaN(n)) refused(`its ${META} names no ${kind} session`)
    else if (taken.has(meta.name)) refused(`another record is named ${meta.name}`)
    else {
      taken.add(meta.name)
      found.push({ record, n })
      next = Math.max(next, n + 1)
    }
  }
  found.sort((a, b) => a.n - b.n)
  return { records: found.map((f) => f.record), next }
}
