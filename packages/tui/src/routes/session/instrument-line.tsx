import type { Instrument } from "@opencorp/protocol"
import { createMemo, Show } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { wrap } from "../../ui/read-through"
import { Locale } from "../../util/locale"

/** Each kind's count, in the line's order. */
const KINDS: { kind: Instrument["kind"]; one: string; many: string }[] = [
  { kind: "terminal", one: "{} shell", many: "{} shells" },
  { kind: "codex", one: "{} Codex session", many: "{} Codex sessions" },
  { kind: "claude", one: "{} Claude Code session", many: "{} Claude Code sessions" },
]

/** The most columns a waiting command takes on the line, its ellipsis included. */
const COMMAND_COLUMNS = 30

/** `command` on one row, cut to `columns` with an ellipsis when it is wider. */
function cut(command: string, columns: number) {
  const row = command.replace(/\s+/g, " ").trim()
  if (Bun.stringWidth(row) <= columns) return row
  return wrap(row, columns - 1)[0] + "…"
}

/** The oldest of `instruments` waiting on the owner. */
export function waitingInstrument(instruments: readonly Instrument[] | undefined) {
  return instruments?.find((i) => i.status === "waiting")
}

/** After the prompt line's left side: a count per kind of the session's instruments that haven't ended, then how
 *  many of them failed. Nothing while it has none. It takes only the room the line has left, cut in the middle when
 *  that is too little, so the rest of the line stays as it was and a failure still shows. */
export function InstrumentLine(props: { sessionID: string }) {
  const office = useOffice()
  const { theme } = useTheme()
  const listed = createMemo(() => (office.state.instruments[props.sessionID] ?? []).filter((i) => i.status !== "ended"))
  const counts = createMemo(() =>
    KINDS.flatMap(({ kind, one, many }) => {
      const n = listed().filter((i) => i.kind === kind).length
      return n ? [` · ${Locale.pluralize(n, one, many)}`] : []
    }).join(""),
  )
  const failed = createMemo(() => listed().filter((i) => i.status === "failed").length)
  return (
    <Show when={counts()}>
      <box flexGrow={1} flexBasis={0} overflow="hidden" paddingRight={2}>
        <text fg={theme.textMuted} wrapMode="none" truncate>
          {counts()}
          <Show when={failed()}>
            {" · "}
            <span style={{ fg: theme.error }}>{failed()} failed</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}

/** In place of the prompt line's shortcuts: which instrument waits on the owner, by its command or else its name. */
export function InstrumentWarning(props: { sessionID: string }) {
  const office = useOffice()
  const { theme } = useTheme()
  const waiting = createMemo(() => waitingInstrument(office.state.instruments[props.sessionID]))
  return (
    <Show when={waiting()}>
      {(i) => (
        <text fg={theme.warning} wrapMode="none">
          ⚠ {i().command ? cut(i().command!, COMMAND_COLUMNS) : i().name} is waiting for you
        </text>
      )}
    </Show>
  )
}
