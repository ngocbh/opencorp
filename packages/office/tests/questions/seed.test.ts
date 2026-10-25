/** The side chat's seed: framing, the asker's context, and the question card. */
import path from "node:path"
import { expect, test } from "bun:test"
import type { DiscussionEntry, Message, Part } from "@opencorp/protocol"
import { loadRepo } from "../../src/company/loader.ts"
import { DISCUSSION_CAP } from "../../src/questions/format.ts"
import { FRAMING, buildSeed, cardText, firstMessage } from "../../src/questions/seed.ts"
import { type QuestionRecord, type Store, newId } from "../../src/store/store.ts"
import { baseFiles, writeRepo } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { comment, openStore, question, session, workItem } from "../store/helpers.ts"

function at(n: number): string {
  return `2026-09-30T10:00:${String(n).padStart(2, "0")}.000Z`
}

function text(t: string): Part {
  return { id: newId(), type: "text", text: t }
}

function tool(name: string, output: unknown): Part {
  return {
    id: newId(),
    type: "tool",
    call_id: newId(),
    tool: name,
    state: "completed",
    input: { path: "src/app.py" },
    output,
    error: null,
  }
}

function message(sessionId: string, parts: Part[], createdAt: string, role: "user" | "assistant" = "assistant"): Message {
  return { id: newId(), session_id: sessionId, role, author: null, parts, created_at: createdAt }
}

/** A stand-in transcript over messages built in the test, by session id. */
function transcriptOf(byId: Map<string, Message[]>) {
  return { messages: (sid: string) => byId.get(sid) ?? [] }
}

function makeRepo() {
  return loadRepo(writeRepo(path.join(tempDir(), "company"), baseFiles()))
}

/** Python's `asked` fixture: a question on a child work item with a comment, asked mid-transcript. */
function asked(store: Store): { question: QuestionRecord; byId: Map<string, Message[]> } {
  const parent = store.createWorkItem(workItem({ title: "Ship v2" }))
  const item = store.createWorkItem(workItem({ title: "Fix the build", parent_id: parent.id, assignee: "minh" }))
  store.addComment(comment(item.id, { body: "CI is red since Monday" }))
  const asker = store.createSession(session({ work_item_id: item.id }))
  const q = store.addQuestion(
    question(asker.id, {
      work_item_id: item.id,
      question: "Retry or back off?",
      options: ["Retry", "Back off"],
      created_at: at(3),
      updated_at: at(3),
    }),
  )
  const messages = [
    message(asker.id, [text("fix the build")], at(1), "user"),
    message(asker.id, [text("Looking."), tool("read_file", "x".repeat(5000))], at(2)),
    message(asker.id, [text("after the question")], at(4)),
  ]
  return { question: q, byId: new Map([[asker.id, messages]]) }
}

/** Code points, as Python's `len` counts them. */
function chars(t: string): number {
  return Array.from(t).length
}

test("the seed frames the chat then gives context and the card", () => {
  const store = openStore()
  const repo = makeRepo()
  const { question: q, byId } = asked(store)
  const seed = buildSeed(store, transcriptOf(byId), repo, q, { maxChars: 200_000 })
  expect(seed.startsWith(FRAMING)).toBe(true)
  const order = [
    "# Who asked",
    "Minh (@minh), Engineer",
    "people/minh/../../shared/flows/chat.yaml",
    "tool_id: take",
    '"Fix the build"',
    "CI is red since Monday",
    '"Ship v2"',
    "[user] fix the build",
    "[you] Looking.",
    "[tool read_file, completed]",
    "# The question you asked (with ask_user)",
    "Retry or back off?",
    "1. Retry",
    "2. Back off",
  ]
  const places = order.map((s) => seed.indexOf(s))
  expect(places.every((p) => p >= 0)).toBe(true)
  expect(places).toEqual([...places].sort((a, b) => a - b))
  expect(seed).toContain(`at commit ${"a".repeat(12)}\n`)
  expect(seed).toContain("x".repeat(2000) + "… [5000 chars]")
  expect(seed).not.toContain("x".repeat(2001))
  expect(seed).not.toContain("after the question")
})

test("a long transcript keeps its start and end", () => {
  const store = openStore()
  const repo = makeRepo()
  const asker = store.createSession(session())
  const messages = Array.from({ length: 40 }, (_, n) =>
    message(asker.id, [text(`step ${String(n).padStart(2, "0")} ` + "y".repeat(400))], at(n)),
  )
  const q = store.addQuestion(question(asker.id, { created_at: at(59), updated_at: at(59) }))
  const seed = buildSeed(store, transcriptOf(new Map([[asker.id, messages]])), repo, q, { maxChars: 8000 })
  expect(chars(seed)).toBeLessThanOrEqual(8000)
  expect(seed.startsWith(FRAMING)).toBe(true)
  expect(seed.trimEnd().endsWith("Which db?")).toBe(true)
  const kept = Array.from({ length: 40 }, (_, n) => n).filter((n) =>
    seed.includes(`step ${String(n).padStart(2, "0")}`),
  )
  const head = kept.filter((n) => n < 20)
  const tail = kept.filter((n) => n >= 20)
  expect(head).toEqual(Array.from({ length: head.length }, (_, i) => i))
  expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => 40 - tail.length + i))
  // The newest events get more of the room.
  expect(head.length).toBeGreaterThan(0)
  expect(head.length).toBeLessThan(tail.length)
  expect(seed).toContain(`…${40 - kept.length} events omitted…`)
})

