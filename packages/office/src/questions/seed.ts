/** The first message of a side chat: framing, what the asker was doing, and the question card. */
import fs from "node:fs"
import path from "node:path"
import type { DiscussionEntry, Message } from "@opencorp/protocol"
import type { Transcript } from "../chat/transcript.ts"
import type { CompanyRepo } from "../company/loader.ts"
import { pyJson, repr } from "../perm/redact.ts"
import type { QuestionRecord, SessionRecord, Store } from "../store/store.ts"
import { personFlow } from "../worker/job.ts"
import { cappedJson } from "./format.ts"

export const FRAMING =
  "You are now talking directly with the person you asked the question below, before they answer it. " +
  'Speak to them as "you"; never call them "the user" or "they". They want to understand your question: ' +
  "explain it; do not decide for them, and do not change anything."
/** Characters (code points) of one tool call's input or output the seed keeps. */
export const TOOL_OUTPUT_CHARS = 2000
export const FIRST_MESSAGE = "# Their first message to you\n\n"
export const CUT = "… [the rest of the context is cut]"
// A harness card never gets a side chat (cards.ts refuses it), so it has no line here.
const VIA: Partial<Record<QuestionRecord["source"], string>> = {
  ask_user: "with ask_user",
  ask_manager: "with ask_manager, to your manager",
  ask: "at an ask step of your flow",
}

/**
 * The side chat's seed for `question`: framing, context, then the card; at most `maxChars` code points.
 *
 * The context is who asked, the asker's flow at its session's pinned commit (`repo` is that commit's checkout), the
 * question's work item and its parents with their comments, and the asker's transcript before the question. The
 * transcript is shortened to fit first: its oldest and newest events are kept around an `…N events omitted…` marker,
 * and each tool input and output is cut to `TOOL_OUTPUT_CHARS`. If the rest is still too long, the comments go, then
 * the context is cut from its end; the card always stays. `carried` is the discussion of an earlier, expired question.
 */
export function buildSeed(
  store: Store,
  transcript: Pick<Transcript, "messages">,
  repo: CompanyRepo,
  question: QuestionRecord,
  { maxChars, carried = [] }: { maxChars: number; carried?: Iterable<DiscussionEntry> },
): string {
  const asker = store.getSession(question.session_id)
  const card = cardText(question, carried)
  let head = ""
  for (const comments of [true, false]) {
    head = [FRAMING, who(repo, question), flow(repo, asker), work(store, question.work_item_id, comments)]
      .filter((part) => part)
      .join("\n\n")
    if (chars(head) + 2 + chars(card) <= maxChars) break
  }
  const events = asker ? eventsBefore(transcript.messages(asker.id, asker.run_ids), question.created_at) : []
  return fit(head, events, card, maxChars)
}

/** The first turn's text: the seed, then the human's first message. */
export function firstMessage(seed: string, text: string): string {
  return `${seed}\n\n${FIRST_MESSAGE}${text}`
}

/**
 * The question as its card shows it, with any discussion carried over from an expired question. Throws on a
 * `harness` question, which has no side chat.
 */
export function cardText(question: QuestionRecord, carried: Iterable<DiscussionEntry> = []): string {
  const via = VIA[question.source]
  if (via === undefined) throw new Error(`a ${question.source} question has no card text`)
  const lines = [`# The question you asked (${via})`, ""]
  if (question.title) lines.push(`Title: ${question.title}`)
  if (question.question) lines.push(question.question)
  question.options.forEach((option, i) => lines.push(`  ${i + 1}. ${option}`))
  const pages = question.questions ?? []
  pages.forEach((page, i) => {
    lines.push(
      `Question ${i + 1} of ${pages.length} · ${page.header}${page.multi_select ? " (pick any)" : ""}: ${page.question}`,
    )
    for (const o of page.options) lines.push(`  - ${o.label}${o.description ? `: ${o.description}` : ""}`)
  })
  if (!pages.length) {
    for (const field of question.answer_schema) {
      // Python's list repr, as the card has always shown it.
      const allowed = field.enum?.length ? `, one of [${field.enum.map(repr).join(", ")}]` : ""
      lines.push(`Answer field ${field.name}: ${field.type}${allowed}${field.required ? "" : ", optional"}`)
    }
  }
  const earlier = Array.from(carried)
  if (earlier.length) {
    lines.push(
      "",
      "You discussed an earlier question with them before it expired (JSON, oldest first):",
      cappedJson(earlier),
    )
  }
  return lines.join("\n")
}

function who(repo: CompanyRepo, question: QuestionRecord): string {
  const person = repo.people.get(question.asker)
  if (person === undefined) return `# Who asked\n\nYou are ${question.asker}.`
  const title = person.title ? `, ${person.title}` : ""
  return `# Who asked\n\nYou are ${person.name} (@${person.handle})${title}.`
}

