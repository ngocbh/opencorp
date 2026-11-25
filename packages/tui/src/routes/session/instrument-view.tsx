import type { Instrument, Message } from "@opencorp/protocol"
import { TextAttributes, type RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useOffice } from "../../context/office"
import { usePanel } from "../../context/panel"
import { useTheme } from "../../context/theme"
import { useCommandShortcut, useOpenCorpKeymap } from "../../keymap"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { display } from "../../util/printable"
import { working } from "../../util/status"
import { lineTail } from "../../util/text-boundary"
import { childState } from "./composer/tabs"
import { followOutput, LIVE, TerminalPane } from "./terminal-pane"

/** What the header says of a shell's status. */
const STATUS_LABEL: Record<Instrument["status"], string> = {
  starting: "starting",
  idle: "idle",
  running: "running",
  waiting: "waiting for you",
  ended: "ended",
  failed: "failed",
}

/** What the header says of a shell waiting on a password, which only the owner may type: short, so a half-screen
 *  pane shows it whole beside who drives it. */
const SECRET_LABEL = "type your password here"

/** The most of a pipes shell's output a view keeps, its newest part. */
const OUTPUT_CHARS = 64 * 1024

/** Who has the controls of an open instrument: the owner, while they type into it, or else its driver, the employee;
 *  `color` is that person's. */
export type Driver = { you: boolean; handle: string | undefined; color: RGBA }

/**
 * An open instrument in the right pane, in the upstream TUI's diff-viewer chrome: a header row, the body, and a footer
 * with the pane's keys. The header says who is at the controls, "@minh is driving" in the employee's colour (with a
 * spinner while the shell or the harness works) or "you are driving" in the owner's, then what it is, its status in
 * the warning colour while it waits on the owner, and the command it runs.
 */
export function InstrumentPanel(props: {
  instrument: Instrument
  driver: Driver
  focused: boolean
  /** Whether the viewer is the session's approver, the one person whose keys its shells take. */
  approver: boolean
  /** Whether Esc closes it: it takes no typing. */
  dismissable: boolean
  children: JSX.Element
}) {
  const { theme } = useTheme()
  const office = useOffice()
  const panels = usePanel()
  const leftKey = useCommandShortcut("pane.focus.left")
  const rightKey = useCommandShortcut("pane.focus.right")
  const closeKey = useCommandShortcut("pane.close")
  const escKey = useCommandShortcut("pane.dismiss")
  const fullKey = useCommandShortcut("pane.fullscreen")
  const docked = () => panels.presentation() === "panel"
  // A Codex or Claude Code instrument is its own session, whose status says how its harness is doing.
  const child = createMemo(() =>
    props.instrument.kind === "terminal" ? undefined : office.state.sessions.find((s) => s.id === props.instrument.id),
  )
  const busy = () => {
    const session = child()
    if (session) return working(session.status)
    return props.instrument.status === "starting" || props.instrument.status === "running"
  }
  const waiting = () => (child()?.status ?? props.instrument.status) === "waiting"
  const status = () => {
    if (props.instrument.kind !== "terminal") return childState(child(), props.instrument)
    // Only while the view has the keys: with them in the chat, a password typed would go there.
    const secret = props.instrument.status === "waiting" && props.instrument.waiting === "secret"
    if (props.approver && props.focused && secret) return SECRET_LABEL
    return STATUS_LABEL[props.instrument.status]
  }
  const command = createMemo(() => display(props.instrument.command ?? "").replace(/\s+/g, " ").trim())
  const close = () => (props.dismissable ? escKey() : closeKey()).replace(/\bescape\b/, "esc")
  // Docked, the keys move between the chat and the pane; full screen leaves no chat, so closing is the way back.
  const hint = () => {
    if (!docked()) return { key: close(), label: "close" }
    return props.focused ? { key: leftKey(), label: "focus chat" } : { key: rightKey(), label: "focus pane" }
  }

  return (
    <box flexGrow={1} minWidth={0} minHeight={0}>
      {/* One row, so the screen's room never changes with the header: when it is too narrow the command gives way
          first, then who drives it and the name; the status, which may ask for the owner's password, stays whole. */}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} gap={1} overflow="hidden">
        <Show when={busy()}>
          <box flexShrink={0}>
            <Spinner color={props.driver.color} />
          </box>
        </Show>
        <text fg={theme.text} wrapMode="none" flexShrink={1} minWidth={0}>
          <span style={{ fg: props.driver.color }}>
            <b>{props.driver.you ? "you" : `@${display(props.driver.handle ?? props.instrument.driver)}`}</b>
          </span>
          {props.driver.you ? " are driving" : " is driving"}
        </text>
        <text fg={theme.textMuted} wrapMode="none" flexShrink={1} minWidth={0}>
          · <span style={{ fg: theme.text }}>{display(props.instrument.name)}</span>
        </text>
        <text fg={waiting() ? theme.warning : theme.textMuted} wrapMode="none" flexShrink={0}>
          · {status()}
        </text>
        <Show when={command()}>
          <text fg={theme.textMuted} wrapMode="none" flexShrink={1000} minWidth={0}>
            · {command()}
          </text>
        </Show>
      </box>
      {props.children}
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} gap={1} overflow="hidden">
        <text
          fg={props.focused ? theme.primary : theme.textMuted}
          attributes={props.focused ? 0 : TextAttributes.DIM}
          wrapMode="none"
          flexGrow={1}
          minWidth={0}
        >
          {hint().key}
          <span style={{ fg: theme.textMuted }}> {hint().label}</span>
        </text>
        <Show when={docked()}>
          <text fg={theme.text} wrapMode="none" flexShrink={0}>
            {close()}
            <span style={{ fg: theme.textMuted }}> close</span>
          </text>
        </Show>
        <Show when={panels.canSplit() && fullKey()}>
          <text fg={theme.text} wrapMode="none" flexShrink={0}>
            {fullKey()}
            <span style={{ fg: theme.textMuted }}>{docked() ? " full screen" : " split"}</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

