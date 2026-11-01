/**
 * Read-only access to yian run logs that workers may still be appending to: a lazy, bounded index per log folded from
 * yian's `iterRunRecords`, and pages of node attempts and records. Plain reads only: no lock, no write, no `advance`.
 *
 * Record pages and one opened record read raw lines and parse each with yian's codec (`parseJson`), as
 * `iterRunRecords` can neither skip nor cap a line and yian has no record-to-wire encoder. Values are shown in a
 * display form any client reads as plain JSON. A derived commit's value is rebuilt only when one record is opened,
 * by replaying the whole log through yian's `foldRunLog`; node kinds come from the flow the log recorded.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import { Readable } from "node:stream"
import type { Failure } from "@ngocbh/yian"
import {
  FileRef,
  foldRunLog,
  InboxRef,
  iterRunRecords,
  JSONDecodeError,
  parseJson,
  RunLogChangedError,
  type RunLogEntry,
  RunLogSchemaError,
  TypedValue,
} from "@ngocbh/yian/run"
import type { RunEvent, RunEventPage } from "@opencorp/protocol"
import { cutReason } from "../store/store.ts"
import { recordedKinds } from "./nodes.ts"

/** The run-log schema this office reads: yian's SCHEMA_VERSION at the submodule pin. */
export const SCHEMA = 23
/** Every this-many records, the index keeps the record's byte offset, so a page seeks near its first record. */
export const SPARSE_EVERY = 64
/** The index also keeps the offset of a record that starts this many bytes or more past its last kept one, so a seek
 *  skips at most this many bytes of lines. */
export const SPARSE_BYTES = 8 << 20
/** The most open attempts the index keeps: a run's open nodes are bounded by its widest map. */
export const OPEN_CAP = 256
/** The most resume dividers the index keeps. */
export const DIVIDER_CAP = 1_000
/** The most node attempts the index keeps: the newest. */
export const NODE_CAP = 100_000
/** The bytes read at a time when the office scans or hashes a log itself. */
export const CHUNK = 1 << 20
/** A record line longer than this is a stub with its size on a record page. */
export const BIG_LINE = 2 << 20
/** The most code points of a string a record page shows; a longer one is cut there with "…". */
export const FIELD_CHARS = 4 << 10
/** The most JSON a record page holds. */
export const PAGE_BYTES = 256 << 10
/** The most bytes of lines a record page scans past its first record (a bounded read window, as DeepSeek's
 *  `readWindowMax`): its reads are synchronous, so this bounds how long one page holds the event loop. */
export const PAGE_SCAN = 64 << 20
/** The most JSON one opened record shows. */
export const EVENT_BYTES = 2 << 20
/** The deepest a payload is shown: a container nested deeper shows as "…", so showing and serializing it recurse a
 *  bounded depth. */
export const DEPTH_CAP = 128
/** The most characters of JSON pointers one event's `cut` names; an event whose cuts would name more is a size stub. */
export const CUT_CHARS = 64 << 10
/** The longest record one opened record parses; a longer one is a stub with its size, read without holding its line
 *  (parsing a record takes several times its size in memory). The download has it whole. */
export const HUGE_LINE = 16 << 20
/** The longest complete line the index reads: yian's reader holds a line whole and parses it, so a longer one makes
 *  the log unreadable before yian sees it. Until yian's reader takes a line cap, a build's peak memory is several
 *  times this: yian holds the line, its string and its parse. */
export const LINE_CAP = 64 << 20
/** The longest log whose derived values are shown: rebuilding one replays the whole log, held in memory. */
export const FOLD_BYTES = 16 << 20
/** The longest run start whose recorded flow is compiled for node kinds. */
export const FLOW_BYTES = 4 << 20
/** The most bytes of indexes the reader keeps. */
export const LRU_BYTES = 128 << 20
/** The most indexes the reader keeps. */
export const LRU_LOGS = 128
/** How much of a node's error is shown. */
export const ERROR_CHARS = 200
/** How much of a node's error and route handle the index keeps, to bound a log with many nodes; a longer one is cut
 *  with "…". */
export const ERROR_KEPT = 256

/** A complete line of the log isn't a run-log record this office can read: the index stops for that log, with a
 *  message for the run page. The message never quotes the log. */
export class UnreadableLog extends Error {
  override name = "UnreadableLog"
}

/** A line of the log is in a run-log schema this office can't read. */
export class UnsupportedSchema extends UnreadableLog {
  override name = "UnsupportedSchema"
  /** The schema the line names when it is an int; else null, as anything else could be any text. */
  readonly schema: number | null

  constructor(schema: number | null) {
    super(
      schema === null
        ? "This log uses a run-log schema this office can't read"
        : `This log uses run-log schema ${schema}, ${
          schema < SCHEMA ? "which is older than this office supports" : "which this office can't read"
        }`,
    )
    this.schema = schema
  }
}

/** The run log's path is a symlink, a FIFO, a socket or anything else that isn't a regular file, so it isn't read.
 *  Deliberately not an UnreadableLog: it is no log to the routes, and the reader never keeps it as a failed build. The
 *  message never names the path. */
export class NotALog extends Error {
  override name = "NotALog"

  constructor() {
    super("The run log isn't a regular file")
  }
}

/** Opens the log at `path` for reading: a file descriptor of a regular file. Throws NotALog when the path is a symlink
 *  or isn't a regular file, and the `fs` error (`ENOENT`) of one it can't open. */
function openLog(path: string): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd: number
  try {
    // O_NOFOLLOW: a symlink in the log's place isn't followed. O_NONBLOCK: a FIFO can't hang the open.
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // A symlink under O_NOFOLLOW is ELOOP on Linux and macOS, EMLINK on FreeBSD; a socket is ENXIO on Linux and
    // EOPNOTSUPP on macOS.
    if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EOPNOTSUPP") throw new NotALog()
    throw error
  }
  let regular = false
  try {
    regular = fs.fstatSync(fd).isFile()
  } catch {}
  if (!regular) {
    fs.closeSync(fd)
    throw new NotALog()
  }
  return fd
}

