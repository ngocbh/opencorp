// The client's copy of office state and the pure reducers that keep it current. Reducers
// mutate their argument, so the Solid provider can pass a `produce` draft and tests a plain
// object.
import type {
  Comment,
  Company,
  CompanyView,
  CostReport,
  Event,
  Group,
  Instrument,
  LiveEvent,
  Message,
  Part,
  Person,
  Profile,
  ProfileProposal,
  Question,
  RepoIssue,
  Session,
  WorkItem,
} from "@opencorp/protocol"
import { now } from "@opencorp/protocol"
import {
  asInstrument, asInstrumentRemoved, asMessage, asMessageRemoved, asPartDelta, asPartUpdated, isMetaData,
} from "./live"
import type { StreamEvent } from "./sse"

export type OfficeState = {
  people: Person[]
  /** People who worked in the client's cwd, most recent first. */
  folderPeople: Person[]
  /** Newest updated first. */
  sessions: Session[]
  /** Only for sessions the client synced, the newest page first and older pages as they load; oldest first. */
  messages: Record<string, Message[]>
  /** The cursor of the next older page of a synced session's messages; none once its first message is held. */
  messageCursor: Record<string, string>
  /** Only for sessions the client synced: their shells and harness sessions, oldest first. Their output isn't
   *  kept here; the sync hands it to `on("instrument.output")` listeners. */
  instruments: Record<string, Instrument[]>
  questions: Record<string, Question>
  workItems: Record<string, WorkItem>
  proposals: Record<string, ProfileProposal>
  /** By work item id, oldest first. */
  comments: Record<string, Comment[]>
  /** By handle. */
  profiles: Record<string, Profile>
  /** The company file at `sha` (HQ); null when it's missing or doesn't parse, or before the first snapshot. */
  company: Company | null
  groups: Group[]
  /** The commit `people`, `groups` and `company` come from (HQ). */
  sha: string | null
  /** Files at `sha` that don't parse (HQ). */
  issues: RepoIssue[]
  /** Spend per person for the app's window (HQ). */
  costs: CostReport | null
}

export function emptyState(): OfficeState {
  return {
    people: [],
    folderPeople: [],
    sessions: [],
    messages: {},
    messageCursor: {},
    instruments: {},
    questions: {},
    workItems: {},
    proposals: {},
    comments: {},
    profiles: {},
    company: null,
    groups: [],
    sha: null,
    issues: [],
    costs: null,
  }
}

/** Applies a company snapshot: people, groups, the company and its issues, all from one commit. */
export function applyCompany(s: OfficeState, view: CompanyView) {
  s.people = view.people
  s.groups = view.groups
  s.company = view.company
  s.sha = view.sha
  s.issues = view.issues
}

/** Whether `local` is strictly newer than `incoming`, so the incoming copy is stale. */
const newer = (local: { updated_at?: string } | undefined, incoming: { updated_at?: string }) =>
  !!local?.updated_at && !!incoming.updated_at && local.updated_at > incoming.updated_at

function upsert<T extends { updated_at?: string }>(map: Record<string, T>, key: string, value: T) {
  if (!newer(map[key], value)) map[key] = value
}

/** Replaces or inserts a question by id unless the local copy is newer. */
export function upsertQuestion(s: OfficeState, q: Question) {
  upsert(s.questions, q.id, q)
}

/** Replaces or inserts a session by id unless the local copy is newer; keeps newest updated first. */
export function upsertSession(s: OfficeState, session: Session) {
  const i = s.sessions.findIndex((x) => x.id === session.id)
  if (i >= 0) {
    if (newer(s.sessions[i], session)) return
    s.sessions.splice(i, 1)
  }
  const at = s.sessions.findIndex(
    (x) => x.updated_at < session.updated_at || (x.updated_at === session.updated_at && x.id < session.id),
  )
  s.sessions.splice(at < 0 ? s.sessions.length : at, 0, session)
}

