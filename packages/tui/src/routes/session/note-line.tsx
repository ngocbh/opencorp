import type { Message } from "@opencorp/protocol"
import { useRenderer } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { display } from "../../util/printable"

/**
 * An instrument's note to the employee about their own work, such as a command of theirs that ended: one line in
 * the info colour, `↳` and the note's first line, cut to the screen's width, as the upstream TUI shows a background
 * command's end. A click opens the rest of the note under it, and closes it again.
 */
export function NoteLine(props: { message: Message; index: number }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [open, setOpen] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const lines = createMemo(() =>
    display(props.message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
      .trim()
      .split("\n"),
  )
  const rest = createMemo(() => lines().slice(1).join("\n").trimEnd())
  return (
    <Show when={lines()[0]}>
      {(heading) => (
        <box
          id={props.message.id}
          marginTop={props.index === 0 ? 0 : 1}
          paddingLeft={3}
          flexShrink={0}
          onMouseOver={() => rest() && setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            if (rest()) setOpen((value) => !value)
          }}
        >
          <text fg={hover() ? theme.text : theme.info} wrapMode="none" truncate>
            ↳ {heading()}
          </text>
          <Show when={open() && rest()}>
            <box paddingLeft={2}>
              <text fg={theme.textMuted}>{rest()}</text>
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}
