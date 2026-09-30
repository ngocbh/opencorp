import type { Person, Session } from "@agent-corp/protocol"
import os from "node:os"
import { createMemo, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useOffice } from "../context/office"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useLocal } from "../context/local"
import { Locale } from "../util/locale"
import { personLabel } from "../util/transcript"
import { Spinner } from "./spinner"
import { useCommandShortcut } from "../keymap"

/** Main sessions, newest updated first; only those in `cwd` when it is given. */
export function listedSessions(sessions: readonly Session[], cwd?: string) {
  return sessions
    .filter((s) => s.kind === "main" && (cwd === undefined || s.cwd === cwd))
    .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
}

/** A session's list row: `@handle · folder · age`, with the home folder shown as `~`. */
export function sessionRow(session: Session, people: readonly Person[], opts: { now?: number; home?: string } = {}) {
  const home = opts.home ?? os.homedir()
  const cwd =
    session.cwd === home || session.cwd.startsWith(home + "/") ? "~" + session.cwd.slice(home.length) : session.cwd
  const age = Locale.relative(Date.parse(session.updated_at), opts.now)
  return `${personLabel(people, session.person)} · ${cwd} · ${age}`
}

/** The group a session is listed under: "Today", or the date it was last updated. */
export function sessionCategory(session: Session, now = Date.now()) {
  const day = new Date(session.updated_at).toDateString()
  return day === new Date(now).toDateString() ? "Today" : day
}

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const office = useOffice()
  const kv = useKV()
  const { theme } = useTheme()
  const local = useLocal()
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const quickSwitchFooterHints = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last || local.session.slots().length === 0) return []
    return [{ title: "switch", label: quickSwitchRange(first, last) }]
  })

  const options = createMemo(() => {
    const now = Date.now()
    const filtered = kv.get("session_directory_filter_enabled", true)
    const sessions = listedSessions(office.state.sessions, filtered ? office.cwd : undefined)
    const pinned = new Set(local.session.pinned())
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))
    const option = (s: Session, category: string) => {
      const slot = slotByID.get(s.id)
      const working = s.status === "starting" || s.status === "busy"
      return {
        title: sessionRow(s, office.state.people, { now }),
        value: s.id,
        category,
        gutter: working
          ? () => <Spinner />
          : slot !== undefined
            ? () => <text fg={theme.accent}>{slot}</text>
            : undefined,
      }
    }
    return [
      ...sessions.filter((s) => pinned.has(s.id)).map((s) => option(s, "Pinned")),
      ...sessions.filter((s) => !pinned.has(s.id)).map((s) => option(s, sessionCategory(s, now))),
    ]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      preserveSelection={true}
      current={currentSessionID()}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            local.session.togglePin(option.value)
          },
        },
      ]}
      footerHints={quickSwitchFooterHints()}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