/** Applies one metadata event. Unknown types and malformed data are ignored. */
export function applyMeta(s: OfficeState, e: Event) {
  if (!isMetaData(e)) return
  switch (e.type) {
    case "session.created":
    case "session.updated":
      return upsertSession(s, e.data as Session)
    case "question.created":
    case "question.updated": {
      const q = e.data as Question
      return upsert(s.questions, q.id, q)
    }
    case "work_item.created":
    case "work_item.updated": {
      const item = e.data as WorkItem
      return upsert(s.workItems, item.id, item)
    }
    case "profile_proposal.created":
    case "profile_proposal.updated": {
      const proposal = e.data as ProfileProposal
      s.proposals[proposal.id] = proposal
      return
    }
    case "profile.updated":
      if (typeof e.subject_id === "string") s.profiles[e.subject_id] = e.data as Profile
      return
    case "comment.created": {
      const comment = e.data as Comment
      const list = (s.comments[comment.work_item_id] ??= [])
      if (!list.some((c) => c.id === comment.id)) list.push(comment)
      return
    }
  }
}

function findMessage(list: Message[], id: string) {
  return list.find((m) => m.id === id)
}

/** A page of a session's messages, oldest first, and the cursor of the page before it. */
export type MessagesPage = { messages: Message[]; next: string | null }

/** Sets or clears session `id`'s older-page cursor. */
function setCursor(s: OfficeState, id: string, next: string | null) {
  if (next === null) delete s.messageCursor[id]
  else s.messageCursor[id] = next
}

/**
 * Puts the newest page of session `id`'s messages. It replaces the held messages from its first one on; the older
 * ones held before it stay, with their cursor, so a reload doesn't drop the history the reader loaded. A page that
 * doesn't reach the held messages, or holds the whole transcript, or `replace`, replaces them all, its `next` the
 * cursor.
 */
export function putNewest(s: OfficeState, id: string, page: MessagesPage, opts: { replace?: boolean } = {}) {
  const held = s.messages[id]
  const first = page.messages[0]
  const at = held && first && page.next !== null && !opts.replace ? held.findIndex((m) => m.id === first.id) : -1
  if (at <= 0) {
    s.messages[id] = page.messages
    setCursor(s, id, page.next)
    return
  }
  const fresh = new Set(page.messages.map((m) => m.id))
  held!.splice(at, held!.length - at, ...page.messages)
  // A message that moved into the page since (an unread one read) shows only where the page has it.
  for (let i = at - 1; i >= 0; i--) if (fresh.has(held![i]!.id)) held!.splice(i, 1)
}

/**
 * Puts an older page of session `id`'s messages, read with `cursor`, before those held, unless the held messages have
 * moved on from that cursor (a reload replaced them, or the page went in already); returns whether it went in. A
 * message held already stays as held, so a live update that came first isn't undone. `beforePut` runs just before
 * it goes in, in the same update, with how many messages go in front: a view pins what the reader sees there.
 */
export function putOlder(
  s: OfficeState,
  id: string,
  page: MessagesPage,
  cursor: string,
  beforePut?: (added: number) => void,
): boolean {
  const held = s.messages[id]
  if (!held || s.messageCursor[id] !== cursor) return false
  const ids = new Set(held.map((m) => m.id))
  const older = page.messages.filter((m) => !ids.has(m.id))
  beforePut?.(older.length)
  held.unshift(...older)
  setCursor(s, id, page.next)
  return true
}

/** Whether `id`, a message session `session` doesn't hold, belongs to its older messages not loaded yet: their page
 *  brings it, as it is then. */
function unloaded(s: OfficeState, session: string, list: Message[], id: string) {
  return s.messageCursor[session] !== undefined && list.length > 0 && id < list[0]!.id
}

/** The message a live event changes, if it changes one. */
function messageOf(e: LiveEvent): string | undefined {
  if (e.type === "message.updated") return asMessage(e.data)?.id
  if (e.type === "message.removed") return asMessageRemoved(e.data)?.id
  if (e.type === "part.updated") return asPartUpdated(e.data)?.message_id
  if (e.type === "part.delta") return asPartDelta(e.data)?.message_id
  return undefined
}

/**
 * Whether `applyLive` leaves live event `e` out because the message it changes belongs to its session's older messages
 * not loaded yet. While their page loads, it may hold the message as it was before the event: the sync holds such an
 * event back and applies it once the page is in.
 */
export function heldBack(s: OfficeState, e: LiveEvent): boolean {
  const list = s.messages[e.session_id]
  const id = messageOf(e)
  return !!list && id !== undefined && !findMessage(list, id) && unloaded(s, e.session_id, list, id)
}