test("an oversized header loses its comments first and never the card", () => {
  const store = openStore()
  const repo = makeRepo()
  const { question: q, byId } = asked(store)
  for (let n = 0; n < 30; n++) store.addComment(comment(q.work_item_id!, { body: `comment ${n} ` + "z".repeat(300) }))
  let seed = buildSeed(store, transcriptOf(byId), repo, q, { maxChars: 5000 })
  expect(chars(seed)).toBeLessThanOrEqual(5000)
  expect(seed.startsWith(FRAMING)).toBe(true)
  expect(seed.trimEnd().endsWith("2. Back off")).toBe(true)
  expect(seed).not.toContain("comment 0")
  expect(seed).toContain('"Fix the build"')

  // Even a work item too long to show at all leaves the framing and the card.
  store.updateWorkItem(q.work_item_id!, { summary: "w".repeat(20_000) })
  seed = buildSeed(store, transcriptOf(byId), repo, q, { maxChars: 3000 })
  expect(chars(seed)).toBeLessThanOrEqual(3000)
  expect(seed.startsWith(FRAMING)).toBe(true)
  expect(seed).toContain("# The question you asked")
  expect(seed.trimEnd().endsWith("2. Back off")).toBe(true)
})

test("a carried discussion is capped in the card", () => {
  const ask = question(newId(), { question: "Retry?" })
  const carried: DiscussionEntry[] = Array.from({ length: 100 }, (_, n) => ({
    role: n % 2 ? "user" : "assistant",
    text: `message ${String(n).padStart(3, "0")} ` + "c".repeat(500),
  }))
  const card = cardText(ask, carried)
  const carriedJson = card.split("\n").at(-1)!
  expect(chars(carriedJson)).toBeLessThanOrEqual(DISCUSSION_CAP)
  expect(carriedJson).toContain("earlier messages omitted")
  expect(carriedJson).toContain("message 099")
  expect(carriedJson).not.toContain("message 000")
})

test("the card lists pages and fields and carries an earlier discussion", () => {
  const gate = question(newId(), {
    source: "ask",
    node_id: "gate",
    question: "",
    title: "Setup",
    questions: [
      {
        question: "Which database?",
        header: "db",
        options: [{ label: "Postgres", description: "server" }, { label: "SQLite" }],
      },
      { question: "Which features?", header: "features", multi_select: true, options: [{ label: "auth" }] },
    ],
  })
  const carried: DiscussionEntry[] = [
    { role: "user", text: "why Postgres?" },
    { role: "assistant", text: "scale" },
  ]
  expect(cardText(gate, carried)).toBe(
    "# The question you asked (at an ask step of your flow)\n\n" +
      "Title: Setup\n" +
      "Question 1 of 2 · db: Which database?\n" +
      "  - Postgres: server\n" +
      "  - SQLite\n" +
      "Question 2 of 2 · features (pick any): Which features?\n" +
      "  - auth\n\n" +
      "You discussed an earlier question with them before it expired (JSON, oldest first):\n" +
      '[{"role":"user","text":"why Postgres?"},{"role":"you","text":"scale"}]',
  )
  const typed = question(newId(), {
    source: "ask",
    node_id: "gate",
    question: "How many days?",
    answer_schema: [{ name: "answer", type: "int", required: true }],
  })
  expect(cardText(typed).endsWith("How many days?\nAnswer field answer: int")).toBe(true)
})

test("the framing has the asker talk to the person directly", () => {
  expect(FRAMING).toBe(
    "You are now talking directly with the person you asked the question below, before they answer it. " +
      'Speak to them as "you"; never call them "the user" or "they". They want to understand your question: ' +
      "explain it; do not decide for them, and do not change anything.",
  )
})

test("the first message is the seed then what the user typed", () => {
  expect(firstMessage("SEED", "why?")).toBe("SEED\n\n# Their first message to you\n\nwhy?")
})

test("a cut never splits a character", () => {
  const store = openStore()
  const repo = makeRepo()
  const asker = store.createSession(session())
  const read = [message(asker.id, [text("Looking."), tool("read_file", "😀".repeat(3000))], at(1))]
  const q = store.addQuestion(question(asker.id, { created_at: at(9), updated_at: at(9) }))
  const seed = buildSeed(store, transcriptOf(new Map([[asker.id, read]])), repo, q, { maxChars: 200_000 })
  expect(seed).toContain("😀".repeat(2000) + "… [3000 chars]")
  expect(seed).not.toContain("😀".repeat(2001))

  const other = store.createSession(session())
  const steps = Array.from({ length: 40 }, (_, n) => message(other.id, [text(`step ${n} ` + "😀".repeat(400))], at(n)))
  const astral = store.addQuestion(
    question(other.id, { question: "😀".repeat(500), created_at: at(59), updated_at: at(59) }),
  )
  const transcript = transcriptOf(new Map([[other.id, steps]]))
  for (const maxChars of [300, 301, 2000, 2001, 4000, 4001, 8000, 8001]) {
    const cut = buildSeed(store, transcript, repo, astral, { maxChars })
    expect(cut.isWellFormed()).toBe(true)
    expect(chars(cut)).toBeLessThanOrEqual(maxChars)
  }
})
