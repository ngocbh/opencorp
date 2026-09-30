// Keeps an `OfficeState` in step with the office. The event stream has no replay, so every
// (re)connect re-reads state over GET: open the stream, wait for `: connected` (the office
// subscribes before sending it), fetch while buffering stream events, apply the snapshot,
// then replay the buffer on top.
import type { Event, LiveEvent, Question } from "@agent-corp/protocol"
import type { OfficeClient } from "./client"
import { OfficeError, OfficeUnavailable } from "./errors"
import type { StreamEvent, SubscribeOptions, Subscription } from "./sse"
import { applyLive, applyMeta, replay, upsertSession, type OfficeState } from "./store"

/** `error`: the office is reachable but its state couldn't be read (see `error()`); retrying. */
export type OfficeStatus = "connecting" | "online" | "offline" | "error"

/** The payload each `on()` event type delivers. */
export type OfficeEvents = { [K in Event["type"]]: Event } & { [K in LiveEvent["type"]]: LiveEvent }

export type OfficeSync = ReturnType<typeof createOfficeSync>

const SESSION_LIMIT = 50

export function createOfficeSync(opts: {
  client: OfficeClient
  cwd: string
  /** Reads the current state (to find the open questions to re-check). */
  state: () => OfficeState
  /** Applies a change to the state; may run it later, but in call order. */
  mutate: (fn: (s: OfficeState) => void) => void
  /** Called on each status change, with the failure's message when the status is `error`. */
  onStatus?: (s: OfficeStatus, error?: string) => void
  stream?: SubscribeOptions
}) {
  const { client, cwd, mutate } = opts
  let status: OfficeStatus = "connecting"
  let error: string | undefined
  let sub: Subscription | undefined
  // Bumped when a stream ends, so a bootstrap still in flight for it is dropped.
  let generation = 0
  // Set while a bootstrap runs: every stream event waits here until the snapshot is applied.
  let buffer: StreamEvent[] | undefined
  // Sessions whose messages are held, and the live-event windows of those still loading.
  const synced = new Set<string>()
  const pending = new Map<string, StreamEvent[]>()
  const listeners = new Map<string, Set<(e: any) => void>>()

  function setStatus(next: OfficeStatus, message?: string) {
    if (next === status && message === error) return
    status = next
    error = message
    opts.onStatus?.(next, message)
  }

  function fire(events: StreamEvent[]) {
    for (const e of events) {
      if (e.type !== "meta" && e.type !== "live") continue
      for (const fn of listeners.get(e.event.type) ?? []) fn(e.event)
    }
  }

  /** Applies a stream event now, or parks a live one in its session's loading window. */
  function deliver(e: StreamEvent) {
    if (e.type === "live" && pending.has(e.event.session_id)) return void pending.get(e.event.session_id)!.push(e)
    if (e.type === "meta") mutate((s) => applyMeta(s, e.event))
    else if (e.type === "live") mutate((s) => applyLive(s, e.event))
    fire([e])
  }

  function onStream(e: StreamEvent) {
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
        if (e.type === "unreachable") setStatus("offline")
        else if (status !== "error") setStatus("connecting")
        return
    }
    if (buffer) buffer.push(e)
    else deliver(e)
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

  /** Who worked in `cwd`; a failure only costs the list, not the bootstrap. */
  async function readFolderPeople() {
    try {
      return await client.people.inFolder(cwd)
    } catch (e) {
      console.error("Failed to read the folder's people", { error: e })
      return []
    }
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
    return { id, session, messages, questions }
  }

  /** Reloads a synced session for a bootstrap; one the office no longer has stops being synced. */
  async function reload(id: string) {
    try {
      return await loadSession(id)
    } catch (e) {
      if (!(e instanceof OfficeError && e.code === "not_found")) throw e
      synced.delete(id)
      return undefined
    }
  }

  async function bootstrap() {
    const mine = ++generation
    buffer = []
    try {
      const held = Object.values(opts.state().questions)
        .filter((q) => q.status === "open")
        .map((q) => q.id)
      const [people, folderPeople, sessions, loaded, rechecked] = await Promise.all([
        client.people.list(),
        readFolderPeople(),
        client.sessions.list({ limit: SESSION_LIMIT }),
        Promise.all([...synced].filter((id) => !pending.has(id)).map(reload)),
        Promise.all(held.map(async (id) => [id, await recheck(id)] as const)),
      ])
      if (mine !== generation) return
      const events = buffer
      buffer = undefined
      // Live events for sessions still loading belong to those sessions' windows.
      const now = events.filter((e) => {
        if (e.type !== "live" || !pending.has(e.event.session_id)) return true
        pending.get(e.event.session_id)!.push(e)
        return false
      })
      mutate((s) => {
        s.people = people
        s.folderPeople = folderPeople
        for (const session of sessions) upsertSession(s, session)
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
        replay(s, now)
      })
      setStatus("online")
      fire(now)
    } catch (e) {
      if (mine !== generation) return
      buffer = undefined
      setStatus("error", e instanceof Error ? e.message : String(e))
      // The stream's backoff paces the retries.
      sub?.reconnect()
    }
  }

  return {
    /** Starts following the office. */
    start() {
      sub ??= client.events.subscribe(onStream, opts.stream)
    },
    stop() {
      generation++
      sub?.close()
      sub = undefined
    },
    status: () => status,
    /** Why the last bootstrap failed, while the status is `error`. */
    error: () => error,
    /** Loads a session's messages and open questions, and keeps them live from then on. */
    async syncSession(id: string) {
      synced.add(id)
      const window: StreamEvent[] = []
      pending.set(id, window)
      mutate((s) => void (s.messages[id] ??= []))
      try {
        const l = await loadSession(id)
        pending.delete(id)
        mutate((s) => {
          s.messages[id] = l.messages
          upsertSession(s, l.session)
          for (const q of l.questions) s.questions[q.id] = q
          replay(s, window)
        })
        fire(window)
      } catch (e) {
        pending.delete(id)
        // While the office is down the next bootstrap loads it; any other failure is final.
        if (!(e instanceof OfficeUnavailable)) synced.delete(id)
        throw e
      }
    },
    /** Re-reads a question, e.g. after the office says it is no longer open; drops it if the office has none. */
    async refreshQuestion(id: string) {
      const q = await recheck(id)
      mutate((s) => {
        if (q) s.questions[id] = q
        else delete s.questions[id]
      })
    },
    /** Re-reads both people lists (there are no person events, e.g. after a hire). */
    async refreshPeople() {
      const [people, folderPeople] = await Promise.all([client.people.list(), readFolderPeople()])
      mutate((s) => {
        s.people = people
        s.folderPeople = folderPeople
      })
    },
    /** Calls `fn` for each event of `type` once it is applied; returns an unsubscribe. */
    on<K extends keyof OfficeEvents>(type: K, fn: (e: OfficeEvents[K]) => void) {
      const set = listeners.get(type) ?? new Set()
      listeners.set(type, set)
      set.add(fn)
      return () => void set.delete(fn)
    },
  }
}