/** Where a node attempt stands: `restarted` when a resume retried it before it had an outcome. */
export type AttemptStatus = "open" | "waiting" | "succeeded" | "routed" | "expanded" | "failed" | "restarted"

/** One node attempt: its start record's seq, and its outcome once there is one. */
export interface Attempt {
  seq: number
  nodeId: string
  endSeq: number | null
  status: AttemptStatus
  handle: string | null
  error: string | null
}

/** What the office keeps of one log: where it read up to, what the first record says, the open nodes, resume
 *  dividers, a sparse seq → byte table, and the node table. */
export interface Index {
  dev: bigint
  ino: bigint
  /** After the last complete record read. */
  offset: number
  /** Where that record's line starts, so a rewrite of it is noticed. */
  lastStart: number
  /** The sha256 (hex) of that line, newline included. */
  lastSha: string
  lastSeq: number | null
  runId: string | null
  /** The end of the first line: the run start's size. */
  startEnd: number | null
  fingerprint: string | null
  learnable: boolean | null
  /** Each static path's model, from the run start. */
  models: Record<string, string>
  /** Node id → its latest attempt, while it has no outcome. */
  open: Map<string, Attempt>
  /** (seq, the node ids it retried) of each resume. */
  dividers: [number, string[]][]
  /** (seq, byte offset) of every SPARSE_EVERY-th record, and of each record SPARSE_BYTES or more past the last
   *  entry. */
  sparse: [number, number][]
  /** Every attempt by start, the newest `nodeCap`. */
  nodes: Attempt[]
  /** Whether older attempts were trimmed from `nodes`. */
  dropped: boolean
  /** The characters of the run id, models, node ids, handles, errors and retried ids it keeps, and an estimate of its
   *  node kinds' size. */
  held: number
  /** The node kinds of the flow the log recorded, once asked for (see `RunLogReader.kinds`). */
  kinds?: Promise<Map<string, string> | null>
}

/** What replaying a log or compiling its recorded flow reads: the run's environment, for its `YIAN_*` values, and
 *  the folder every CODE reference must stay inside. */
export type FoldOptions = { env: (name: string) => string | undefined; codeRoot: string }

/** An estimate of the bytes `index` holds, for the LRU. */
export function cost(index: Index): number {
  return 512 + 160 * index.open.size + 48 * index.sparse.length + 96 * index.dividers.length
    + 160 * index.nodes.length + index.held
}

/** Reads the log at `path` on from `index.offset` into `index`; `resumed` is whether `index` holds an earlier read.
 *  `readOn` is the default; tests pass their own to `refresh` to act around a read. */
export type ReadOn = (path: string, index: Index, resumed: boolean, nodeCap: number) => Promise<void>

/** Records that end a node attempt, and the status each gives it. */
const OUTCOMES: ReadonlyMap<string, AttemptStatus> = new Map([
  ["node_succeeded", "succeeded"],
  ["node_routed", "routed"],
  ["node_expanded", "expanded"],
  ["node_failed", "failed"],
])

/** A file's stat, its numbers as bigints (`ino` and `mtimeNs` don't fit a double). */
type Stat = fs.BigIntStats

/**
 * `index` brought up to date with `path` by reading only what was appended, or a new index read from the start when
 * the file was replaced, shrank, rewrote its last line, or its next record doesn't continue the last. A torn last line
 * is left for the next call. A line it can't read while the file changed under the read is read again once, from the
 * start.
 *
 * Throws UnsupportedSchema or UnreadableLog for a complete line this office can't read or any line over LINE_CAP,
 * NotALog for a log that is a symlink or isn't a regular file, and the `fs` error (`ENOENT`) of a log it can't open.
 */
export async function refresh(
  path: string,
  index: Index | null,
  options: { nodeCap?: number; readOn?: ReadOn } = {},
): Promise<Index> {
  const { nodeCap = NODE_CAP, readOn: read = readOn } = options
  const st = fs.statSync(path, { bigint: true })
  try {
    return await build(path, index, st, nodeCap, read)
  } catch (error) {
    if (!(error instanceof UnreadableLog) || error instanceof UnsupportedSchema) throw error
    const now = fs.statSync(path, { bigint: true })
    if (now.size === st.size && now.mtimeNs === st.mtimeNs) throw error
    // A writer rewrote the file while it was read (a rollback), so the bad line may be half of each version.
    return await build(path, null, now, nodeCap, read)
  }
}

/** `refresh` against the file as `st` found it, without the retry. */
async function build(path: string, index: Index | null, st: Stat, nodeCap: number, read: ReadOn): Promise<Index> {
  const resumed = index !== null && continues(path, index, st)
  const into = resumed ? index! : emptyIndex(st)
  try {
    await read(path, into, resumed, nodeCap)
  } catch (error) {
    if (error instanceof RunLogChangedError && resumed) {
      return build(path, null, fs.statSync(path, { bigint: true }), nodeCap, read)
    }
    if (error instanceof RunLogSchemaError) throw new UnsupportedSchema(error.schema)
    // yian's message quotes the log's path and values, so only the line number is kept.
    if (error instanceof RangeError) {
      const line = into.lastSeq === null ? 1 : into.lastSeq + 2
      throw new UnreadableLog(`This log has a line this office can't read (line ${line})`)
    }
    throw error
  }
  return into
}

/** An index of no record yet, of the file `st` found. */
function emptyIndex(st: Stat): Index {
  return {
    dev: st.dev,
    ino: st.ino,
    offset: 0,
    lastStart: 0,
    lastSha: "",
    lastSeq: null,
    runId: null,
    startEnd: null,
    fingerprint: null,
    learnable: null,
    models: {},
    open: new Map(),
    dividers: [],
    sparse: [],
    nodes: [],
    dropped: false,
    held: 0,
  }
}

