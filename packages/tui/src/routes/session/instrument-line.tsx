import type { Instrument } from "@opencorp/protocol"
import { createMemo, createSignal, Show } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useCommandShortcut, useOpenCorpKeymap } from "../../keymap"
import { wrap } from "../../ui/read-through"
import { Locale } from "../../util/locale"
import { display } from "../../util/printable"
import { busyCounts, busyTab, harnessFamily, shellRunning } from "./composer/tabs"

/** The most columns a waiting command takes on the line, its ellipsis included. */
const COMMAND_COLUMNS = 30
/** The ellipsis OpenTUI cuts the counts with, so a line shows one kind. */
const ELLIPSIS = "..."

/** `command` drawn on one row, cut to `columns` with an ellipsis when it is wider. */
function cut(command: string, columns: number) {
  const row = display(command).replace(/\s+/g, " ").trim()
  if (Bun.stringWidth(row) <= columns) return row
  return wrap(row, columns - ELLIPSIS.length)[0] + ELLIPSIS
}

/** The oldest of `instruments` waiting on the owner. */
export function waitingInstrument(instruments: readonly Instrument[] | undefined) {
  return instruments?.find((i) => i.status === "waiting")
}

/** After the prompt line's left side: what the picker lists before ctrl+a, after its key (↓): the session's shells
 *  running a command and its family's live Codex and Claude Code sessions, running or idle, a count per kind; then how
 *  many of its instruments failed. Nothing while there is none of those. A harness session counts while idle, as the
 *  owner can open and message it, so this line is how they learn it is there; an idle shell doesn't, as it stays open
 *  for the chat's life between the employee's commands. A click opens the picker on the first tab with something
 *  running. It takes only the room the line has left, cut in the middle when that is too little, so the rest of the
 *  line stays as it was and a failure still shows. The upstream TUI's prompt footer count. */
export function InstrumentLine(props: { sessionID: string }) {
  const office = useOffice()
  const { theme } = useTheme()
  const keymap = useOpenCorpKeymap()
  const shortcut = useCommandShortcut("session.child.first")
  const [hovered, setHovered] = createSignal(false)
  const listed = createMemo(() => office.state.instruments[props.sessionID] ?? [])
  const family = createMemo(() => harnessFamily(office.state, props.sessionID))
  const counts = createMemo(() => busyCounts({ family: family(), shells: listed(), sessionID: props.sessionID }))
  const live = createMemo(() => {
    const harness = (kind: string) =>
      family().filter((e) => e.sessionID !== props.sessionID && e.harness === kind && e.state !== "ended").length
    return [
      [listed().filter((i) => i.kind === "terminal" && shellRunning(i)).length, "{} shell", "{} shells"] as const,
      [harness("codex"), "{} Codex session", "{} Codex sessions"] as const,
      [harness("claude"), "{} Claude Code session", "{} Claude Code sessions"] as const,
    ].flatMap(([n, one, many]) => (n ? [Locale.pluralize(n, one, many)] : []))
  })
  const failed = createMemo(() => listed().filter((i) => i.status === "failed").length)
  return (
    <Show when={live().length > 0 || failed()}>
      <box flexGrow={1} flexBasis={0} overflow="hidden" paddingRight={2}>
        <text
          fg={hovered() ? theme.text : theme.textMuted}
          wrapMode="none"
          truncate
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          onMouseUp={() => keymap.dispatchCommand("session.child.first", { payload: busyTab(counts()) })}
        >
          <Show when={live().length > 0}>
            {" · "}
            <Show when={shortcut()}>{(key) => <span style={{ fg: theme.text }}>{key()} </span>}</Show>
            {live().join(" · ")}
          </Show>
          <Show when={failed()}>
            {" · "}
            <span style={{ fg: theme.error }}>{failed()} failed</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}

/** In place of the prompt line's shortcuts: `instrument` waits on the owner, named by its command, or by its name
 *  when it has none to show. */
export function InstrumentWarning(props: { instrument: Instrument }) {
  const { theme } = useTheme()
  const label = createMemo(() => cut(props.instrument.command ?? "", COMMAND_COLUMNS) || display(props.instrument.name))
  return (
    <text fg={theme.warning} wrapMode="none">
      ⚠ {label()} is waiting for you
    </text>
  )
}
