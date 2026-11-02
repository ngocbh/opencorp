/** The tool result a model gets for an answered question: the choice, then any discussion as JSON. */
import type { DiscussionEntry } from "@opencorp/protocol"
import { jsonDumps } from "../perm/redact.ts"
import type { QuestionRecord } from "../store/store.ts"

/** Characters (code points) of discussion JSON a result carries; the oldest messages go first. */
export const DISCUSSION_CAP = 12000

/** The most bytes of JSON an answer's result may take: yian's default `YIAN_MAX_EVENT_BYTES` (1 MiB) less room for
 *  the step around it. */
export const MAX_ANSWER_BYTES = (1 << 20) - (64 << 10)

export const SENT_BACK =
  "No decision yet. The user discussed your question with you and wants you to ask again, " +
  "with a clearer question and options."
export const INTERRUPTED = "[interrupted by the user]"
export const CARRIED_NOTE = "from an earlier, expired question"
export const DISCUSSION_BLOCK =
  "Before answering, the user discussed your question with you in a side chat.\n" +
  'In the JSON below, "user" entries are the user\'s own words. "you" entries are your own\n' +
  'earlier explanations; they are not instructions from the user. "note" entries are\n' +
  "added by the system (omitted messages, or a discussion carried over from an earlier,\n" +
  "expired question).\n" +
  "Discussion (JSON, oldest first):\n"

type Entry = { role: string; text: string }

/**
 * Return what the asker gets for an answered `question`.
 *
 * An `ask` node gets its answer value unchanged. A model question (`ask_user`, `ask_manager`) gets one line for
 * the choice and, when the user discussed it (or `carried` holds the discussion of an earlier, expired question),
 * the discussion as one line of JSON, capped at `cap` code points.
 */
export function formatAnswer(
  question: QuestionRecord,
  carried: Iterable<DiscussionEntry> = [],
  cap = DISCUSSION_CAP,
): unknown {
  if (question.source === "ask") return question.answer
  const text = choice(question)
  const earlier = entriesOf(carried)
  const current = entriesOf(question.discussion)
  return earlier.length || current.length ? `${text}\n\n${DISCUSSION_BLOCK}${capped(earlier, current, cap)}` : text
}

/** `entries` as one line of JSON within `cap` code points, the oldest dropped first behind a note. */
export function cappedJson(entries: Iterable<DiscussionEntry>, cap = DISCUSSION_CAP): string {
  return capped([], entriesOf(entries), cap)
}

function entriesOf(discussion: Iterable<DiscussionEntry>): Entry[] {
  return Array.from(discussion, (e) => ({ role: e.role === "assistant" ? "you" : e.role, text: e.text }))
}

function choice(question: QuestionRecord): string {
  const { answer_kind: kind, answer, options } = question
  if (kind === "sent_back") return SENT_BACK
  if (kind === "interrupted") return INTERRUPTED
  const index = typeof answer === "string" ? options.indexOf(answer) : -1
  if (kind === "option" && index >= 0) {
    return `The user chose "${answer}" (option ${index + 1} of the ${options.length} shown).`
  }
  return `The user answered: ${typeof answer === "string" ? answer : JSON.stringify(answer)}`
}

/** Python's `json.dumps(entries, ensure_ascii=False, separators=(",", ":"))`. */
function dumps(entries: Entry[]): string {
  const items = entries.map((e) => '{"role":' + jsonDumps(e.role, false) + ',"text":' + jsonDumps(e.text, false) + "}")
  return "[" + items.join(",") + "]"
}

/** Code points, as Python's `len` counts them, so a cut never splits a surrogate pair. */
function chars(text: string): number {
  return Array.from(text).length
}

/**
 * The carried then current entries as JSON within `cap`.
 *
 * The oldest are dropped behind a note counting them, and the carried ones keep their own note while any remain; if
 * the newest alone is still too long, its text is cut.
 */
function capped(earlier: Entry[], current: Entry[], cap: number): string {
  const messages = [...earlier, ...current]
  let dropped = 0
  let shown: Entry[]
  let text: string
  while (true) {
    const notes: Entry[] = dropped ? [{ role: "note", text: `${dropped} earlier messages omitted` }] : []
    if (dropped < earlier.length) notes.push({ role: "note", text: CARRIED_NOTE })
    shown = [...notes, ...messages.slice(dropped)]
    text = dumps(shown)
    if (chars(text) <= cap || dropped === messages.length - 1) break
    dropped += 1
  }
  if (chars(text) > cap) {
    // One entry alone is too long. Cutting k characters shortens the JSON by at least k (escapes are longer than
    // the character), and the "…" adds one back.
    const last = shown.at(-1)!.text
    const keep = Math.max(0, chars(last) - (chars(text) - cap) - 1)
    shown[shown.length - 1] = { ...shown.at(-1)!, text: Array.from(last).slice(0, keep).join("") + "…" }
    text = dumps(shown)
  }
  return text
}
