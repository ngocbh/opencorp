// Keeps an `OfficeState` in step with the office. The event stream has no replay, so every
// (re)connect re-reads state over GET: open the stream, wait for `: connected` (the office
// subscribes before sending it), fetch while buffering stream events, apply the snapshot,
// then replay the buffer on top.
import type { Event, LiveEvent, Message, Person, Question } from "@opencorp/protocol"
import type { OfficeClient } from "./client"
import { BadToken, failureKind, OfficeError, OfficeUnavailable, UnknownDevice } from "./errors"
import { runEach } from "./queue"
import type { StreamEvent, SubscribeOptions, Subscription } from "./sse"
import { applyLive, applyMeta, replay, upsertQuestion, upsertSession, type OfficeState } from "./store"

/** `error`: the office is reachable but its state couldn't be read (see `error()`); retrying. */
export type OfficeStatus = "connecting" | "online" | "offline" | "error"

/** The payload each `on()` event type delivers. */
export type OfficeEvents = { [K in Event["type"]]: Event } & { [K in LiveEvent["type"]]: LiveEvent }

export type OfficeSync = ReturnType<typeof createOfficeSync>

/**
 * Reads what a client shows besides synced sessions; resolves to how to apply it. A client with its own snapshot
 * (HQ) re-reads its open questions there: its held questions aren't re-read by id, and `refreshQuestion` and
 * `syncSession` read routes HQ doesn't serve, so HQ clients don't call them.
 */
export type Snapshot = (client: OfficeClient) => Promise<(s: OfficeState) => void>

const SESSION_LIMIT = 50
/** The office's largest page: this folder's main sessions, however many newer ones elsewhere. */
const FOLDER_LIMIT = 500
/** The events held back while a snapshot loads, per bootstrap and per session load. */
const MAX_BUFFERED = 10_000

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

/** `value` with `clean` applied to every string in it, at any depth. */
function cleanLeaves(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") return clean(value)
  if (Array.isArray(value)) return value.map((v) => cleanLeaves(v, clean))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanLeaves(v, clean)]))
  return value
}

/** A message part with `clean` applied to the text it shows; ids and states stay as sent. */
function cleanPart(part: unknown, clean: (text: string) => string): unknown {
  if (!isRecord(part)) return part
  const str = (x: unknown) => (typeof x === "string" ? clean(x) : x)
  if (part.type === "text") return { ...part, text: str(part.text) }
  if (part.type === "error") return { ...part, message: str(part.message) }
  if (part.type === "tool")
    return {
      ...part,
      tool: str(part.tool),
      input: cleanLeaves(part.input, clean),
      output: cleanLeaves(part.output, clean),
      error: str(part.error),
    }
  return part
}

/** A message with `clean` applied to its parts. */
function cleanMessage<M>(message: M, clean: (text: string) => string): M {
  if (!isRecord(message) || !Array.isArray(message.parts)) return message
  return { ...message, parts: message.parts.map((p) => cleanPart(p, clean)) } as M
}

/** A live event with `clean` applied to the text it carries. */
function cleanLive(e: LiveEvent, clean: (text: string) => string): LiveEvent {
  const d = e.data
  if (e.type === "message.updated") return { ...e, data: cleanMessage(d, clean) }
  if (e.type === "part.updated") return { ...e, data: { ...d, part: cleanPart(d.part, clean) } }
  if (e.type === "part.delta" && typeof d.text === "string") return { ...e, data: { ...d, text: clean(d.text) } }
  return e
}

