// The sync's loads of older messages against a scripted office, whose transcript a test changes between and during
// reads: a load of every older page ends with the whole transcript, or fails saying so.
import { expect, test } from "bun:test"
import type { Message, Session } from "@opencorp/protocol"
import type { OfficeClient } from "../src/client"
import { OfficeError } from "../src/errors"
import type { StreamEvent } from "../src/sse"
import { emptyState } from "../src/store"
import { createOfficeSync, type OfficeStatus } from "../src/sync"

const S = "S1"

/** Message `k` of S, by an id that sorts as the office's. */
const message = (k: number): Message => ({
  id: `M${String(k).padStart(4, "0")}`,
  session_id: S,
  role: k % 2 === 0 ? "user" : "assistant",
  parts: [{ id: `p${k}`, type: "text", text: `m${k}` }],
  created_at: "t",
})
const messages = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => message(from + i))
const range = (from: number, to: number) => messages(from, to).map((m) => m.id)

/**
 * A sync on an office whose transcript is `office.list`: a page is read as the office reads it (the newest `limit`
 * before the message `before` names, a cursor being the message's id), then `office.onRead` runs, if set, with the
 * read's `before`, before the page is answered.
 */
async function scripted(list: Message[]) {
  const office = {
    list,
    onRead: undefined as ((before: string | undefined) => Promise<void> | void) | undefined,
    reads: 0,
  }
  const session: Session = {
    id: S,
    person: "minh",
    harness: "yian",
    office: "laptop",
    cwd: "/tmp/proj",
    repo_commit: "c",
    status: "idle",
    kind: "main",
    created_at: "t0",
    updated_at: "t1",
  }
  let handler: ((e: StreamEvent) => void) | undefined
  const client = {
    events: {
      subscribe: (h: (e: StreamEvent) => void) => {
        handler = h
        return { close() {}, reconnect() {} }
      },
    },
    sessions: {
      get: async () => session,
      instruments: async () => [],
      messagePage: async (_id: string, { limit = 50, before }: { limit?: number; before?: string } = {}) => {
        office.reads++
        const all = office.list
        const end = before === undefined ? all.length : all.findIndex((m) => m.id === before)
        const start = Math.max(0, end - limit)
        const page = { messages: all.slice(start, end), next: start > 0 ? all[start]!.id : null }
        await office.onRead?.(before)
        if (end < 0) throw new OfficeError(400, "bad_cursor", "before names a message this session's transcript no longer has")
        return page
      },
    },
    questions: { list: async () => [] },
  } as unknown as OfficeClient
  const state = emptyState()
  const statuses: OfficeStatus[] = []
  const sync = createOfficeSync({
    client,
    snapshot: async () => () => {},
    state: () => state,
    mutate: (fn) => fn(state),
    onStatus: (status) => statuses.push(status),
  })
  sync.start()
  handler!({ type: "connected" })
  while (!statuses.includes("online")) await new Promise((resolve) => setTimeout(resolve, 1))
  await sync.syncSession(S)
  return { office, state, sync }
}

test("a reload that replaces the held messages while every older page loads still ends with the whole transcript", async () => {
  const { office, state, sync } = await scripted(messages(0, 30))
  expect(state.messages[S]!.map((m) => m.id)).toEqual(range(10, 30))
  // As the older pages are read, 30 messages more come, and the session is read again: its newest page doesn't reach
  // what is held, so it takes its place, and the older pages read no longer go before it.
  office.onRead = async (before) => {
    if (before === undefined) return
    office.onRead = undefined
    office.list = messages(0, 60)
    await sync.syncSession(S)
  }
  await sync.loadOlder(S, { all: true })
  expect(state.messages[S]!.map((m) => m.id)).toEqual(range(0, 60))
  expect(state.messageCursor[S]).toBeUndefined()
})

test("a reload that goes in just after every older page still ends with the whole transcript", async () => {
  const { office, state, sync } = await scripted(messages(0, 30))
  let published!: () => void
  const put = new Promise<void>((resolve) => (published = resolve))
  let reload: Promise<void> | undefined
  // The older pages are read; then 30 messages more come, and the session's newest page, read now, is answered only
  // once the older pages went in.
  office.onRead = (before) => {
    if (before === undefined) return
    office.list = messages(0, 60)
    office.onRead = () => ((office.onRead = undefined), put)
    reload = sync.syncSession(S)
  }
  await sync.loadOlder(S, { all: true, beforePublish: published })
  expect(state.messages[S]!.map((m) => m.id)).toEqual(range(0, 60))
  expect(state.messageCursor[S]).toBeUndefined()
  await reload
})

test("a transcript that keeps changing under every older page's load fails it, saying so", async () => {
  const { office, state, sync } = await scripted(messages(0, 30))
  // Each older read finds its cursor gone: once the newest page is read, the transcript starts over.
  let round = 1
  office.list = messages(100, 130)
  office.onRead = (before) => {
    if (before === undefined) office.list = messages(++round * 100, round * 100 + 30)
  }
  await expect(sync.loadOlder(S, { all: true })).rejects.toThrow("couldn't load the whole transcript")
  // What is held is the newest page, with its cursor: not a part passed off as the whole.
  expect(state.messages[S]).toHaveLength(20)
  expect(state.messageCursor[S]).toEqual(expect.any(String))
  expect(office.reads).toBeLessThan(20)
})