/** Whether `path` still holds what `index` read: the same file, no shorter, its last read line unchanged. */
function continues(path: string, index: Index, st: Stat): boolean {
  if (st.dev !== index.dev || st.ino !== index.ino || Number(st.size) < index.offset) return false
  return index.offset === 0 || sha256(path, index.lastStart, index.offset) === index.lastSha
}

/** The sha256 (hex) of bytes `[start, end)` of `path`, read CHUNK at a time. */
function sha256(path: string, start: number, end: number): string {
  const hash = crypto.createHash("sha256")
  const fd = openLog(path)
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    for (let pos = start; pos < end;) {
      const count = fs.readSync(fd, chunk, 0, Math.min(CHUNK, end - pos), pos)
      if (count === 0) break
      hash.update(chunk.subarray(0, count))
      pos += count
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest("hex")
}

/** A function that yields to the event loop when at least 10 ms passed since it last did. */
function pacer(): () => Promise<void> {
  let since = performance.now()
  return async () => {
    if (performance.now() - since < 10) return
    await new Promise((resolve) => setImmediate(resolve))
    since = performance.now()
  }
}

/**
 * The end of the last complete line of `path` from `index.offset` on, scanned CHUNK at a time for newlines only, so
 * nothing but one chunk is held. Throws UnreadableLog as soon as a line, terminated or not, passes LINE_CAP, so at most
 * LINE_CAP and a chunk past the last complete line is read.
 */
async function scan(path: string, index: Index, pace: () => Promise<void>): Promise<number> {
  const fd = openLog(path)
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    let pos = index.offset
    let lineStart = index.offset
    let line = index.lastSeq === null ? 1 : index.lastSeq + 2
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, CHUNK, pos)
      if (count === 0) return lineStart
      const data = chunk.subarray(0, count)
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, nl + 1)) {
        if (pos + nl + 1 - lineStart > LINE_CAP) {
          throw new UnreadableLog(`This log has a record too large to read (line ${line})`)
        }
        lineStart = pos + nl + 1
        line += 1
      }
      // A line already past LINE_CAP can never be read, wherever its newline falls, so it is refused before the rest.
      if (pos + count - lineStart > LINE_CAP) {
        throw new UnreadableLog(`This log has a record too large to read (line ${line})`)
      }
      pos += count
      await pace()
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Folds each complete record of `path` from `index.offset` on into `index` (the default `ReadOn`). The office scans
 * the new bytes first, so a line over LINE_CAP, complete or a torn tail, is refused before yian's reader holds it, and
 * yian's reader is stopped at the last complete line the scan saw, so it never reads a tail being written. Yields to
 * the event loop about every 10 ms, checked every 256 records and every CHUNK bytes of records, so at most one record
 * (up to LINE_CAP) is read past that between yields. The last line read is hashed after the loop: a writer that
 * rewrites that line between the read and the hash makes the next refresh rebuild once. A writer that replaces or
 * rewrites the scanned bytes between the scan and yian's read can still make yian hold a line over LINE_CAP: only a
 * line cap in yian's reader closes that.
 */
export async function readOn(path: string, index: Index, resumed: boolean, nodeCap: number): Promise<void> {
  const pace = pacer()
  const scanEnd = await scan(path, index, pace)
  if (scanEnd === index.offset) return
  const from = resumed && index.lastSeq !== null
    ? { afterOffset: index.offset, runId: index.runId, afterSeq: index.lastSeq }
    : {}
  let count = 0
  let pacedAt = index.offset
  for (const entry of iterRunRecords(path, from)) {
    // A record past the scanned end means the line at that end was rewritten since the scan.
    if (entry.end > scanEnd) throw new RunLogChangedError("the run log changed under its read")
    apply(index, entry, nodeCap)
    index.offset = entry.end
    index.lastStart = entry.offset
    index.lastSeq = entry.seq
    if (index.runId !== entry.runId) {
      index.held += entry.runId.length - (index.runId?.length ?? 0)
      index.runId = own(entry.runId)
    }
    if (entry.seq === 0) index.startEnd = entry.end
    if (entry.end === scanEnd) break
    if (++count % 256 === 0 || entry.end - pacedAt >= CHUNK) {
      await pace()
      pacedAt = entry.end
    }
  }
  index.lastSha = sha256(path, index.lastStart, index.offset)
}

/** Folds one record into `index`. */
function apply(index: Index, entry: RunLogEntry, nodeCap: number): void {
  const { seq, kind, nodeId } = entry
  const record = entry.envelope.record
  if (seq % SPARSE_EVERY === 0 || entry.offset - (index.sparse.at(-1)?.[1] ?? 0) >= SPARSE_BYTES) {
    index.sparse.push([seq, entry.offset])
  }
  if (kind === "run_started") {
    const start = record as {
      flowFingerprint: string
      learnable: boolean
      effectiveLlmByStaticPath: Record<string, Record<string, unknown>>
    }
    index.fingerprint = own(start.flowFingerprint)
    index.learnable = start.learnable
    index.held -= modelChars(index.models)
    // Built with fromEntries, so a static path named like an Object member is an own key.
    index.models = Object.fromEntries(
      Object.entries(start.effectiveLlmByStaticPath)
        .filter(([, llm]) => typeof llm.model === "string" && llm.model !== "")
        .map(([staticPath, llm]) => [own(staticPath), own(llm.model as string)]),
    )
    index.held += modelChars(index.models)
  } else if (kind === "node_started") {
    started(index, seq, nodeId!, nodeCap)
  } else if (OUTCOMES.has(kind)) {
    ended(index, seq, kind, nodeId!, record)
  } else if (kind === "node_waiting" || kind === "node_woken") {
    const attempt = index.open.get(nodeId!)
    if (attempt !== undefined) attempt.status = kind === "node_waiting" ? "waiting" : "open"
  } else if (kind === "run_resumed") {
    // yian retries the attempts in flight; a waiting one stays waiting.
    for (const [id, attempt] of index.open) {
      if (attempt.status !== "open") continue
      attempt.status = "restarted"
      index.open.delete(id)
    }
    const ids = (record as { retryNodeIds: readonly string[] }).retryNodeIds
    const retried = ids.slice(0, OPEN_CAP).map(own)
    index.dividers.push([seq, retried])
    index.held += retried.reduce((sum, id) => sum + id.length, 0)
    if (index.dividers.length > DIVIDER_CAP) {
      index.held -= index.dividers.shift()![1].reduce((sum, id) => sum + id.length, 0)
    }
  }
}

