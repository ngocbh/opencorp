import { openQuestions, type OfficeState } from "@opencorp/client"
import type { Instrument, Question, Session } from "@opencorp/protocol"
import { createEffect, createMemo, createSignal, on, untrack, type Signal } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComposerTab } from "./context"
import { sessionFamily } from "../../../util/session"

const order = ["subagents", "shell"]

const rank = (id: string) => {
  const index = order.indexOf(id)
  return index < 0 ? order.length : index
}

/** How the picker marks a Codex or Claude Code session: running a turn now, idle between turns, or ended. */
export type ChildState = "running" | "idle" | "ended"

/** A harness's name as the picker and the chat's calls say it, before the session's (`Codex: codex 1`). */
export const HARNESS_TITLE: Record<"codex" | "claude", string> = { codex: "Codex", claude: "Claude Code" }

/** A Codex or Claude Code session of a chat's family, as the picker lists it. */
export type FamilyEntry = {
  sessionID: string
  harness: "codex" | "claude"
  /** Its name in the chat's list (`codex 1`). */
  name: string
  state: ChildState
  /** The tree prefix its row draws. */
  prefix: string
}

const SESSION_STATE: Record<Session["status"], ChildState> = {
  starting: "running",
  busy: "running",
  waiting: "running",
  idle: "idle",
  // Ending takes no message either.
  ending: "ended",
  debriefing: "ended",
  ended: "ended",
  failed: "ended",
  interrupted: "ended",
}

const INSTRUMENT_STATE: Record<Instrument["status"], ChildState> = {
  starting: "running",
  running: "running",
  waiting: "running",
  idle: "idle",
  ended: "ended",
  failed: "ended",
}

/** A child's state: its session's, else, while the store doesn't hold the session, its listing's. */
export function childState(session: Session | undefined, listed: Instrument | undefined): ChildState {
  if (session) return SESSION_STATE[session.status]
  return listed ? INSTRUMENT_STATE[listed.status] : "ended"
}

/** Whether a shell runs a command now, or waits on the owner in one. */
export const shellRunning = (shell: Instrument) => INSTRUMENT_STATE[shell.status] === "running"

/**
 * The family of `sessionID` as the picker lists it: its chat's Codex and Claude Code sessions, oldest first, as
 * `sessionFamily` walks them. The store may not hold a child yet (it holds the latest sessions): the chat's list names
 * it too.
 */
export function harnessFamily(
  state: { sessions: readonly Session[]; instruments: Readonly<Record<string, readonly Instrument[] | undefined>> },
  sessionID: string,
): FamilyEntry[] {
  const chat = state.sessions.find((s) => s.id === sessionID)?.instrument_of ?? sessionID
  const listed = (state.instruments[chat] ?? []).filter((i) => i.kind !== "terminal")
  const stored = state.sessions.filter((s) => s.instrument_of === chat)
  const nodes = [
    { id: chat, instrument_of: null, created_at: "" },
    ...stored,
    ...listed.filter((i) => !stored.some((s) => s.id === i.id)).map((i) => ({ ...i, instrument_of: chat })),
  ].toSorted((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
  const from = nodes.some((node) => node.id === sessionID) ? sessionID : chat
  return sessionFamily(nodes, from).map(({ session, prefix }) => {
    const stored = state.sessions.find((s) => s.id === session.id)
    const listing = listed.find((i) => i.id === session.id)
    const harness = stored?.harness === "claude" || listing?.kind === "claude" ? "claude" : "codex"
    return {
      sessionID: session.id,
      harness,
      name: listing?.name ?? (harness === "claude" ? "Claude Code session" : "Codex session"),
      state: childState(stored, listing),
      prefix,
    }
  })
}

/**
 * The open cards session `sessionID` shows, as the upstream TUI's session lists its descendants' requests: a chat's
 * own first, then its Codex and Claude Code sessions', in the order the picker lists them; a child's own only.
 */
export function familyQuestions(state: OfficeState, sessionID: string): Question[] {
  const own = openQuestions(state, sessionID)
  if (state.sessions.find((s) => s.id === sessionID)?.instrument_of) return own
  return [
    ...own,
    ...harnessFamily(state, sessionID)
      .filter((entry) => entry.sessionID !== sessionID)
      .flatMap((entry) => openQuestions(state, entry.sessionID)),
  ]
}

/**
 * A tab's active/inactive filter, kept as long as the TUI runs, one per renderer: the session route remounts on
 * navigation, and the upstream TUI keeps its filter in its memory store, which outlives the route.
 */
export function filterMemory() {
  const filters = new WeakMap<object, Signal<{ active: boolean }>>()
  return (renderer: object) => {
    let filter = filters.get(renderer)
    if (!filter) filters.set(renderer, (filter = createSignal<{ active: boolean }>({ active: true })))
    return filter
  }
}

// What a session has running, for the picker tabs and the line under the prompt: the other sessions of its family
// running a turn, and its shells running a command.
export function busyCounts(input: {
  family: readonly FamilyEntry[]
  shells: readonly Instrument[]
  sessionID: string
}) {
  return {
    subagents: input.family.filter((entry) => entry.sessionID !== input.sessionID && entry.state === "running").length,
    shells: input.shells.filter((shell) => shell.kind === "terminal" && shellRunning(shell)).length,
  }
}

// The tab the picker opens on when nothing asks for one: the first that has something running, else Sessions.
export function busyTab(input: { subagents: number; shells: number }) {
  if (input.subagents) return "subagents"
  if (input.shells) return "shell"
  return "subagents"
}

// The picker's tabs in a fixed order, and which one is active. Tabs that come and go while it is open leave the
// active tab alone unless they remove it.
export function createComposerTabs(input: { open: () => boolean; defaultTab: () => string | undefined }) {
  const [store, setStore] = createStore({
    tabs: {} as Record<string, ComposerTab>,
    active: "",
    // Set once the user picks a tab, so a requested tab that registers late no longer takes over.
    chosen: false,
  })

  const list = createMemo(() => Object.values(store.tabs).toSorted((a, b) => rank(a.id) - rank(b.id)))

  const pick = (tabs: ComposerTab[]) => {
    const defaultTab = input.defaultTab()
    const match = defaultTab && tabs.find((tab) => tab.id === defaultTab)
    setStore("active", match ? match.id : tabs[0].id)
  }

  createEffect(
    on(
      () => [input.open(), input.defaultTab()] as const,
      ([open]) => {
        setStore("chosen", false)
        const tabs = untrack(list)
        if (open && tabs.length > 0) pick(tabs)
      },
    ),
  )

  createEffect(() => {
    const tabs = list()
    if (!input.open() || tabs.length === 0) return
    const requested = input.defaultTab()
    const late = !store.chosen && requested && requested !== store.active && tabs.some((tab) => tab.id === requested)
    if (late || !tabs.some((tab) => tab.id === store.active)) pick(tabs)
  })

  return {
    list,
    active: () => store.active,
    setActive: (id: string) => setStore({ active: id, chosen: true }),
    register(tab: ComposerTab) {
      setStore("tabs", tab.id, tab)
      if (!store.active) setStore("active", tab.id)
      return () => setStore("tabs", tab.id, undefined!)
    },
  }
}
