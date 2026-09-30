// The client's copy of office state and the pure reducers that keep it current. Reducers
// mutate their argument, so the Solid provider can pass a `produce` draft and tests a plain
// object.
import type {
  Comment,
  Debrief,
  Event,
  Feedback,
  LiveEvent,
  Message,
  Part,
  Person,
  Profile,
  ProfileProposal,
  Question,
  Session,
  WorkItem,
} from "@agent-corp/protocol"
import { asMessage, asPartDelta, asPartUpdated, isMetaData } from "./live"
import type { StreamEvent } from "./sse"

export type OfficeState = {
  people: Person[]
  /** People who worked in the client's cwd, most recent first. */
  folderPeople: Person[]
  /** Newest updated first. */
  sessions: Session[]
  /** Only for sessions the client synced; oldest first. */
  messages: Record<string, Message[]>
  questions: Record<string, Question>
  workItems: Record<string, WorkItem>
  proposals: Record<string, ProfileProposal>
  feedback: Record<string, Feedback>
  /** By work item id, oldest first. */
  comments: Record<string, Comment[]>
  /** By person id. */
  profiles: Record<string, Profile>
  /** By session id. */
  debriefs: Record<string, Debrief>
}

export function emptyState(): OfficeState {
  return {
    people: [],
    folderPeople: [],
    sessions: [],
    messages: {},
    questions: {},
    workItems: {},
    proposals: {},
    feedback: {},
    comments: {},
    profiles: {},
    debriefs: {},
  }
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
  const data = e.data as any
  switch (e.type) {
    case "session.created":
    case "session.updated":
      return upsertSession(s, data as Session)
    case "question.created":
    case "question.updated":
      return upsert(s.questions, data.id, data as Question)
    case "work_item.created":
    case "work_item.updated":
      return upsert(s.workItems, data.id, data as WorkItem)
    case "profile_proposal.created":
    case "profile_proposal.updated":
      s.proposals[data.id] = data as ProfileProposal
      return
    case "feedback.created":
    case "feedback.updated":
      s.feedback[data.id] = data as Feedback
      return
    case "debrief.created":
    case "debrief.updated":
      return upsert(s.debriefs, data.session_id, data as Debrief)
    case "profile.updated":
      if (typeof e.subject_id === "string") s.profiles[e.subject_id] = data as Profile
      return
    case "comment.created": {
      const list = (s.comments[data.work_item_id] ??= [])
      if (!list.some((c) => c.id === data.id)) list.push(data as Comment)
      return
    }
  }
}

function findMessage(list: Message[], id: string) {
  return list.find((m) => m.id === id)
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
      if (!local) {
        insertMessage(list, structuredClone(msg))
      } else {
        const { parts, ...rest } = msg
        Object.assign(local, rest)
        for (const p of parts) putPart(local, p)
      }
      return msg.parts.map((p) => p.id)
    }
    case "part.updated": {
      const d = asPartUpdated(e.data)
      if (!d) return []
      let local = findMessage(list, d.message_id)
      if (!local) {
        // A placeholder until the message's own message.updated arrives.
        insertMessage(list, {
          id: d.message_id,
          session_id: e.session_id,
          role: "assistant",
          parts: [],
          created_at: new Date().toISOString(),
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
