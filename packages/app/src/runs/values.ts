// What node detail says of a node: a value's preview in its row and whether it opens, how long the node took, and
// which work section its kind shows.
import type { RunNode, RunNodeValue } from "@opencorp/protocol"

/** A preview shows at most this many characters of a string, or of a record's keys. */
export const PREVIEW_CHARS = 60

/** `text` cut to PREVIEW_CHARS, with "…" when it was longer. */
const cut = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** Whether `v` reads as a message: a record with a role. */
const isMessage = (v: unknown) => isRecord(v) && typeof v.role === "string"

/** `n` and its noun, singular for one. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/**
 * A value in one short line: a string quoted, its first line cut to PREVIEW_CHARS; a list by its length, in messages
 * when it holds messages; a record by its keys; anything else as JSON. A value that isn't here says why.
 */
export function preview(v: RunNodeValue): string {
  if (v.missing === "too_large") return `${((v.size ?? 0) / 2 ** 20).toFixed(1)} MB: too large to show; download the log`
  if (v.missing === "not_rebuilt") return "this office couldn't rebuild it from the log"
  const value = v.value ?? null
  if (typeof value === "string") {
    const first = value.split("\n", 1)[0]!
    return `"${first.length > PREVIEW_CHARS || first.length === value.length ? cut(first) : `${first}…`}"`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value.every(isMessage) ? count(value.length, "message") : count(value.length, "item")
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    return keys.length ? `{${cut(keys.join(", "))}}` : "{}"
  }
  return JSON.stringify(value)
}

/** Whether `v`'s preview shows all there is, so there's nothing to open: a scalar, a short one-line string the office
 *  didn't cut, an empty list or record, or a value that isn't here. */
export function shownWhole(v: RunNodeValue): boolean {
  if (v.missing) return true
  if ((v.cut ?? []).length) return false
  const value = v.value ?? null
  if (typeof value === "string") return !value.includes("\n") && value.length <= PREVIEW_CHARS
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return true
}

/** A span of `ms` milliseconds, as the Run Logs list says how long a run took: "450ms", "4.3s", "3m 5s", "2h 10m". */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** How long a node took from its start record's time to its end record's; null without both, or when the clock
 *  went back between them (record times aren't promised to increase). */
export function duration(started: string | null | undefined, ended: string | null | undefined): string | null {
  if (!started || !ended) return null
  const ms = Date.parse(ended) - Date.parse(started)
  return Number.isFinite(ms) && ms >= 0 ? durationText(ms) : null
}

/** The kinds that show a work section between a node's inputs and outputs; node.tsx draws each. */
export const WORK_KINDS = ["agent", "case"] as const
export type WorkKind = (typeof WORK_KINDS)[number]

/** The work section `node` shows by its kind: an agent's model calls, a case's route (a node with a handle is a case,
 *  its kind known or not); null for every other kind, for now. */
export function workOf(node: Pick<RunNode, "kind" | "handle">): WorkKind | null {
  const kind = node.kind ?? (node.handle != null ? "case" : null)
  return (WORK_KINDS as readonly string[]).includes(kind ?? "") ? (kind as WorkKind) : null
}