/** The characters of the static paths and models in `models`. */
function modelChars(models: Record<string, string>): number {
  return Object.entries(models).reduce((sum, [staticPath, model]) => sum + staticPath.length + model.length, 0)
}

/** A copy of `s` that shares no memory with the line it was parsed from: JSC keeps a substring's parent string alive,
 *  so a kept id or error would pin its whole (maybe multi-MiB) line in every cached index. A structured clone copies
 *  the code units as they are, a lone surrogate included. */
function own(s: string): string {
  return structuredClone(s)
}

/** A new open attempt of `nodeId`, replacing its earlier open one. */
function started(index: Index, seq: number, id: string, nodeCap: number): void {
  const nodeId = own(id)
  const attempt: Attempt = { seq, nodeId, endSeq: null, status: "open", handle: null, error: null }
  index.open.delete(nodeId)
  index.open.set(nodeId, attempt)
  if (index.open.size > OPEN_CAP) index.open.delete(index.open.keys().next().value!)
  index.nodes.push(attempt)
  index.held += nodeId.length
  // Trimmed in batches: one removal per append would be quadratic.
  if (index.nodes.length > Math.floor(nodeCap * 11 / 10)) {
    const gone = index.nodes.splice(0, index.nodes.length - nodeCap)
    for (const old of gone) index.held -= old.nodeId.length + (old.handle?.length ?? 0) + (old.error?.length ?? 0)
    index.dropped = true
  }
}

/** Ends `nodeId`'s open attempt with the outcome record `kind`. */
function ended(index: Index, seq: number, kind: string, nodeId: string, record: unknown): void {
  const attempt = index.open.get(nodeId)
  if (attempt === undefined) return
  index.open.delete(nodeId)
  attempt.endSeq = seq
  attempt.status = OUTCOMES.get(kind)!
  let failure: Failure | null = null
  if (kind === "node_routed") {
    const route = record as { handle: string; terminalFailure: Failure | null }
    attempt.handle = own(cutReason(route.handle.slice(0, 2 * ERROR_KEPT + 1), ERROR_KEPT))
    index.held += attempt.handle.length
    failure = route.terminalFailure
  } else if (kind === "node_failed") {
    failure = (record as { failure: Failure }).failure
  }
  if (failure !== null) {
    // The slice keeps cutReason from splitting a huge message; the cut is the same.
    attempt.error = own(cutReason((failure.message || failure.code).slice(0, 2 * ERROR_KEPT + 1), ERROR_KEPT)) || null
    index.held += attempt.error?.length ?? 0
  }
}

/** Node attempts, newest start first (copies), the dividers among them, and where the next older page starts. */
export interface NodePage {
  nodes: Attempt[]
  dividers: [number, string[]][]
  nextBefore: number | null
  dropped: boolean
}

/** Up to `limit` attempts that started before seq `before` (all when null), newest first. */
export function nodePage(index: Index, { before, limit }: { before: number | null; limit: number }): NodePage {
  const table = index.nodes
  let end = table.length
  if (before !== null) {
    let low = 0
    while (low < end) {
      const mid = (low + end) >> 1
      if (table[mid]!.seq < before) low = mid + 1
      else end = mid
    }
  }
  const start = Math.max(0, end - limit)
  const nodes = table.slice(start, end).reverse().map((attempt) => ({ ...attempt }))
  if (nodes.length === 0) return { nodes: [], dividers: [], nextBefore: null, dropped: index.dropped }
  const low = table[start]!.seq
  const high = before ?? Infinity
  const dividers = index.dividers
    .filter(([seq]) => low <= seq && seq < high)
    .map(([seq, retried]): [number, string[]] => [seq, [...retried]])
  return { nodes, dividers, nextBefore: start > 0 ? low : null, dropped: index.dropped }
}

/** The seq and byte offset of the last sparse entry at or before seq `first`, and the offset after the last complete
 *  line indexed. */
function window(index: Index, first: number): [number, number, number] {
  let low = 0
  let high = index.sparse.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (index.sparse[mid]![0] <= first) low = mid + 1
    else high = mid
  }
  const [seq, start] = low > 0 ? index.sparse[low - 1]! : [0, 0]
  return [seq, start, index.offset]
}

/** One complete line: its bytes, or null when it is longer than the caller's cap; its first 256 bytes; its last
 *  TAIL bytes when its bytes are null (else empty); its size; the byte after it. */
interface Line {
  bytes: Buffer | null
  head: Buffer
  tail: Buffer
  size: number
  end: number
}

/** How much of the end of a line too long to hold is read, for its seq. */
const TAIL = 64

/**
 * The complete lines of `fd` between byte `start` and byte `stop`, one at a time, after skipping `skip` of them. Lines
 * are scanned CHUNK at a time for newlines, keeping only a line's start and first 256 bytes; a line no longer than
 * `cap` is then read whole in one read, and of a longer one only its last TAIL bytes are.
 */
