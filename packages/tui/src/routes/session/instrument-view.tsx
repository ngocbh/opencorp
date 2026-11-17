import type { Instrument } from "@opencorp/protocol"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import { display } from "../../util/printable"
import { lineTail } from "../../util/text-boundary"
import { followOutput, TerminalPane } from "./terminal-pane"

/** How an open instrument shows: floating over the chat, in a split beside it, or full screen in its place. */
export type InstrumentPlacement = "floating" | "split" | "full"
export const PLACEMENTS: readonly InstrumentPlacement[] = ["floating", "split", "full"]

/** The view <leader>o moves an open instrument to; after full screen it goes back to the list. */
export function nextPlacement(view: InstrumentPlacement): InstrumentPlacement | undefined {
  return PLACEMENTS[PLACEMENTS.indexOf(view) + 1]
}

/** What the title calls each view <leader>o moves to. */
const PLACEMENT_LABEL: Record<InstrumentPlacement, string> = {
  floating: "floating",
  split: "split",
  full: "full screen",
}

/** What the title says of each status. */
const STATUS_LABEL: Record<Instrument["status"], string> = {
  starting: "starting",
  idle: "idle",
  running: "running",
  waiting: "waiting for you",
  ended: "ended",
  failed: "failed",
}

/** The most of a pipes shell's output a view keeps, its newest part. */
const OUTPUT_CHARS = 64 * 1024

/**
 * An open instrument: a frame whose title names it, says how it is doing and what it runs, and gives the keys that
 * move it on and put it back; inside, a PTY shell's screen, or a pipes shell's output lines. A click in it gives it
 * the keys.
 */
export function InstrumentView(props: {
  sessionID: string
  instrument: Instrument
  view: InstrumentPlacement
  focused: boolean
  onFocus: () => void
}) {
  const { theme } = useTheme()
  const cycleKey = useCommandShortcut("session.instrument.cycle")
  const closeKey = useCommandShortcut("session.instrument.close")
  const command = createMemo(() => display(props.instrument.command ?? "").replace(/\s+/g, " ").trim())
  const hints = createMemo(() => {
    const close = closeKey().replace(/\bescape\b/, "esc")
    const next = nextPlacement(props.view)
    const cycle = cycleKey()
    if (!cycle) return `${close}: back to the list`
    if (!next) return `${cycle}, ${close}: back to the list`
    return `${cycle}: ${PLACEMENT_LABEL[next]} · ${close}: back to the list`
  })

  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      border
      borderStyle="rounded"
      borderColor={props.focused ? theme.borderActive : theme.border}
      backgroundColor={theme.backgroundPanel}
      onMouseDown={() => props.onFocus()}
    >
      {/* One row, so the screen's room never changes with the title: when it is too narrow the command gives way
          first, then the keys. */}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} overflow="hidden">
        <text fg={theme.text} wrapMode="none" flexShrink={0}>
          <b>{display(props.instrument.name)}</b> · {STATUS_LABEL[props.instrument.status]}
        </text>
        <Show when={command()}>
          <text fg={theme.text} wrapMode="none" flexShrink={1000} minWidth={0}>
            {" · "}
            {command()}
          </text>
        </Show>
        <text fg={theme.textMuted} wrapMode="none" flexShrink={1} minWidth={0}>
          {" · "}
          {hints()}
        </text>
      </box>
      <Show
        when={props.instrument.interactive}
        fallback={<ShellOutput sessionID={props.sessionID} instrument={props.instrument} />}
      >
        <TerminalPane sessionID={props.sessionID} instrument={props.instrument} />
      </Show>
    </box>
  )
}

/**
 * A pipes shell's output, as lines with its escapes stripped, in the upstream TUI's shell-output layout: the
 * command, a note when the office no longer holds the start, then the output, following its end.
 */
function ShellOutput(props: { sessionID: string; instrument: Instrument }) {
  const { theme } = useTheme()
  const [output, setOutput] = createSignal<string>()
  const [omitted, setOmitted] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // Escapes go whole, so a colour split across two events leaves nothing behind; a lone CR starts a line.
  const text = createMemo(() => display((output() ?? "").replace(/\r\n?/g, "\n")).replace(/\n+$/, ""))
  let decoder = new TextDecoder()

  /** Shows `next`, its newest part when it is longer than a view keeps. */
  const show = (next: string) => {
    if (next.length > OUTPUT_CHARS) setOmitted(true)
    setOutput(lineTail(next, OUTPUT_CHARS))
  }
  followOutput({
    sessionID: props.sessionID,
    instrumentID: props.instrument.id,
    screen: (data, offset) => {
      decoder = new TextDecoder()
      setOmitted(offset > 0)
      show(decoder.decode(data, { stream: true }))
    },
    output: (data) => show((output() ?? "") + decoder.decode(data, { stream: true })),
    failed: setError,
  })

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <Show when={props.instrument.command}>
        {(command) => (
          <text fg={theme.textMuted} maxHeight={3} wrapMode="word" flexShrink={0}>
            {display(command())}
          </text>
        )}
      </Show>
      <Show when={omitted()}>
        <text fg={theme.textMuted} flexShrink={0}>
          Earlier output omitted · showing recent output
        </text>
      </Show>
      <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
        <text fg={theme.text} wrapMode="word">
          {text() || (output() === undefined ? "Loading output…" : "No output yet.")}
        </text>
      </scrollbox>
      <Show when={error()}>
        {(message) => (
          <text fg={theme.error} flexShrink={0}>
            {message()}
          </text>
        )}
      </Show>
    </box>
  )
}
