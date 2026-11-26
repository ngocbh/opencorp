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

/**
 * Attempt `a`'s detail from the log `path` that `index` indexes: its row, model and record times; for a success, the
 * values its commits hold (rebuilt under `fold`) and, for a derived node other than a START, the values its binding
 * read; its route's handle whole; its failure. The values are fitted as one opened record is.
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
  let outputs: RunNodeValue[] = []
  let inputs: RunNodeValue[] = []
  if (a.status === "succeeded" && end?.kind === "node_succeeded") {
    const commit = end.payload?.commit
    const messages = end.payload?.messages
    if (typeof commit === "number") {
      // A derived commit names what its binding read, each by its commit's seq.
      const from = isStart(a.nodeId) ? [] : Object.entries(asRecord(readEvent(path, index, commit)?.payload?.from) ?? {})
      const read = from.filter((entry): entry is [string, number] => typeof entry[1] === "number")
      const seqs = [commit, ...(typeof messages === "number" ? [messages] : []), ...read.map(([, seq]) => seq)]
      const events = await reader.readEvents(path, index, seqs, { fold })
      const own = valueOf("output", commit, events[0]!)
      outputs = isBoundary(a.nodeId) ? fields(own) : [own]
      if (typeof messages === "number") outputs.push(valueOf(NEW_MESSAGES, messages, events[1]!))
      const first = seqs.length - read.length
      inputs = read.map(([key, seq], i) => valueOf(inputName(key, a.nodeId), seq, events[first + i]!))
    }
  }
  const fitted = fitValues([...outputs, ...inputs])
  return {
    node,
    model: Object.hasOwn(index.models, staticPathOf(a.nodeId)) ? index.models[staticPathOf(a.nodeId)]! : null,
    started_at: recordTime(path, index, a.seq),
    ended_at: a.endSeq === null ? null : recordTime(path, index, a.endSeq),
    outputs: fitted.slice(0, outputs.length),
    inputs: fitted.slice(outputs.length),
    failure: failureOf(a, end),
  }
}
