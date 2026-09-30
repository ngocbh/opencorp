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

/** The person to talk to: `--person` (id or handle), else the person of the newest main session in `cwd`, else the first person who works in `cwd`, else the first agent, else the first person. */
export function pickPerson(input: {
  arg?: string
  people: readonly Person[]
  folderPeople: readonly Person[]
  sessions: readonly Session[]
  cwd?: string
}) {
  const { people } = input
  const known = (id: string | undefined) => (id && people.some((p) => p.id === id) ? id : undefined)
  return (
    people.find((p) => p.id === input.arg || p.handle === input.arg)?.id ??
    known(input.sessions.find((s) => s.kind === "main" && s.cwd === input.cwd)?.person) ??
    known(input.folderPeople[0]?.id) ??
    people.find((p) => p.kind === "agent")?.id ??
    people[0]?.id
  )
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
        const id = selected()
        return list().find((p) => p.id === id) ?? list().find((p) => p.id === picked())
      })
      // Hold the first pick once the office's state is in, so later sessions don't swap the person.
      createEffect(() => {
        if (selected() || office.status() !== "online") return
        const id = picked()
        if (!id) return
        setSelected(id)
        if (args.person && !list().some((p) => p.id === args.person || p.handle === args.person))
          toast.show({ variant: "warning", message: `No one here matches --person ${args.person}`, duration: 10000 })
      })
      return {
        list,
        current,
        set(id: string) {
          if (!list().some((p) => p.id === id))
            return toast.show({ variant: "warning", message: `No such person: ${id}`, duration: 3000 })
          setSelected(id)
        },
        cycle(direction: 1 | -1) {
          const people = list()
          if (!people.length) return
          const index = people.findIndex((p) => p.id === current()?.id)
          setSelected(people[(index + direction + people.length) % people.length].id)
        },
        color(id: string | undefined) {
          const index = list().findIndex((p) => p.id === id)
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
