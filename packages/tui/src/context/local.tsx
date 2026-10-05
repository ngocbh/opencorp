import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { Person, Session } from "@agent-corp/protocol"
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { useOffice } from "./office"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

/** The person's handle to talk to: `--person` (a handle, with or without @), else the person of the newest main session in `cwd`, else the first person who works in `cwd`, else the first agent, else the first person. */
export function pickPerson(input: {
  arg?: string
  people: readonly Person[]
  folderPeople: readonly Person[]
  sessions: readonly Session[]
  cwd?: string
}) {
  const { people } = input
  const known = (handle: string | undefined) => (handle && people.some((p) => p.handle === handle) ? handle : undefined)
  return (
    known(input.arg?.replace(/^@/, "")) ??
    known(input.sessions.find((s) => s.kind === "main" && s.cwd === input.cwd)?.person) ??
    known(input.folderPeople[0]?.handle) ??
    people.find((p) => p.kind === "agent")?.handle ??
    people[0]?.handle
  )
}

/** A model on a connection, as a `/model` pick names it. */
export type ModelPick = { connection: string; model: string }

const RECENT_MAX = 10

const samePick = (a: ModelPick, b: ModelPick) => a.connection === b.connection && a.model === b.model

/**
 * This device's recent and favorite models, kept in `file` (`model.json`). An entry whose
 * connection isn't in `connections()` is hidden, not deleted, so it comes back with its
 * connection; while `connections()` is unknown, every entry shows.
 */
export function createModelState(file: string, connections: () => readonly string[] | undefined) {
  const [store, setStore] = createStore<{ ready: boolean; recent: ModelPick[]; favorite: ModelPick[] }>({
    ready: false,
    recent: [],
    favorite: [],
  })
  const state = { pending: false }
  // Queued, so rapid picks reach the file in order.
  let write = Promise.resolve()

  function save() {
    if (!store.ready) {
      state.pending = true
      return
    }
    state.pending = false
    const snapshot = { recent: [...store.recent], favorite: [...store.favorite] }
    write = write.then(() => writeJsonAtomic(file, snapshot)).catch(() => {})
  }

  const picks = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter(
            (x): x is ModelPick =>
              !!x && typeof x === "object" && typeof x.connection === "string" && typeof x.model === "string",
          )
          .map((x) => ({ connection: x.connection, model: x.model }))
      : []

  readJson<unknown>(file)
    .then((x) => {
      if (!x || typeof x !== "object") return
      const data = x as Record<string, unknown>
      setStore({ recent: picks(data.recent).slice(0, RECENT_MAX), favorite: picks(data.favorite) })
    })
    .catch(() => {})
    .finally(() => {
      setStore("ready", true)
      if (state.pending) save()
    })

  const shown = (list: ModelPick[]) => {
    const names = connections()
    return names ? list.filter((p) => names.includes(p.connection)) : list
  }

  return {
    get ready() {
      return store.ready
    },
    /** Newest first. */
    recent: () => shown(store.recent),
    favorite: () => shown(store.favorite),
    isFavorite: (pick: ModelPick) => store.favorite.some((x) => samePick(x, pick)),
    /** Makes `pick` the newest recent. */
    pick(pick: ModelPick) {
      setStore("recent", [pick, ...store.recent.filter((x) => !samePick(x, pick))].slice(0, RECENT_MAX))
      save()
    },
    toggleFavorite(pick: ModelPick) {
      const next = store.favorite.some((x) => samePick(x, pick))
        ? store.favorite.filter((x) => !samePick(x, pick))
        : [...store.favorite, pick]
      setStore("favorite", next)
      save()
    },
  }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const office = useOffice()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()

    function createPerson() {
      const [selected, setSelected] = createSignal<string>()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      const list = () => office.state.people
      const picked = () =>
        pickPerson({
          arg: args.person,
          people: list(),
          folderPeople: office.state.folderPeople,
          sessions: office.state.sessions,
          cwd: office.cwd,
        })
      const current = createMemo(() => {
        const handle = selected()
        return list().find((p) => p.handle === handle) ?? list().find((p) => p.handle === picked())
      })
      // Hold the first pick once the office's state is in, so later sessions don't swap the person.
      createEffect(() => {
        if (selected() || office.status() !== "online") return
        const handle = picked()
        if (!handle) return
        setSelected(handle)
        const arg = args.person?.replace(/^@/, "")
        if (arg && !list().some((p) => p.handle === arg))
          toast.show({ variant: "warning", message: `No one here matches --person ${args.person}`, duration: 10000 })
      })
      return {
        list,
        current,
        set(handle: string) {
          if (!list().some((p) => p.handle === handle))
            return toast.show({ variant: "warning", message: `No such person: @${handle}`, duration: 3000 })
          setSelected(handle)
        },
        cycle(direction: 1 | -1) {
          // Agents only, as in the picker; from a human, go to the first or last agent.
          const people = list().filter((p) => p.kind === "agent")
          if (!people.length) return
          const index = people.findIndex((p) => p.handle === current()?.handle)
          setSelected(people.at(index < 0 ? (direction > 0 ? 0 : -1) : (index + direction) % people.length)!.handle)
        },
        color(handle: string | undefined) {
          const index = list().findIndex((p) => p.handle === handle)
          return colors()[Math.max(0, index) % colors().length]
        },
      }
    }

    const person = createPerson()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(office.state.sessions.filter((x) => x.kind === "main").map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const result = {
      person,
      session,
    }
    return result
  },
})