/**
 * A shell's body in the pane: a PTY shell's screen, which takes every key but the leader while `focused`, or a pipes
 * shell's output, which takes only Ctrl-C, its interrupt. `color` is the driver's, which the employee's `$` command
 * lines in a pipes shell's output take.
 */
export function InstrumentScreen(props: {
  sessionID: string
  instrument: Instrument
  focused: boolean
  color: RGBA
  onFocusRequest?: (focus: (() => void) | undefined) => void
  onLine?: (typing: boolean) => void
}) {
  const office = useOffice()
  const keymap = useOpenCorpKeymap()
  const toast = useToast()
  const live = () => LIVE.includes(props.instrument.status)

  // Ctrl-C interrupts a live pipes shell's command; in a view that doesn't take keys it does nothing, rather than
  // what it does in the chat. A live terminal takes it itself.
  const isCtrlC = keymap.createKeyMatcher("ctrl+c")
  onCleanup(
    keymap.intercept(
      "key",
      ({ event, consume }) => {
        if (!props.focused || (props.instrument.interactive && live()) || !isCtrlC(event)) return
        consume()
        if (props.instrument.interactive || !live()) return
        office.client.sessions
          .keys(props.sessionID, props.instrument.id, { data: "\x03" })
          .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
      },
      { priority: 100 },
    ),
  )

  // The employee's commands in it, as the chat's record of their terminal calls has them, and the one it runs now.
  const commands = createMemo(() => {
    const ran = employeeCommands(office.state.messages[props.sessionID] ?? [], props.instrument.name)
    if (props.instrument.command) ran.add(props.instrument.command)
    return ran
  })

  return (
    <Show
      when={props.instrument.interactive}
      fallback={
        <ShellOutput
          sessionID={props.sessionID}
          instrument={props.instrument}
          color={props.color}
          commands={commands()}
        />
      }
    >
      <TerminalPane
        sessionID={props.sessionID}
        instrument={props.instrument}
        focused={props.focused}
        onFocusRequest={props.onFocusRequest}
        onLine={props.onLine}
      />
    </Show>
  )
}

/** The commands the chat's terminal calls ran in shell `name`: each `terminal_run` the shell's reply, or its input,
 *  names. */
function employeeCommands(messages: readonly Message[], name: string) {
  const ran = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "terminal_run" || typeof part.input?.command !== "string") continue
      let shell = typeof part.input.shell === "string" ? part.input.shell : undefined
      try {
        const reply: unknown = JSON.parse(typeof part.output === "string" ? part.output : "")
        if (reply && typeof reply === "object" && "shell" in reply && typeof reply.shell === "string") shell = reply.shell
      } catch {}
      if (shell === name) ran.add(part.input.command)
    }
  }
  return ran
}

/** `text`'s lines as runs, each one span: the `$ <command>` lines the office wrote for one of `commands`, and the
 *  rest. A run after the first starts with its newline. */
export function commandRuns(text: string, commands: ReadonlySet<string>) {
  // A command's first line, as the office writes it, and how many lines the command takes.
  const starts = new Map<string, number>()
  for (const command of commands) {
    const lines = command.split("\n").map((line) => display(line))
    const key = `$ ${lines[0]}`
    starts.set(key, Math.max(starts.get(key) ?? 0, lines.length))
  }
  const runs: { text: string; command: boolean }[] = []
  let left = 0
  for (const line of text.split("\n")) {
    left = Math.max(left - 1, starts.get(line) ?? 0)
    const command = left > 0
    const last = runs.at(-1)
    if (last && last.command === command) last.text += "\n" + line
    else runs.push({ text: (last ? "\n" : "") + line, command })
  }
  return runs
}

/**
 * A pipes shell's output, as lines with its escapes stripped, in the upstream TUI's shell-output layout: the
 * command, a note when the office no longer holds the start, then the output, following its end. The office writes
 * each command the employee runs as a `$ <command>` line; those of `commands` take `color`, theirs.
 */
function ShellOutput(props: {
  sessionID: string
  instrument: Instrument
  color: RGBA
  commands: ReadonlySet<string>
}) {
  const { theme } = useTheme()
  const [output, setOutput] = createSignal<string>()
  const [omitted, setOmitted] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // Escapes go whole, so a colour split across two events leaves nothing behind; a lone CR starts a line.
  const text = createMemo(() => display((output() ?? "").replace(/\r\n?/g, "\n")).replace(/\n+$/, ""))
  const runs = createMemo(() => commandRuns(text(), props.commands))
  // A `$ ` line that no command in the chat's loaded pages names may be the employee's from an older page: the older
  // pages load, once per view, so it takes their colour.
  const office = useOffice()
  let olderLoaded = false
  createEffect(() => {
    if (olderLoaded || !office.hasOlder(props.sessionID)) return
    if (!runs().some((run) => !run.command && /(^|\n)\$ /.test(run.text))) return
    olderLoaded = true
    office.loadOlder(props.sessionID, { all: true }).catch(() => {})
  })
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
        <Show
          when={text()}
          fallback={
            <text fg={theme.text} wrapMode="word">
              {output() === undefined ? "Loading output…" : "No output yet."}
            </text>
          }
        >
          <text fg={theme.text} wrapMode="word">
            <For each={runs()}>
              {(run) => <span style={{ fg: run.command ? props.color : theme.text }}>{run.text}</span>}
            </For>
          </text>
        </Show>
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