export function createOfficeSync(opts: {
  client: OfficeClient
  /** The folder whose people the default snapshot reads; without it, `folderPeople` isn't read. */
  cwd?: string
  /** Replaces the default snapshot (people, folder people, the latest sessions). */
  snapshot?: Snapshot
  /** Reads the current state (to find the open questions to re-check). */
  state: () => OfficeState
  /** Applies a change to the state; may run it later, but in call order. */
  mutate: (fn: (s: OfficeState) => void) => void
  /**
   * Called on each status change, with the failure's message when the status is `error`, and the failure itself
   * (`cause`) when there is one: an `UnknownDevice` means the device or browser must sign in again.
   */
  onStatus?: (s: OfficeStatus, error?: string, cause?: unknown) => void
  stream?: SubscribeOptions
  /** Past this many held-back events a load is abandoned and the stream reconnected. */
  maxBuffered?: number
  /**
   * Applied to the text the office relays from models and people (message text, tool calls, names and titles)
   * as it comes in; ids, sessions and questions stay as sent, since they go back to the office.
   */
  clean?: (text: string) => string
}) {
  const { client, cwd, maxBuffered = MAX_BUFFERED, clean } = opts
  const cleanPeople = (people: Person[]) =>
    clean ? people.map((p) => ({ ...p, name: clean(p.name), title: clean(p.title) })) : people
  const cleanMessages = (messages: Message[]) => (clean ? messages.map((m) => cleanMessage(m, clean)) : messages)
  // After stop(), loads still in flight must not touch the state.
  let stopped = false
  const mutate = (fn: (s: OfficeState) => void) => {
    if (!stopped) opts.mutate(fn)
  }
  let status: OfficeStatus = "connecting"
  let error: string | undefined
  let cause: string = failureKind(undefined)
  let sub: Subscription | undefined
  // Bumped when a stream ends, so a bootstrap still in flight for it is dropped.
  let generation = 0
  // Set while a bootstrap runs: every stream event waits here until the snapshot is applied.
  let buffer: StreamEvent[] | undefined
  // Sessions whose messages are held, the live-event windows of those still loading, and
  // their loads in flight.
  const synced = new Set<string>()
  const pending = new Map<string, StreamEvent[]>()
  const loads = new Map<string, Promise<void>>()
  const listeners = new Map<string, Set<(e: any) => void>>()

  function setStatus(next: OfficeStatus, message?: string, failure?: unknown) {
    if (next === status && message === error && failureKind(failure) === cause) return
    status = next
    error = message
    cause = failureKind(failure)
    opts.onStatus?.(next, message, failure)
  }

  function fire(events: StreamEvent[]) {
    for (const e of events) {
      if (e.type !== "meta" && e.type !== "live") continue
      // One listener's bug mustn't cost the others their event, or the stream (and the state) its update.
      runEach(listeners.get(e.event.type) ?? [], e.event)
    }
  }

  /**
   * Gives up on the loads in flight when the office sends more than they can hold back
   * (a snapshot that never comes, or a firehose): they start over on a new stream.
   */
  function overflow() {
    generation++
    buffer = undefined
    for (const window of pending.values()) window.length = 0
    sub?.reconnect()
  }

  /** Applies a stream event now, or parks a live one in its session's loading window. */
  function deliver(e: StreamEvent) {
    const window = e.type === "live" ? pending.get(e.event.session_id) : undefined
    if (window) {
      window.push(e)
      if (window.length > maxBuffered) overflow()
      return
    }
    if (e.type === "meta") mutate((s) => applyMeta(s, e.event))
    else if (e.type === "live") mutate((s) => applyLive(s, e.event))
    fire([e])
  }

  function onStream(e: StreamEvent) {
    if (clean && e.type === "live") e = { ...e, event: cleanLive(e.event, clean) }
    switch (e.type) {
      case "connected":
        // A failed bootstrap stays visible while it retries.
        if (status !== "error") setStatus("connecting")
        void bootstrap()
        return
      case "disconnected":
      case "unreachable":
        generation++
        buffer = undefined
        // A reset or dropped stream reconnects at once, so it shouldn't flash "offline".
        // A refused token, or one that can't be sent, won't pass on a retry, so it reads as an error, not as no office.
        if (e.type === "unreachable" && (e.error instanceof UnknownDevice || e.error instanceof BadToken))
          setStatus("error", e.error.message, e.error)
        else if (e.type === "unreachable") setStatus("offline", undefined, e.error)
        else if (status !== "error") setStatus("connecting")
        return
    }
    if (!buffer) return deliver(e)
    buffer.push(e)
    if (buffer.length > maxBuffered) overflow()
  }

  /** A session's open questions; an office without the list route yet has none to report. */
  async function openQuestionsOf(session: string): Promise<Question[]> {
    try {
      return await client.questions.list({ session, status: "open" })
    } catch (e) {
      if (e instanceof OfficeError && [404, 405, 501].includes(e.status) && e.code !== "not_found") return []
      throw e
    }
  }

  /**
   * Who worked in `cwd`, or undefined if there is no `cwd` or it can't be read: it costs the list,
   * not the bootstrap.
   */
  async function readFolderPeople() {
    if (cwd === undefined) return undefined
    try {
      return cleanPeople(await client.people.inFolder(cwd))
    } catch (e) {
      console.error("Failed to read the folder's people", { error: e })
      return undefined
    }
  }

  /** The TUI's snapshot: everyone, who worked in `cwd`, the latest sessions, and `cwd`'s main sessions. */
  const defaultSnapshot: Snapshot = async () => {
    const [people, folderPeople, sessions, here] = await Promise.all([
      client.people.list(),
      readFolderPeople(),
      client.sessions.list({ limit: SESSION_LIMIT }),
      // This folder's main sessions, so /sessions and --continue find older ones too.
      cwd ? client.sessions.list({ kind: "main", cwd, limit: FOLDER_LIMIT }) : Promise.resolve([]),
    ])
    return (s) => {
      s.people = cleanPeople(people)
      if (folderPeople) s.folderPeople = folderPeople
      for (const session of [...sessions, ...here]) upsertSession(s, session)
    }
  }
  const snapshot = opts.snapshot ?? defaultSnapshot

  /** Stops keeping a session live and drops its messages, which would only go stale. */
  function unsync(id: string) {
    synced.delete(id)
    mutate((s) => void delete s.messages[id])
  }

  /** A question re-read by id, or undefined if the office no longer has it. */
  async function recheck(id: string) {
    try {
      return await client.questions.get(id)
    } catch (e) {
      if (e instanceof OfficeError && e.code === "not_found") return undefined
      throw e
    }
  }

  async function loadSession(id: string) {
    const [session, messages, questions] = await Promise.all([
      client.sessions.get(id),
      client.sessions.messages(id),
      openQuestionsOf(id),
    ])
    return { id, session, messages: cleanMessages(messages), questions }
  }

  /**
   * Reloads a synced session for a bootstrap. One the office no longer has stops being synced;
   * any other failure is noted in `failed` (to load on its own later) so the bootstrap goes on.
   */
  async function reload(id: string, failed: string[]) {
    try {
      return await loadSession(id)
    } catch (e) {
      if (e instanceof OfficeError && e.code === "not_found") unsync(id)
      else {
        console.error("Failed to reload a session", { id, error: e })
        failed.push(id)
      }
      return undefined
    }
  }

  /** Loads a session and applies it with the live events that arrived while it loaded. */
  async function loadLive(id: string) {
    mutate((s) => void (s.messages[id] ??= []))
    for (;;) {
      const mine = generation
      const window: StreamEvent[] = []
      pending.set(id, window)
      let l: Awaited<ReturnType<typeof loadSession>>
      try {
        l = await loadSession(id)
      } catch (e) {
        pending.delete(id)
        // While the office is down the next bootstrap loads it; any other failure is final.
        if (!(e instanceof OfficeUnavailable)) unsync(id)
        throw e
      }
      if (stopped) return
      // The stream ended or restarted while this loaded, so events may have been missed
      // between the read and the new stream: read again.
      if (mine !== generation) continue
      pending.delete(id)
      mutate((s) => {
        s.messages[id] = l.messages
        upsertSession(s, l.session)
        for (const q of l.questions) s.questions[q.id] = q
        replay(s, window)
      })
      fire(window)
      return
    }
  }

  async function bootstrap() {
    const mine = ++generation
    buffer = []
    const failed: string[] = []
    try {
      // A custom snapshot replaces every open question itself (HQ has no GET /questions/{id}).
      const held = opts.snapshot
        ? []
        : Object.values(opts.state().questions)
            .filter((q) => q.status === "open")
            .map((q) => q.id)
      const [apply, loaded, rechecked] = await Promise.all([
        snapshot(client),
        // Sessions still loading too: their own load may have read state before the stream
        // ended, so it will load again, but the snapshot shouldn't wait for that.
        Promise.all([...synced].map((id) => reload(id, failed))),
        Promise.all(held.map(async (id) => [id, await recheck(id)] as const)),
      ])
      if (mine !== generation) return
      const events = buffer
      buffer = undefined
      // A session still loading gets its events here, on this snapshot, and in its window, on
      // the snapshot its load ends with; replaying an event twice is harmless.
      for (const e of events) if (e.type === "live") pending.get(e.event.session_id)?.push(e)
      mutate((s) => {
        apply(s)
        for (const [id, q] of rechecked) {
          if (q) s.questions[id] = q
          else delete s.questions[id]
        }
        for (const l of loaded) {
          if (!l) continue
          s.messages[l.id] = l.messages
          upsertSession(s, l.session)
          for (const q of l.questions) s.questions[q.id] = q
        }
        replay(s, events)
      })
      setStatus("online")
      fire(events)
      // Each in its own window, so one slow or broken history doesn't hold up the rest.
      for (const id of failed)
        if (synced.has(id)) syncSession(id).catch((error) => console.error("Failed to load a session", { id, error }))
    } catch (e) {
      if (mine !== generation) return
      buffer = undefined
      setStatus("error", e instanceof Error ? e.message : String(e), e)
      // The stream's backoff paces the retries.
      sub?.reconnect()
    }
  }

  /** Loads a session's messages and open questions, and keeps them live from then on. */
  function syncSession(id: string) {
    synced.add(id)
    let load = loads.get(id)
    if (!load) {
      load = loadLive(id).finally(() => loads.delete(id))
      loads.set(id, load)
    }
    return load
  }

  return {
    /** Starts following the office. */
    start() {
      stopped = false
      sub ??= client.events.subscribe(onStream, opts.stream)
    },
    stop() {
      stopped = true
      generation++
      sub?.close()
      sub = undefined
    },
    status: () => status,
    /** Why the last bootstrap failed, while the status is `error`. */
    error: () => error,
    syncSession,
    /** Re-reads a question, e.g. after the office says it is no longer open; drops it if the office has none. */
    async refreshQuestion(id: string) {
      const q = await recheck(id)
      mutate((s) => {
        if (q) s.questions[id] = q
        else delete s.questions[id]
      })
    },
    /** Stores a question a call returned (e.g. an answer), unless a newer copy is already in. */
    putQuestion(q: Question) {
      mutate((s) => upsertQuestion(s, q))
    },
    /** Re-reads both people lists (there are no person events, e.g. after a hire). */
    async refreshPeople() {
      const [people, folderPeople] = await Promise.all([client.people.list(), readFolderPeople()])
      mutate((s) => {
        s.people = cleanPeople(people)
        if (folderPeople) s.folderPeople = folderPeople
      })
    },
    /** Calls `fn` for each event of `type` once it is applied (a throw is logged); returns an unsubscribe. */
    on<K extends keyof OfficeEvents>(type: K, fn: (e: OfficeEvents[K]) => void) {
      const set = listeners.get(type) ?? new Set()
      listeners.set(type, set)
      set.add(fn)
      return () => void set.delete(fn)
    },
  }
}
