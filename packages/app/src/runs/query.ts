// The Run Logs search box's query, as GitHub's issue search writes one: qualifiers (`flow:chat`, `@kai`, `is:open`,
// `started:7d`) and free text for part of a run id. Pure, so it's tested without a browser; the whole query lives in
// the address (`/runs?q=`), so a filtered list can be linked to (the Org panel's "All runs").
import type { CompanyTreeEntry, RunSummary } from "@opencorp/protocol"

export type Status = RunSummary["status"]

export const STATUSES: Status[] = ["running", "waiting", "idle", "finished", "failed", "interrupted"]
const OPEN: Status[] = ["running", "waiting", "idle"]
const CLOSED: Status[] = ["finished", "failed", "interrupted"]

/** The query the list opens with when the address has none: open runs from the last 7 days, so a read stays small. */
export const DEFAULT_QUERY = "is:open started:7d"

const KEYS = ["flow", "person", "is", "started"] as const
type Key = (typeof KEYS)[number]

/** What the box asks for, each value as typed (checked, not yet resolved against the clock). */
export type RunQuery = { flow?: string; person?: string; is?: string; started?: string; text?: string }

/** `GET /runs`'s filter parameters, with `started:` resolved to Timestamps. */
export type RunParams = { flow?: string; person?: string; status?: Status[]; since?: string; until?: string; q?: string }

/**
 * One whitespace-separated piece of the box: a recognised qualifier, run id text, a qualifier with no value yet, or
 * something ignored (and hinted).
 */
export type Token = { start: number; end: number; text: string; kind: "qualifier" | "text" | "pending" | "ignored" }

const STARTED_HINT = "started: takes 24h, 7d, >2026-10-13 or 2026-10-01..2026-10-15"
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** `key:value`, `@value` (a person), or null for free text. */
function split(text: string): { key: string; value: string } | null {
  if (text.startsWith("@")) return { key: "person", value: text.slice(1) }
  const m = /^([A-Za-z_]+):(.*)$/.exec(text)
  return m ? { key: m[1]!.toLowerCase(), value: m[2]! } : null
}

/** The query `text` asks for, its tokens, and a hint for each part it ignores. */
export function parse(text: string): { query: RunQuery; tokens: Token[]; hints: string[] } {
  const query: RunQuery = {}
  const tokens: Token[] = []
  const hints: string[] = []
  const hint = (h: string) => hints.includes(h) || hints.push(h)
  for (const m of text.matchAll(/\S+/g)) {
    const token: Token = { start: m.index, end: m.index + m[0].length, text: m[0], kind: "ignored" }
    tokens.push(token)
    const q = split(m[0])
    if (!q) {
      if (query.text !== undefined) hint("one run id at a time")
      else {
        query.text = m[0]
        token.kind = "text"
      }
      continue
    }
    if (!(KEYS as readonly string[]).includes(q.key)) {
      hint(`unknown filter ${q.key}:`)
      continue
    }
    const key = q.key as Key
    const value = key === "person" ? q.value.replace(/^@/, "") : key === "is" ? q.value.toLowerCase() : q.value
    if (!value) {
      token.kind = "pending"
      continue
    }
    if (query[key] !== undefined) {
      hint(`one ${key}: at a time`)
      continue
    }
    if (key === "is" && !statusesOf(value)) {
      hint(`unknown state ${value}: is: takes open, closed or a state`)
      continue
    }
    if (key === "started" && !startedRange(value, new Date())) {
      hint(STARTED_HINT)
      continue
    }
    query[key] = value
    token.kind = "qualifier"
  }
  return { query, tokens, hints }
}

/** The statuses an `is:` value stands for; undefined for one that isn't open, closed or a status. */
function statusesOf(is: string): Status[] | undefined {
  if (is === "open") return OPEN
  if (is === "closed") return CLOSED
  return (STATUSES as string[]).includes(is) ? [is as Status] : undefined
}

/** The start of local day `d` (`YYYY-MM-DD`) plus `plus` days; undefined for a day that doesn't exist. */
function localDay(d: string, plus = 0): Date | undefined {
  const m = DAY.exec(d)
  if (!m) return undefined
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const at = new Date(y, mo - 1, day)
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== day) return undefined
  at.setDate(at.getDate() + plus)
  return at
}

