import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { SetupAsk, SetupChoose, SetupSecret } from "@agent-corp/protocol"
import { Spinner } from "../component/spinner"
import { useTheme } from "../context/theme"
import type { SetupChild } from "./child"

type Line = { kind: "step" | "why" | "say"; text: string }

/** The install's transcript, its pending question, and a spinner while it works; Ctrl-C asks it to stop. */
export function SetupScreen(props: { child: SetupChild; lines: string[] }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [lines, setLines] = createSignal<Line[]>([])
  const [pending, setPending] = createSignal<SetupAsk | SetupChoose | SetupSecret>()
  const [stopping, setStopping] = createSignal(false)

  /** Adds a line to the transcript shown now and to the one printed once the screen is gone. */
  const add = (kind: Line["kind"], text: string) => {
    props.lines.push(text)
    setLines((all) => [...all, { kind, text }])
  }

  props.child.onPrompt((prompt) => {
    if (prompt.type === "step") {
      add("step", `Step ${prompt.number} of ${prompt.total}: ${prompt.title}`)
      add("why", prompt.why)
    } else if (prompt.type === "say") add("say", prompt.text)
    else setPending(prompt)
  })

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return
    props.child.interrupt()
    setStopping(true)
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1}>
        <For each={lines()}>
          {(line) => (
            <text
              fg={line.kind === "step" ? theme.accent : line.kind === "why" ? theme.textMuted : theme.text}
              attributes={line.kind === "step" ? TextAttributes.BOLD : undefined}
            >
              {line.text}
            </text>
          )}
        </For>
      </scrollbox>
      <box flexShrink={0} paddingTop={1}>
        <Show when={!pending() || stopping()}>
          <Spinner>{stopping() ? "Stopping…" : "Working…"}</Spinner>
        </Show>
      </box>
    </box>
  )
}