function flow(repo: CompanyRepo, asker: SessionRecord | undefined): string {
  const person = asker ? repo.people.get(asker.person) : undefined
  if (asker === undefined || asker.kind !== "main" || person === undefined || !person.main) return ""
  const rel = personFlow(person.handle, person.main)
  let text: string
  try {
    text = fs.readFileSync(path.join(repo.root, rel), "utf8")
  } catch {
    return ""
  }
  return `# Your instructions: the flow ${rel} at commit ${asker.repo_commit.slice(0, 12)}\n\n` +
    "```yaml\n" + text.trimEnd() + "\n```"
}

function work(store: Store, workItemId: string | null, comments: boolean): string {
  const blocks: string[] = []
  const seen = new Set<string>()
  let id = workItemId
  while (id && !seen.has(id)) {
    seen.add(id)
    const item = store.getWorkItem(id)
    if (item === undefined) break
    const lines = [
      `Work item "${item.title}" (${item.kind}, ${item.status}), requested by ${item.requester}` +
        (item.assignee ? `, assigned to ${item.assignee}` : ""),
    ]
    if (item.summary) lines.push(item.summary)
    if (comments) for (const c of store.listComments(item.id)) lines.push(`- ${c.author}: ${c.body}`)
    blocks.push(lines.join("\n"))
    id = item.parent_id
  }
  return blocks.length ? "# The work\n\n" + blocks.join("\n\n") : ""
}

/** The asker's events before `before`; both are UTC ISO stamps, so string order is time order. */
function eventsBefore(messages: readonly Message[], before: string): string[] {
  const events: string[] = []
  for (const message of messages) {
    if (message.created_at >= before) break
    const by = message.role === "user" ? "user" : "you"
    for (const part of message.parts) {
      if (part.type === "text" && part.text) events.push(`[${by}] ${part.text}`)
      else if (part.type === "tool") {
        const result = part.error ? part.error : part.output
        events.push(`[tool ${part.tool}, ${part.state}] input: ${cut(part.input)}\n  output: ${cut(result)}`)
      }
    }
  }
  return events
}

function cut(value: unknown): string {
  const text = typeof value === "string" ? value : pyJson(value, false)
  if (text.length <= TOOL_OUTPUT_CHARS) return text
  // Tool outputs can be megabytes: count and find the cut in one walk, never splitting the text into an array.
  let count = 0
  let index = 0
  for (const point of text) if (count++ < TOOL_OUTPUT_CHARS) index += point.length
  return count <= TOOL_OUTPUT_CHARS ? text : `${text.slice(0, index)}… [${count} chars]`
}

// Lengths and cuts count code points, as Python does: yian refuses a message with an unpaired surrogate, so a cut
// inside a surrogate pair would fail the side chat's first turn.

/** Code points in `text`. */
function chars(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** Python's `text[:n]` in code points. */
function first(text: string, n: number): string {
  if (n >= 0 && text.length <= n) return text
  if (n < 0) n = Math.max(0, chars(text) + n)
  // Walk to the UTF-16 index of the n-th code point, so a huge text is never split into an array.
  let index = 0
  let count = 0
  for (const point of text) {
    if (count++ >= n) break
    index += point.length
  }
  return text.slice(0, index)
}

function fit(head: string, events: string[], card: string, maxChars: number): string {
  const title = "# What you did before asking (oldest first)"
  const parts = events.length ? [head, title, ...events, card] : [head, card]
  const text = parts.join("\n\n")
  if (chars(text) <= maxChars) return text
  const budget = maxChars - chars([head, title, card].join("\n\n")) - 64
  if (budget <= 0) {
    // No room for any event: drop them, then cut the context; keep the card.
    if (chars(head) + 2 + chars(card) <= maxChars) return `${head}\n\n${card}`
    const room = maxChars - chars(card) - chars(CUT) - 2
    return room > 0 ? `${first(head, room)}${CUT}\n\n${card}` : first(card, maxChars)
  }
  const tail: string[] = []
  let used = 0
  // The newest events matter most: they take up to three quarters of the room.
  for (let i = events.length - 1; i >= 0; i--) {
    const size = chars(events[i]!) + 2
    if (used + size > Math.floor((budget * 3) / 4)) break
    tail.unshift(events[i]!)
    used += size
  }
  const kept: string[] = []
  for (const event of events.slice(0, events.length - tail.length)) {
    const size = chars(event) + 2
    if (used + size > budget) break
    kept.push(event)
    used += size
  }
  const omitted = events.length - kept.length - tail.length
  return first([head, title, ...kept, `…${omitted} events omitted…`, ...tail, card].join("\n\n"), maxChars)
}
