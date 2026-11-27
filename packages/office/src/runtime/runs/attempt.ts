/**
 * One node attempt as Run Logs show it: its row of the node page, and its detail read from its log. The detail follows
 * the record that ended it: a success names its pool commits by seq, and a derived commit names, by `from`, the
 * commits its binding read; derived values are rebuilt by one replay of the log (see `RunLogReader.readEvents`).
 */
import { staticPathOf } from "@ngocbh/yian/run"
import type { RunEvent, RunNode, RunNodeDetail, RunNodeFailure, RunNodeValue } from "@opencorp/protocol"
import { cutReason } from "../store/store.ts"
import { kindOf } from "./nodes.ts"
import {
  type Attempt,
  ERROR_CHARS,
  EVENT_BYTES,
  fitValues,
  type FoldOptions,
  type Index,
  readEvent,
  recordTime,
  type RunLogReader,
} from "./reader.ts"

/** The field an agent's new messages are read under, after its id: `${<node>.new_messages}`. */
const NEW_MESSAGES = "new_messages"

/** Attempt `a` as a node page lists it, with its node's kind from `kinds`, its error cut to ERROR_CHARS. */
export function runNode(a: Attempt, kinds: ReadonlyMap<string, string> | null): RunNode {
  return {
    seq: a.seq,
    end_seq: a.endSeq,
    node_id: a.nodeId,
    kind: kindOf(kinds, a.nodeId),
    // The protocol has no waiting node: a waiting node is in progress.
    status: a.status === "waiting" ? "open" : a.status,
    handle: a.handle,
    error: a.error === null ? null : cutReason(a.error, ERROR_CHARS),
  }
}

/** Whether `nodeId` is a flow's START or END, whose record is shown a field at a time. */
const isBoundary = (nodeId: string) => /(^|\/)__(start|end)__$/.test(nodeId)
const isStart = (nodeId: string) => /(^|\/)__start__$/.test(nodeId)

type Payload = Record<string, unknown>
const asRecord = (v: unknown): Payload | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : null)
const text = (v: unknown): string | null => (typeof v === "string" ? v : null)

/** `pointers` under `prefix`, made relative to it. */
function under(pointers: readonly string[] | undefined, prefix: string): string[] {
  return (pointers ?? []).flatMap((p) => (p === prefix || p.startsWith(`${prefix}/`) ? [p.slice(prefix.length)] : []))
}

/** `key` as a JSON pointer segment. */
const segment = (key: string) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`

/** The value of commit `seq` as its record `event` shows it, named `name`: too large, not rebuilt (a derived commit
 *  shown as written), or its kind and value. */
function valueOf(name: string, seq: number, event: RunEvent | null): RunNodeValue {
  const none = { name, seq, type: null, value: null, size: null, cut: [] }
  if (event?.size != null) return { ...none, missing: "too_large", size: event.size }
  const payload = event?.payload
  if (!payload || !Object.hasOwn(payload, "kind")) return { ...none, missing: "not_rebuilt" }
  return { ...none, type: text(payload.kind), value: payload.value ?? null, missing: null, cut: under(event.cut, "/value") }
}

/** A START's or END's record, a row per field; any other value as it is. */
function fields(row: RunNodeValue): RunNodeValue[] {
  const record = row.type === "object" ? asRecord(row.value) : null
  if (record === null) return [row]
  return Object.entries(record).map(([key, value]) => ({
    ...row,
    name: key,
    type: null,
    value,
    cut: under(row.cut, segment(key)),
  }))
}

/**
 * Pool name `key` as node `nodeId`'s binding reads it, in its flow: `input` for the flow's START, `<node>.output`,
 * `<node>.new_messages`, `system.<name>`; a name from another flow as it is.
 */
export function inputName(key: string, nodeId: string): string {
  if (key.startsWith("system.")) return key
  const scope = nodeId.slice(0, nodeId.lastIndexOf("/") + 1)
  if (!key.startsWith(scope)) return key
  const rest = key.slice(scope.length)
  if (rest.includes("/")) return key
  if (rest === "__start__") return "input"
  return rest.endsWith(`.${NEW_MESSAGES}`) ? rest : `${rest}.output`
}

/** The failure `end` records for attempt `a`: its own (or a route's terminal one), else, when the record is too large
 *  to show or ended another node (a flow call's scope that ended), the error the index kept. */
function failureOf(a: Attempt, end: RunEvent | null): RunNodeFailure | null {
  const field = end?.kind === "node_failed" ? "failure" : end?.kind === "node_routed" ? "terminal_failure" : null
  const recorded = field === null ? null : asRecord(end?.payload?.[field])
  if (recorded !== null && recorded.node_id === a.nodeId) {
    const cut = under(end!.cut, `/${field}`).filter((p) => p.startsWith("/message") || p.startsWith("/traceback"))
    return {
      message: text(recorded.message) || text(recorded.code) || "",
      traceback: text(recorded.traceback),
      cut,
      size: null,
    }
  }
  if (a.error === null) return null
  return { message: cutReason(a.error, ERROR_CHARS), traceback: null, cut: [], size: end?.size ?? null }
}

/** The most input rows one detail shows. */
export const INPUT_ROWS = 100

/** The index of the first attempt in `index.nodes` that starts at or after seq `seq`. */
function from(index: Index, seq: number): number {
  let low = 0
  let high = index.nodes.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (index.nodes[mid]!.seq < seq) low = mid + 1
    else high = mid
  }
  return low
}

/** Whether `id` is one of loop `loop`'s drivers (`<loop>~<k>`). */
const isDriver = (id: string, loop: string) => id.startsWith(`${loop}~`) && /^[0-9]+$/.test(id.slice(loop.length + 1))

/** Whether `id` runs in spawner `spawner`'s flow: its child flow's nodes (`<spawner>/…`), its iterations'
 *  (`<spawner>#<k>/…`) and its drivers. */
