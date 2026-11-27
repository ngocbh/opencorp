/**
 * One node attempt as Run Logs show it: its row of the node page, and its detail read from its own records, so it
 * answers at once however long the log: its times, a flow call's or a loop's outcome, its failure, and the outputs
 * its success's commits hold. Its inputs, and a value derived from others, need a replay: that is its view (`view.ts`).
 */
import { staticPathOf } from "@ngocbh/yian/run"
import type { RunEvent, RunNode, RunNodeDetail, RunNodeFailure, RunNodeValue } from "@opencorp/protocol"
import { cutReason } from "../store/store.ts"
import { kindOf } from "./nodes.ts"
import { type Attempt, ERROR_CHARS, fitValues, type Index, readEvent, recordTime, TOO_LARGE } from "./reader.ts"

/** What a value derived from others (a commit that names only the commits it read) says it is missing for. */
export const DERIVED = "derived from other values"

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

type Payload = Record<string, unknown>
const asRecord = (v: unknown): Payload | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : null)
const text = (v: unknown): string | null => (typeof v === "string" ? v : null)

/** `pointers` under `prefix`, made relative to it. */
function under(pointers: readonly string[] | undefined, prefix: string): string[] {
  return (pointers ?? []).flatMap((p) => (p === prefix || p.startsWith(`${prefix}/`) ? [p.slice(prefix.length)] : []))
}

/** The value of commit `seq` as its record `event` shows it, named `name`: too large, derived from others, or its kind
 *  and value. */
function valueOf(name: string, seq: number, event: RunEvent | null): RunNodeValue {
  const none = { name, seq, type: null, value: null, size: null, cut: [] }
  if (event?.size != null) return { ...none, missing: TOO_LARGE, size: event.size }
  const payload = event?.payload
  if (!payload || !Object.hasOwn(payload, "kind")) return { ...none, missing: DERIVED }
  return { ...none, type: text(payload.kind), value: payload.value ?? null, missing: null, cut: under(event.cut, "/value") }
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
export function cameTo(index: Index, a: Attempt): { ender: Attempt | null; outcome: RunNodeDetail["outcome"] } {
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

/** Which start of its node attempt `a` is, from 1, as yian's `nodeView` counts them; null when the index no longer
 *  holds every attempt before it. */
export function attemptNumber(index: Index, a: Attempt): number | null {
  if (index.dropped) return null
  let n = 0
  for (let i = 0; i < index.nodes.length && index.nodes[i]!.seq <= a.seq; i++) {
    if (index.nodes[i]!.nodeId === a.nodeId) n += 1
  }
  return n
}

/**
 * Attempt `a`'s detail from the log `path` that `index` indexes, read from its records alone: its row, model and record
 * times; for a flow call or a loop, what it came to; the outputs its success (for a flow call or a loop, what returns
 * its value) commits hold, a derived one as such, fitted as one opened record is; its route's handle whole; its
 * failure.
 */
export function nodeDetail(
  path: string,
  index: Index,
  a: Attempt,
  kinds: ReadonlyMap<string, string> | null,
): RunNodeDetail {
  const node = runNode(a, kinds)
  const end = a.endSeq === null ? null : readEvent(path, index, a.endSeq)
  const handle = text(end?.payload?.handle)
  if (end?.kind === "node_routed" && handle !== null) node.handle = handle
  const { ender, outcome } = a.status === "expanded" ? cameTo(index, a) : { ender: null, outcome: null }
  // The success whose values show: the node's own, or what returns a flow call's or a loop's.
  const success = a.status === "succeeded" ? end
    : ender?.status === "succeeded" && ender.endSeq !== null ? readEvent(path, index, ender.endSeq) : null
  const outputs: RunNodeValue[] = []
  const commit = success?.kind === "node_succeeded" ? success.payload?.commit : undefined
  if (typeof commit === "number") {
    outputs.push(valueOf("output", commit, readEvent(path, index, commit)))
    const messages = success!.payload?.messages
    if (typeof messages === "number") outputs.push(valueOf("new_messages", messages, readEvent(path, index, messages)))
  }
  // An expansion ends its attempt at once: a flow call or a loop ends when what returns its value does.
  const endedSeq = a.status === "expanded" ? (ender?.endSeq ?? null) : a.endSeq
  return {
    node,
    model: Object.hasOwn(index.models, staticPathOf(a.nodeId)) ? index.models[staticPathOf(a.nodeId)]! : null,
    started_at: recordTime(path, index, a.seq),
    ended_at: endedSeq === null ? null : recordTime(path, index, endedSeq),
    outcome,
    outputs: fitValues(outputs),
    failure: failureOf(a, end),
  }
}