function* lines(fd: number, start: number, stop: number, cap: number, skip: number): Generator<Line> {
  const chunk = Buffer.allocUnsafe(Math.min(CHUNK, stop - start))
  let at = start
  let head = Buffer.alloc(0)
  for (let pos = start; pos < stop;) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stop - pos), pos)
    if (count === 0) return
    const data = chunk.subarray(0, count)
    for (let from = 0; from < count;) {
      const nl = data.indexOf(0x0a, from)
      const end = nl === -1 ? count : nl + 1
      if (skip === 0 && head.length < 256) {
        head = Buffer.concat([head, data.subarray(from, Math.min(end, from + 256 - head.length))])
      }
      from = end
      if (nl === -1) break
      if (skip > 0) {
        skip -= 1
      } else {
        const size = pos + end - at
        let bytes: Buffer | null = null
        let tail = Buffer.alloc(0)
        if (size <= cap) {
          bytes = Buffer.allocUnsafe(size)
          bytes = bytes.subarray(0, fs.readSync(fd, bytes, 0, size, at))
        } else {
          tail = Buffer.allocUnsafe(TAIL)
          tail = tail.subarray(0, fs.readSync(fd, tail, 0, TAIL, pos + end - TAIL))
        }
        yield { bytes, head, tail, size, end: pos + end }
        head = Buffer.alloc(0)
      }
      at = pos + end
    }
    pos += count
  }
}

/** `key` as a JSON pointer segment. */
function escape(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1")
}

/** The JSON pointers of one event's cut values, their characters bounded by CUT_CHARS. */
class Cuts {
  readonly pointers: string[] = []
  private chars = 0

  /** Adds `pointer`; throws TooManyCuts when the pointers would pass CUT_CHARS. */
  add(pointer: string): void {
    this.chars += pointer.length
    if (this.chars > CUT_CHARS) throw new TooManyCuts()
    this.pointers.push(pointer)
  }
}

/** An event's cuts would name more than CUT_CHARS: the walk stops and the event is a size stub. */
class TooManyCuts extends Error {}

/** `text` cut to FIELD_CHARS code points and "…" when it is longer, its pointer added to `cuts`. */
function cutText(text: string, pointer: string, cuts: Cuts): string {
  if (text.length <= FIELD_CHARS) return text
  // Walked a code point at a time, so a surrogate pair is never split and no copy of the whole string is made.
  let end = 0
  for (let n = 0; n < FIELD_CHARS && end < text.length; n++) {
    const unit = text.charCodeAt(end)
    const pair = unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(end + 1) & 0xfc00) === 0xdc00
    end += pair ? 2 : 1
  }
  if (end >= text.length) return text
  cuts.add(pointer)
  return text.slice(0, end) + "…"
}

/**
 * `value` at JSON pointer `pointer`, `depth` containers deep, in its display form: an int as a JSON number when it is
 * a safe integer, else its decimal string; an infinite float as "Infinity" or "-Infinity"; a file as `{uri, mime,
 * name}`; an inbox handle as its name. Strings longer than FIELD_CHARS code points are cut when `cutting`, and a
 * container DEPTH_CAP deep is "…"; each pointer is added to `cuts`.
 */
function shown(value: unknown, pointer: string, cuts: Cuts, depth: number, cutting: boolean): unknown {
  if (typeof value === "string") return cutting ? cutText(value, pointer, cuts) : value
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString()
  }
  if (value === Infinity) return "Infinity"
  if (value === -Infinity) return "-Infinity"
  if (FileRef.isFileRef(value)) {
    return shown({ uri: value.uri, mime: value.mime, name: value.name }, pointer, cuts, depth, cutting)
  }
  if (InboxRef.isInboxRef(value)) return shown(value.inbox, pointer, cuts, depth, cutting)
  if (typeof value !== "object" || value === null) return value
  if (depth >= DEPTH_CAP) {
    cuts.add(pointer)
    return "…"
  }
  if (Array.isArray(value)) return value.map((item, i) => shown(item, `${pointer}/${i}`, cuts, depth + 1, cutting))
  // Built with fromEntries, so a key named like an Object member (`__proto__`) stays a plain data key.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      shown(item, `${pointer}/${escape(key)}`, cuts, depth + 1, cutting),
    ]),
  )
}

/** The payload of a record of kind `kind` in its display form; a commit's value is decoded from its typed-value wire
 *  first, and shown as parsed when that wire doesn't decode. A derived commit's rebuilt value `derived` is shown with
 *  its kind beside what the record holds. */