const isInside = (id: string, spawner: string) =>
  id.startsWith(`${spawner}/`) || id.startsWith(`${spawner}#`) || isDriver(id, spawner)

/**
 * What expanded attempt `a` (a flow call, loop or map) came to, read from the attempts after it up to its next
 * attempt: the attempt that returns its value (its END, or a loop's last turn's driver, the latest that did more than
 * expand), and its outcome: open while a node in it is, succeeded once that attempt did, failed once a node in it did.
 */
function cameTo(index: Index, a: Attempt): { ender: Attempt | null; outcome: RunNodeDetail["outcome"] } {
  const end = `${a.nodeId}/__end__`
  let ender: Attempt | null = null
  let open = false
  let failed = false
  for (let i = from(index, a.seq + 1); i < index.nodes.length; i++) {
    const n = index.nodes[i]!
    if (n.nodeId === a.nodeId) break
    if (!isInside(n.nodeId, a.nodeId)) continue
    if (n.nodeId === end || (isDriver(n.nodeId, a.nodeId) && n.status !== "expanded")) ender = n
    open ||= n.status === "open" || n.status === "waiting"
    failed ||= n.status === "failed"
  }
  const outcome = open ? "open" : ender?.status === "succeeded" ? "succeeded" : failed ? "failed" : null
  return { ender: ender && { ...ender }, outcome }
}

/** What reading `event` adds to a detail, for its budget. */
const weight = (event: RunEvent | null) => (event === null ? 0 : Buffer.byteLength(JSON.stringify(event)))

/**
 * Attempt `a`'s detail from the log `path` that `index` indexes: its row, model and record times; for a success, the
 * values its commits hold (rebuilt under `fold`) and, for a derived node other than a START, the values its binding
 * read, at most INPUT_ROWS of them and no more than one detail holds; for a flow call or a loop, what it came to and
 * the values its END (its last turn) returned; its route's handle whole; its failure. The values are fitted as one
 * opened record is.
 */
export async function nodeDetail(
  reader: RunLogReader,
  path: string,
  index: Index,
  a: Attempt,
  { fold, kinds }: { fold: FoldOptions | undefined; kinds: ReadonlyMap<string, string> | null },
): Promise<RunNodeDetail> {
  const node = runNode(a, kinds)
  const end = a.endSeq === null ? null : readEvent(path, index, a.endSeq)
  const handle = text(end?.payload?.handle)
  if (end?.kind === "node_routed" && handle !== null) node.handle = handle
  const { ender, outcome } = a.status === "expanded" ? cameTo(index, a) : { ender: null, outcome: null }
  // The success whose values show: the node's own, or what returns a flow call's or a loop's.
  const success = a.status === "succeeded" ? end
    : ender?.status === "succeeded" && ender.endSeq !== null ? readEvent(path, index, ender.endSeq) : null
  let outputs: RunNodeValue[] = []
  let inputs: RunNodeValue[] = []
  let more = 0
  const commit = success?.kind === "node_succeeded" ? success.payload?.commit : undefined
  if (typeof commit === "number") {
    const messages = typeof success!.payload?.messages === "number" ? (success!.payload.messages as number) : null
    const own = readEvent(path, index, commit)
    const messageRead = messages === null ? [] : [readEvent(path, index, messages)]
    // A derived commit names what its binding read, each by its commit's seq: read in name order until the rows or
    // the bytes one detail shows.
    const named = a.status === "succeeded" && !isStart(a.nodeId) ? Object.entries(asRecord(own?.payload?.from) ?? {}) : []
    const sources = named.filter((entry): entry is [string, number] => typeof entry[1] === "number")
    let used = weight(own) + weight(messageRead[0] ?? null)
    const read: [string, number, RunEvent | null][] = []
    for (const [key, seq] of sources) {
      if (read.length >= INPUT_ROWS || used > EVENT_BYTES) break
      const event = readEvent(path, index, seq)
      used += weight(event)
      read.push([key, seq, event])
    }
    more = sources.length - read.length
    const seqs = [commit, ...(messages === null ? [] : [messages]), ...read.map(([, seq]) => seq)]
    const events = await reader.rebuilt(path, index, seqs, [own, ...messageRead, ...read.map(([, , e]) => e)], { fold })
    const value = valueOf("output", commit, events[0]!)
    outputs = isBoundary(a.nodeId) || ender !== null ? fields(value) : [value]
    if (messages !== null) outputs.push(valueOf(NEW_MESSAGES, messages, events[1]!))
    const first = seqs.length - read.length
    inputs = read.map(([key, seq], i) => valueOf(inputName(key, a.nodeId), seq, events[first + i]!))
  }
  const fitted = fitValues([...outputs, ...inputs])
  // An expansion ends its attempt at once: a flow call or a loop ends when what returns its value does.
  const endedSeq = a.status === "expanded" ? (ender?.endSeq ?? null) : a.endSeq
  return {
    node,
    model: Object.hasOwn(index.models, staticPathOf(a.nodeId)) ? index.models[staticPathOf(a.nodeId)]! : null,
    started_at: recordTime(path, index, a.seq),
    ended_at: endedSeq === null ? null : recordTime(path, index, endedSeq),
    outcome,
    outputs: fitted.slice(0, outputs.length),
    inputs: fitted.slice(outputs.length),
    inputs_more: more,
    failure: failureOf(a, end),
  }
}