function insertMessage(list: Message[], msg: Message) {
  const at = list.findIndex((m) => m.id > msg.id)
  list.splice(at < 0 ? list.length : at, 0, msg)
}

function putPart(msg: Message, part: Part) {
  const i = msg.parts.findIndex((p) => p.id === part.id)
  if (i >= 0) msg.parts[i] = part
  else msg.parts.push(part)
}

/** Replaces or inserts an instrument by id unless the local copy is newer; keeps them in id order, oldest first. */
function putInstrument(list: Instrument[], instrument: Instrument) {
  const i = list.findIndex((x) => x.id === instrument.id)
  if (i >= 0) {
    if (!newer(list[i], instrument)) list[i] = instrument
    return
  }
  const at = list.findIndex((x) => x.id > instrument.id)
  list.splice(at < 0 ? list.length : at, 0, instrument)
}

/**
 * Applies one live event to a synced session; events for other sessions are dropped.
 * Returns the ids of the parts it replaced in full.
 */
export function applyLive(s: OfficeState, e: LiveEvent): string[] {
  const list = s.messages[e.session_id]
  if (!list) return []
  switch (e.type) {
    case "message.updated": {
      const msg = asMessage(e.data)
      if (!msg) return []
      const local = findMessage(list, msg.id)
      if (!local && unloaded(s, e.session_id, list, msg.id)) return []
      if (!local) {
        insertMessage(list, structuredClone(msg))
      } else {
        const { parts, ...rest } = msg
        Object.assign(local, rest)
        for (const p of parts) putPart(local, p)
      }
      return msg.parts.map((p) => p.id)
    }
    case "message.removed": {
      const removed = asMessageRemoved(e.data)
      if (!removed || removed.session_id !== e.session_id) return []
      const i = list.findIndex((m) => m.id === removed.id)
      if (i >= 0) list.splice(i, 1)
      return []
    }
    case "part.updated": {
      const d = asPartUpdated(e.data)
      if (!d) return []
      let local = findMessage(list, d.message_id)
      if (!local && unloaded(s, e.session_id, list, d.message_id)) return []
      if (!local) {
        // A placeholder until the message's own message.updated arrives.
        insertMessage(list, {
          id: d.message_id,
          session_id: e.session_id,
          role: "assistant",
          parts: [],
          created_at: now(),
        })
        local = findMessage(list, d.message_id)!
      }
      putPart(local, d.part)
      return [d.part.id]
    }
    case "part.delta": {
      const d = asPartDelta(e.data)
      const part = d && findMessage(list, d.message_id)?.parts.find((p) => p.id === d.part_id)
      if (part?.type === "text") part.text += d!.text
      return []
    }
    case "instrument.updated": {
      const instrument = asInstrument(e.data)
      if (instrument?.session_id === e.session_id) putInstrument((s.instruments[e.session_id] ??= []), instrument)
      return []
    }
    case "instrument.removed": {
      const removed = asInstrumentRemoved(e.data)
      const instruments = s.instruments[e.session_id]
      if (!removed || removed.session_id !== e.session_id || !instruments) return []
      const i = instruments.findIndex((x) => x.id === removed.id)
      if (i >= 0) instruments.splice(i, 1)
      return []
    }
    // A shell's bytes are its viewer's to keep: they go only to the sync's listeners.
    case "instrument.output":
      return []
  }
  return []
}

/**
 * Applies events buffered while a snapshot was fetched. A delta applies only after a buffered
 * full copy of its part, because the snapshot may already contain it.
 */
export function replay(s: OfficeState, events: StreamEvent[]) {
  const fresh = new Set<string>()
  for (const e of events) {
    if (e.type === "meta") applyMeta(s, e.event)
    else if (e.type === "live") {
      if (e.event.type === "part.delta" && !fresh.has(asPartDelta(e.event.data)?.part_id ?? "")) continue
      for (const id of applyLive(s, e.event)) fresh.add(id)
    }
  }
}

/** The session's open questions, oldest first. */
export function openQuestions(s: OfficeState, sessionId: string) {
  return Object.values(s.questions)
    .filter((q) => q.session_id === sessionId && q.status === "open")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}

/** The main sessions in `cwd`, newest updated first. */
export function sessionsIn(s: OfficeState, cwd: string) {
  return s.sessions.filter((x) => x.kind === "main" && x.cwd === cwd)
}
