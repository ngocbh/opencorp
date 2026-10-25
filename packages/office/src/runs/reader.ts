/**
 * Read-only access to yian run logs that workers may still be appending to: a lazy, bounded index per log folded from
 * yian's `iterRunRecords`, and pages of node attempts and records. Plain reads only: no lock, no write, no `advance`.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import type { Failure } from "@ngocbh/yian"
import { iterRunRecords, RunLogChangedError, type RunLogEntry, RunLogSchemaError } from "@ngocbh/yian/run"
import { cutReason } from "../store/store.ts"

/** The run-log schema this office reads: yian's SCHEMA_VERSION at the submodule pin. */
export const SCHEMA = 22
/** Every this-many records, the index keeps the record's byte offset, so a page seeks near its first record. */
export const SPARSE_EVERY = 64
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
/** The longest string a record page shows whole; a longer one is cut with "…". */
export const FIELD_CHARS = 4 << 10
/** The most JSON a record page holds. */
export const PAGE_BYTES = 256 << 10
/** The most JSON one opened record shows. */
export const EVENT_BYTES = 2 << 20
/** The longest record one opened record parses; a longer one is a stub with its size, read without holding its line
 *  (parsing a record takes several times its size in memory). The download has it whole. */
export const HUGE_LINE = 16 << 20
/** The longest complete line the index reads: yian's reader holds a line whole and parses it, so a longer one makes
 *  the log unreadable before yian sees it. */
export const LINE_CAP = 64 << 20
/** The most bytes of indexes the reader keeps. */
export const LRU_BYTES = 128 << 20
/** The most indexes the reader keeps. */
export const LRU_LOGS = 128
/** How much of a node's error is shown. */
export const ERROR_CHARS = 200
/** How much of a node's error the index keeps, to bound a log with many failed nodes; a longer error is cut with
 *  "…". */
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
  /** (seq, byte offset) of every SPARSE_EVERY-th record. */
  sparse: [number, number][]
  /** Every attempt by start, the newest `nodeCap`. */
  nodes: Attempt[]
  /** Whether older attempts were trimmed from `nodes`. */
  dropped: boolean
  /** The characters of the node ids, errors and retried ids it keeps. */
  held: number
}

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
 * Throws UnsupportedSchema or UnreadableLog for a complete line this office can't read, and the `fs` error (`ENOENT`)
 * of a log it can't open.
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
  const fd = fs.openSync(path, "r")
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
 * nothing but one chunk is held. Throws UnreadableLog for a complete line over LINE_CAP.
 */
async function scan(path: string, index: Index, pace: () => Promise<void>): Promise<number> {
  const fd = fs.openSync(path, "r")
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
      pos += count
      await pace()
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Folds each complete record of `path` from `index.offset` on into `index` (the default `ReadOn`). The office scans
 * the new bytes first, so a line over LINE_CAP is refused before yian's reader holds it, and yian's reader is stopped
 * at the last complete line the scan saw, so it never reads a tail being written. Yields to the event loop about every
 * 10 ms. The last line read is hashed after the loop: a writer that rewrites that line between the read and the hash
 * makes the next refresh rebuild once. A writer that replaces or rewrites the scanned bytes between the scan and
 * yian's read can still make yian hold a line over LINE_CAP: only a line cap in yian's reader closes that.
 */
export async function readOn(path: string, index: Index, resumed: boolean, nodeCap: number): Promise<void> {
  const pace = pacer()
  const scanEnd = await scan(path, index, pace)
  if (scanEnd === index.offset) return
  const from = resumed && index.lastSeq !== null
    ? { afterOffset: index.offset, runId: index.runId, afterSeq: index.lastSeq }
    : {}
  let count = 0
  for (const entry of iterRunRecords(path, from)) {
    // A record past the scanned end means the line at that end was rewritten since the scan.
    if (entry.end > scanEnd) throw new RunLogChangedError("the run log changed under its read")
    apply(index, entry, nodeCap)
    index.offset = entry.end
    index.lastStart = entry.offset
    index.lastSeq = entry.seq
    if (index.runId !== entry.runId) index.runId = own(entry.runId)
    if (entry.seq === 0) index.startEnd = entry.end
    if (entry.end === scanEnd) break
    if (++count % 256 === 0) await pace()
  }
  index.lastSha = sha256(path, index.lastStart, index.offset)
}

/** Folds one record into `index`. */
function apply(index: Index, entry: RunLogEntry, nodeCap: number): void {
  const { seq, kind, nodeId } = entry
  const record = entry.envelope.record
  if (seq % SPARSE_EVERY === 0) index.sparse.push([seq, entry.offset])
  if (kind === "run_started") {
    const start = record as unknown as {
      flowFingerprint: string
      learnable: boolean
      effectiveLlmByStaticPath: Record<string, Record<string, unknown>>
    }
    index.fingerprint = own(start.flowFingerprint)
    index.learnable = start.learnable
    // Built with fromEntries, so a static path named like an Object member is an own key.
    index.models = Object.fromEntries(
      Object.entries(start.effectiveLlmByStaticPath)
        .filter(([, llm]) => typeof llm.model === "string" && llm.model !== "")
        .map(([staticPath, llm]) => [own(staticPath), own(llm.model as string)]),
    )
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
    const ids = (record as unknown as { retryNodeIds: readonly string[] }).retryNodeIds
    const retried = ids.slice(0, OPEN_CAP).map(own)
    index.dividers.push([seq, retried])
    index.held += retried.reduce((sum, id) => sum + id.length, 0)
    if (index.dividers.length > DIVIDER_CAP) {
      index.held -= index.dividers.shift()![1].reduce((sum, id) => sum + id.length, 0)
    }
  }
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
    for (const old of gone) index.held -= old.nodeId.length + (old.error?.length ?? 0)
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
    attempt.handle = own(route.handle)
    failure = route.terminalFailure
  } else if (kind === "node_failed") {
    failure = (record as { failure: Failure }).failure
  }
  if (failure !== null) {
    // The slice keeps cutReason from splitting a huge message; the cut is the same.
    attempt.error = own(cutReason((failure.message || failure.code).slice(0, 2 * ERROR_KEPT), ERROR_KEPT)) || null
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

/** A file's identity, size and modification time, as text. */
function stamp(st: Stat): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`
}

/**
 * The office's run-log indexes: built lazily per log on its first request, one build per log at a time; kept, node
 * table and all, in an LRU capped in bytes and logs, so a log is read whole once unless it is evicted. A log that
 * can't be read isn't read again until its file changes.
 */
export class RunLogReader {
  private readonly budget: number
  private readonly logs: number
  private readonly nodeCap: number
  private readonly build: typeof refresh
  private readonly lru = new Map<string, Index>()
  private readonly building = new Map<string, Promise<Index>>()
  private readonly failed = new Map<string, { stamp: string; error: UnreadableLog }>()

  /** `refresh` builds each index; tests pass their own to act around a build. */
  constructor(
    { budget = LRU_BYTES, logs = LRU_LOGS, nodeCap = NODE_CAP, refresh: build = refresh }: {
      budget?: number
      logs?: number
      nodeCap?: number
      refresh?: typeof refresh
    } = {},
  ) {
    this.budget = budget
    this.logs = logs
    this.nodeCap = nodeCap
    this.build = build
  }

  /** `path`'s index, brought up to date; concurrent callers share one build. Throws UnreadableLog (or
   *  UnsupportedSchema) and the `fs` error (`ENOENT`) of a log it can't open. */
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