function shownPayload(
  payload: Record<string, unknown>,
  kind: string,
  cuts: Cuts,
  cutting: boolean,
  derived: TypedValue | null,
): Record<string, unknown> {
  if (derived !== null) {
    const rebuilt = { ...payload, kind: derived.kind, value: derived.toObject() }
    return shown(rebuilt, "", cuts, 0, cutting) as Record<string, unknown>
  }
  const { value } = payload
  if (kind !== "pool_commit" || !Object.hasOwn(payload, "kind") || value === null || value === undefined) {
    return shown(payload, "", cuts, 0, cutting) as Record<string, unknown>
  }
  let decoded: unknown = value
  try {
    decoded = TypedValue.fromWire({ kind: payload.kind, value }).toObject()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  return shown({ ...payload, value: decoded }, "", cuts, 0, cutting) as Record<string, unknown>
}

/** The node a payload names: its `node_id`, else its `spawner_id`, else its failure's `node_id`. */
function nodeOf(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null
  const failure = isRecord(payload.failure) ? payload.failure : {}
  const found = payload.node_id || payload.spawner_id || failure.node_id
  return typeof found === "string" ? found : null
}

/** Whether `value` is a JSON object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// yian writes sorted-key JSON, so a record starts with "at" then "kind" and ends with "seq": an oversized line's kind
// and seq can be read without parsing it. Its seq is still its line number: the one at its end only checks it.
const HEAD = /^\{(?:"at":"[^"]{0,64}",)?"kind":"([a-z_]{1,64})"/
const SEQ = /,"seq":(0|[1-9][0-9]{0,15})\}\n$/

// The same sorted keys put the payload's members after "kind", in key order: the scalars before its `node_id` (or
// `spawner_id`) can be stepped over one at a time. A container is never entered, so an id nested in one can't match.
const PAYLOAD = /^\{(?:"at":"[^"]{0,64}",)?"kind":"[a-z_]{1,64}","payload":\{/
const KEY = /"((?:[^"\\]|\\.)*)":/y
const STRING = /"(?:[^"\\]|\\.)*"/y
const SCALAR = /(?:"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null),/y

/** Decodes UTF-8, throwing a TypeError on bytes that aren't UTF-8. */
const UTF8 = new TextDecoder("utf-8", { fatal: true })

/** The node an oversized record's first bytes `head` name, as `nodeOf` reads it: its payload's `node_id`, else its
 *  `spawner_id`, when only scalars come before it and it ends within `head`; else null. */
function stubNode(head: Buffer): string | null {
  // Latin-1 maps each byte to one character, so offsets are byte offsets; a UTF-8 byte of a longer character is never
  // a quote or a backslash.
  const text = head.toString("latin1")
  let at = PAYLOAD.exec(text)?.[0].length
  while (at !== undefined) {
    KEY.lastIndex = at
    const key = KEY.exec(text)?.[1]
    if (key === undefined) return null
    at = KEY.lastIndex
    if (key === "node_id" || key === "spawner_id") {
      STRING.lastIndex = at
      if (STRING.exec(text) !== null) {
        try {
          const id = JSON.parse(UTF8.decode(head.subarray(at, STRING.lastIndex))) as string
          if (id !== "") return id
        } catch {
          return null
        }
      }
    }
    SCALAR.lastIndex = at
    at = SCALAR.exec(text) === null ? undefined : SCALAR.lastIndex
  }
  return null
}

/** Record `seq`, `size` bytes long, as its size and the kind and node its first bytes `head` name: it isn't parsed.
 *  Null when the line's last bytes `tail` (its newline included) don't end with seq `seq` (the file changed since it
 *  was indexed). */
function stub(head: Buffer, tail: Buffer, seq: number, size: number): RunEvent | null {
  if (SEQ.exec(tail.toString("latin1"))?.[1] !== String(seq)) return null
  const first = head.subarray(0, 256)
  const found = HEAD.exec(first.toString("latin1"))
  return { seq, kind: found?.[1] ?? "unknown", node_id: stubNode(first), size }
}

/**
 * Line `seq` (`bytes`) as a page shows it, or as one opened record shows it when `whole` (see `fitted`), with a
 * derived commit's rebuilt value `derived`. Null when it no longer reads as record `seq` (the file changed since it
 * was indexed).
 */
function decode(bytes: Buffer, seq: number, whole: boolean, derived: TypedValue | null = null): RunEvent | null {
  let record: unknown
  try {
    record = parseJson(UTF8.decode(bytes), "codec")
  } catch (error) {
    if (error instanceof TypeError || error instanceof JSONDecodeError) return null
    throw error
  }
  if (!isRecord(record) || record.seq !== BigInt(seq)) return null
  const kind = typeof record.kind === "string" && record.kind !== "" ? record.kind : "unknown"
  const raw = isRecord(record.payload) ? record.payload : null
  const event: RunEvent = raw === null
    ? { seq, kind, node_id: null, payload: null, cut: [] }
    : fitted(seq, kind, raw, bytes.length, whole, (cuts, cutting) => shownPayload(raw, kind, cuts, cutting, derived))
  // yian's parser makes its strings as slices of the line (or of the replayed log, for a derived value), and JSC keeps
  // a slice's parent alive: a copy keeps only what is shown, not every line a page read (see `own`).
  return structuredClone(event)
}

/**
 * Record `seq` of kind `kind` (`size` bytes, payload `raw`) with the payload `show(cuts, cutting)` gives: on a page its
 * strings cut; when `whole`, its strings cut only when the payload and its cuts are over EVENT_BYTES, and a stub with
 * its size when they are still over. A stub too when its cuts would name more than CUT_CHARS.
 */
function fitted(
  seq: number,
  kind: string,
  raw: Record<string, unknown>,
  size: number,
  whole: boolean,
  show: (cuts: Cuts, cutting: boolean) => Record<string, unknown>,
): RunEvent {
  try {
    let cuts = new Cuts()
    let payload = show(cuts, !whole)
    if (whole && Buffer.byteLength(JSON.stringify({ payload, cut: cuts.pointers })) > EVENT_BYTES) {
      cuts = new Cuts()
      payload = show(cuts, true)
      // Many short strings: cutting each can't bring it under.
      if (Buffer.byteLength(JSON.stringify({ payload, cut: cuts.pointers })) > EVENT_BYTES) {
        return { seq, kind, node_id: nodeOf(payload), size }
      }
    }
    return { seq, kind, node_id: nodeOf(payload), payload, cut: cuts.pointers }
  } catch (error) {
    if (!(error instanceof TooManyCuts)) throw error
    const nodeId = nodeOf(raw)
    return { seq, kind, node_id: nodeId === null ? null : cutText(nodeId, "", new Cuts()), size }
  }
}

/**
 * Records after seq `after` (from the first when null), up to `limit` records, PAGE_BYTES of JSON, or `pageScan` bytes
 * of lines scanned past its first record (always its first record); a page cut by bytes says `cut`. A line over
 * BIG_LINE is a stub with its size. A line's seq is its line number, counted from a sparse entry; a line that no
 * longer reads as its seq ends the page there. `after` is a seq, a non-negative safe integer: anything else reads from
 * the first record. `limit` is at least 1: a fraction is floored. Tests pass a small `pageScan`.
 */
export function readEvents(
  path: string,
  index: Index,
  { after, limit, pageScan = PAGE_SCAN }: { after: number | null; limit: number; pageScan?: number },
): RunEventPage {
  const from = after !== null && Number.isSafeInteger(after) && after >= 0 ? after : null
  const most = Math.max(1, Math.floor(limit) || 1)
  const first = from === null ? 0 : from + 1
  const [base, start, stop] = window(index, first)
  const events: RunEvent[] = []
  let used = 0
  let begin = 0
  let nextAfter: number | null = null
  let cut = false
  const fd = openLog(path)
  try {
    let seq = first
    for (const line of lines(fd, start, stop, BIG_LINE, first - base)) {
      if (events.length === 0) begin = line.end - line.size
      if (events.length >= most) {
        nextAfter = events.at(-1)!.seq
        break
      }
      const event = line.bytes === null ? stub(line.head, line.tail, seq, line.size) : decode(line.bytes, seq, false)
      if (event === null) {
        // Rewritten since it was indexed: the next request's refresh rebuilds.
        nextAfter = events.at(-1)?.seq ?? from
        break
      }
      const size = Buffer.byteLength(JSON.stringify(event))
      if (events.length > 0 && used + size > PAGE_BYTES) {
        nextAfter = events.at(-1)!.seq
        cut = true
        break
      }
      events.push(event)
      used += size
      seq += 1
      if (line.end - begin >= pageScan && line.end < stop) {
        nextAfter = event.seq
        cut = true
        break
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return { events, next_after: nextAfter, cut }
}

/** A newline, appended to a line given without one. */
const NL = Buffer.from("\n")

/** Record `seq`'s line `bytes` (with or without its newline) as a page shows it, a stub with its size when it is over
 *  BIG_LINE; null when it doesn't read as record `seq`. */
export function lineEvent(bytes: Buffer, seq: number): RunEvent | null {
  // Pages count a line's size with its newline: the stub size and the BIG_LINE boundary must match theirs.
  const line = bytes.at(-1) === 0x0a ? bytes : Buffer.concat([bytes, NL])
  return line.length > BIG_LINE
    ? stub(line.subarray(0, 256), line.subarray(-TAIL), seq, line.length)
    : decode(line, seq, false)
}

/**
 * The records of the log `path` from seq `from` through `to` (to its last complete line when null), each as
 * `lineEvent` maps it; a null, then nothing more, at a line that doesn't read as its seq (a line over BIG_LINE isn't
 * parsed: the seq at its end is checked). With `index` of the same file (device and inode), the read
 * starts at its last sparse entry at or before `from` rather than at byte 0, and still reads past what it indexed; a
 * file edited since then yields that null too when it is now shorter than that entry. An index of another file is
 * ignored. The file is opened on the first pull and closed when the generator ends or is returned.
 */
export function* logEvents(
  path: string,
  from: number,
  to: number | null,
  index: Index | null = null,
): Generator<RunEvent | null> {
  if (to !== null && from > to) return
  const fd = openLog(path)
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    const size = Number(st.size)
    // An index of a replaced file could start mid-line and count a stub (checked only at its end) as the wrong seq.
    const same = index !== null && st.dev === index.dev && st.ino === index.ino
    const [base, start] = same ? window(index, from) : [0, 0]
    if (start > size) {
      yield null
      return
    }
    let seq = from
    for (const line of lines(fd, start, size, BIG_LINE, from - base)) {
      const event = line.bytes === null ? stub(line.head, line.tail, seq, line.size) : decode(line.bytes, seq, false)
      yield event
      seq += 1
      // Stopping here, not at the next line, leaves that line unread.
      if (event === null || (to !== null && seq > to)) return
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The record with `seq`: its strings cut only when its payload is over EVENT_BYTES, and a stub with its size when it
 * is still over after that, or when its line is over HUGE_LINE (never held or parsed). Null if there is none, and
 * when `seq` isn't a non-negative safe integer.
 */
export function readEvent(path: string, index: Index, seq: number): RunEvent | null {
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return eventAt(path, index, seq, null)
}

/** `readEvent`, a derived commit shown with its rebuilt value `derived`. */
function eventAt(path: string, index: Index, seq: number, derived: TypedValue | null): RunEvent | null {
  const [base, start, stop] = window(index, seq)
  if (seq < base) return null
  const fd = openLog(path)
  try {
    for (const line of lines(fd, start, stop, HUGE_LINE, seq - base)) {
      return line.bytes === null ? stub(line.head, line.tail, seq, line.size) : decode(line.bytes, seq, true, derived)
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The download: every complete line of `path` as it is when called, as stored, streamed CHUNK at a time, so no line
 * is ever held whole. The file is opened when called (NotALog, or its `fs` error, `ENOENT`, rejects the promise, not
 * the stream).
 * It needs no index, so a log this office can't read still downloads. The caller consumes or destroys the stream,
 * which closes the file.
 */
export async function logStream(path: string): Promise<Readable> {
  const fd = openLog(path)
  let end: number
  try {
    end = await lastLineEnd(fd, fs.fstatSync(fd).size)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  if (end === 0) {
    fs.closeSync(fd)
    return Readable.from([], { objectMode: false })
  }
  return fs.createReadStream(path, { fd, start: 0, end: end - 1, highWaterMark: CHUNK })
}

/** The end of the last complete line of `fd` before byte `size`, scanned backward CHUNK at a time, yielding to the
 *  event loop about every 10 ms; 0 when none. */
async function lastLineEnd(fd: number, size: number): Promise<number> {
  const pace = pacer()
  const piece = Buffer.allocUnsafe(CHUNK)
  for (let stop = size; stop > 0;) {
    const start = Math.max(0, stop - piece.length)
    const count = fs.readSync(fd, piece, 0, stop - start, start)
    const nl = piece.subarray(0, count).lastIndexOf(0x0a)
    if (nl !== -1) return start + nl + 1
    stop = start
    await pace()
  }
  return 0
}

/** `recordedKinds` of `path`, copied so they don't pin the recorded flow's text, their size added to `index.held`. */
async function keptKinds(path: string, index: Index, options: FoldOptions): Promise<Map<string, string> | null> {
  const kinds = await recordedKinds(path, options)
  if (kinds === null) return null
  const kept = new Map([...kinds].map(([nodePath, kind]) => [own(nodePath), own(kind)]))
  for (const nodePath of kept.keys()) index.held += 64 + nodePath.length
  return kept
}

/** A file's identity, size and modification time, as text. */
function stamp(st: Stat): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`
}

/**
 * The office's run-log indexes: built lazily per log on its first request, one build per log at a time; kept, node
 * table and all, in an LRU capped in bytes and logs, so a log is read whole once unless it is evicted. A log that
 * can't be read isn't read again until its file changes. Derived values are rebuilt one log replay at a time.
 */
export class RunLogReader {
  private readonly budget: number
  private readonly logs: number
  private readonly nodeCap: number
  private readonly foldBytes: number
  private readonly build: typeof refresh
  private readonly lru = new Map<string, Index>()
  private readonly building = new Map<string, Promise<Index>>()
  private readonly failed = new Map<string, { stamp: string; error: UnreadableLog }>()
  private folding: Promise<void> = Promise.resolve()

  /** `refresh` builds each index; tests pass their own to act around a build. */
  constructor(
    { budget = LRU_BYTES, logs = LRU_LOGS, nodeCap = NODE_CAP, foldBytes = FOLD_BYTES, refresh: build = refresh }: {
      budget?: number
      logs?: number
      nodeCap?: number
      foldBytes?: number
      refresh?: typeof refresh
    } = {},
  ) {
    this.budget = budget
    this.logs = logs
    this.nodeCap = nodeCap
    this.foldBytes = foldBytes
    this.build = build
  }

  /**
   * The record with `seq`, as the module's `readEvent` reads it (null when `seq` isn't a non-negative safe integer).
   * With `fold`, a derived commit (one that names its value by `from`, `take` or `steps`) of a log no longer than
   * `foldBytes` when indexed and when its replay starts shows the value it accepted, rebuilt by replaying the log as it
   * is now through `foldRunLog`, one replay at a time; it stays as written when the replay fails (a CODE reference
   * outside `fold.codeRoot`, other `YIAN_*` values, a log yian refuses). Each opened derived commit queues one replay,
   * and the routes' request limits bound the queue.
   */
  async readEvent(
    path: string,
    index: Index,
    seq: number,
    { fold }: { fold?: FoldOptions } = {},
  ): Promise<RunEvent | null> {
    const event = readEvent(path, index, seq)
    const payload = event?.payload
    const derived = event?.kind === "pool_commit" && isRecord(payload) && (payload.value ?? null) === null
      && ["from", "take", "steps"].some((form) => (payload[form] ?? null) !== null)
    if (fold === undefined || !derived || index.offset > this.foldBytes) return event
    // Replays queue behind each other and each reads the log as it is on its turn, so the size is checked again then.
    const replay = this.folding.then(() => fs.statSync(path).size > this.foldBytes ? null : foldRunLog(path, fold))
    // The chain keeps neither the replayed log nor its error.
    this.folding = replay.then(() => {}, () => {})
    let value: TypedValue | null
    try {
      value = (await replay)?.records[seq]?.value ?? null
    } catch {
      return event
    }
    return value === null ? event : eventAt(path, index, seq, value) ?? event
  }

  /**
   * The node kinds of the flow `path`'s log recorded (`recordedKinds`), compiled once per index and kept on it, a
   * null result too; null without compiling when the run start is over FLOW_BYTES. Null, not kept, until the run
   * start is indexed.
   */
  kinds(path: string, index: Index, options: FoldOptions): Promise<Map<string, string> | null> {
    // An empty log or a run start still being written gets its kinds on a later refresh of the same index.
    if (index.startEnd === null) return Promise.resolve(null)
    index.kinds ??= index.startEnd <= FLOW_BYTES ? keptKinds(path, index, options) : Promise.resolve(null)
    return index.kinds
  }

  /** `path`'s index, brought up to date; concurrent callers share one build. Throws UnreadableLog (or
   *  UnsupportedSchema), NotALog for a log that isn't a regular file, and the `fs` error (`ENOENT`) of a log it can't
   *  open. */
  async index(path: string): Promise<Index> {
    const failed = this.failed.get(path)
    if (failed !== undefined) {
      if (failed.stamp === stamp(fs.statSync(path, { bigint: true }))) throw failed.error
      this.failed.delete(path)
    }
    const building = this.building.get(path) ?? this.start(path)
    let index: Index
    try {
      index = await building
    } catch (error) {
      this.lru.delete(path)
      throw error
    }
    this.keep(path, index)
    return index
  }

  /** The paths whose indexes are kept, least recently used first. */
  cached(): string[] {
    return [...this.lru.keys()]
  }

  /** Starts the build of `path`'s index, shared until it settles. */
  private start(path: string): Promise<Index> {
    const run = async () => {
      const st = fs.statSync(path, { bigint: true })
      try {
        return await this.build(path, this.lru.get(path) ?? null, { nodeCap: this.nodeCap })
      } catch (error) {
        if (error instanceof UnreadableLog) {
          if (this.failed.size >= this.logs) this.failed.clear()
          this.failed.set(path, { stamp: stamp(st), error })
        }
        throw error
      }
    }
    const promise = run()
    this.building.set(path, promise)
    const clear = () => {
      if (this.building.get(path) === promise) this.building.delete(path)
    }
    promise.then(clear, clear)
    return promise
  }

  /** Keeps `index` as the most recently used, evicting the least recently used past the caps. */
  private keep(path: string, index: Index): void {
    this.lru.delete(path)
    this.lru.set(path, index)
    while (this.lru.size > 1 && (this.lru.size > this.logs || this.total() > this.budget)) {
      this.lru.delete(this.lru.keys().next().value!)
    }
  }

  /** The cost of every kept index. */
  private total(): number {
    let sum = 0
    for (const index of this.lru.values()) sum += cost(index)
    return sum
  }
}