/**
 * The launch window a `started:` value stands for at `now`: `since` inclusive and `until` exclusive. `<n>h` and `<n>d`
 * end now; dates are local days (`>D`, `>=D`, `<D`, `<=D`, `D`, `D..D` with both days included). Undefined for a
 * value that's none of these.
 */
export function startedRange(value: string, now: Date): { since?: string; until?: string } | undefined {
  const ago = /^(\d+)([hd])$/.exec(value)
  if (ago) {
    const n = Number(ago[1])
    return n > 0 ? { since: new Date(now.getTime() - n * (ago[2] === "h" ? 3_600_000 : 86_400_000)).toISOString() } : undefined
  }
  const range = /^([^.]+)\.\.([^.]+)$/.exec(value)
  if (range) {
    const [from, to] = [localDay(range[1]!), localDay(range[2]!, 1)]
    return from && to && from < to ? { since: from.toISOString(), until: to.toISOString() } : undefined
  }
  const cmp = /^(>=|>|<=|<)?(.+)$/.exec(value)
  if (!cmp) return undefined
  const iso = (plus: number) => localDay(cmp[2]!, plus)?.toISOString()
  const [since, until] =
    cmp[1] === ">" ? [iso(1), null] : cmp[1] === ">=" ? [iso(0), null] : cmp[1] === "<" ? [null, iso(0)]
    : cmp[1] === "<=" ? [null, iso(1)] : [iso(0), iso(1)]
  if (since === undefined || until === undefined) return undefined
  return { ...(since && { since }), ...(until && { until }) }
}

/** `GET /runs`'s parameters for `query` at `now`. */
export function paramsOf(query: RunQuery, now: Date): RunParams {
  const p: RunParams = {
    flow: query.flow,
    person: query.person,
    status: query.is ? statusesOf(query.is) : undefined,
    ...(query.started && startedRange(query.started, now)),
    q: query.text,
  }
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as RunParams
}

/** The query as text, qualifiers in one order, then the run id text. */
export function serialize(q: RunQuery): string {
  return [q.flow && `flow:${q.flow}`, q.person && `@${q.person}`, q.is && `is:${q.is}`, q.started && `started:${q.started}`, q.text]
    .filter(Boolean)
    .join(" ")
}

type Param = string | string[] | undefined
const first = (p: Param) => (Array.isArray(p) ? p[0] : p) || undefined

/**
 * The box's text for an address: `q` as it is (empty is an empty box); old `?flow=`, `?person=` and `?status=`
 * addresses turned into qualifiers (`old` says the address should be rewritten); the default when there's no query.
 */
export function queryOfAddress(params: Record<string, Param>): { text: string; old: boolean } {
  const [flow, person, status] = [first(params.flow), first(params.person), first(params.status)]
  const q = Array.isArray(params.q) ? params.q[0] : params.q
  if (flow || person || status)
    return { text: [flow && `flow:${flow}`, person && `@${person}`, status && `is:${status}`, q].filter(Boolean).join(" "), old: true }
  return { text: q ?? DEFAULT_QUERY, old: false }
}

/** The list's address for the query `text`, readable: spaces as `+`, and `:` and `@` as they are. */
export const hrefOf = (text: string) =>
  `/runs?q=${encodeURIComponent(text).replace(/%20/g, "+").replace(/%3A/gi, ":").replace(/%40/g, "@")}`

/** Whether `run` matches every parameter set (the office decides which rows a page holds; this opens matching children). */
export const matches = (run: RunSummary, p: RunParams) =>
  (!p.flow || run.flow === p.flow) &&
  (!p.person || run.driver === p.person || (run.participants ?? []).includes(p.person)) &&
  (!p.status || p.status.includes(run.status)) &&
  (!p.since || Date.parse(run.launched_at) >= Date.parse(p.since)) &&
  (!p.until || Date.parse(run.launched_at) < Date.parse(p.until)) &&
  (!p.q || run.run_id.includes(p.q.trim().toUpperCase()))

/** Whether `q` is a whole run id (a ULID), which search opens instead of filtering by. */
export const isRunId = (q: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(q.trim().toUpperCase())

/** The flows a company repo listing holds: each YAML file directly in a `flows/` folder, by name. */
export const flowsOf = (entries: Pick<CompanyTreeEntry, "path" | "type">[]) =>
  [...new Set(entries.flatMap((e) => (e.type === "file" && /(^|\/)flows\/([^/]+)\.ya?ml$/.exec(e.path)?.[2]) || []))].sort()

/** An autocomplete choice: the text that replaces the token, and whether it completes a filter (a space follows). */
export type Option = { insert: string; label: string; detail?: string; complete: boolean }
/** The token under the caret (`start`..`end`) and the options for it. */
export type Suggestions = { start: number; end: number; options: Option[] }
export type Sources = { flows: string[]; people: { handle: string; name: string }[] }

const KEY_OPTIONS: Option[] = [
  { insert: "flow:", label: "flow:", detail: "flow name", complete: false },
  { insert: "person:", label: "person:", detail: "who drove it or took part; or type @", complete: false },
  { insert: "is:", label: "is:", detail: "open, closed or a state", complete: false },
  { insert: "started:", label: "started:", detail: "when it started", complete: false },
]
const IS_DETAIL: Record<string, string> = { open: "running, waiting or idle", closed: "finished, failed or interrupted" }
const STARTED_OPTIONS: [string, string][] = [["24h", "last 24 hours"], ["7d", "last 7 days"], ["30d", "last 30 days"]]
const MAX_OPTIONS = 8

/** `items` whose `keys` contain `typed`: those starting with it first, each group in the order given. */
function filtered<T>(items: T[], typed: string, keys: (t: T) => string[]): T[] {
  const t = typed.toLowerCase()
  const has = (item: T, f: (k: string) => boolean) => keys(item).some((k) => f(k.toLowerCase()))
  const starts = items.filter((i) => has(i, (k) => k.startsWith(t)))
  return [...starts, ...items.filter((i) => !starts.includes(i) && has(i, (k) => k.includes(t)))]
}

/**
 * What to offer for the token under `caret`, judged by its text before the caret: the qualifiers while it has no
 * colon (nothing for run id text), then the values of the one it names. Undefined when there's nothing to offer.
 */
export function suggest(text: string, caret: number, sources: Sources): Suggestions | undefined {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  let end = caret
  while (end < text.length && !/\s/.test(text[end]!)) end++
  const typed = text.slice(start, caret)
  const q = split(typed)
  let options: Option[] = []
  if (!q) options = KEY_OPTIONS.filter((o) => o.insert.startsWith(typed.toLowerCase()))
  else {
    const prefix = typed.slice(0, typed.length - q.value.length)
    const value = (v: string, label = v, detail?: string): Option => ({ insert: prefix + v, label, detail, complete: true })
    if (q.key === "flow") {
      const flows = [...new Set(sources.flows)].sort()
      options = filtered(flows, q.value, (f) => [f]).map((f) => value(f))
    } else if (q.key === "person") {
      const typedAt = q.value.startsWith("@")
      const people = [...sources.people].sort((a, b) => a.name.localeCompare(b.name))
      options = filtered(people, q.value.replace(/^@/, ""), (p) => [p.handle, p.name]).map((p) =>
        value(typedAt ? `@${p.handle}` : p.handle, `@${p.handle}`, p.name),
      )
    } else if (q.key === "is") {
      options = filtered(["open", "closed", ...STATUSES], q.value, (s) => [s]).map((s) => value(s, s, IS_DETAIL[s]))
      // Prefix matches only: "is:f" means finished or failed, not every state with an "f" in it.
      options = options.filter((o) => o.label.startsWith(q.value.toLowerCase()))
    } else if (q.key === "started")
      options = STARTED_OPTIONS.filter(([v]) => v.startsWith(q.value)).map(([v, d]) => value(v, v, d))
  }
  options = options.slice(0, MAX_OPTIONS)
  return options.length ? { start, end, options } : undefined
}

/** `text` with the token `s` names replaced by `option`, and where the caret goes. */
export function accept(text: string, s: Suggestions, option: Option): { text: string; caret: number } {
  const after = text.slice(s.end)
  const space = option.complete ? (after.startsWith(" ") ? "" : " ") : ""
  const head = text.slice(0, s.start) + option.insert + space
  return { text: head + after, caret: head.length + (option.complete && !space ? 1 : 0) }
}
